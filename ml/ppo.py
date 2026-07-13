"""
PPO trainer for the Arc Spirits candidate-scoring policy + value network.

Consumes the trajectory JSONL format — a superset of the AWR/AlphaZero decision
rows. On top of obs/cands/chosen/ret, each row carries:

  gameId    (str)    episode key; rows are grouped by it
  stepIdx   (int)    order of the decision within the episode
  rStep     (float)  per-step shaping reward
  done      (bool)   True on the terminal decision row of the game
  logpOld   (float)  behavior-policy log-prob of the chosen candidate at decision time
  policyMask (0|1)   1 only when logpOld came from the exact learned stochastic policy;
                     deterministic hybrid/search/custom rows remain in the trajectory with 0
  behaviorTemperature (float, optional) sampled softmax temperature (default 1 for old data)
  behaviorMask (list[0|1], optional) post-filter candidate support (default all candidates)
  vPred     (float)  value estimate at decision time (GAE baseline + value clipping)
  strategic (0|1)   round-level route/engine/conversion decision eligible for optional
                     full-episode Monte Carlo credit (default 0 for legacy rows)
  playerCount (1-6) configured seats for the episode (default 4 for legacy rows); solo
                     episodes do not receive the automatic first-place competitive reward
  placementProbs    behavior checkpoint's 4-way placement-head probabilities, used as
                     a state-only baseline for optional pure outcome credit
  placement (int)    final placement 1-4 (terminal rows / per-game meta); mapped to a
                     terminal reward added to rStep on the done step

All rows of a policy-backed episode are retained for reward accumulation, GAE,
value, and auxiliary losses. Only policyMask=1 rows enter the clipped policy
surrogate. A malformed row rejects its complete episode instead of silently
splicing time and terminal rewards around the missing transition.

The policy is the temperature-scaled masked softmax over per-candidate logits
from CandidateScorer, so the PPO ratio is exp(logp_new(chosen) - logpOld) with
the new distribution using the exact candidate support and temperature that
the actor used.
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

from model import CandidateScorer, model_parameters_are_finite

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


def compute_discounted_returns(
    rewards,
    dones,
    gamma: float,
    last_value: float = 0.0,
) -> np.ndarray:
    """Full-return Monte Carlo target over one episode.

    Completed episodes propagate the realized terminal outcome all the way back without
    GAE(lambda)'s additional attenuation. Truncated episodes bootstrap from ``last_value``.
    ``gamma=1`` is the undiscounted build-convert-finish objective.
    """
    rewards = np.asarray(rewards, dtype=np.float64)
    dones = np.asarray(dones, dtype=bool)
    if rewards.shape != dones.shape:
        raise ValueError("rewards and dones must have the same shape")
    out = np.zeros_like(rewards, dtype=np.float64)
    running = float(last_value)
    for t in range(rewards.shape[0] - 1, -1, -1):
        if dones[t]:
            running = 0.0
        running = float(rewards[t]) + gamma * running
        out[t] = running
    return out


# ---------------------------------------------------------------------------
# Trajectory loading
# ---------------------------------------------------------------------------

@dataclass
class TrajectoryBuffer:
    obs: np.ndarray                 # (N, obs_dim) float32
    cands: list[np.ndarray]         # N x (n_cands_i, act_dim) float32
    chosen: np.ndarray              # (N,) int64
    policy_mask: np.ndarray         # (N,) bool; exact learned stochastic behavior only
    logp_old: np.ndarray            # (N,) float32
    behavior_temperature: np.ndarray # (N,) float32
    behavior_mask: list[np.ndarray] # N x (n_cands_i,) bool
    v_pred: np.ndarray              # (N,) float32
    advantages: np.ndarray          # (N,) float32
    returns: np.ndarray             # (N,) float32
    strategic_mask: np.ndarray      # (N,) bool; long-horizon credit group
    strategic_mc_coef: float        # loader blend; 0 preserves ordinary PPO bit behavior
    solo_strategic_mc_coef: float   # solo-only full-episode blend; may coexist with PvP outcome
    strategic_outcome_coef: float   # pure placement-outcome advantage blend on strategic rows
    placement_probs: np.ndarray     # (N, 4) behavior outcome-head probabilities
    placement_prob_mask: np.ndarray # (N,) bool; behavior checkpoint exposed the outcome head
    farm_value: np.ndarray          # (N,) float32
    farm_mask: np.ndarray           # (N,) bool
    reward_pi: list[np.ndarray]     # N x (n_cands_i,) float32
    reward_mask: np.ndarray         # (N,) bool
    route_mode: np.ndarray          # (N,) float32
    route_mask: np.ndarray          # (N,) bool
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


def _coerce_end_round(raw: Any) -> int | None:
    """The game's final round from a done row (driver stamps endRound). Any positive
    integer; None when absent (old-format rows) — the win bonus then stays undecayed."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int) and raw >= 1:
        return raw
    if isinstance(raw, float) and raw.is_integer() and raw >= 1:
        return int(raw)
    return None


