"""
PPO trainer for the Arc Spirits candidate-scoring policy + value network.

Consumes the trajectory JSONL format — a superset of the AWR/AlphaZero decision
rows. On top of obs/cands/chosen/ret, each row carries:

  gameId    (str)    episode key; rows are grouped by it
  stepIdx   (int)    order of the decision within the episode
  rStep     (float)  per-step shaping reward
  done      (bool)   True on the terminal decision row of the game
  logpOld   (float)  behavior-policy log-prob of the chosen candidate at decision time
  vPred     (float)  value estimate at decision time (GAE baseline + value clipping)
  placement (int)    final placement 1-4 (terminal rows / per-game meta); mapped to a
                     terminal reward added to rStep on the done step

Rows missing the PPO fields are skipped here (with a count) — such old-format
rows still train normally under train.py --mode awr / alphazero.

The policy is the masked softmax over per-candidate logits from CandidateScorer,
so the PPO ratio is exp(logp_new(chosen) - logpOld) with logp_new taken from
log_softmax over the legal candidates only.
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from model import CandidateScorer

DEFAULT_PLACEMENT_REWARDS = "1.0,0.3,-0.3,-1.0"


# ---------------------------------------------------------------------------
# Rewards / advantages
# ---------------------------------------------------------------------------

def parse_placement_rewards(spec: str) -> tuple[float, float, float, float]:
    """Parse "r1,r2,r3,r4" into the terminal reward for placements 1-4."""
    vals = tuple(float(x) for x in spec.split(","))
    if len(vals) != 4:
        raise ValueError(f"--placement-rewards needs 4 comma-separated floats, got {spec!r}")
    return vals  # type: ignore[return-value]


def compute_gae(
    rewards,
    values,
    dones,
    gamma: float,
    lam: float,
    last_value: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """
    GAE(lambda) over one episode.

      delta_t = r_t + gamma * V(s_{t+1}) * (1 - done_t) - V(s_t)
      A_t     = delta_t + gamma * lam * (1 - done_t) * A_{t+1}
      returns = A + V     (value-head regression target)

    `last_value` bootstraps V(s_{T+1}) when the final step is not terminal
    (truncated episode); it is ignored when the final step has done=True.
    """
    rewards = np.asarray(rewards, dtype=np.float64)
    values = np.asarray(values, dtype=np.float64)
    dones = np.asarray(dones, dtype=bool)
    T = rewards.shape[0]
    adv = np.zeros(T, dtype=np.float64)
    next_adv = 0.0
    next_value = float(last_value)
    for t in range(T - 1, -1, -1):
        nonterminal = 0.0 if dones[t] else 1.0
        delta = rewards[t] + gamma * next_value * nonterminal - values[t]
        next_adv = delta + gamma * lam * nonterminal * next_adv
        adv[t] = next_adv
        next_value = float(values[t])
    returns = adv + values
    return adv, returns


# ---------------------------------------------------------------------------
# Trajectory loading
# ---------------------------------------------------------------------------

@dataclass
class TrajectoryBuffer:
    obs: np.ndarray                 # (N, obs_dim) float32
    cands: list[np.ndarray]         # N x (n_cands_i, act_dim) float32
    chosen: np.ndarray              # (N,) int64
    logp_old: np.ndarray            # (N,) float32
    v_pred: np.ndarray              # (N,) float32
    advantages: np.ndarray          # (N,) float32
    returns: np.ndarray             # (N,) float32
    # Game placement broadcast to every step of the game (0 = unknown): the
    # placement-aux target "final placement given this state" is defined at
    # every decision, not just on the terminal row.
    placement: np.ndarray           # (N,) int64

    def __len__(self) -> int:
        return len(self.cands)


def _coerce_placement(raw: Any) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int) and 1 <= raw <= 4:
        return raw
    if isinstance(raw, float) and raw.is_integer() and 1 <= raw <= 4:
        return int(raw)
    return None


def load_trajectory_buffer(
    data_dir: Path,
    gamma: float,
    gae_lambda: float,
    placement_rewards: tuple[float, float, float, float],
    obs_key: str = "obs",
) -> TrajectoryBuffer:
    """Load trajectory rows, group by gameId ordered by stepIdx, and compute
    GAE advantages + returns learner-side.

    obs_key: "obs" (v1 62-float summary) or "obsV2" (flat arc-obs-v2,
    paired-row contract); rows lacking it are skipped and counted."""
    data_dir = Path(data_dir)
    # Skip the actor pool's games-*.jsonl per-game summaries (no obs/cands keys).
    jsonl_files = sorted(
        p for p in data_dir.rglob("*.jsonl")
        if p.is_file() and not p.name.startswith("games-")
    )
    if not jsonl_files:
        raise FileNotFoundError(f"No *.jsonl files found in {data_dir}")

    episodes: dict[str, list[dict]] = {}
    n_skipped = 0
    n_missing_obs = 0
    for fpath in jsonl_files:
        with open(fpath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:  # tolerate a partial last line if a file is being appended concurrently
                    rec: dict[str, Any] = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if obs_key not in rec:
                    n_missing_obs += 1
                    continue
                try:
                    obs = np.array(rec[obs_key], dtype=np.float32)
                    cands = np.array(rec["cands"], dtype=np.float32)
                    chosen = int(rec["chosen"])
                except (KeyError, ValueError, TypeError):
                    continue
                try:
                    step = {
                        "game_id": str(rec["gameId"]),
                        "step_idx": int(rec["stepIdx"]),
                        "r_step": float(rec["rStep"]),
                        "done": bool(rec["done"]),
                        "logp_old": float(rec["logpOld"]),
                        "v_pred": float(rec["vPred"]),
                        "placement": _coerce_placement(rec.get("placement")),
                        "obs": obs,
                        "cands": cands,
                        "chosen": min(max(chosen, 0), cands.shape[0] - 1),
                    }
                except (KeyError, ValueError, TypeError):
                    n_skipped += 1  # old-format row without PPO fields
                    continue
                if not all(math.isfinite(step[k]) for k in ("r_step", "logp_old", "v_pred")):
                    n_skipped += 1
                    continue
                episodes.setdefault(step["game_id"], []).append(step)

    if not episodes:
        raise ValueError(
            f"No PPO trajectory rows in {data_dir} "
            f"({n_skipped} rows lacked gameId/stepIdx/rStep/done/logpOld/vPred)"
        )

    obs_list: list[np.ndarray] = []
    cands_list: list[np.ndarray] = []
    chosen_list: list[int] = []
    logp_old_list: list[float] = []
    v_pred_list: list[float] = []
    placement_list: list[int] = []
    adv_list: list[np.ndarray] = []
    ret_list: list[np.ndarray] = []
    n_truncated = 0
    n_with_placement = 0

    for game_id in sorted(episodes):
        steps = sorted(episodes[game_id], key=lambda s: s["step_idx"])
        rewards = np.array([s["r_step"] for s in steps], dtype=np.float64)
        values = np.array([s["v_pred"] for s in steps], dtype=np.float64)
        dones = np.array([s["done"] for s in steps], dtype=bool)

        placement = None
        for s in steps:
            if s["placement"] is not None:
                placement = s["placement"]
        if dones[-1] and placement is not None:
            rewards[-1] += placement_rewards[placement - 1]
            n_with_placement += 1

        if dones[-1]:
            last_value = 0.0
        else:
            # Truncated episode (no terminal row): bootstrap V(s_{T+1}) with the
            # last recorded vPred — the best available proxy; keeps truncated
            # tails from reading as artificial zero-return endings.
            last_value = float(values[-1])
            n_truncated += 1

        adv, ret = compute_gae(rewards, values, dones, gamma, gae_lambda, last_value)
        for s in steps:
            obs_list.append(s["obs"])
            cands_list.append(s["cands"])
            chosen_list.append(s["chosen"])
            logp_old_list.append(s["logp_old"])
            v_pred_list.append(s["v_pred"])
            placement_list.append(placement if placement is not None else 0)
        adv_list.append(adv)
        ret_list.append(ret)

    advantages = np.concatenate(adv_list).astype(np.float32)
    returns = np.concatenate(ret_list).astype(np.float32)
    print(
        f"Loaded {len(cands_list)} PPO steps from {len(episodes)} game(s) "
        f"({n_with_placement} with terminal placement reward, {n_truncated} truncated, "
        f"{n_skipped} rows without PPO fields skipped, "
        f"{n_missing_obs} skipped without {obs_key!r})"
    )
    return TrajectoryBuffer(
        obs=np.stack(obs_list),
        cands=cands_list,
        chosen=np.array(chosen_list, dtype=np.int64),
        logp_old=np.array(logp_old_list, dtype=np.float32),
        v_pred=np.array(v_pred_list, dtype=np.float32),
        advantages=advantages,
        returns=returns,
        placement=np.array(placement_list, dtype=np.int64),
    )


# ---------------------------------------------------------------------------
# Placement aux loss (model v2 only)
# ---------------------------------------------------------------------------

# Seat-family field index of `isSelf`, fixed by the encodeV2 contract
# (src/lib/play/ml/encodeV2.ts fieldNames.seat = ["present", "isSelf", ...]).
SEAT_ISSELF_IDX = 1


def placement_aux_loss_v1(
    model,
    obs: torch.Tensor,            # (B, obs_dim) v1 obs
    placement: torch.Tensor,      # (B,) int, 1-4, 0 = unknown
    has_placement: torch.Tensor,  # (B,) bool
) -> torch.Tensor:
    """4-way CE on CandidateScorer.placement_head for rows carrying placement."""
    if not has_placement.any():
        return torch.zeros((), dtype=torch.float32, device=obs.device)
    logits = model.placement_head_logits(obs[has_placement])
    target = (placement[has_placement] - 1).long().clamp(0, 3)
    return F.cross_entropy(logits, target)


def placement_aux_loss(
    model,
    obs: torch.Tensor,            # (B, flat_len) raw v2 obs
    placement: torch.Tensor,      # (B,) int, 1-4, 0 = unknown
    has_placement: torch.Tensor,  # (B,) bool
) -> torch.Tensor:
    """
    Aux loss for EntityCandidateScorer.placement_logits on rows carrying `placement`.

    Regression, not CE: the head emits ONE scalar per seat token (there is no
    4-way simplex per seat), and placement is ordinal — a scalar score
    t = (4 - placement) / 3 (1st -> 1.0 ... 4th -> 0.0) preserves the ordering
    and stays meaningful if the seat count ever differs from 4. Only the ego
    seat is supervised: rows are egocentric and carry just the recorder's own
    placement, so the other seats' scalars come alive once the recorder emits
    all-seat placements. Ego seat = the seat token whose isSelf feature is set.

    Note: placement_logits re-runs encode_state, so enabling this roughly
    doubles the v2 forward cost for placement-carrying batches.
    """
    rows = has_placement
    if not bool(torch.any(rows)):
        return torch.zeros((), dtype=torch.float32, device=obs.device)
    obs_p = obs[rows]
    pred, _seat_real = model.placement_logits(obs_p)

    spec = model.spec
    seat = spec.family("seat")
    off = spec.header_len
    for f in spec.families:
        if f.name == "seat":
            break
        off += f.cap * f.dim
    is_self = obs_p[:, off : off + seat.cap * seat.dim].reshape(-1, seat.cap, seat.dim)[:, :, SEAT_ISSELF_IDX]
    ego = is_self.argmax(dim=1)  # (B',)

    ego_pred = pred.gather(1, ego.unsqueeze(1)).squeeze(1)
    target = (4.0 - placement[rows].float()) / 3.0
    return F.mse_loss(ego_pred, target)


# ---------------------------------------------------------------------------
# PPO update loop
# ---------------------------------------------------------------------------

def _minibatch_tensors(
    buffer: TrajectoryBuffer, idx: np.ndarray, device: torch.device
) -> tuple[torch.Tensor, ...]:
    """Pad the candidate lists of the selected steps to a common length."""
    B = len(idx)
    max_cands = max(buffer.cands[i].shape[0] for i in idx)
    act_dim = buffer.cands[idx[0]].shape[1]
    cands = np.zeros((B, max_cands, act_dim), dtype=np.float32)
    mask = np.zeros((B, max_cands), dtype=bool)
    for j, i in enumerate(idx):
        c = buffer.cands[i]
        cands[j, : c.shape[0]] = c
        mask[j, : c.shape[0]] = True
    return (
        torch.from_numpy(buffer.obs[idx]).to(device),
        torch.from_numpy(cands).to(device),
        torch.from_numpy(mask).to(device),
        torch.from_numpy(buffer.chosen[idx]).to(device),
        torch.from_numpy(buffer.logp_old[idx]).to(device),
        torch.from_numpy(buffer.v_pred[idx]).to(device),
        torch.from_numpy(buffer.advantages[idx]).to(device),
        torch.from_numpy(buffer.returns[idx]).to(device),
        torch.from_numpy(buffer.placement[idx]).to(device),
    )


def train_ppo(
    model: CandidateScorer,
    buffer: TrajectoryBuffer,
    device: torch.device,
    *,
    epochs: int = 4,
    batch_size: int = 256,
    lr: float = 1e-3,
    clip_eps: float = 0.2,
    policy_coef: float = 1.0,
    value_coef: float = 0.5,
    entropy_coef: float = 0.01,
    entropy_anneal: bool = False,
    value_clip_eps: float = 0.0,
    target_kl: float | None = None,
    kl_ref_coef: float = 0.0,
    lr_schedule: str = "const",
    placement_coef: float = 0.0,
    max_grad_norm: float = 1.0,
    seed: int | None = None,
) -> list[dict]:
    """K epochs of clipped-surrogate PPO over a fixed rollout buffer.
    Returns per-epoch metric dicts (used by tests).

    Divergence guards: gradient clipping (max_grad_norm, 0=off) and a NaN/Inf
    check after every optimizer step — on a non-finite step the run halts and
    the last finite epoch snapshot is restored, so the exported checkpoint is
    always finite (the fair-rules league diverged at gen ~13 without this)."""
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    # KL-to-reference anchor (piKL / AlphaStar KL-to-BC): penalize divergence from
    # the WARM-START policy. The reference is the state of `model` at entry.
    ref_model = None
    if kl_ref_coef > 0:
        import copy

        ref_model = copy.deepcopy(model)
        ref_model.eval()
        for p_ in ref_model.parameters():
            p_.requires_grad_(False)
    n = len(buffer)
    rng = np.random.default_rng(seed)
    indices = np.arange(n)
    # v2 (per-seat-token regression) and v1 (4-way CE) placement aux heads.
    use_placement = placement_coef > 0 and hasattr(model, "placement_logits")
    use_placement_v1 = placement_coef > 0 and hasattr(model, "placement_head")
    history: list[dict] = []
    last_finite = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    halted = False

    for epoch in range(1, epochs + 1):
        frac = 0.0 if epochs <= 1 else (epoch - 1) / (epochs - 1)
        ent_coef = entropy_coef * (1.0 - frac) if entropy_anneal else entropy_coef
        if lr_schedule == "cosine":
            # lr -> 0.1*lr over the epochs; guards late-epoch overshoot on small buffers.
            lr_e = lr * (0.1 + 0.45 * (1.0 + math.cos(math.pi * frac)))
            for group in optimizer.param_groups:
                group["lr"] = lr_e
        rng.shuffle(indices)
        model.train()

        tot_policy = tot_value = tot_entropy = tot_kl = tot_clip = tot_prob = 0.0
        tot_placement = 0.0
        tot_kl_ref = 0.0
        n_seen = 0
        stop = False

        for start in range(0, n, batch_size):
            mb = indices[start : start + batch_size]
            obs, cands, mask, chosen, logp_old, v_pred, adv, ret, placement = _minibatch_tensors(
                buffer, mb, device
            )
            adv = (adv - adv.mean()) / (adv.std() + 1e-8)

            logits, probs, value = model(obs, cands, mask)
            log_probs = F.log_softmax(logits, dim=-1)
            logp_new = log_probs.gather(1, chosen.unsqueeze(1)).squeeze(1)
            log_ratio = (logp_new - logp_old).clamp(-20.0, 20.0)
            ratio = log_ratio.exp()

            with torch.no_grad():
                # k3 estimator of KL(old || new): nonnegative, low variance.
                approx_kl = ((ratio - 1.0) - log_ratio).mean().item()
                clip_frac = ((ratio - 1.0).abs() > clip_eps).float().mean().item()
            if target_kl is not None and approx_kl > target_kl:
                print(
                    f"  PPO early stop in epoch {epoch}: "
                    f"approx_kl={approx_kl:.4f} > target_kl={target_kl}"
                )
                stop = True
                break

            surr1 = ratio * adv
            surr2 = ratio.clamp(1.0 - clip_eps, 1.0 + clip_eps) * adv
            policy_loss = -torch.min(surr1, surr2).mean()

            if value_clip_eps > 0:
                v_clipped = v_pred + (value - v_pred).clamp(-value_clip_eps, value_clip_eps)
                value_loss = torch.max((value - ret) ** 2, (v_clipped - ret) ** 2).mean()
            else:
                value_loss = F.mse_loss(value, ret)

            # Entropy over the legal candidates only; padded slots contribute 0.
            plogp = torch.where(mask, probs * log_probs, torch.zeros_like(probs))
            entropy = -plogp.sum(dim=-1).mean()

            kl_ref = torch.zeros((), dtype=torch.float32, device=device)
            if ref_model is not None:
                with torch.no_grad():
                    ref_logits, _, _ = ref_model(obs, cands, mask)
                    ref_logp = F.log_softmax(ref_logits, dim=-1)
                # KL(new || ref) over legal candidates only.
                kl_terms = torch.where(mask, probs * (log_probs - ref_logp), torch.zeros_like(probs))
                kl_ref = kl_terms.sum(dim=-1).mean()

            placement_loss = torch.zeros((), dtype=torch.float32, device=device)
            if use_placement:
                placement_loss = placement_aux_loss(model, obs, placement, placement > 0)
            elif use_placement_v1:
                placement_loss = placement_aux_loss_v1(model, obs, placement, placement > 0)

            loss = (
                policy_coef * policy_loss
                + value_coef * value_loss
                - ent_coef * entropy
                + placement_coef * placement_loss
                + kl_ref_coef * kl_ref
            )
            optimizer.zero_grad()
            loss.backward()
            if max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
            optimizer.step()
            if not all(torch.isfinite(p).all() for p in model.parameters()):
                print(
                    f"WARNING: non-finite weights after a PPO step in epoch {epoch} — "
                    "halting and restoring the last finite snapshot",
                    file=sys.stderr,
                )
                model.load_state_dict(last_finite)
                halted = True
                break

            bs = len(mb)
            n_seen += bs
            tot_policy += policy_loss.item() * bs
            tot_value += value_loss.item() * bs
            tot_entropy += entropy.item() * bs
            tot_kl += approx_kl * bs
            tot_clip += clip_frac * bs
            tot_prob += logp_new.detach().exp().mean().item() * bs
            tot_placement += placement_loss.item() * bs
            tot_kl_ref += kl_ref.item() * bs

        if halted:
            break
        if n_seen:
            print(
                f"PPO epoch {epoch}/{epochs} | "
                f"policy_loss={tot_policy / n_seen:.4f} | "
                f"value_loss={tot_value / n_seen:.4f} | "
                f"entropy={tot_entropy / n_seen:.4f} (coef={ent_coef:.4f}) | "
                f"approx_kl={tot_kl / n_seen:.4f} | "
                f"clip_frac={tot_clip / n_seen:.3f} | "
                f"placement_loss={tot_placement / n_seen:.4f} | "
                f"kl_ref={tot_kl_ref / n_seen:.4f} | "
                f"mean_p_chosen={tot_prob / n_seen:.3f}"
            )
            history.append({
                "policy_loss": tot_policy / n_seen,
                "value_loss": tot_value / n_seen,
                "entropy": tot_entropy / n_seen,
                "approx_kl": tot_kl / n_seen,
                "clip_frac": tot_clip / n_seen,
                "placement_loss": tot_placement / n_seen,
                "kl_ref": tot_kl_ref / n_seen,
                "mean_p_chosen": tot_prob / n_seen,
            })
            last_finite = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        if stop:
            break
    return history
