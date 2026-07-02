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
) -> TrajectoryBuffer:
    """Load trajectory rows, group by gameId ordered by stepIdx, and compute
    GAE advantages + returns learner-side."""
    data_dir = Path(data_dir)
    jsonl_files = sorted(p for p in data_dir.rglob("*.jsonl") if p.is_file())
    if not jsonl_files:
        raise FileNotFoundError(f"No *.jsonl files found in {data_dir}")

    episodes: dict[str, list[dict]] = {}
    n_skipped = 0
    for fpath in jsonl_files:
        with open(fpath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:  # tolerate a partial last line if a file is being appended concurrently
                    rec: dict[str, Any] = json.loads(line)
                    obs = np.array(rec["obs"], dtype=np.float32)
                    cands = np.array(rec["cands"], dtype=np.float32)
                    chosen = int(rec["chosen"])
                except (json.JSONDecodeError, KeyError, ValueError, TypeError):
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
        for i, s in enumerate(steps):
            obs_list.append(s["obs"])
            cands_list.append(s["cands"])
            chosen_list.append(s["chosen"])
            logp_old_list.append(s["logp_old"])
            v_pred_list.append(s["v_pred"])
        adv_list.append(adv)
        ret_list.append(ret)

    advantages = np.concatenate(adv_list).astype(np.float32)
    returns = np.concatenate(ret_list).astype(np.float32)
    print(
        f"Loaded {len(cands_list)} PPO steps from {len(episodes)} game(s) "
        f"({n_with_placement} with terminal placement reward, {n_truncated} truncated, "
        f"{n_skipped} rows without PPO fields skipped)"
    )
    return TrajectoryBuffer(
        obs=np.stack(obs_list),
        cands=cands_list,
        chosen=np.array(chosen_list, dtype=np.int64),
        logp_old=np.array(logp_old_list, dtype=np.float32),
        v_pred=np.array(v_pred_list, dtype=np.float32),
        advantages=advantages,
        returns=returns,
    )


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
    seed: int | None = None,
) -> None:
    """K epochs of clipped-surrogate PPO over a fixed rollout buffer."""
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    n = len(buffer)
    rng = np.random.default_rng(seed)
    indices = np.arange(n)

    for epoch in range(1, epochs + 1):
        frac = 0.0 if epochs <= 1 else (epoch - 1) / (epochs - 1)
        ent_coef = entropy_coef * (1.0 - frac) if entropy_anneal else entropy_coef
        rng.shuffle(indices)
        model.train()

        tot_policy = tot_value = tot_entropy = tot_kl = tot_clip = tot_prob = 0.0
        n_seen = 0
        stop = False

        for start in range(0, n, batch_size):
            mb = indices[start : start + batch_size]
            obs, cands, mask, chosen, logp_old, v_pred, adv, ret = _minibatch_tensors(
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

            loss = policy_coef * policy_loss + value_coef * value_loss - ent_coef * entropy
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            bs = len(mb)
            n_seen += bs
            tot_policy += policy_loss.item() * bs
            tot_value += value_loss.item() * bs
            tot_entropy += entropy.item() * bs
            tot_kl += approx_kl * bs
            tot_clip += clip_frac * bs
            tot_prob += logp_new.detach().exp().mean().item() * bs

        if n_seen:
            print(
                f"PPO epoch {epoch}/{epochs} | "
                f"policy_loss={tot_policy / n_seen:.4f} | "
                f"value_loss={tot_value / n_seen:.4f} | "
                f"entropy={tot_entropy / n_seen:.4f} (coef={ent_coef:.4f}) | "
                f"approx_kl={tot_kl / n_seen:.4f} | "
                f"clip_frac={tot_clip / n_seen:.3f} | "
                f"mean_p_chosen={tot_prob / n_seen:.3f}"
            )
        if stop:
            break