def _coerce_player_count(raw: Any) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int) and 1 <= raw <= 6:
        return raw
    if isinstance(raw, float) and raw.is_integer() and 1 <= raw <= 6:
        return int(raw)
    return None


def _coerce_behavior_mask(raw: Any, n_cands: int) -> np.ndarray | None:
    """Parse the actor's post-filter support without truthy-string coercions.

    Missing masks are the legacy contract: every recorded candidate was in support.
    Malformed, empty, or non-binary masks reject the PPO row instead of silently
    changing its behavior-policy denominator.
    """
    if raw is None:
        return np.ones(n_cands, dtype=bool)
    if not isinstance(raw, list) or len(raw) != n_cands:
        return None
    vals: list[bool] = []
    for value in raw:
        if isinstance(value, (bool, np.bool_)):
            vals.append(bool(value))
        elif isinstance(value, (int, float)) and not isinstance(value, bool) and value in (0, 1):
            vals.append(bool(value))
        else:
            return None
    mask = np.asarray(vals, dtype=bool)
    return mask if mask.any() else None


def _coerce_binary_flag(raw: Any) -> bool | None:
    """Strict 0/1 parser used for policyMask (truthy strings are rejected)."""
    if isinstance(raw, (bool, np.bool_)):
        return bool(raw)
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw in (0, 1):
        return bool(raw)
    return None


def _coerce_unit_target(raw: Any) -> tuple[float, bool]:
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(float(raw)):
        return float(np.clip(float(raw), 0.0, 1.0)), True
    return 0.0, False


def _coerce_policy_target(raw: Any, n_cands: int) -> tuple[np.ndarray, bool]:
    empty = np.zeros(n_cands, dtype=np.float32)
    if not isinstance(raw, list) or len(raw) != n_cands:
        return empty, False
    try:
        target = np.asarray(raw, dtype=np.float32)
    except (TypeError, ValueError):
        return empty, False
    if not np.isfinite(target).all() or np.any(target < 0):
        return empty, False
    total = float(target.sum())
    if total <= 0:
        return empty, False
    return target / total, True


def load_trajectory_buffer(
    data_dir: Path,
    gamma: float,
    gae_lambda: float,
    placement_rewards: tuple[float, float, float, float],
    win_bonus: float = 0.0,
    win_bonus_halflife: float = 0.0,
    all_fallen_loss: float = 0.0,
    strategic_mc_coef: float = 0.0,
    solo_strategic_mc_coef: float = 0.0,
    strategic_mc_gamma: float = 1.0,
    strategic_outcome_coef: float = 0.0,
    obs_key: str = "obs",
) -> TrajectoryBuffer:
    """Load trajectory rows, group by gameId ordered by stepIdx, and compute
    GAE advantages + returns learner-side.

    obs_key: "obs" (current v1 187-float summary) or "obsV2" (flat arc-obs-v2,
    paired-row contract). A missing/malformed row rejects its entire episode:
    silently dropping one row would move dense rewards, done, and GAE across a
    transition that the learner can no longer represent."""
    if not 0.0 <= strategic_mc_coef <= 1.0:
        raise ValueError("strategic_mc_coef must be in [0, 1]")
    if not 0.0 <= solo_strategic_mc_coef <= 1.0:
        raise ValueError("solo_strategic_mc_coef must be in [0, 1]")
    if not 0.0 <= strategic_mc_gamma <= 1.0:
        raise ValueError("strategic_mc_gamma must be in [0, 1]")
    if not 0.0 <= strategic_outcome_coef <= 1.0:
        raise ValueError("strategic_outcome_coef must be in [0, 1]")
    if strategic_mc_coef > 0 and strategic_outcome_coef > 0:
        raise ValueError("strategic_mc_coef and strategic_outcome_coef are mutually exclusive")
    data_dir = Path(data_dir)
    # Skip the actor pool's games-*.jsonl per-game summaries (no obs/cands keys).
    jsonl_files = sorted(
        p for p in data_dir.rglob("*.jsonl")
        if p.is_file() and not p.name.startswith("games-")
    )
    if not jsonl_files:
        raise FileNotFoundError(f"No *.jsonl files found in {data_dir}")

    episodes: dict[str, list[dict]] = {}
    invalid_episodes: set[str] = set()
    n_nontrajectory = 0
    n_invalid_rows = 0
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
                # AWR/AlphaZero teacher rows are intentionally not PPO trajectories.
                # Once gameId exists, however, every row is part of an episode and a
                # malformed member must invalidate the whole episode rather than vanish.
                if "gameId" not in rec:
                    n_nontrajectory += 1
                    continue
                game_id = str(rec["gameId"])
                if obs_key not in rec:
                    n_missing_obs += 1
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                try:
                    obs = np.array(rec[obs_key], dtype=np.float32)
                    cands = np.array(rec["cands"], dtype=np.float32)
                    chosen = int(rec["chosen"])
                except (KeyError, ValueError, TypeError):
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                if (
                    obs.ndim != 1
                    or cands.ndim != 2
                    or cands.shape[0] < 1
                    or not np.isfinite(obs).all()
                    or not np.isfinite(cands).all()
                    or chosen < 0
                    or chosen >= cands.shape[0]
                ):
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue

                # New rows are explicit. Legacy rows with logpOld are the old exact-policy
                # contract and remain readable as policyMask=1; a no-logp legacy row cannot
                # safely be placed in a complete PPO trajectory.
                if "policyMask" in rec:
                    policy_mask = _coerce_binary_flag(rec.get("policyMask"))
                else:
                    policy_mask = True if "logpOld" in rec else None
                if policy_mask is None:
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue

                if policy_mask:
                    behavior_mask = _coerce_behavior_mask(
                        rec.get("behaviorMask"), cands.shape[0]
                    )
                    if behavior_mask is None or not behavior_mask[chosen]:
                        n_invalid_rows += 1
                        invalid_episodes.add(game_id)
                        continue
                    try:
                        logp_old = float(rec["logpOld"])
                        behavior_temperature = float(rec.get("behaviorTemperature", 1.0))
                    except (KeyError, ValueError, TypeError):
                        n_invalid_rows += 1
                        invalid_episodes.add(game_id)
                        continue
                    if (
                        not math.isfinite(logp_old)
                        or not math.isfinite(behavior_temperature)
                        or behavior_temperature <= 0
                    ):
                        n_invalid_rows += 1
                        invalid_episodes.add(game_id)
                        continue
                else:
                    # No behavior distribution exists for a deterministic override. These
                    # placeholders are never consumed by the policy surrogate.
                    behavior_mask = np.ones(cands.shape[0], dtype=bool)
                    behavior_temperature = 1.0
                    logp_old = 0.0

                farm_value, farm_mask = _coerce_unit_target(
                    rec.get("farmValue", rec.get("farm_value"))
                )
                reward_pi, reward_mask = _coerce_policy_target(
                    rec.get("rewardPi", rec.get("reward_pi")), cands.shape[0]
                )
                route_mode, route_mask = _coerce_unit_target(
                    rec.get("routeMode", rec.get("route_mode"))
                )
                placement_probs, placement_prob_mask = _coerce_policy_target(
                    rec.get("placementProbs", rec.get("placement_probs")), 4
                )
                done = _coerce_binary_flag(rec.get("done"))
                if done is None:
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                strategic = _coerce_binary_flag(rec.get("strategic", 0))
                if strategic is None:
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                try:
                    step = {
                        "game_id": game_id,
                        "step_idx": int(rec["stepIdx"]),
                        "r_step": float(rec["rStep"]),
                        "done": done,
                        "policy_mask": policy_mask,
                        "logp_old": logp_old,
                        "behavior_temperature": behavior_temperature,
                        "behavior_mask": behavior_mask,
                        "farm_value": farm_value,
                        "farm_mask": farm_mask,
                        "reward_pi": reward_pi,
                        "reward_mask": reward_mask,
                        "route_mode": route_mode,
                        "route_mask": route_mask,
                        "placement_probs": placement_probs,
                        "placement_prob_mask": placement_prob_mask,
                        "v_pred": float(rec["vPred"]),
                        "placement": _coerce_placement(rec.get("placement")),
                        "won": 1 if rec.get("won") else 0,
                        "all_fallen": 1 if rec.get("allFallen") else 0,
                        "end_round": _coerce_end_round(rec.get("endRound")),
                        "strategic": strategic,
                        "player_count": _coerce_player_count(rec.get("playerCount", 4)),
                        "obs": obs,
                        "cands": cands,
                        "chosen": chosen,
                    }
                except (KeyError, ValueError, TypeError):
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                if (
                    step["step_idx"] < 0
                    or step["player_count"] is None
                    or not all(
                        math.isfinite(step[k])
                        for k in ("r_step", "logp_old", "v_pred", "behavior_temperature")
                    )
                ):
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                episodes.setdefault(game_id, []).append(step)

    for game_id in invalid_episodes:
        episodes.pop(game_id, None)

    # The actor emits contiguous 0..T-1 indices and done only on T-1. Enforce that
    # contract so duplicated shards or a missing terminal override cannot become a
    # superficially valid but temporally spliced episode.
    invalid_structure: set[str] = set()
    for game_id, raw_steps in episodes.items():
        steps = sorted(raw_steps, key=lambda s: s["step_idx"])
        if [s["step_idx"] for s in steps] != list(range(len(steps))):
            invalid_structure.add(game_id)
            continue
        done_indices = [i for i, s in enumerate(steps) if s["done"]]
        if done_indices and done_indices != [len(steps) - 1]:
            invalid_structure.add(game_id)
    for game_id in invalid_structure:
        episodes.pop(game_id, None)

    if not episodes:
        raise ValueError(
            f"No complete PPO trajectories in {data_dir} "
            f"({len(invalid_episodes) + len(invalid_structure)} episode(s) rejected, "
            f"{n_nontrajectory} non-trajectory row(s))"
        )

    obs_list: list[np.ndarray] = []
    cands_list: list[np.ndarray] = []
    chosen_list: list[int] = []
    policy_mask_list: list[bool] = []
    logp_old_list: list[float] = []
    behavior_temperature_list: list[float] = []
    behavior_mask_list: list[np.ndarray] = []
    v_pred_list: list[float] = []
    farm_value_list: list[float] = []
    farm_mask_list: list[bool] = []
    reward_pi_list: list[np.ndarray] = []
    reward_mask_list: list[bool] = []
    route_mode_list: list[float] = []
    route_mask_list: list[bool] = []
    placement_list: list[int] = []
    placement_probs_list: list[np.ndarray] = []
    placement_prob_mask_list: list[bool] = []
    strategic_mask_list: list[bool] = []
    adv_list: list[np.ndarray] = []
    ret_list: list[np.ndarray] = []
    n_truncated = 0
    n_with_placement = 0
    n_outcome_credit = 0

    for game_id in sorted(episodes):
        steps = sorted(episodes[game_id], key=lambda s: s["step_idx"])
        rewards = np.array([s["r_step"] for s in steps], dtype=np.float64)
        values = np.array([s["v_pred"] for s in steps], dtype=np.float64)
        dones = np.array([s["done"] for s in steps], dtype=bool)

        placement = None
        end_round = None
        player_count = steps[0]["player_count"]
        if any(s["player_count"] != player_count for s in steps):
            raise ValueError(f"Episode {game_id} mixes playerCount values")
        for s in steps:
            if s["placement"] is not None:
                placement = s["placement"]
            if s["end_round"] is not None:
                end_round = s["end_round"]
        if dones[-1]:
            # All-Fallen collapse (driver stamps allFallen=1 on EVERY seat's done row when the game
            # ended via mutual corruption with no 30-VP finish): a uniform LOSS terminal for every
            # seat, REPLACING the placement reward — so racing to Fallen (and assassinating a
            # non-corruptor to force the ending) pays nothing to anyone. all_fallen_loss < 0; 0 = off
            # (normal placement). dense ΔVP and win_bonus are untouched.
            if all_fallen_loss and any(s["all_fallen"] for s in steps):
                rewards[-1] += all_fallen_loss
            elif placement is not None and player_count > 1:
                rewards[-1] += placement_rewards[placement - 1]
                n_with_placement += 1
            # True 30-VP win (driver stamps won=1 only on target-VP finishes, never cap/all-Fallen):
            # the explicit "win the game" incentive on top of placement. Never fires on a collapse.
            if win_bonus and any(s["won"] for s in steps):
                bonus = win_bonus
                # Tempo decay: with a halflife R, a win at round 12-or-earlier pays the full bonus
                # and every R rounds later halves it (round 20 -> 0.5x, 28 -> 0.25x at R=8). Off (0)
                # = flat bonus. Rounds before 12 are not amplified (max(0, ...)).
                if win_bonus_halflife > 0 and end_round is not None:
                    bonus *= 0.5 ** (max(0, end_round - 12) / win_bonus_halflife)
                rewards[-1] += bonus

        if dones[-1]:
            last_value = 0.0
        else:
            # Truncated episode (no terminal row): bootstrap V(s_{T+1}) with the
            # last recorded vPred — the best available proxy; keeps truncated
            # tails from reading as artificial zero-return endings.
            last_value = float(values[-1])
            n_truncated += 1

        adv, ret = compute_gae(rewards, values, dones, gamma, gae_lambda, last_value)
        strategic = np.array([s["strategic"] for s in steps], dtype=bool)
        # Only completed episodes have a realized complete-game outcome. Truncated rows retain
        # ordinary GAE instead of pretending the actor's tail bootstrap is a terminal result.
        # When an explicit solo coefficient is set it owns solo rows; the legacy/global knob
        # continues to cover every player count otherwise.
        standard_strategic = (
            strategic & (player_count > 1)
            if solo_strategic_mc_coef > 0
            else strategic
        )
        if strategic_mc_coef > 0 and dones[-1] and standard_strategic.any():
            mc_ret = compute_discounted_returns(
                rewards, dones, strategic_mc_gamma, last_value=0.0
            )
            mc_adv = mc_ret - values
            adv[standard_strategic] = (
                (1.0 - strategic_mc_coef) * adv[standard_strategic]
                + strategic_mc_coef * mc_adv[standard_strategic]
            )
            ret[standard_strategic] = (
                (1.0 - strategic_mc_coef) * ret[standard_strategic]
                + strategic_mc_coef * mc_ret[standard_strategic]
            )
        # Solo has no meaningful placement ordering: it is always first by definition. Use the
        # actual episode reward (dense score progress + true 30-VP win bonus) for long-horizon
        # engine decisions instead. This can coexist with multiplayer-only outcome credit.
        if solo_strategic_mc_coef > 0 and player_count == 1 and dones[-1] and strategic.any():
            solo_ret = compute_discounted_returns(
                rewards, dones, strategic_mc_gamma, last_value=0.0
            )
            solo_adv = solo_ret - values
            adv[strategic] = (
                (1.0 - solo_strategic_mc_coef) * adv[strategic]
                + solo_strategic_mc_coef * solo_adv[strategic]
            )
            ret[strategic] = (
                (1.0 - solo_strategic_mc_coef) * ret[strategic]
                + solo_strategic_mc_coef * solo_ret[strategic]
            )
        # Pure long-horizon outcome credit. Unlike strategic MC, this deliberately excludes
        # dense VP, build shaping, and the tactical value target: navigation receives only the
        # realized placement consequence, baselined by the behavior checkpoint's separately
        # trained placement head. The ordinary value head remains a short-horizon GAE critic.
        if (
            strategic_outcome_coef > 0
            and player_count > 1
            and dones[-1]
            and placement is not None
            and strategic.any()
        ):
            outcome_target = (
                min(placement_rewards)
                if any(s["all_fallen"] for s in steps)
                else placement_rewards[placement - 1]
            )
            outcome_mask = strategic & np.array(
                [s["placement_prob_mask"] for s in steps], dtype=bool
            )
            if outcome_mask.any():
                behavior_outcome = np.array(
                    [
                        float(np.dot(s["placement_probs"], placement_rewards))
                        for s in steps
                    ],
                    dtype=np.float64,
                )
                outcome_adv = outcome_target - behavior_outcome
                adv[outcome_mask] = (
                    (1.0 - strategic_outcome_coef) * adv[outcome_mask]
                    + strategic_outcome_coef * outcome_adv[outcome_mask]
                )
                n_outcome_credit += int(outcome_mask.sum())
        for s in steps:
            obs_list.append(s["obs"])
            cands_list.append(s["cands"])
            chosen_list.append(s["chosen"])
            policy_mask_list.append(s["policy_mask"])
            logp_old_list.append(s["logp_old"])
            behavior_temperature_list.append(s["behavior_temperature"])
            behavior_mask_list.append(s["behavior_mask"])
            v_pred_list.append(s["v_pred"])
            farm_value_list.append(s["farm_value"])
            farm_mask_list.append(s["farm_mask"])
            reward_pi_list.append(s["reward_pi"])
            reward_mask_list.append(s["reward_mask"])
            route_mode_list.append(s["route_mode"])
            route_mask_list.append(s["route_mask"])
            placement_list.append(placement if placement is not None and player_count > 1 else 0)
            placement_probs_list.append(s["placement_probs"])
            placement_prob_mask_list.append(s["placement_prob_mask"])
            strategic_mask_list.append(s["strategic"])
        adv_list.append(adv)
        ret_list.append(ret)

    advantages = np.concatenate(adv_list).astype(np.float32)
    returns = np.concatenate(ret_list).astype(np.float32)
    print(
        f"Loaded {len(cands_list)} PPO steps from {len(episodes)} game(s) "
        f"({sum(policy_mask_list)} exact policy step(s), "
        f"{n_with_placement} with terminal placement reward, {n_truncated} truncated, "
        f"{sum(farm_mask_list)} with farmValue, {sum(reward_mask_list)} with rewardPi, "
        f"{sum(route_mask_list)} with routeMode, "
        f"{sum(strategic_mask_list)} strategic (MC coef={strategic_mc_coef:g}, "
        f"solo MC coef={solo_strategic_mc_coef:g}, gamma={strategic_mc_gamma:g}; "
        f"outcome coef={strategic_outcome_coef:g}, "
        f"applied={n_outcome_credit}), "
        f"{len(invalid_episodes) + len(invalid_structure)} malformed episode(s) rejected, "
        f"{n_invalid_rows} malformed row(s), {n_nontrajectory} non-trajectory row(s), "
        f"{n_missing_obs} missing {obs_key!r})"
    )
    return TrajectoryBuffer(
        obs=np.stack(obs_list),
        cands=cands_list,
        chosen=np.array(chosen_list, dtype=np.int64),
        policy_mask=np.array(policy_mask_list, dtype=bool),
        logp_old=np.array(logp_old_list, dtype=np.float32),
        behavior_temperature=np.array(behavior_temperature_list, dtype=np.float32),
        behavior_mask=behavior_mask_list,
        v_pred=np.array(v_pred_list, dtype=np.float32),
        advantages=advantages,
        returns=returns,
        strategic_mask=np.array(strategic_mask_list, dtype=bool),
        strategic_mc_coef=float(strategic_mc_coef),
        solo_strategic_mc_coef=float(solo_strategic_mc_coef),
        strategic_outcome_coef=float(strategic_outcome_coef),
        placement_probs=np.stack(placement_probs_list),
        placement_prob_mask=np.array(placement_prob_mask_list, dtype=bool),
        farm_value=np.array(farm_value_list, dtype=np.float32),
        farm_mask=np.array(farm_mask_list, dtype=bool),
        reward_pi=reward_pi_list,
        reward_mask=np.array(reward_mask_list, dtype=bool),
        route_mode=np.array(route_mode_list, dtype=np.float32),
        route_mask=np.array(route_mask_list, dtype=bool),
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

def normalize_policy_advantages(
    advantages: np.ndarray,
    policy_mask: np.ndarray,
    strategic_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Normalize once over the rollout's exact-policy rows.

    Per-minibatch ``torch.std()`` uses Bessel correction by default and becomes
    NaN for a singleton tail minibatch. Global normalization is also the usual
    PPO contract. If the entire rollout has one policy row, preserve its raw
    advantage so the only valid policy sample still has a learning signal.
    Non-policy entries are zero because they never enter the surrogate.

    When ``strategic_mask`` is supplied, normalize strategic and tactical policy
    rows independently. Full-episode strategic returns have intentionally higher
    variance; group normalization prevents either population from washing out the
    other's policy gradient. Omitting the mask preserves historical bit behavior.
    """
    advantages = np.asarray(advantages, dtype=np.float32)
    policy_mask = np.asarray(policy_mask, dtype=bool)
    out = np.zeros_like(advantages, dtype=np.float32)

    def normalize_group(mask: np.ndarray) -> None:
        values = advantages[mask]
        if values.size == 0:
            return
        if values.size == 1:
            out[mask] = values
            return
        centered = values - values.mean()
        std = float(values.std(ddof=0))
        out[mask] = centered / (std + 1e-8) if std > 0 else centered

    if strategic_mask is None:
        normalize_group(policy_mask)
    else:
        strategic_mask = np.asarray(strategic_mask, dtype=bool)
        if strategic_mask.shape != policy_mask.shape:
            raise ValueError("strategic_mask and policy_mask must have the same shape")
        normalize_group(policy_mask & strategic_mask)
        normalize_group(policy_mask & ~strategic_mask)
    return out


def _minibatch_tensors(
    buffer: TrajectoryBuffer,
    idx: np.ndarray,
    device: torch.device,
    normalized_advantages: np.ndarray,
) -> tuple[torch.Tensor, ...]:
    """Pad the candidate lists of the selected steps to a common length."""
    B = len(idx)
    max_cands = max(buffer.cands[i].shape[0] for i in idx)
    act_dim = buffer.cands[idx[0]].shape[1]
    cands = np.zeros((B, max_cands, act_dim), dtype=np.float32)
    candidate_mask = np.zeros((B, max_cands), dtype=bool)
    behavior_mask = np.zeros((B, max_cands), dtype=bool)
    reward_pi = np.zeros((B, max_cands), dtype=np.float32)
    for j, i in enumerate(idx):
        c = buffer.cands[i]
        cands[j, : c.shape[0]] = c
        candidate_mask[j, : c.shape[0]] = True
        behavior_mask[j, : c.shape[0]] = buffer.behavior_mask[i]
        reward_pi[j, : c.shape[0]] = buffer.reward_pi[i]
    return (
        torch.from_numpy(buffer.obs[idx]).to(device),
        torch.from_numpy(cands).to(device),
        torch.from_numpy(candidate_mask).to(device),
        torch.from_numpy(behavior_mask).to(device),
        torch.from_numpy(buffer.chosen[idx]).to(device),
        torch.from_numpy(buffer.policy_mask[idx]).to(device),
        torch.from_numpy(buffer.logp_old[idx]).to(device),
        torch.from_numpy(buffer.behavior_temperature[idx]).to(device),
        torch.from_numpy(buffer.v_pred[idx]).to(device),
        torch.from_numpy(normalized_advantages[idx]).to(device),
        torch.from_numpy(buffer.returns[idx]).to(device),
        torch.from_numpy(buffer.strategic_mask[idx]).to(device),
        torch.from_numpy(buffer.farm_value[idx]).to(device),
        torch.from_numpy(buffer.farm_mask[idx]).to(device),
        torch.from_numpy(reward_pi).to(device),
        torch.from_numpy(buffer.reward_mask[idx]).to(device),
        torch.from_numpy(buffer.route_mode[idx]).to(device),
        torch.from_numpy(buffer.route_mask[idx]).to(device),
        torch.from_numpy(buffer.placement[idx]).to(device),
    )


def behavior_log_probs(
    logits: torch.Tensor,
    behavior_mask: torch.Tensor,
    behavior_temperature: torch.Tensor,
) -> torch.Tensor:
    """Apply the actor's exact support and per-row sampling temperature.

    This transformation is shared by PPO ratios, entropy, KL anchoring, and the
    ratio-at-rollout-start invariant tests.
    """
    scaled = logits / behavior_temperature.unsqueeze(1)
    scaled = scaled.masked_fill(~behavior_mask, float("-inf"))
    return F.log_softmax(scaled, dim=-1)


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
    farm_value_coef: float = 0.0,
    reward_pick_coef: float = 0.0,
    route_mode_coef: float = 0.0,
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
    normalized_advantages = normalize_policy_advantages(
        buffer.advantages,
        buffer.policy_mask,
        buffer.strategic_mask
        if (
            buffer.strategic_mc_coef > 0
            or buffer.solo_strategic_mc_coef > 0
            or buffer.strategic_outcome_coef > 0
        )
        else None,
    )
    n_policy_total = int(buffer.policy_mask.sum())
    if policy_coef > 0 and n_policy_total == 0:
        print(
            "WARNING: PPO policy coefficient is nonzero but the rollout has no "
            "policyMask=1 rows; training value/auxiliary heads only",
            file=sys.stderr,
        )
    if route_mode_coef > 0 and not bool(buffer.route_mask.any()):
        print(
            "WARNING: route_mode_coef is nonzero but the rollout contains no routeMode "
            "labels; the route auxiliary head receives no training signal",
            file=sys.stderr,
        )
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
        tot_farm = tot_reward = tot_route = 0.0
        tot_placement = 0.0
        tot_kl_ref = 0.0
        tot_strategic_value = tot_tactical_value = 0.0
        n_seen = 0
        n_policy_seen = 0
        n_strategic_seen = n_tactical_seen = 0
        stop = False

        for start in range(0, n, batch_size):
            mb = indices[start : start + batch_size]
            (
                obs,
                cands,
                candidate_mask,
                behavior_mask,
                chosen,
                policy_mask,
                logp_old,
                behavior_temperature,
                v_pred,
                adv,
                ret,
                strategic_mask,
                farm_value,
                farm_mask,
                reward_pi,
                reward_mask,
                route_mode,
                route_mask,
                placement,
            ) = _minibatch_tensors(buffer, mb, device, normalized_advantages)

            logits, _, value = model(obs, cands, behavior_mask)
            log_probs = behavior_log_probs(logits, behavior_mask, behavior_temperature)
            probs = log_probs.exp()
            logp_new = log_probs.gather(1, chosen.unsqueeze(1)).squeeze(1)
            log_ratio = (logp_new - logp_old).clamp(-20.0, 20.0)
            ratio = log_ratio.exp()

            policy_count = int(policy_mask.sum().item())
            if policy_count:
                with torch.no_grad():
                    # k3 estimator of KL(old || new): nonnegative, low variance.
                    approx_kl = (
                        (ratio[policy_mask] - 1.0) - log_ratio[policy_mask]
                    ).mean().item()
                    clip_frac = (
                        (ratio[policy_mask] - 1.0).abs() > clip_eps
                    ).float().mean().item()
                surr1 = ratio[policy_mask] * adv[policy_mask]
                surr2 = ratio[policy_mask].clamp(
                    1.0 - clip_eps, 1.0 + clip_eps
                ) * adv[policy_mask]
                policy_loss = -torch.min(surr1, surr2).mean()
            else:
                approx_kl = 0.0
                clip_frac = 0.0
                policy_loss = torch.zeros((), dtype=torch.float32, device=device)
            if target_kl is not None and policy_count and approx_kl > target_kl:
                print(
                    f"  PPO early stop in epoch {epoch}: "
                    f"approx_kl={approx_kl:.4f} > target_kl={target_kl}"
                )
                stop = True
                break

            if value_clip_eps > 0:
                v_clipped = v_pred + (value - v_pred).clamp(-value_clip_eps, value_clip_eps)
                value_loss = torch.max((value - ret) ** 2, (v_clipped - ret) ** 2).mean()
            else:
                value_loss = F.mse_loss(value, ret)

            # Diagnostics split by credit group. These do not change the loss; they make noisy
            # strategic Monte Carlo targets visible instead of hiding them in one global MSE.
            value_sqerr = (value - ret) ** 2
            strategic_count = int(strategic_mask.sum().item())
            tactical_count = int((~strategic_mask).sum().item())
            strategic_value_loss = (
                value_sqerr[strategic_mask].mean().item() if strategic_count else 0.0
            )
            tactical_value_loss = (
                value_sqerr[~strategic_mask].mean().item() if tactical_count else 0.0
            )

            # Entropy over the actor's exact post-filter support only. Do not form
            # `0 * -inf` on filtered candidates and then hide it with torch.where:
            # the forward value looks finite, but autograd can still propagate a
            # NaN from the unselected branch (and the finite-weight guard then
            # restores the entire update). Mask log-probs to a finite value before
            # multiplying so both the forward and backward graphs are finite.
            support_log_probs = log_probs.masked_fill(~behavior_mask, 0.0)
            plogp = probs * support_log_probs
            entropy_per_row = -plogp.sum(dim=-1)
            entropy = (
                entropy_per_row[policy_mask].mean()
                if policy_count
                else torch.zeros((), dtype=torch.float32, device=device)
            )

            kl_ref = torch.zeros((), dtype=torch.float32, device=device)
            if ref_model is not None:
                with torch.no_grad():
                    ref_logits, _, _ = ref_model(obs, cands, behavior_mask)
                    ref_logp = behavior_log_probs(
                        ref_logits, behavior_mask, behavior_temperature
                    )
                # KL(new || ref) over legal candidates only.
                # As above, avoid `-inf - -inf` on candidates excluded from the
                # behavior support. Mask each operand before the subtraction so
                # the inactive branch never contains a NaN in the autograd graph.
                support_ref_logp = ref_logp.masked_fill(~behavior_mask, 0.0)
                kl_terms = probs * (support_log_probs - support_ref_logp)
                kl_ref_per_row = kl_terms.sum(dim=-1)
                kl_ref = (
                    kl_ref_per_row[policy_mask].mean()
                    if policy_count
                    else torch.zeros((), dtype=torch.float32, device=device)
                )

            farm_loss = torch.zeros((), dtype=torch.float32, device=device)
            if farm_value_coef > 0 and farm_mask.any():
                pred_farm = model.farm_value(obs)
                farm_loss = F.mse_loss(pred_farm[farm_mask], farm_value[farm_mask])

            reward_loss = torch.zeros((), dtype=torch.float32, device=device)
            if reward_pick_coef > 0 and reward_mask.any():
                reward_logits = model.reward_pick_logits(obs, cands, candidate_mask)
                reward_log_probs = F.log_softmax(reward_logits, dim=-1)
                reward_per_row = -(reward_pi * reward_log_probs).sum(dim=-1)
                reward_loss = reward_per_row[reward_mask].mean()

            route_loss = torch.zeros((), dtype=torch.float32, device=device)
            if route_mode_coef > 0 and route_mask.any():
                route_logits = model.route_mode_logits(obs)
                route_loss = F.binary_cross_entropy_with_logits(
                    route_logits[route_mask], route_mode[route_mask]
                )

            placement_loss = torch.zeros((), dtype=torch.float32, device=device)
            if use_placement:
                placement_loss = placement_aux_loss(model, obs, placement, placement > 0)
            elif use_placement_v1:
                placement_loss = placement_aux_loss_v1(model, obs, placement, placement > 0)

            loss = (
                policy_coef * policy_loss
                + value_coef * value_loss
                + farm_value_coef * farm_loss
                + reward_pick_coef * reward_loss
                + route_mode_coef * route_loss
                - ent_coef * entropy
                + placement_coef * placement_loss
                + kl_ref_coef * kl_ref
            )
            optimizer.zero_grad()
            loss.backward()
            if max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
            optimizer.step()
            if not model_parameters_are_finite(model):
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
            n_policy_seen += policy_count
            tot_policy += policy_loss.item() * policy_count
            tot_value += value_loss.item() * bs
            tot_farm += farm_loss.item() * bs
            tot_reward += reward_loss.item() * bs
            tot_route += route_loss.item() * bs
            tot_entropy += entropy.item() * policy_count
            tot_kl += approx_kl * policy_count
            tot_clip += clip_frac * policy_count
            if policy_count:
                tot_prob += (
                    logp_new.detach().exp()[policy_mask].mean().item() * policy_count
                )
            tot_placement += placement_loss.item() * bs
            tot_kl_ref += kl_ref.item() * policy_count
            tot_strategic_value += strategic_value_loss * strategic_count
            tot_tactical_value += tactical_value_loss * tactical_count
            n_strategic_seen += strategic_count
            n_tactical_seen += tactical_count

        if halted:
            break
        if n_seen:
            policy_denom = max(1, n_policy_seen)
            print(
                f"PPO epoch {epoch}/{epochs} | "
                f"policy_loss={tot_policy / policy_denom:.4f} | "
                f"value_loss={tot_value / n_seen:.4f} | "
                f"strategic_value_loss={tot_strategic_value / max(1, n_strategic_seen):.4f} "
                f"(n={n_strategic_seen}) | "
                f"tactical_value_loss={tot_tactical_value / max(1, n_tactical_seen):.4f} "
                f"(n={n_tactical_seen}) | "
                f"farm_value_loss={tot_farm / n_seen:.4f} | "
                f"reward_pick_loss={tot_reward / n_seen:.4f} | "
                f"route_mode_loss={tot_route / n_seen:.4f} | "
                f"entropy={tot_entropy / policy_denom:.4f} (coef={ent_coef:.4f}) | "
                f"approx_kl={tot_kl / policy_denom:.4f} | "
                f"clip_frac={tot_clip / policy_denom:.3f} | "
                f"placement_loss={tot_placement / n_seen:.4f} | "
                f"kl_ref={tot_kl_ref / policy_denom:.4f} | "
                f"mean_p_chosen={tot_prob / policy_denom:.3f} | "
                f"policy_steps={n_policy_seen}/{n_seen}"
            )
            history.append({
                "policy_loss": tot_policy / policy_denom,
                "value_loss": tot_value / n_seen,
                "strategic_value_loss": tot_strategic_value / max(1, n_strategic_seen),
                "tactical_value_loss": tot_tactical_value / max(1, n_tactical_seen),
                "strategic_steps": n_strategic_seen,
                "tactical_steps": n_tactical_seen,
                "farm_value_loss": tot_farm / n_seen,
                "reward_pick_loss": tot_reward / n_seen,
                "route_mode_loss": tot_route / n_seen,
                "entropy": tot_entropy / policy_denom,
                "approx_kl": tot_kl / policy_denom,
                "clip_frac": tot_clip / policy_denom,
                "placement_loss": tot_placement / n_seen,
                "kl_ref": tot_kl_ref / policy_denom,
                "mean_p_chosen": tot_prob / policy_denom,
                "policy_steps": n_policy_seen,
                "total_steps": n_seen,
            })
            last_finite = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        if stop:
            break
    return history
