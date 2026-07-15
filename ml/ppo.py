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
import os
import pickle
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from model import CandidateScorer, model_parameters_are_finite

DEFAULT_PLACEMENT_REWARDS = "1.0,0.3,-0.3,-1.0"
TERMINAL_TEACHER_MAX_ROWS = 4_096
SOLO_TERMINAL_OBJECTIVES = ("legacy", "resolved", "lexicographic")
SOLO_OBJECTIVE_HORIZON = 30
SOLO_VP_TARGET = 30


# ---------------------------------------------------------------------------
# Rewards / advantages
# ---------------------------------------------------------------------------

def parse_placement_rewards(spec: str) -> tuple[float, float, float, float]:
    """Parse "r1,r2,r3,r4" into the terminal reward for placements 1-4."""
    vals = tuple(float(x) for x in spec.split(","))
    if len(vals) != 4:
        raise ValueError(f"--placement-rewards needs 4 comma-separated floats, got {spec!r}")
    return vals  # type: ignore[return-value]


def solo_lexicographic_terminal_reward(
    *, won: bool, finish_round: int | None, final_vp: int
) -> float:
    """Order-preserving scalarization of the solo objective.

    Primary: reach 30 by round 30. Secondary among wins: finish earlier. Tertiary:
    final VP margin. The constants are chosen so the full margin span (0.000998)
    cannot outweigh one round (0.001), and every secondary term together is far
    smaller than the unit win/loss gap.
    """
    if isinstance(final_vp, bool) or not isinstance(final_vp, int) or final_vp < 0:
        raise ValueError("lexicographic solo objective requires a nonnegative integer finalVP")
    if won:
        if (
            isinstance(finish_round, bool)
            or not isinstance(finish_round, int)
            or not 1 <= finish_round <= SOLO_OBJECTIVE_HORIZON
        ):
            raise ValueError(
                "lexicographic solo win requires finish round in "
                f"[1,{SOLO_OBJECTIVE_HORIZON}]"
            )
        tempo = SOLO_OBJECTIVE_HORIZON + 1 - finish_round
    else:
        tempo = 0
    margin = max(-499, min(499, final_vp - SOLO_VP_TARGET))
    return float(won) + 0.001 * tempo + 0.000001 * margin


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

SELF_IMITATION_PHASES = ("route", "build", "convert", "yield")
SELF_IMITATION_PHASE_QUOTAS = {
    "route": 0.25,
    "build": 0.35,
    "convert": 0.30,
    "yield": 0.10,
}
_SELF_IMITATION_YIELD_TYPES = {
    "endLocationActions",
    "commitBenefits",
    "commitAwakening",
    "commitCleanup",
    "passEncounter",
}
_SELF_IMITATION_ROUTE_TYPES = {"lockNavigation", "selectNavigationDestination"}
_SELF_IMITATION_BUILD_TYPES = {
    "resolveLocationInteraction",
    "spawnHandSpirit",
    "absorbSpirit",
    "placeAugmentOnSpirit",
    "discardSpirit",
    "discardRune",
    "discardUnplacedAugments",
}


def self_imitation_phase(decision_type: str) -> str:
    """Coarse strategy-cycle phase used for replay quotas and diagnostics."""
    if decision_type in _SELF_IMITATION_YIELD_TYPES:
        return "yield"
    if decision_type in _SELF_IMITATION_ROUTE_TYPES:
        return "route"
    if decision_type in _SELF_IMITATION_BUILD_TYPES:
        return "build"
    return "convert"


@dataclass
class SelfImitationReplay:
    """Winning-decision demonstrations kept outside PPO's ratio/value tensors.

    ``weight`` is normalized to one within each source episode and phase. The
    replay objective normalizes each sampled phase independently before applying
    ``SELF_IMITATION_PHASE_QUOTAS`` exactly once. It is masked chosen-action CE
    only; none of these fields can be consumed by GAE, the clipped surrogate, or
    the value loss.
    """

    obs: np.ndarray
    cands: list[np.ndarray]
    chosen: np.ndarray
    behavior_mask: list[np.ndarray]
    logp_old: np.ndarray
    behavior_temperature: np.ndarray
    weight: np.ndarray
    phase: np.ndarray
    generation: np.ndarray
    row_key: list[str]

    def __len__(self) -> int:
        return len(self.cands)


@dataclass
class TerminalTeacherReplay:
    """Fixed offline terminal-rollout targets for ambiguous reward choices.

    This dataset is deliberately separate from the on-policy trajectory buffer:
    it has no behavior log-probability, advantage, return, value, or reach-30
    target.  It can therefore contribute only a masked categorical policy loss.
    """

    obs: np.ndarray
    cands: list[np.ndarray]
    evaluated_mask: list[np.ndarray]
    terminal_pi: list[np.ndarray]
    weight: np.ndarray
    state_id: list[str]
    obs_dim: int
    act_dim: int

    def __len__(self) -> int:
        return len(self.cands)


@dataclass
class OptionEventBuffer:
    """One validated SMDP transition per active policy-controlled seat-round."""

    obs: np.ndarray                 # (M, obs_dim) public round-start observations
    chosen: np.ndarray              # (M,) option ids
    behavior_mask: np.ndarray       # (M, option_dim) exact actor support
    logp_old: np.ndarray            # (M,) exact behavior option log-probability
    v_pred: np.ndarray              # (M,) behavior option-value prediction
    advantages: np.ndarray          # (M,) duration-aware SMDP GAE
    returns: np.ndarray             # (M,) option-value targets
    durations: np.ndarray           # (M,) count of low-level transitions
    rewards: np.ndarray             # (M,) within-interval discounted rewards
    importance_weight: np.ndarray   # (M,) retained under fixed-budget resampling
    game_id: list[str]
    seat: list[str]
    round: np.ndarray
    option_dim: int
    rejected_episodes: int = 0
    support_violations: int = 0

    def __len__(self) -> int:
        return len(self.chosen)

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
    round: np.ndarray               # (N,) int64; public decision round
    continuation_mask: np.ndarray  # (N,) bool; train-only late-state suffix metadata
    strategic_mask: np.ndarray      # (N,) bool; long-horizon credit group
    strategic_mc_coef: float        # loader blend; 0 preserves ordinary PPO bit behavior
    solo_strategic_mc_coef: float   # solo-only full-episode blend; may coexist with PvP outcome
    solo_outcome_coef: float        # pure true-win advantage blend on solo strategic rows
    solo_reach30_coef: float        # true-win minus behavior p30(s) blend on solo strategic rows
    solo_reach30_bands: tuple[tuple[int, float], ...] | None  # optional round-varying blend
    strategic_outcome_coef: float   # pure placement-outcome advantage blend on strategic rows
    placement_probs: np.ndarray     # (N, 4) behavior outcome-head probabilities
    placement_prob_mask: np.ndarray # (N,) bool; behavior checkpoint exposed the outcome head
    reach30_pred: np.ndarray        # (N,) behavior checkpoint P(reach30 | state)
    reach30_pred_mask: np.ndarray   # (N,) behavior checkpoint exposed the reach30 head
    reach30_target: np.ndarray      # (N,) final solo true-win label broadcast over the episode
    reach30_target_mask: np.ndarray # (N,) completed solo episode rows only
    reach30_weight: np.ndarray      # (N,) inverse episode length; each solo game has equal weight
    reach30_finish_round: np.ndarray # (N,) positive objective finish round; 0 when unavailable
    reach30_horizon: int | None     # one explicit round cap for all labeled episodes
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
    options: np.ndarray             # (N, option_dim) selected option one-hot
    option_dim: int
    option_events: OptionEventBuffer | None
    option_rejected_episodes: int
    # Optional, default-off auxiliary dataset. It is deliberately separate from
    # every PPO tensor above so replay can never alter ratios or value targets.
    self_imitation: SelfImitationReplay | None = None

    def __len__(self) -> int:
        return len(self.cands)


def apply_observation_feature_cutoff(
    buffer: TrajectoryBuffer,
    cutoff: int,
    terminal_teacher: TerminalTeacherReplay | None = None,
) -> tuple[int, int]:
    """Zero an append-only observation suffix for a compute-matched PPO control.

    Both experiment arms retain the same tensor width and execute this assignment;
    passing the full width masks an empty suffix. Optional self-imitation and terminal-
    teacher observations are masked too so no auxiliary objective can bypass the control.
    """
    if isinstance(cutoff, bool) or not isinstance(cutoff, int):
        raise ValueError("observation feature cutoff must be an integer")
    if buffer.obs.ndim != 2:
        raise ValueError(f"trajectory observations must be rank 2, got {buffer.obs.shape}")
    obs_dim = int(buffer.obs.shape[1])
    if cutoff < 1 or cutoff > obs_dim:
        raise ValueError(
            f"observation feature cutoff must be in [1, {obs_dim}], got {cutoff}"
        )
    buffer.obs[:, cutoff:] = 0.0
    replay = buffer.self_imitation
    if replay is not None:
        if replay.obs.ndim != 2 or replay.obs.shape[1] != obs_dim:
            raise ValueError(
                "self-imitation observation width does not match trajectory observations"
            )
        replay.obs[:, cutoff:] = 0.0
    if terminal_teacher is not None:
        if (
            terminal_teacher.obs.ndim != 2
            or terminal_teacher.obs.shape[1] != obs_dim
            or terminal_teacher.obs_dim != obs_dim
        ):
            raise ValueError(
                "terminal-teacher observation width does not match trajectory observations"
            )
        terminal_teacher.obs[:, cutoff:] = 0.0
    return cutoff, obs_dim


def apply_option_feature_cutoff(
    buffer: TrajectoryBuffer,
    cutoff: int,
) -> tuple[int, int]:
    """Zero an option suffix on every low-level input in both causal arms."""
    if isinstance(cutoff, bool) or not isinstance(cutoff, int):
        raise ValueError("option feature cutoff must be an integer")
    if buffer.options.ndim != 2 or buffer.options.shape[1] != buffer.option_dim:
        raise ValueError("trajectory option tensor is malformed")
    if cutoff < 0 or cutoff > buffer.option_dim:
        raise ValueError(
            f"option feature cutoff must be in [0, {buffer.option_dim}], got {cutoff}"
        )
    buffer.options[:, cutoff:] = 0.0
    return cutoff, buffer.option_dim


_LOW_LEVEL_OPTION_HEADS = (
    ("trunk", "trunk"),
    ("value", "value_head"),
    ("farm_value", "farm_value_head"),
    ("placement", "placement_head"),
    ("reward_pick", "reward_pick_head"),
    ("route_mode", "route_mode_head"),
    ("reach30", "reach30_head"),
)


def audit_low_level_option_columns(
    model: CandidateScorer,
    buffer: TrajectoryBuffer,
    cutoff: int | None,
    *,
    active_heads: set[str] | None = None,
) -> dict[str, list[float]]:
    """Fail closed on the V23 control/treatment causal manipulation.

    The expanded checkpoint starts with exact-zero option columns. The control must
    preserve all of them exactly; a treatment epoch must connect every option that
    actually appears on a low-level row to each active loss head. Options excluded by
    behavior support (solo option 3) must remain exact zero in either arm.
    """
    if model.option_dim == 0:
        if cutoff not in (None, 0):
            raise ValueError("legacy model cannot expose low-level option features")
        return {}
    if cutoff is None:
        return {}
    if cutoff < 0 or cutoff > model.option_dim:
        raise ValueError(
            f"option feature cutoff must be in [0, {model.option_dim}], got {cutoff}"
        )
    if buffer.option_events is None:
        raise ValueError("option-column audit requires validated option events")
    supported = np.any(buffer.option_events.behavior_mask, axis=0)
    observed_low = np.any(buffer.options != 0.0, axis=0)
    active_heads = active_heads or set()
    result: dict[str, list[float]] = {}
    for public_name, attr in _LOW_LEVEL_OPTION_HEADS:
        module = getattr(model, attr)
        first = next(
            (layer for layer in module if isinstance(layer, torch.nn.Linear)), None
        )
        if first is None or first.weight.shape[1] < model.option_dim:
            raise ValueError(f"{public_name} has no valid option-conditioned input layer")
        columns = first.weight[:, -model.option_dim :]
        if not torch.isfinite(columns).all():
            raise FloatingPointError(f"{public_name} option columns became non-finite")
        norms = torch.linalg.vector_norm(columns.detach(), dim=0).cpu().tolist()
        result[public_name] = [float(value) for value in norms]
        if cutoff == 0:
            if torch.count_nonzero(columns).item() != 0:
                raise RuntimeError(
                    f"control invariant failed: {public_name} option columns changed"
                )
            continue
        unsupported_or_masked = (~supported) | (np.arange(model.option_dim) >= cutoff)
        for option_id in np.flatnonzero(unsupported_or_masked):
            if torch.count_nonzero(columns[:, int(option_id)]).item() != 0:
                raise RuntimeError(
                    f"treatment invariant failed: {public_name} unsupported/masked "
                    f"option column {int(option_id)} changed"
                )
        if public_name in active_heads:
            for option_id in np.flatnonzero(observed_low & ~unsupported_or_masked):
                if torch.count_nonzero(columns[:, int(option_id)]).item() == 0:
                    raise RuntimeError(
                        f"treatment differentiation failed: active {public_name} "
                        f"option column {int(option_id)} stayed zero"
                    )
    return result


def compute_smdp_gae(
    reward_sequences: list[np.ndarray] | list[list[float]],
    values,
    dones,
    gamma: float = 0.999,
    lam: float = 0.95,
    last_value: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Duration-aware option GAE over one ordered seat episode.

    R_k = sum_i gamma**i r[k,i]
    delta_k = R_k + gamma**duration V(next) - V(k)
    A_k = delta_k + gamma**duration lambda A_(k+1)
    """
    values = np.asarray(values, dtype=np.float64)
    dones = np.asarray(dones, dtype=bool)
    if len(reward_sequences) != len(values) or dones.shape != values.shape:
        raise ValueError("SMDP rewards, values, and dones must have the same length")
    if not 0 < gamma <= 1 or not 0 <= lam <= 1:
        raise ValueError("SMDP gamma and lambda must be in (0,1] and [0,1]")
    rewards = np.zeros(len(values), dtype=np.float64)
    durations = np.zeros(len(values), dtype=np.int64)
    for k, sequence in enumerate(reward_sequences):
        seq = np.asarray(sequence, dtype=np.float64)
        if seq.ndim != 1 or not np.isfinite(seq).all():
            raise ValueError("every option interval needs a finite one-dimensional reward stream")
        durations[k] = len(seq)
        rewards[k] = float(np.dot(np.power(gamma, np.arange(len(seq))), seq))
    advantages = np.zeros(len(values), dtype=np.float64)
    next_advantage = 0.0
    next_value = float(last_value)
    for k in range(len(values) - 1, -1, -1):
        discount = gamma ** int(durations[k])
        nonterminal = 0.0 if dones[k] else 1.0
        delta = rewards[k] + discount * next_value * nonterminal - values[k]
        next_advantage = delta + discount * lam * nonterminal * next_advantage
        advantages[k] = next_advantage
        next_value = float(values[k])
    return advantages, advantages + values, rewards, durations


def _self_imitation_from_rows(rows: list[dict[str, Any]]) -> SelfImitationReplay | None:
    if not rows:
        return None
    return SelfImitationReplay(
        obs=np.stack([row["obs"] for row in rows]).astype(np.float32, copy=False),
        cands=[np.asarray(row["cands"], dtype=np.float32) for row in rows],
        chosen=np.asarray([row["chosen"] for row in rows], dtype=np.int64),
        behavior_mask=[np.asarray(row["behavior_mask"], dtype=bool) for row in rows],
        logp_old=np.asarray([row["logp_old"] for row in rows], dtype=np.float32),
        behavior_temperature=np.asarray(
            [row["behavior_temperature"] for row in rows], dtype=np.float32
        ),
        weight=np.asarray([row["weight"] for row in rows], dtype=np.float32),
        phase=np.asarray([row["phase"] for row in rows], dtype="U8"),
        generation=np.asarray([row["generation"] for row in rows], dtype=np.int64),
        row_key=[str(row["row_key"]) for row in rows],
    )


def _self_imitation_rows(replay: SelfImitationReplay | None) -> list[dict[str, Any]]:
    if replay is None:
        return []
    return [
        {
            "obs": replay.obs[i],
            "cands": replay.cands[i],
            "chosen": int(replay.chosen[i]),
            "behavior_mask": replay.behavior_mask[i],
            "logp_old": float(replay.logp_old[i]),
            "behavior_temperature": float(replay.behavior_temperature[i]),
            "weight": float(replay.weight[i]),
            "phase": str(replay.phase[i]),
            "generation": int(replay.generation[i]),
            "row_key": replay.row_key[i],
        }
        for i in range(len(replay))
    ]


def _valid_self_imitation_row(row: dict[str, Any]) -> bool:
    try:
        obs = np.asarray(row["obs"], dtype=np.float32)
        cands = np.asarray(row["cands"], dtype=np.float32)
        behavior_mask = np.asarray(row["behavior_mask"], dtype=bool)
        chosen = int(row["chosen"])
        logp_old = float(row["logp_old"])
        temperature = float(row["behavior_temperature"])
        weight = float(row["weight"])
        generation = int(row["generation"])
        phase = str(row["phase"])
        row_key = str(row["row_key"])
    except (KeyError, TypeError, ValueError):
        return False
    return bool(
        obs.ndim == 1
        and cands.ndim == 2
        and cands.shape[0] >= 1
        and behavior_mask.shape == (cands.shape[0],)
        and 0 <= chosen < cands.shape[0]
        and behavior_mask[chosen]
        and behavior_mask.any()
        and np.isfinite(obs).all()
        and np.isfinite(cands).all()
        and math.isfinite(logp_old)
        and math.isfinite(temperature)
        and temperature > 0
        and math.isfinite(weight)
        and weight > 0
        and generation >= 0
        and phase in SELF_IMITATION_PHASES
        and bool(row_key)
    )


def _trim_self_imitation_rows(
    rows: list[dict[str, Any]], max_rows: int
) -> list[dict[str, Any]]:
    """Bound persistence at episode granularity, preserving normalized weights."""
    if len(rows) <= max_rows:
        return rows
    episodes: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        episode_key = str(row["row_key"]).rsplit(":", 1)[0]
        episodes.setdefault(episode_key, []).append(row)
    ordered = sorted(
        episodes.items(),
        key=lambda item: (-max(int(row["generation"]) for row in item[1]), item[0]),
    )
    kept: list[dict[str, Any]] = []
    for _, episode_rows in ordered:
        if len(kept) + len(episode_rows) <= max_rows:
            kept.extend(episode_rows)
    return kept


def load_self_imitation_replay(
    path: Path, *, generation: int, max_age: int
) -> list[dict[str, Any]]:
    """Read a trusted local league replay, rejecting malformed or future rows."""
    if not path.exists():
        return []
    try:
        payload = torch.load(path, map_location="cpu", weights_only=True)
    except (OSError, RuntimeError, ValueError, TypeError, EOFError, pickle.UnpicklingError) as exc:
        print(f"WARNING: ignoring unreadable self-imitation replay {path}: {exc}", file=sys.stderr)
        return []
    if not isinstance(payload, dict) or payload.get("version") != 1:
        print(f"WARNING: ignoring unsupported self-imitation replay {path}", file=sys.stderr)
        return []
    raw_rows = payload.get("rows")
    if not isinstance(raw_rows, list):
        return []
    rows: list[dict[str, Any]] = []
    for raw in raw_rows:
        if not isinstance(raw, dict):
            continue
        # weights_only=True returns tensors for array fields; numpy conversion is safe.
        row = dict(raw)
        if _valid_self_imitation_row(row):
            age = generation - int(row["generation"])
            if 0 <= age <= max_age:
                rows.append(row)
    return rows


def save_self_imitation_replay(path: Path, rows: list[dict[str, Any]]) -> None:
    """Atomically persist tensor-only replay data beside a league lane."""
    path.parent.mkdir(parents=True, exist_ok=True)
    serializable = []
    for row in rows:
        serializable.append(
            {
                **row,
                "obs": torch.from_numpy(np.asarray(row["obs"], dtype=np.float32)),
                "cands": torch.from_numpy(np.asarray(row["cands"], dtype=np.float32)),
                "behavior_mask": torch.from_numpy(
                    np.asarray(row["behavior_mask"], dtype=bool)
                ),
            }
        )
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        torch.save({"version": 1, "rows": serializable}, tmp)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


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


def _coerce_nonnegative_int(raw: Any) -> int | None:
    if (
        isinstance(raw, bool)
        or not isinstance(raw, (int, float))
        or not float(raw).is_integer()
        or int(raw) < 0
    ):
        return None
    return int(raw)


def _coerce_seat(raw: Any) -> str | None:
    if isinstance(raw, bool) or not isinstance(raw, (str, int)):
        return None
    seat = str(raw)
    return seat if seat else None


def load_terminal_teacher_replay(
    source: Path,
    *,
    expected_obs_dim: int | None = None,
    expected_act_dim: int | None = None,
) -> TerminalTeacherReplay:
    """Load the immutable V24 terminal-reward teacher dataset fail-closed.

    A directory contains one or more ``terminal-teacher-*.jsonl`` shards.  A
    direct JSONL path is also accepted for focused audits/tests.  Unlike actor
    files, these labels are not written concurrently, so malformed JSON is an
    error rather than a tolerated partial tail.
    """
    source = Path(source)
    if source.is_dir():
        paths = sorted(
            path
            for path in source.rglob("terminal-teacher-*.jsonl")
            if path.is_file()
        )
    elif source.is_file() and source.suffix == ".jsonl":
        paths = [source]
    else:
        raise FileNotFoundError(
            f"terminal-teacher source {source} is not a JSONL file or directory"
        )
    if not paths:
        raise FileNotFoundError(
            f"No terminal-teacher-*.jsonl files found in {source}"
        )
    if (
        expected_obs_dim is not None
        and (
            isinstance(expected_obs_dim, bool)
            or not isinstance(expected_obs_dim, int)
            or expected_obs_dim <= 0
        )
    ):
        raise ValueError("expected terminal-teacher obs_dim must be positive")
    if (
        expected_act_dim is not None
        and (
            isinstance(expected_act_dim, bool)
            or not isinstance(expected_act_dim, int)
            or expected_act_dim <= 0
        )
    ):
        raise ValueError("expected terminal-teacher act_dim must be positive")

    obs_rows: list[np.ndarray] = []
    cand_rows: list[np.ndarray] = []
    mask_rows: list[np.ndarray] = []
    target_rows: list[np.ndarray] = []
    weights: list[float] = []
    state_ids: list[str] = []
    seen_ids: set[str] = set()
    obs_dim = expected_obs_dim
    act_dim = expected_act_dim

    for path in paths:
        with path.open() as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                context = f"{path}:{line_number}"
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{context}: malformed terminal-teacher JSON") from exc
                if not isinstance(raw, dict):
                    raise ValueError(f"{context}: terminal-teacher row must be an object")
                state_id = raw.get("stateId")
                if not isinstance(state_id, str) or not state_id:
                    raise ValueError(f"{context}: stateId must be a nonempty string")
                if state_id in seen_ids:
                    raise ValueError(f"{context}: duplicate terminal-teacher stateId {state_id!r}")
                try:
                    obs = np.asarray(raw["obs"], dtype=np.float32)
                    cands = np.asarray(raw["cands"], dtype=np.float32)
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError(
                        f"{context}: obs/cands must be finite numeric arrays"
                    ) from exc
                if obs.ndim != 1 or obs.size < 1 or not np.isfinite(obs).all():
                    raise ValueError(f"{context}: obs must be a finite nonempty vector")
                if (
                    cands.ndim != 2
                    or cands.shape[0] < 2
                    or cands.shape[1] < 1
                    or not np.isfinite(cands).all()
                ):
                    raise ValueError(
                        f"{context}: cands must be a finite matrix with at least two rows"
                    )
                if obs_dim is None:
                    obs_dim = int(obs.shape[0])
                if act_dim is None:
                    act_dim = int(cands.shape[1])
                if obs.shape != (obs_dim,):
                    raise ValueError(
                        f"{context}: obs width {obs.shape} does not match ({obs_dim},)"
                    )
                if cands.shape[1] != act_dim:
                    raise ValueError(
                        f"{context}: action width {cands.shape[1]} does not match {act_dim}"
                    )

                mask_raw = raw.get("evaluatedMask")
                evaluated_mask = _coerce_behavior_mask(mask_raw, cands.shape[0])
                if evaluated_mask is None or not isinstance(mask_raw, list):
                    raise ValueError(
                        f"{context}: evaluatedMask must be a nonempty strict binary list"
                    )
                if int(evaluated_mask.sum()) < 2:
                    raise ValueError(
                        f"{context}: evaluatedMask must contain at least two candidates"
                    )
                target_raw = raw.get("terminalPi")
                if not isinstance(target_raw, list) or len(target_raw) != cands.shape[0]:
                    raise ValueError(
                        f"{context}: terminalPi length must match the candidate count"
                    )
                try:
                    target = np.asarray(target_raw, dtype=np.float32)
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"{context}: terminalPi must be numeric") from exc
                if (
                    target.ndim != 1
                    or not np.isfinite(target).all()
                    or np.any(target < 0)
                    or np.any(target[~evaluated_mask] != 0)
                    or np.any(target[evaluated_mask] <= 0)
                ):
                    raise ValueError(
                        f"{context}: terminalPi must be finite, positive exactly on "
                        "evaluatedMask, and zero elsewhere"
                    )
                total = float(target[evaluated_mask].sum(dtype=np.float64))
                if not math.isclose(total, 1.0, rel_tol=0.0, abs_tol=1e-6):
                    raise ValueError(
                        f"{context}: terminalPi must sum to 1 over evaluatedMask, got {total}"
                    )
                weight_raw = raw.get("teacherWeight", 1.0)
                if (
                    isinstance(weight_raw, bool)
                    or not isinstance(weight_raw, (int, float))
                    or not math.isfinite(float(weight_raw))
                    or float(weight_raw) <= 0
                ):
                    raise ValueError(f"{context}: teacherWeight must be finite and positive")

                seen_ids.add(state_id)
                state_ids.append(state_id)
                obs_rows.append(obs)
                cand_rows.append(cands)
                mask_rows.append(evaluated_mask)
                # Remove harmless decimal-rounding drift after the strict sum check.
                target_rows.append((target / total).astype(np.float32, copy=False))
                weights.append(float(weight_raw))
                if len(obs_rows) > TERMINAL_TEACHER_MAX_ROWS:
                    raise ValueError(
                        f"terminal-teacher dataset exceeds V24 cap of "
                        f"{TERMINAL_TEACHER_MAX_ROWS} rows"
                    )

    if not obs_rows or obs_dim is None or act_dim is None:
        raise ValueError(f"terminal-teacher dataset {source} contains no rows")
    return TerminalTeacherReplay(
        obs=np.stack(obs_rows).astype(np.float32, copy=False),
        cands=cand_rows,
        evaluated_mask=mask_rows,
        terminal_pi=target_rows,
        weight=np.asarray(weights, dtype=np.float32),
        state_id=state_ids,
        obs_dim=int(obs_dim),
        act_dim=int(act_dim),
    )


def _read_option_events(
    data_dir: Path, obs_key: str
) -> tuple[dict[str, list[dict]], set[str]]:
    """Read strict high-level events; any malformed member rejects its game."""
    events: dict[str, list[dict]] = {}
    malformed_games: set[str] = set()
    last_round: dict[tuple[str, str], int] = {}
    seen_identity: set[tuple[str, str, int]] = set()
    seen_event_ids: set[str] = set()
    for path in sorted(p for p in data_dir.rglob("options-*.jsonl") if p.is_file()):
        with path.open() as handle:
            for line in handle:
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(raw, dict) or "gameId" not in raw:
                    continue
                game_id = str(raw["gameId"])
                try:
                    obs = np.asarray(raw[obs_key], dtype=np.float32)
                    option_id = _coerce_nonnegative_int(raw.get("optionId"))
                    seat = _coerce_seat(raw.get("seat"))
                    round_index = _coerce_nonnegative_int(raw.get("round"))
                    behavior_mask_raw = raw.get("behaviorMask")
                    behavior_mask = _coerce_behavior_mask(behavior_mask_raw, 4)
                    logp_old = float(raw["logpOld"])
                    value = float(raw["optionVPred"])
                    player_count = _coerce_player_count(raw.get("playerCount"))
                    low_level_decision_count = _coerce_nonnegative_int(
                        raw.get("lowLevelDecisionCount")
                    )
                    event_id = raw.get("eventId")
                    importance_weight = float(raw.get("importanceWeight", 1.0))
                except (KeyError, TypeError, ValueError):
                    malformed_games.add(game_id)
                    continue
                identity = (game_id, seat or "", round_index if round_index is not None else -1)
                expected_support = (
                    np.asarray([True, True, True, False])
                    if player_count == 1
                    else np.ones(4, dtype=bool)
                )
                if (
                    obs.ndim != 1
                    or not np.isfinite(obs).all()
                    or option_id is None
                    or option_id >= 4
                    or seat is None
                    or round_index is None
                    or round_index < 1
                    or behavior_mask is None
                    or not isinstance(behavior_mask_raw, list)
                    or not np.array_equal(behavior_mask, expected_support)
                    or not behavior_mask[option_id]
                    or not math.isfinite(logp_old)
                    or not math.isfinite(value)
                    or player_count is None
                    or low_level_decision_count is None
                    or not isinstance(event_id, str)
                    or not event_id
                    or not math.isfinite(importance_weight)
                    or importance_weight <= 0
                    or identity in seen_identity
                    or event_id in seen_event_ids
                    or round_index <= last_round.get((game_id, seat), 0)
                ):
                    malformed_games.add(game_id)
                    continue
                seen_identity.add(identity)
                seen_event_ids.add(event_id)
                last_round[(game_id, seat)] = round_index
                events.setdefault(game_id, []).append(
                    {
                        "game_id": game_id,
                        "seat": seat,
                        "round": round_index,
                        "obs": obs,
                        "option_id": option_id,
                        "behavior_mask": behavior_mask,
                        "logp_old": logp_old,
                        "v_pred": value,
                        "player_count": player_count,
                        "low_level_decision_count": low_level_decision_count,
                        "importance_weight": importance_weight,
                    }
                )
    for game_id in malformed_games:
        events.pop(game_id, None)
    return events, malformed_games


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
    solo_outcome_coef: float = 0.0,
    solo_reach30_coef: float = 0.0,
    solo_reach30_bands: tuple[tuple[int, float], ...] | None = None,
    solo_terminal_objective: str = "legacy",
    strategic_mc_gamma: float = 1.0,
    strategic_outcome_coef: float = 0.0,
    obs_key: str = "obs",
    collect_self_imitation: bool = False,
    self_imitation_generation: int = 0,
    self_imitation_replay_path: Path | None = None,
    self_imitation_max_age: int = 3,
    self_imitation_max_rows: int = 100_000,
) -> TrajectoryBuffer:
    """Load trajectory rows, group by gameId ordered by stepIdx, and compute
    GAE advantages + returns learner-side.

    obs_key: "obs" (current v1 199-float summary) or "obsV2" (flat arc-obs-v2,
    paired-row contract). A missing/malformed row rejects its entire episode:
    silently dropping one row would move dense rewards, done, and GAE across a
    transition that the learner can no longer represent."""
    if not 0.0 <= strategic_mc_coef <= 1.0:
        raise ValueError("strategic_mc_coef must be in [0, 1]")
    if not 0.0 <= solo_strategic_mc_coef <= 1.0:
        raise ValueError("solo_strategic_mc_coef must be in [0, 1]")
    if not 0.0 <= solo_outcome_coef <= 1.0:
        raise ValueError("solo_outcome_coef must be in [0, 1]")
    if not 0.0 <= solo_reach30_coef <= 1.0:
        raise ValueError("solo_reach30_coef must be in [0, 1]")
    if solo_reach30_coef > 0 and solo_reach30_bands is not None:
        raise ValueError("solo_reach30_coef and solo_reach30_bands are mutually exclusive")
    if solo_reach30_bands is not None:
        # Validate the schedule even for an empty rollout. Coverage is checked once
        # the exact decision rounds are known.
        round_band_coefficients(np.empty(0, dtype=np.int64), solo_reach30_bands)
    if solo_terminal_objective not in SOLO_TERMINAL_OBJECTIVES:
        raise ValueError(
            "solo_terminal_objective must be one of "
            + ", ".join(repr(mode) for mode in SOLO_TERMINAL_OBJECTIVES)
        )
    if not 0.0 <= strategic_mc_gamma <= 1.0:
        raise ValueError("strategic_mc_gamma must be in [0, 1]")
    if not 0.0 <= strategic_outcome_coef <= 1.0:
        raise ValueError("strategic_outcome_coef must be in [0, 1]")
    if strategic_mc_coef > 0 and strategic_outcome_coef > 0:
        raise ValueError("strategic_mc_coef and strategic_outcome_coef are mutually exclusive")
    if solo_outcome_coef > 0 and (
        solo_reach30_coef > 0 or solo_reach30_bands is not None
    ):
        raise ValueError(
            "solo_outcome_coef and solo reach30 credit are mutually exclusive"
        )
    if (
        isinstance(self_imitation_generation, bool)
        or not isinstance(self_imitation_generation, int)
        or self_imitation_generation < 0
    ):
        raise ValueError("self_imitation_generation must be a nonnegative integer")
    if (
        isinstance(self_imitation_max_age, bool)
        or not isinstance(self_imitation_max_age, int)
        or self_imitation_max_age < 0
    ):
        raise ValueError("self_imitation_max_age must be a nonnegative integer")
    if (
        isinstance(self_imitation_max_rows, bool)
        or not isinstance(self_imitation_max_rows, int)
        or self_imitation_max_rows <= 0
    ):
        raise ValueError("self_imitation_max_rows must be a positive integer")
    data_dir = Path(data_dir)
    # Skip the actor pool's games-*.jsonl per-game summaries (no obs/cands keys).
    jsonl_files = sorted(
        p for p in data_dir.rglob("*.jsonl")
        if p.is_file()
        and not p.name.startswith("games-")
        and not p.name.startswith("options-")
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
                reach30_pred, reach30_pred_mask = _coerce_unit_target(
                    rec.get("reach30Pred", rec.get("reach30_pred"))
                )
                reach30_target_raw = rec.get("reach30Target", rec.get("reach30_target"))
                reach30_target = _coerce_binary_flag(reach30_target_raw)
                reach30_horizon_raw = rec.get("reach30Horizon", rec.get("reach30_horizon"))
                reach30_horizon = _coerce_end_round(reach30_horizon_raw)
                objective_done_raw = rec.get("objectiveDone", rec.get("objective_done"))
                objective_done = (
                    _coerce_binary_flag(objective_done_raw)
                    if objective_done_raw is not None
                    else None
                )
                final_vp_raw = rec.get("finalVP", rec.get("final_vp"))
                final_vp = (
                    _coerce_nonnegative_int(final_vp_raw)
                    if final_vp_raw is not None
                    else None
                )
                if (
                    (reach30_target_raw is not None and reach30_target is None)
                    or (reach30_horizon_raw is not None and reach30_horizon is None)
                    or (objective_done_raw is not None and objective_done is None)
                    or (final_vp_raw is not None and final_vp is None)
                ):
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
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
                continuation_curriculum = _coerce_binary_flag(
                    rec.get("continuationCurriculum", 0)
                )
                if continuation_curriculum is None:
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                # Historical/synthetic PPO rows predate the public round field; preserve
                # their bit-compatible default while V32's external auditor requires it.
                decision_round = _coerce_nonnegative_int(rec.get("round", 1))
                if decision_round is None or decision_round < 1:
                    n_invalid_rows += 1
                    invalid_episodes.add(game_id)
                    continue
                raw_option_id = rec.get("optionId")
                if raw_option_id is None:
                    option_id = None
                    option_seat = None
                else:
                    option_id = _coerce_nonnegative_int(raw_option_id)
                    option_seat = _coerce_seat(rec.get("seat"))
                    if (
                        option_id is None
                        or option_id >= 4
                        or option_seat is None
                    ):
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
                        "reach30_pred": reach30_pred,
                        "reach30_pred_mask": reach30_pred_mask,
                        "reach30_target": reach30_target,
                        "reach30_horizon": reach30_horizon,
                        "objective_done": objective_done,
                        "final_vp": final_vp,
                        "v_pred": float(rec["vPred"]),
                        "placement": _coerce_placement(rec.get("placement")),
                        "won": 1 if rec.get("won") else 0,
                        "all_fallen": 1 if rec.get("allFallen") else 0,
                        "end_round": _coerce_end_round(rec.get("endRound")),
                        "strategic": strategic,
                        "decision_type": rec.get("decisionType")
                        if isinstance(rec.get("decisionType"), str)
                        else "",
                        "continuation_curriculum": continuation_curriculum,
                        "player_count": _coerce_player_count(rec.get("playerCount", 4)),
                        "option_id": option_id,
                        "seat": option_seat,
                        "round": decision_round,
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
            continue
        if any(
            s["continuation_curriculum"] != steps[0]["continuation_curriculum"]
            for s in steps
        ):
            invalid_structure.add(game_id)
            continue
        option_presence = [s["option_id"] is not None for s in steps]
        if any(option_presence) and not all(option_presence):
            invalid_structure.add(game_id)
            continue
        # The outcome is post-game training metadata, never an observation. Keep
        # its contract strict: target+horizon are a pair, appear only on the final
        # row, and only belong to a solo trajectory.
        for index, step in enumerate(steps):
            has_target = step["reach30_target"] is not None
            has_horizon = step["reach30_horizon"] is not None
            has_objective_done = step["objective_done"] is not None
            has_final_vp = step["final_vp"] is not None
            if (
                has_target != has_horizon
                or (has_target and index != len(steps) - 1)
                or (has_target and step["player_count"] != 1)
                or has_objective_done != has_final_vp
                or (has_objective_done and step["objective_done"] is not True)
                or (has_objective_done and not has_target)
                or (has_objective_done and index != len(steps) - 1)
                or (has_objective_done and step["player_count"] != 1)
            ):
                invalid_structure.add(game_id)
                break
    for game_id in invalid_structure:
        episodes.pop(game_id, None)

    raw_option_events, malformed_option_event_games = _read_option_events(data_dir, obs_key)
    option_mode = any(
        step["option_id"] is not None
        for raw_steps in episodes.values()
        for step in raw_steps
    )
    option_invalid: set[str] = set()
    if option_mode:
        # An option-enabled generation is one causal dataset. Legacy episodes or
        # unmatched/extra high-level events cannot silently enter low-level PPO.
        for game_id, raw_steps in episodes.items():
            steps = sorted(raw_steps, key=lambda s: s["step_idx"])
            if any(step["option_id"] is None for step in steps):
                option_invalid.add(game_id)
                continue
            low_groups: dict[tuple[str, int], list[dict]] = {}
            for step in steps:
                low_groups.setdefault((step["seat"], step["round"]), []).append(step)
            event_groups = {
                (event["seat"], event["round"]): event
                for event in raw_option_events.get(game_id, [])
            }
            if not set(low_groups).issubset(set(event_groups)):
                option_invalid.add(game_id)
                continue
            for identity, event in event_groups.items():
                if len(low_groups.get(identity, [])) != event["low_level_decision_count"]:
                    option_invalid.add(game_id)
                    break
            if game_id in option_invalid:
                continue
            for identity, group in low_groups.items():
                event = event_groups[identity]
                first = min(group, key=lambda step: step["step_idx"])
                if (
                    any(step["option_id"] != event["option_id"] for step in group)
                    or any(step["player_count"] != event["player_count"] for step in group)
                    or first["obs"].shape != event["obs"].shape
                ):
                    option_invalid.add(game_id)
                    break
        option_invalid.update(set(raw_option_events) - set(episodes))
    elif raw_option_events:
        option_invalid.update(raw_option_events)
    for game_id in option_invalid:
        episodes.pop(game_id, None)
        raw_option_events.pop(game_id, None)
    n_option_rejected = len(malformed_option_event_games | option_invalid)

    if not episodes:
        raise ValueError(
            f"No complete PPO trajectories in {data_dir} "
            f"({len(invalid_episodes) + len(invalid_structure) + n_option_rejected} "
            "episode(s) rejected, "
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
    reach30_pred_list: list[float] = []
    reach30_pred_mask_list: list[bool] = []
    reach30_target_list: list[float] = []
    reach30_target_mask_list: list[bool] = []
    reach30_weight_list: list[float] = []
    reach30_finish_round_list: list[int] = []
    strategic_mask_list: list[bool] = []
    continuation_mask_list: list[bool] = []
    round_list: list[int] = []
    option_id_list: list[int] = []
    adv_list: list[np.ndarray] = []
    ret_list: list[np.ndarray] = []
    solo_outcome_adv_list: list[np.ndarray] = []
    solo_outcome_mask_list: list[np.ndarray] = []
    reach30_adv_list: list[np.ndarray] = []
    reach30_mask_list: list[np.ndarray] = []
    n_truncated = 0
    n_with_placement = 0
    n_outcome_credit = 0
    n_solo_outcome_credit = 0
    n_solo_reach30_credit = 0
    reach30_horizons: set[int] = set()
    self_imitation_current_rows: list[dict[str, Any]] = []
    self_imitation_source_episodes = 0
    option_event_rows: list[dict[str, Any]] = []

    # Batch-mean control variate for the true solo objective. A solo seat is always
    # placement 1 at the round cap, so only the actor's explicit `won` bit (30 VP)
    # is a real success label. Centering by the on-policy batch rate preserves the
    # REINFORCE expectation while sharply reducing variance across 1,024 episodes.
    completed_solo_outcomes = []
    for raw_steps in episodes.values():
        steps = sorted(raw_steps, key=lambda s: s["step_idx"])
        if steps[0]["player_count"] != 1:
            continue
        if steps[-1]["done"]:
            completed_solo_outcomes.append(float(any(s["won"] for s in steps)))
        elif (
            solo_terminal_objective != "legacy"
            and steps[-1]["reach30_target"] is not None
        ):
            completed_solo_outcomes.append(float(steps[-1]["reach30_target"]))
    solo_outcome_baseline = (
        float(np.mean(completed_solo_outcomes)) if completed_solo_outcomes else 0.0
    )
    solo_reach30_active = solo_reach30_coef > 0 or (
        solo_reach30_bands is not None
        and any(coefficient > 0 for _, coefficient in solo_reach30_bands)
    )

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
        resolved_reach30_target = None
        if player_count == 1 and steps[-1]["reach30_target"] is not None:
            resolved_reach30_target = float(steps[-1]["reach30_target"])
            reach30_horizons.add(int(steps[-1]["reach30_horizon"]))
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

        # `done` is the engine terminal bit. A solo round-cap/stall is nevertheless a
        # resolved reach-30 objective. New training can opt into treating that horizon as
        # terminal instead of bootstrapping V(s_T), while legacy runs retain exact behavior.
        learning_dones = dones.copy()
        if solo_terminal_objective != "legacy" and player_count == 1:
            if resolved_reach30_target is None:
                raise ValueError(
                    f"Episode {game_id} has no resolved reach30Target/reach30Horizon "
                    f"required by solo_terminal_objective={solo_terminal_objective!r}"
                )
            learning_dones[-1] = True
            if solo_terminal_objective == "lexicographic":
                horizon = int(steps[-1]["reach30_horizon"])
                final_vp = steps[-1]["final_vp"]
                if horizon != SOLO_OBJECTIVE_HORIZON:
                    raise ValueError(
                        f"Episode {game_id} has reach30Horizon={horizon}; lexicographic "
                        f"superhuman objective requires {SOLO_OBJECTIVE_HORIZON}"
                    )
                if steps[-1]["objective_done"] is not True or final_vp is None:
                    raise ValueError(
                        f"Episode {game_id} lacks objectiveDone=1/finalVP required by "
                        "the lexicographic solo objective"
                    )
                won_objective = bool(resolved_reach30_target)
                if won_objective != (final_vp >= SOLO_VP_TARGET):
                    raise ValueError(
                        f"Episode {game_id} has inconsistent reach30Target={int(won_objective)} "
                        f"and finalVP={final_vp}"
                    )
                rewards.fill(0.0)
                rewards[-1] = solo_lexicographic_terminal_reward(
                    won=won_objective,
                    finish_round=end_round,
                    final_vp=final_vp,
                )

        if learning_dones[-1]:
            last_value = 0.0
        else:
            # Truncated episode (no terminal row): bootstrap V(s_{T+1}) with the
            # last recorded vPred — the best available proxy; keeps truncated
            # tails from reading as artificial zero-return endings.
            last_value = float(values[-1])
            n_truncated += 1

        if option_mode:
            event_lookup = {
                (event["seat"], event["round"]): event
                for event in raw_option_events[game_id]
            }
            for seat in sorted({step["seat"] for step in steps}):
                identities = sorted(
                    {
                        (event["seat"], event["round"])
                        for event in raw_option_events[game_id]
                        if event["seat"] == seat
                    },
                    key=lambda identity: identity[1],
                )
                seat_events = [event_lookup[identity] for identity in identities]
                reward_sequences: list[np.ndarray] = []
                event_dones: list[bool] = []
                for identity in identities:
                    indices_for_round = [
                        index
                        for index, step in enumerate(steps)
                        if (step["seat"], step["round"]) == identity
                    ]
                    reward_sequences.append(rewards[indices_for_round].copy())
                    event_dones.append(
                        bool(learning_dones[indices_for_round].any())
                        if indices_for_round
                        else False
                    )
                option_values = np.asarray(
                    [event["v_pred"] for event in seat_events], dtype=np.float64
                )
                option_last_value = 0.0 if event_dones[-1] else float(option_values[-1])
                option_adv, option_ret, option_rewards, option_durations = compute_smdp_gae(
                    reward_sequences,
                    option_values,
                    np.asarray(event_dones, dtype=bool),
                    gamma=0.999,
                    lam=0.95,
                    last_value=option_last_value,
                )
                for index, event in enumerate(seat_events):
                    option_event_rows.append(
                        {
                            **event,
                            "advantage": option_adv[index],
                            "return": option_ret[index],
                            "reward": option_rewards[index],
                            "duration": option_durations[index],
                        }
                    )

        adv, ret = compute_gae(rewards, values, learning_dones, gamma, gae_lambda, last_value)
        strategic = np.array([s["strategic"] for s in steps], dtype=bool)
        episode_solo_outcome_adv = np.zeros(len(steps), dtype=np.float64)
        episode_solo_outcome_mask = np.zeros(len(steps), dtype=bool)
        episode_reach30_adv = np.zeros(len(steps), dtype=np.float64)
        episode_reach30_mask = np.zeros(len(steps), dtype=bool)
        # Conservative self-imitation source: only a naturally started, complete,
        # non-stalled solo true win. In the actor contract a stalled/capped game has
        # done=false, so a terminal done row is also the explicit non-stall proof.
        if (
            collect_self_imitation
            and player_count == 1
            and learning_dones[-1]
            and any(s["won"] for s in steps)
            and not any(s["continuation_curriculum"] for s in steps)
        ):
            dense_mc_return = compute_discounted_returns(
                rewards, learning_dones, strategic_mc_gamma, last_value=0.0
            )
            dense_mc_advantage = dense_mc_return - values
            episode_rows_by_phase: dict[str, list[dict[str, Any]]] = {
                phase: [] for phase in SELF_IMITATION_PHASES
            }
            for index, s in enumerate(steps):
                decision_type = s["decision_type"]
                is_engine_cycle = bool(s["strategic"]) or decision_type in _SELF_IMITATION_YIELD_TYPES
                if (
                    not decision_type
                    or not is_engine_cycle
                    or not s["policy_mask"]
                    or not s["behavior_mask"][s["chosen"]]
                    or not s["reach30_pred_mask"]
                    or dense_mc_advantage[index] <= 0
                ):
                    continue
                phase = self_imitation_phase(decision_type)
                # Prefer decisions made when the behavior critic still saw meaningful
                # failure risk, while capping both factors against outliers.
                raw_weight = min(float(dense_mc_advantage[index]), 5.0) * max(
                    0.05, min(1.0, 1.0 - float(s["reach30_pred"]))
                )
                if raw_weight <= 0 or not math.isfinite(raw_weight):
                    continue
                episode_rows_by_phase[phase].append(
                    {
                        "obs": s["obs"],
                        "cands": s["cands"],
                        "chosen": s["chosen"],
                        "behavior_mask": s["behavior_mask"],
                        "logp_old": s["logp_old"],
                        "behavior_temperature": s["behavior_temperature"],
                        "weight": raw_weight,
                        "phase": phase,
                        "generation": self_imitation_generation,
                        "row_key": f"{self_imitation_generation}:{game_id}:{s['step_idx']}",
                    }
                )
            present = [phase for phase, rows in episode_rows_by_phase.items() if rows]
            if present:
                self_imitation_source_episodes += 1
                for phase in present:
                    rows = episode_rows_by_phase[phase]
                    raw_total = sum(float(row["weight"]) for row in rows)
                    for row in rows:
                        # Row weights express only within-phase action quality.
                        # The phase mixture belongs in the loss; embedding the
                        # quota here as well would square it after phase-balanced
                        # sampling and make the objective depend on pool size.
                        row["weight"] = float(row["weight"]) / raw_total
                        self_imitation_current_rows.append(row)
        # Only completed episodes have a realized complete-game outcome. Truncated rows retain
        # ordinary GAE instead of pretending the actor's tail bootstrap is a terminal result.
        # When an explicit solo coefficient is set it owns solo rows; the legacy/global knob
        # continues to cover every player count otherwise.
        standard_strategic = (
            strategic & (player_count > 1)
            if solo_strategic_mc_coef > 0
            else strategic
        )
        if strategic_mc_coef > 0 and learning_dones[-1] and standard_strategic.any():
            mc_ret = compute_discounted_returns(
                rewards, learning_dones, strategic_mc_gamma, last_value=0.0
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
        if (
            solo_strategic_mc_coef > 0
            and player_count == 1
            and learning_dones[-1]
            and strategic.any()
        ):
            solo_ret = compute_discounted_returns(
                rewards, learning_dones, strategic_mc_gamma, last_value=0.0
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
        # Pure threshold credit for the actual solo objective P(finalVP >= 30). This
        # deliberately changes only the policy advantage: the ordinary value head
        # continues to predict dense score/build return instead of a mixed-scale target.
        if (
            solo_outcome_coef > 0
            and player_count == 1
            and learning_dones[-1]
            and strategic.any()
        ):
            outcome = float(any(s["won"] for s in steps))
            outcome_adv = outcome - solo_outcome_baseline
            episode_solo_outcome_adv[strategic] = outcome_adv
            episode_solo_outcome_mask[strategic] = True
            n_solo_outcome_credit += int(strategic.sum())
        # State-dependent threshold credit. The actor records p30(s) from the frozen
        # behavior checkpoint, so y30-p30(s) is an action-independent control variate.
        # This is strictly more informative than one batch-wide baseline while keeping
        # the dense-return value target on its original scale.
        if (
            solo_reach30_active
            and resolved_reach30_target is not None
            and strategic.any()
        ):
            outcome = resolved_reach30_target
            behavior_p30 = np.array([s["reach30_pred"] for s in steps], dtype=np.float64)
            p30_mask = strategic & np.array(
                [s["reach30_pred_mask"] for s in steps], dtype=bool
            )
            if p30_mask.any():
                episode_reach30_adv[p30_mask] = outcome - behavior_p30[p30_mask]
                episode_reach30_mask[p30_mask] = True
                n_solo_reach30_credit += int(p30_mask.sum())
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
            reach30_pred_list.append(s["reach30_pred"])
            reach30_pred_mask_list.append(s["reach30_pred_mask"])
            resolved_solo = resolved_reach30_target is not None
            reach30_target_list.append(resolved_reach30_target if resolved_solo else 0.0)
            reach30_target_mask_list.append(resolved_solo)
            reach30_weight_list.append(1.0 / len(steps) if resolved_solo else 0.0)
            reach30_finish_round_list.append(
                int(end_round) if resolved_solo and resolved_reach30_target and end_round else 0
            )
            strategic_mask_list.append(s["strategic"])
            continuation_mask_list.append(s["continuation_curriculum"])
            round_list.append(int(s["round"]))
            option_id_list.append(int(s["option_id"]) if option_mode else 0)
        adv_list.append(adv)
        ret_list.append(ret)
        solo_outcome_adv_list.append(episode_solo_outcome_adv)
        solo_outcome_mask_list.append(episode_solo_outcome_mask)
        reach30_adv_list.append(episode_reach30_adv)
        reach30_mask_list.append(episode_reach30_mask)

    advantages = np.concatenate(adv_list).astype(np.float32)
    returns = np.concatenate(ret_list).astype(np.float32)
    if len(reach30_horizons) > 1:
        raise ValueError(
            "PPO data mixes reach30Horizon values "
            f"{sorted(reach30_horizons)}; train one objective horizon at a time"
        )
    reach30_horizon = next(iter(reach30_horizons), None)
    scheduled_reach30_coefficients = (
        round_band_coefficients(
            np.asarray(round_list, dtype=np.int64), solo_reach30_bands
        )
        if solo_reach30_bands is not None
        else None
    )
    solo_outcome_base_std = 0.0
    solo_outcome_signal_std = 0.0
    if solo_outcome_coef > 0:
        solo_outcome_mask = np.concatenate(solo_outcome_mask_list)
        solo_outcome_advantages = np.concatenate(solo_outcome_adv_list)
        if solo_outcome_mask.any():
            base_component = advantages[solo_outcome_mask].astype(np.float64)
            outcome_component = solo_outcome_advantages[solo_outcome_mask]
            solo_outcome_base_std = float(base_component.std())
            solo_outcome_signal_std = float(outcome_component.std())

            def standardize(component: np.ndarray) -> np.ndarray:
                std = float(component.std())
                if std < 1e-8:
                    return np.zeros_like(component)
                return (component - float(component.mean())) / std

            # Put the requested coefficient on a stable scale. Without separate
            # standardization a 0.25 binary outcome term can become only a few
            # percent of a multi-unit dense+win-bonus Monte Carlo advantage.
            advantages[solo_outcome_mask] = (
                (1.0 - solo_outcome_coef) * standardize(base_component)
                + solo_outcome_coef * standardize(outcome_component)
            ).astype(np.float32)
    elif solo_reach30_active:
        reach30_mask = np.concatenate(reach30_mask_list)
        reach30_advantages = np.concatenate(reach30_adv_list)
        if reach30_mask.any():
            base_component = advantages[reach30_mask].astype(np.float64)
            reach30_component = reach30_advantages[reach30_mask]
            solo_outcome_base_std = float(base_component.std())
            solo_outcome_signal_std = float(reach30_component.std())

            def standardize_reach30(component: np.ndarray) -> np.ndarray:
                std = float(component.std())
                if std < 1e-8:
                    return np.zeros_like(component)
                return (component - float(component.mean())) / std

            reach30_coefficients = (
                np.full(len(round_list), solo_reach30_coef, dtype=np.float64)
                if scheduled_reach30_coefficients is None
                else scheduled_reach30_coefficients
            )[reach30_mask]
            advantages[reach30_mask] = (
                (1.0 - reach30_coefficients) * standardize_reach30(base_component)
                + reach30_coefficients * standardize_reach30(reach30_component)
            ).astype(np.float32)
    self_imitation = None
    if collect_self_imitation:
        persisted_rows = (
            load_self_imitation_replay(
                Path(self_imitation_replay_path),
                generation=self_imitation_generation,
                max_age=self_imitation_max_age,
            )
            if self_imitation_replay_path is not None
            else []
        )
        # A retried generation replaces its own identical keys instead of growing
        # replay. Current rows win so bug-fixed re-recordings cannot retain stale data.
        merged = {str(row["row_key"]): row for row in persisted_rows}
        merged.update({str(row["row_key"]): row for row in self_imitation_current_rows})
        obs_dim = obs_list[0].shape[0]
        act_dim = cands_list[0].shape[1]
        replay_rows = [
            row
            for row in merged.values()
            if _valid_self_imitation_row(row)
            and np.asarray(row["obs"]).shape == (obs_dim,)
            and np.asarray(row["cands"]).ndim == 2
            and np.asarray(row["cands"]).shape[1] == act_dim
            and 0 <= self_imitation_generation - int(row["generation"]) <= self_imitation_max_age
        ]
        replay_rows = _trim_self_imitation_rows(replay_rows, self_imitation_max_rows)
        self_imitation = _self_imitation_from_rows(replay_rows)
        if self_imitation_replay_path is not None:
            save_self_imitation_replay(Path(self_imitation_replay_path), replay_rows)
        phase_counts = {
            phase: sum(row["phase"] == phase for row in replay_rows)
            for phase in SELF_IMITATION_PHASES
        }
        print(
            "Self-imitation replay | "
            f"source_wins={self_imitation_source_episodes} | "
            f"current_rows={len(self_imitation_current_rows)} | "
            f"persisted_rows={len(persisted_rows)} | total_rows={len(replay_rows)} | "
            + " ".join(f"{phase}={phase_counts[phase]}" for phase in SELF_IMITATION_PHASES)
        )
    option_dim = 4 if option_mode else 0
    option_tensor = np.zeros((len(option_id_list), option_dim), dtype=np.float32)
    if option_mode:
        option_tensor[np.arange(len(option_id_list)), np.asarray(option_id_list)] = 1.0
    option_events = None
    if option_mode:
        option_events = OptionEventBuffer(
            obs=np.stack([event["obs"] for event in option_event_rows]),
            chosen=np.asarray([event["option_id"] for event in option_event_rows], dtype=np.int64),
            behavior_mask=np.stack([event["behavior_mask"] for event in option_event_rows]),
            logp_old=np.asarray([event["logp_old"] for event in option_event_rows], dtype=np.float32),
            v_pred=np.asarray([event["v_pred"] for event in option_event_rows], dtype=np.float32),
            advantages=np.asarray([event["advantage"] for event in option_event_rows], dtype=np.float32),
            returns=np.asarray([event["return"] for event in option_event_rows], dtype=np.float32),
            durations=np.asarray([event["duration"] for event in option_event_rows], dtype=np.int64),
            rewards=np.asarray([event["reward"] for event in option_event_rows], dtype=np.float32),
            importance_weight=np.asarray(
                [event["importance_weight"] for event in option_event_rows], dtype=np.float32
            ),
            game_id=[event["game_id"] for event in option_event_rows],
            seat=[event["seat"] for event in option_event_rows],
            round=np.asarray([event["round"] for event in option_event_rows], dtype=np.int64),
            option_dim=option_dim,
            rejected_episodes=n_option_rejected,
            support_violations=0,
        )
    print(
        f"Loaded {len(cands_list)} PPO steps from {len(episodes)} game(s) "
        f"({sum(policy_mask_list)} exact policy step(s), "
        f"{sum(continuation_mask_list)} continuation step(s), "
        f"{n_with_placement} with terminal placement reward, {n_truncated} truncated, "
        f"{sum(farm_mask_list)} with farmValue, {sum(reward_mask_list)} with rewardPi, "
        f"{sum(route_mask_list)} with routeMode, "
        f"{sum(strategic_mask_list)} strategic (MC coef={strategic_mc_coef:g}, "
        f"solo MC coef={solo_strategic_mc_coef:g}, gamma={strategic_mc_gamma:g}; "
        f"solo outcome coef={solo_outcome_coef:g}, reach30 coef={solo_reach30_coef:g}, "
        f"reach30 horizon={reach30_horizon}, reach30 bands={solo_reach30_bands}, "
        f"terminal objective={solo_terminal_objective}, "
        f"baseline={solo_outcome_baseline:.3f}, "
        f"component stds={solo_outcome_base_std:.3f}/{solo_outcome_signal_std:.3f}, "
        f"applied={n_solo_outcome_credit}/{n_solo_reach30_credit}; "
        f"outcome coef={strategic_outcome_coef:g}, "
        f"applied={n_outcome_credit}), "
        f"{len(invalid_episodes) + len(invalid_structure)} malformed episode(s) rejected, "
        f"{n_option_rejected} malformed option episode(s), "
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
        round=np.array(round_list, dtype=np.int64),
        continuation_mask=np.array(continuation_mask_list, dtype=bool),
        strategic_mask=np.array(strategic_mask_list, dtype=bool),
        strategic_mc_coef=float(strategic_mc_coef),
        solo_strategic_mc_coef=float(solo_strategic_mc_coef),
        solo_outcome_coef=float(solo_outcome_coef),
        solo_reach30_coef=float(solo_reach30_coef),
        solo_reach30_bands=solo_reach30_bands,
        strategic_outcome_coef=float(strategic_outcome_coef),
        placement_probs=np.stack(placement_probs_list),
        placement_prob_mask=np.array(placement_prob_mask_list, dtype=bool),
        reach30_pred=np.array(reach30_pred_list, dtype=np.float32),
        reach30_pred_mask=np.array(reach30_pred_mask_list, dtype=bool),
        reach30_target=np.array(reach30_target_list, dtype=np.float32),
        reach30_target_mask=np.array(reach30_target_mask_list, dtype=bool),
        reach30_weight=np.array(reach30_weight_list, dtype=np.float32),
        reach30_finish_round=np.array(reach30_finish_round_list, dtype=np.int64),
        reach30_horizon=reach30_horizon,
        farm_value=np.array(farm_value_list, dtype=np.float32),
        farm_mask=np.array(farm_mask_list, dtype=bool),
        reward_pi=reward_pi_list,
        reward_mask=np.array(reward_mask_list, dtype=bool),
        route_mode=np.array(route_mode_list, dtype=np.float32),
        route_mask=np.array(route_mask_list, dtype=bool),
        placement=np.array(placement_list, dtype=np.int64),
        options=option_tensor,
        option_dim=option_dim,
        option_events=option_events,
        option_rejected_episodes=n_option_rejected,
        self_imitation=self_imitation,
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
    option: torch.Tensor | None = None,
) -> torch.Tensor:
    """4-way CE on CandidateScorer.placement_head for rows carrying placement."""
    if not has_placement.any():
        return torch.zeros((), dtype=torch.float32, device=obs.device)
    selected_option = option[has_placement] if option is not None else None
    logits = model.placement_head_logits(obs[has_placement], selected_option)
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


def select_ppo_epoch_indices(
    continuation_mask: np.ndarray,
    rng: np.random.Generator,
    rows_per_epoch: int | None = None,
    continuation_fraction: float | None = None,
) -> np.ndarray:
    """Deterministically select a fixed post-GAE training mixture.

    Complete trajectories remain intact through loading and GAE. Only the optimizer's
    per-epoch row order is capped/stratified, so treatment and control can consume the
    exact same number of rows and minibatches without fabricating terminal transitions.
    """
    continuation_mask = np.asarray(continuation_mask, dtype=bool)
    n = int(continuation_mask.size)
    if rows_per_epoch is None:
        if continuation_fraction is not None:
            raise ValueError("continuation_fraction requires rows_per_epoch")
        indices = np.arange(n)
        rng.shuffle(indices)
        return indices
    if isinstance(rows_per_epoch, bool) or rows_per_epoch <= 0 or rows_per_epoch > n:
        raise ValueError(f"rows_per_epoch must be in [1, {n}], got {rows_per_epoch}")
    if continuation_fraction is None:
        indices = np.arange(n)
        rng.shuffle(indices)
        return indices[:rows_per_epoch]
    if not 0.0 <= continuation_fraction <= 1.0:
        raise ValueError("continuation_fraction must be in [0, 1]")

    target_continuation = int(math.floor(rows_per_epoch * continuation_fraction + 0.5))
    target_normal = rows_per_epoch - target_continuation
    continuation = np.flatnonzero(continuation_mask)
    normal = np.flatnonzero(~continuation_mask)
    if target_continuation > continuation.size or target_normal > normal.size:
        raise ValueError(
            "requested PPO row mixture is unavailable: "
            f"need {target_continuation} continuation/{target_normal} normal rows, "
            f"have {continuation.size}/{normal.size}"
        )
    # Draw fixed child seeds before touching either stratum. This keeps the normal-row
    # permutation identical between a control (zero continuation rows selected) and a
    # treatment using the same trainer seed; continuation sampling cannot advance the
    # normal-row RNG. The third stream only interleaves the already-selected mixture.
    child_seeds = rng.integers(0, np.iinfo(np.uint64).max, size=3, dtype=np.uint64)
    continuation_rng = np.random.default_rng(int(child_seeds[0]))
    normal_rng = np.random.default_rng(int(child_seeds[1]))
    shuffle_rng = np.random.default_rng(int(child_seeds[2]))
    continuation = continuation_rng.permutation(continuation)[:target_continuation]
    normal = normal_rng.permutation(normal)[:target_normal]
    selected = np.concatenate((continuation, normal))
    shuffle_rng.shuffle(selected)
    return selected


def normalized_round_policy_weights(
    rounds: np.ndarray,
    policy_mask: np.ndarray,
    bands: tuple[tuple[int, float], ...] | None,
) -> np.ndarray:
    """Return fixed round-band policy weights normalized over exact-policy rows.

    A ``None`` configuration is the historical control path and returns exact
    float32 ones.  Configured bands are inclusive upper bounds, must be strictly
    increasing, and must cover every selected decision round.  Critic losses do
    not consume these weights.
    """
    rounds = np.asarray(rounds, dtype=np.int64)
    policy_mask = np.asarray(policy_mask, dtype=bool)
    if rounds.shape != policy_mask.shape:
        raise ValueError("rounds and policy_mask must have the same shape")
    if rounds.size and bool((rounds < 1).any()):
        raise ValueError("decision rounds must be positive integers")
    if bands is None:
        return np.ones(rounds.size, dtype=np.float32)
    if not bands:
        raise ValueError("round policy bands cannot be empty")
    previous = 0
    raw = np.zeros(rounds.size, dtype=np.float64)
    for upper, weight in bands:
        if isinstance(upper, bool) or not isinstance(upper, int) or upper <= previous:
            raise ValueError("round policy band upper bounds must be strictly increasing integers")
        if not math.isfinite(weight) or weight <= 0:
            raise ValueError("round policy band weights must be finite and positive")
        raw[(rounds > previous) & (rounds <= upper)] = weight
        previous = upper
    if rounds.size and int(rounds.max()) > previous:
        raise ValueError(
            f"round policy bands end at {previous} but rollout contains round {int(rounds.max())}"
        )
    if not policy_mask.any():
        raise ValueError("round policy weights require at least one exact-policy row")
    mean_weight = float(raw[policy_mask].mean())
    if not math.isfinite(mean_weight) or mean_weight <= 0:
        raise ValueError("round policy weights have nonpositive policy-row mean")
    return (raw / mean_weight).astype(np.float32)


def round_band_coefficients(
    rounds: np.ndarray,
    bands: tuple[tuple[int, float], ...],
) -> np.ndarray:
    """Map positive decision rounds to inclusive, fully covering coefficient bands."""
    rounds = np.asarray(rounds, dtype=np.int64)
    if rounds.ndim != 1:
        raise ValueError("rounds must be one-dimensional")
    if rounds.size and bool((rounds < 1).any()):
        raise ValueError("decision rounds must be positive integers")
    if not bands:
        raise ValueError("round coefficient bands cannot be empty")
    previous = 0
    coefficients = np.zeros(rounds.size, dtype=np.float64)
    for upper, coefficient in bands:
        if isinstance(upper, bool) or not isinstance(upper, int) or upper <= previous:
            raise ValueError(
                "round coefficient band upper bounds must be strictly increasing integers"
            )
        if not math.isfinite(coefficient) or not 0.0 <= coefficient <= 1.0:
            raise ValueError("round coefficient band values must be finite and in [0,1]")
        coefficients[(rounds > previous) & (rounds <= upper)] = coefficient
        previous = upper
    if not any(coefficient > 0 for _, coefficient in bands):
        raise ValueError("round coefficient bands must contain a positive coefficient")
    if rounds.size and int(rounds.max()) > previous:
        raise ValueError(
            f"round coefficient bands end at {previous} but rollout contains round "
            f"{int(rounds.max())}"
        )
    return coefficients


def _minibatch_tensors(
    buffer: TrajectoryBuffer,
    idx: np.ndarray,
    device: torch.device,
    normalized_advantages: np.ndarray,
    round_policy_weights: np.ndarray,
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
        torch.from_numpy(round_policy_weights[idx]).to(device),
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
        torch.from_numpy(buffer.reach30_target[idx]).to(device),
        torch.from_numpy(buffer.reach30_target_mask[idx]).to(device),
        torch.from_numpy(buffer.reach30_weight[idx]).to(device),
        torch.from_numpy(buffer.reach30_finish_round[idx]).to(device),
        torch.from_numpy(buffer.placement[idx]).to(device),
        torch.from_numpy(buffer.options[idx]).to(device),
    )


def select_self_imitation_indices(
    replay: SelfImitationReplay,
    rng: np.random.Generator,
    batch_size: int,
) -> np.ndarray:
    """Draw a phase-balanced auxiliary batch without touching the PPO RNG."""
    if isinstance(batch_size, bool) or batch_size <= 0:
        raise ValueError("self-imitation batch_size must be positive")
    pools = {
        phase: np.flatnonzero(replay.phase == phase)
        for phase in SELF_IMITATION_PHASES
        if bool(np.any(replay.phase == phase))
    }
    if not pools:
        return np.empty(0, dtype=np.int64)
    quota_total = sum(SELF_IMITATION_PHASE_QUOTAS[phase] for phase in pools)
    exact = {
        phase: batch_size * SELF_IMITATION_PHASE_QUOTAS[phase] / quota_total
        for phase in pools
    }
    counts = {phase: int(math.floor(value)) for phase, value in exact.items()}
    remainder = batch_size - sum(counts.values())
    for phase in sorted(pools, key=lambda name: (-(exact[name] - counts[name]), name))[:remainder]:
        counts[phase] += 1
    selected = [
        rng.choice(pool, size=counts[phase], replace=counts[phase] > pool.size)
        for phase, pool in pools.items()
        if counts[phase] > 0
    ]
    out = np.concatenate(selected).astype(np.int64, copy=False)
    rng.shuffle(out)
    return out


def _self_imitation_tensors(
    replay: SelfImitationReplay,
    idx: np.ndarray,
    device: torch.device,
) -> tuple[torch.Tensor, ...]:
    batch = len(idx)
    max_cands = max(replay.cands[i].shape[0] for i in idx)
    act_dim = replay.cands[idx[0]].shape[1]
    cands = np.zeros((batch, max_cands, act_dim), dtype=np.float32)
    behavior_mask = np.zeros((batch, max_cands), dtype=bool)
    for out_index, replay_index in enumerate(idx):
        candidate_rows = replay.cands[replay_index]
        count = candidate_rows.shape[0]
        cands[out_index, :count] = candidate_rows
        behavior_mask[out_index, :count] = replay.behavior_mask[replay_index]
    return (
        torch.from_numpy(replay.obs[idx]).to(device),
        torch.from_numpy(cands).to(device),
        torch.from_numpy(behavior_mask).to(device),
        torch.from_numpy(replay.chosen[idx]).to(device),
        torch.from_numpy(replay.logp_old[idx]).to(device),
        torch.from_numpy(replay.behavior_temperature[idx]).to(device),
        torch.from_numpy(replay.weight[idx]).to(device),
    )


def self_imitation_minibatch_loss(
    model: CandidateScorer,
    replay: SelfImitationReplay,
    idx: np.ndarray,
    device: torch.device,
    *,
    staleness_logp: float = 1.0,
) -> tuple[torch.Tensor, int, int]:
    """Masked CE on winning actions after a current-vs-behavior logp gate.

    This intentionally has no PPO ratio, advantage surrogate, or value target.
    It may be evaluated with a zero coefficient for compute-matched controls.
    """
    if staleness_logp < 0 or not math.isfinite(staleness_logp):
        raise ValueError("staleness_logp must be finite and nonnegative")
    if len(idx) == 0:
        zero = next(model.parameters()).sum() * 0.0
        return zero, 0, 0
    (
        obs,
        cands,
        behavior_mask,
        chosen,
        logp_old,
        behavior_temperature,
        weights,
    ) = _self_imitation_tensors(replay, idx, device)
    logits, _, _ = model(obs, cands, behavior_mask)
    current_behavior_logp = behavior_log_probs(
        logits, behavior_mask, behavior_temperature
    ).gather(1, chosen.unsqueeze(1)).squeeze(1)
    fresh = (current_behavior_logp.detach() - logp_old).abs() <= staleness_logp
    accepted = int(fresh.sum().item())
    if accepted == 0:
        return logits.sum() * 0.0, 0, len(idx)
    # The imitation target is a separate masked categorical CE at policy
    # temperature 1. Behavior temperature is used only for the staleness proof.
    masked_logits = logits.masked_fill(~behavior_mask, float("-inf"))
    ce = -F.log_softmax(masked_logits, dim=-1).gather(
        1, chosen.unsqueeze(1)
    ).squeeze(1)
    # Normalize action-quality weights separately within each phase, then apply
    # the desired phase mixture exactly once. The sampler also uses the quotas to
    # allocate variance efficiently, but sample counts cannot alter this mean.
    weighted_phase_losses: list[torch.Tensor] = []
    active_quota = 0.0
    sampled_phases = replay.phase[idx]
    for phase in SELF_IMITATION_PHASES:
        phase_mask = torch.from_numpy(sampled_phases == phase).to(device) & fresh
        if not bool(phase_mask.any()):
            continue
        phase_weights = weights[phase_mask]
        phase_loss = (ce[phase_mask] * phase_weights).sum() / phase_weights.sum().clamp_min(1e-8)
        quota = SELF_IMITATION_PHASE_QUOTAS[phase]
        weighted_phase_losses.append(phase_loss * quota)
        active_quota += quota
    loss = torch.stack(weighted_phase_losses).sum() / max(active_quota, 1e-8)
    return loss, accepted, len(idx) - accepted


def select_terminal_teacher_indices(
    replay_size: int,
    batch_size: int,
    *,
    seed: int | None,
    epoch: int,
    minibatch: int,
) -> np.ndarray:
    """Select one fixed teacher batch without advancing any PPO RNG stream.

    The selection is a pure function of trainer seed and minibatch coordinates,
    so coefficient-zero controls and treatments see exactly the same examples
    even after their model parameters diverge.
    """
    if (
        isinstance(replay_size, bool)
        or isinstance(batch_size, bool)
        or not isinstance(replay_size, int)
        or not isinstance(batch_size, int)
        or replay_size <= 0
        or batch_size <= 0
    ):
        raise ValueError("terminal-teacher replay and batch sizes must be positive")
    if (
        isinstance(epoch, bool)
        or not isinstance(epoch, int)
        or epoch < 1
        or isinstance(minibatch, bool)
        or not isinstance(minibatch, int)
        or minibatch < 0
    ):
        raise ValueError("terminal-teacher epoch/minibatch coordinates are invalid")
    base_seed = 0 if seed is None else int(seed)
    # SeedSequence accepts a vector and is stable across processes/platforms.
    rng = np.random.default_rng(
        np.random.SeedSequence(
            [base_seed & 0xFFFFFFFF, 0x54454143, int(epoch), int(minibatch)]
        )
    )
    if replay_size < batch_size:
        return rng.choice(replay_size, size=batch_size, replace=True).astype(
            np.int64, copy=False
        )
    return rng.permutation(replay_size)[:batch_size].astype(np.int64, copy=False)


def _terminal_teacher_tensors(
    replay: TerminalTeacherReplay,
    idx: np.ndarray,
    device: torch.device,
) -> tuple[torch.Tensor, ...]:
    batch = len(idx)
    max_cands = max(replay.cands[int(i)].shape[0] for i in idx)
    cands = np.zeros((batch, max_cands, replay.act_dim), dtype=np.float32)
    evaluated_mask = np.zeros((batch, max_cands), dtype=bool)
    terminal_pi = np.zeros((batch, max_cands), dtype=np.float32)
    for output_index, replay_index_raw in enumerate(idx):
        replay_index = int(replay_index_raw)
        candidate_rows = replay.cands[replay_index]
        count = candidate_rows.shape[0]
        cands[output_index, :count] = candidate_rows
        evaluated_mask[output_index, :count] = replay.evaluated_mask[replay_index]
        terminal_pi[output_index, :count] = replay.terminal_pi[replay_index]
    return (
        torch.from_numpy(replay.obs[idx]).to(device),
        torch.from_numpy(cands).to(device),
        torch.from_numpy(evaluated_mask).to(device),
        torch.from_numpy(terminal_pi).to(device),
        torch.from_numpy(replay.weight[idx]).to(device),
    )


def terminal_teacher_minibatch_loss(
    model: CandidateScorer,
    replay: TerminalTeacherReplay,
    idx: np.ndarray,
    device: torch.device,
) -> tuple[torch.Tensor, float]:
    """Soft-target CE renormalized over exactly the evaluated action support."""
    if model.option_dim:
        raise ValueError("terminal-teacher loss rejects option-enabled checkpoints")
    if len(idx) == 0:
        raise ValueError("terminal-teacher minibatch must not be empty")
    obs, cands, evaluated_mask, terminal_pi, weights = _terminal_teacher_tensors(
        replay, idx, device
    )
    logits, _, _ = model(obs, cands, evaluated_mask)
    log_probs = F.log_softmax(
        logits.masked_fill(~evaluated_mask, float("-inf")), dim=-1
    )
    # Avoid 0 * -inf on unevaluated/padded candidates in both forward/backward.
    finite_log_probs = log_probs.masked_fill(~evaluated_mask, 0.0)
    per_row = -(terminal_pi * finite_log_probs).sum(dim=-1)
    weight_sum = weights.sum().clamp_min(1e-8)
    loss = (per_row * weights).sum() / weight_sum
    with torch.no_grad():
        student_top = logits.masked_fill(~evaluated_mask, float("-inf")).argmax(dim=1)
        teacher_top = terminal_pi.argmax(dim=1)
        agreement = float(
            (((student_top == teacher_top).float() * weights).sum() / weight_sum).item()
        )
    return loss, agreement


def binary_auc(
    targets: np.ndarray, scores: np.ndarray, weights: np.ndarray | None = None
) -> float:
    """Tie-aware weighted AUROC; returns NaN when either class has zero weight."""
    targets = np.asarray(targets, dtype=np.int8)
    scores = np.asarray(scores, dtype=np.float64)
    weights = (
        np.ones(targets.size, dtype=np.float64)
        if weights is None
        else np.asarray(weights, dtype=np.float64)
    )
    positive_weight = float(weights[targets == 1].sum())
    negative_weight = float(weights[targets == 0].sum())
    if positive_weight <= 0 or negative_weight <= 0:
        return float("nan")
    order = np.argsort(scores, kind="mergesort")
    concordant = 0.0
    lower_negative_weight = 0.0
    start = 0
    while start < order.size:
        end = start + 1
        while end < order.size and scores[order[end]] == scores[order[start]]:
            end += 1
        group = order[start:end]
        group_positive = float(weights[group][targets[group] == 1].sum())
        group_negative = float(weights[group][targets[group] == 0].sum())
        concordant += group_positive * (lower_negative_weight + 0.5 * group_negative)
        lower_negative_weight += group_negative
        start = end
    return concordant / (positive_weight * negative_weight)


def binary_average_precision(
    targets: np.ndarray, scores: np.ndarray, weights: np.ndarray | None = None
) -> float:
    """Tie-grouped weighted average precision; NaN when there are no positives."""
    targets = np.asarray(targets, dtype=np.int8)
    scores = np.asarray(scores, dtype=np.float64)
    weights = (
        np.ones(targets.size, dtype=np.float64)
        if weights is None
        else np.asarray(weights, dtype=np.float64)
    )
    total_positive = float(weights[targets == 1].sum())
    if total_positive <= 0:
        return float("nan")
    order = np.argsort(-scores, kind="mergesort")
    seen_positive = seen_total = ap = 0.0
    start = 0
    while start < order.size:
        end = start + 1
        while end < order.size and scores[order[end]] == scores[order[start]]:
            end += 1
        group = order[start:end]
        group_positive = float(weights[group][targets[group] == 1].sum())
        group_total = float(weights[group].sum())
        seen_positive += group_positive
        seen_total += group_total
        if group_positive > 0:
            ap += (group_positive / total_positive) * (seen_positive / seen_total)
        start = end
    return ap


def binary_ece(
    targets: np.ndarray,
    scores: np.ndarray,
    bins: int = 10,
    weights: np.ndarray | None = None,
) -> float:
    targets = np.asarray(targets, dtype=np.float64)
    scores = np.asarray(scores, dtype=np.float64)
    if targets.size == 0:
        return float("nan")
    weights = (
        np.ones(targets.size, dtype=np.float64)
        if weights is None
        else np.asarray(weights, dtype=np.float64)
    )
    total_weight = float(weights.sum())
    if total_weight <= 0:
        return float("nan")
    indices = np.minimum((scores * bins).astype(np.int64), bins - 1)
    ece = 0.0
    for index in range(bins):
        mask = indices == index
        if mask.any():
            bin_weight = float(weights[mask].sum())
            if bin_weight <= 0:
                continue
            score_mean = float(np.average(scores[mask], weights=weights[mask]))
            target_mean = float(np.average(targets[mask], weights=weights[mask]))
            ece += (bin_weight / total_weight) * abs(score_mean - target_mean)
    return ece


def reach30_training_metrics(
    model: CandidateScorer,
    buffer: TrajectoryBuffer,
    device: torch.device,
    batch_size: int,
) -> dict[str, float]:
    """Frozen post-epoch, episode-weighted diagnostics on the training buffer.

    These are optimization diagnostics only, never held-out promotion evidence.
    """
    labelled = np.flatnonzero(buffer.reach30_target_mask)
    if labelled.size == 0:
        # Keep history JSON standards-compliant and generic trainer smoke tests
        # finite when the optional critic has no labels.
        return {key: 0.0 for key in ("nll", "brier", "auc", "auprc", "ece")}
    was_training = model.training
    model.eval()
    score_chunks: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, labelled.size, batch_size):
            idx = labelled[start : start + batch_size]
            logits = model.reach30_logits(
                torch.from_numpy(buffer.obs[idx]).to(device),
                torch.from_numpy(buffer.options[idx]).to(device),
            )
            score_chunks.append(torch.sigmoid(logits).cpu().numpy())
    if was_training:
        model.train()
    scores = np.concatenate(score_chunks).astype(np.float64)
    targets = buffer.reach30_target[labelled].astype(np.float64)
    weights = buffer.reach30_weight[labelled].astype(np.float64)
    clipped = np.clip(scores, 1e-7, 1.0 - 1e-7)
    nll = float(np.average(-(targets * np.log(clipped) + (1 - targets) * np.log(1 - clipped)), weights=weights))
    brier = float(np.average((scores - targets) ** 2, weights=weights))
    return {
        "nll": nll,
        "brier": brier,
        "auc": binary_auc(targets, scores, weights),
        "auprc": binary_average_precision(targets, scores, weights),
        "ece": binary_ece(targets, scores, weights=weights),
    }


def behavior_reach30_metrics(buffer: TrajectoryBuffer) -> dict[str, float]:
    """Equal-game calibration of the checkpoint that generated this rollout.

    Unlike ``reach30_training_metrics``, this consumes the immutable actor-recorded
    ``reach30Pred`` values, so it can be checked before the current optimizer sees
    the generation.
    """
    labelled = np.flatnonzero(buffer.reach30_target_mask & buffer.reach30_pred_mask)
    expected = int(buffer.reach30_target_mask.sum())
    if labelled.size == 0 or labelled.size != expected:
        return {
            key: float("nan")
            for key in ("nll", "brier", "constant_brier", "auc", "auprc", "ece", "rows")
        }
    scores = buffer.reach30_pred[labelled].astype(np.float64)
    targets = buffer.reach30_target[labelled].astype(np.float64)
    weights = buffer.reach30_weight[labelled].astype(np.float64)
    clipped = np.clip(scores, 1e-7, 1.0 - 1e-7)
    base_rate = float(np.average(targets, weights=weights))
    return {
        "nll": float(
            np.average(
                -(targets * np.log(clipped) + (1 - targets) * np.log(1 - clipped)),
                weights=weights,
            )
        ),
        "brier": float(np.average((scores - targets) ** 2, weights=weights)),
        "constant_brier": float(np.average((base_rate - targets) ** 2, weights=weights)),
        "auc": binary_auc(targets, scores, weights),
        "auprc": binary_average_precision(targets, scores, weights),
        "ece": binary_ece(targets, scores, weights=weights),
        "rows": float(labelled.size),
    }


def reach30_minibatch_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    mask: torch.Tensor,
    weights: torch.Tensor,
    *,
    total_rows: int,
    total_episode_weight: float,
) -> torch.Tensor:
    """Unbiased SGD estimator for the equal-episode reach-30 BCE objective."""
    if not bool(mask.any()) or total_episode_weight <= 0:
        return torch.zeros((), dtype=logits.dtype, device=logits.device)
    per_row = F.binary_cross_entropy_with_logits(
        logits[mask], targets[mask], reduction="none"
    )
    return (
        per_row.mul(weights[mask]).sum()
        * (total_rows / (logits.shape[0] * total_episode_weight))
    )


def reach30_multihorizon_minibatch_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    mask: torch.Tensor,
    weights: torch.Tensor,
    finish_round: torch.Tensor,
    horizons: tuple[int, ...],
    *,
    total_rows: int,
    total_episode_weight: float,
) -> torch.Tensor:
    """Equal-episode BCE averaged over several nested reach-30 horizons.

    A successful episode's exact finish round labels every earlier horizon;
    failed episodes label every horizon false. This provides the shared entity
    trunk with denser pace supervision while retaining the latest horizon as
    the actor-facing P30 control variate.
    """
    if logits.ndim != 2 or logits.shape[1] != len(horizons):
        raise ValueError(
            f"reach30 logits shape {tuple(logits.shape)} does not match horizons {horizons}"
        )
    if not bool(mask.any()) or total_episode_weight <= 0:
        return torch.zeros((), dtype=logits.dtype, device=logits.device)
    if bool(((targets > 0.5) & mask & (finish_round <= 0)).any()):
        raise ValueError("multi-horizon reach30 labels require finishRound on every success")
    horizon_tensor = torch.tensor(horizons, dtype=finish_round.dtype, device=logits.device)
    nested_targets = (
        (targets > 0.5).unsqueeze(1)
        & (finish_round.unsqueeze(1) <= horizon_tensor.unsqueeze(0))
    ).to(logits.dtype)
    per = F.binary_cross_entropy_with_logits(logits, nested_targets, reduction="none")
    labelled = mask.unsqueeze(1).to(logits.dtype)
    weighted_sum = (per * labelled * weights.unsqueeze(1)).sum()
    return weighted_sum * (
        total_rows / (logits.shape[0] * total_episode_weight * len(horizons))
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
    reach30_value_coef: float = 0.0,
    entropy_coef: float = 0.01,
    entropy_anneal: bool = False,
    value_clip_eps: float = 0.0,
    target_kl: float | None = None,
    kl_ref_coef: float = 0.0,
    lr_schedule: str = "const",
    placement_coef: float = 0.0,
    max_grad_norm: float = 1.0,
    seed: int | None = None,
    rows_per_epoch: int | None = None,
    continuation_fraction: float | None = None,
    round_policy_bands: tuple[tuple[int, float], ...] | None = None,
    self_imitation_coef: float = 0.0,
    self_imitation_replay_fraction: float = 0.0,
    self_imitation_staleness_logp: float = 1.0,
    terminal_teacher: TerminalTeacherReplay | None = None,
    terminal_teacher_coef: float = 0.0,
    terminal_teacher_batch_size: int = 256,
    option_rows_per_epoch: int = 16_384,
    option_batch_size: int = 256,
    option_clip_eps: float = 0.15,
    option_entropy_coef: float = 0.02,
    option_value_coef: float = 0.5,
    option_feature_cutoff: int | None = None,
) -> list[dict]:
    """K epochs of clipped-surrogate PPO over a fixed rollout buffer.
    Returns per-epoch metric dicts (used by tests).

    Divergence guards: gradient clipping (max_grad_norm, 0=off) and a NaN/Inf
    check after every optimizer step — on a non-finite step the run halts and
    the last finite epoch snapshot is restored, so the exported checkpoint is
    always finite (the fair-rules league diverged at gen ~13 without this)."""
    if rows_per_epoch is not None and target_kl is not None:
        raise ValueError(
            "target_kl early stopping is incompatible with rows_per_epoch fixed-update training"
        )
    if round_policy_bands is not None and rows_per_epoch is None:
        raise ValueError("round_policy_bands requires rows_per_epoch fixed-update training")
    if self_imitation_coef < 0 or not math.isfinite(self_imitation_coef):
        raise ValueError("self_imitation_coef must be finite and nonnegative")
    if not 0.0 <= self_imitation_replay_fraction <= 1.0:
        raise ValueError("self_imitation_replay_fraction must be in [0, 1]")
    if self_imitation_coef > 0 and self_imitation_replay_fraction <= 0:
        raise ValueError("self_imitation_coef requires a positive replay fraction")
    if self_imitation_replay_fraction > 0 and target_kl is not None:
        raise ValueError(
            "self-imitation replay is incompatible with target_kl early stopping"
        )
    if self_imitation_staleness_logp < 0 or not math.isfinite(self_imitation_staleness_logp):
        raise ValueError("self_imitation_staleness_logp must be finite and nonnegative")
    if terminal_teacher_coef < 0 or not math.isfinite(terminal_teacher_coef):
        raise ValueError("terminal_teacher_coef must be finite and nonnegative")
    if terminal_teacher_coef > 0 and terminal_teacher is None:
        raise ValueError("terminal_teacher_coef requires terminal-teacher data")
    if terminal_teacher is not None:
        if (
            isinstance(terminal_teacher_batch_size, bool)
            or not isinstance(terminal_teacher_batch_size, int)
            or terminal_teacher_batch_size <= 0
        ):
            raise ValueError("terminal_teacher_batch_size must be a positive integer")
        if target_kl is not None:
            raise ValueError(
                "terminal-teacher batches are incompatible with target_kl early stopping"
            )
        if buffer.option_dim or model.option_dim:
            raise ValueError("terminal-teacher PPO rejects option-enabled checkpoints")
        if terminal_teacher.obs_dim != model.obs_dim:
            raise ValueError(
                f"terminal-teacher obs_dim {terminal_teacher.obs_dim} != model {model.obs_dim}"
            )
        if terminal_teacher.act_dim != model.act_dim:
            raise ValueError(
                f"terminal-teacher act_dim {terminal_teacher.act_dim} != model {model.act_dim}"
            )
    if buffer.option_dim and self_imitation_replay_fraction > 0:
        raise ValueError("option-enabled PPO does not accept legacy self-imitation rows")
    if buffer.option_dim != model.option_dim:
        raise ValueError(
            f"rollout option_dim {buffer.option_dim} != model option_dim {model.option_dim}"
        )
    if buffer.option_dim and buffer.option_events is None:
        raise ValueError("option-enabled PPO requires validated option events")
    if buffer.option_rejected_episodes:
        raise ValueError(
            f"option contract rejected {buffer.option_rejected_episodes} episode(s)"
        )
    if option_feature_cutoff is not None and not buffer.option_dim:
        raise ValueError("option_feature_cutoff requires an option-enabled rollout")
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
    # Independent stream: enabling replay cannot perturb PPO row selection/shuffling.
    self_imitation_rng = np.random.default_rng(
        None if seed is None else (int(seed) ^ 0x53494C)
    )
    option_rng = np.random.default_rng(None if seed is None else (int(seed) ^ 0x4F5054))
    indices = np.arange(n)
    global_normalized_advantages = normalize_policy_advantages(
        buffer.advantages,
        buffer.policy_mask,
        buffer.strategic_mask
        if (
            buffer.strategic_mc_coef > 0
            or buffer.solo_strategic_mc_coef > 0
            or buffer.solo_outcome_coef > 0
            or buffer.solo_reach30_coef > 0
            or buffer.solo_reach30_bands is not None
            or buffer.strategic_outcome_coef > 0
        )
        else None,
    )
    n_policy_total = int(buffer.policy_mask.sum())
    normalized_option_advantages = None
    if buffer.option_events is not None:
        raw_adv = buffer.option_events.advantages.astype(np.float64)
        weights = buffer.option_events.importance_weight.astype(np.float64)
        mean = float(np.average(raw_adv, weights=weights))
        variance = float(np.average((raw_adv - mean) ** 2, weights=weights))
        normalized_option_advantages = (
            (raw_adv - mean) / math.sqrt(variance + 1e-8)
        ).astype(np.float32)
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
    if reach30_value_coef > 0 and not bool(buffer.reach30_target_mask.any()):
        print(
            "WARNING: reach30_value_coef is nonzero but the rollout has no resolved solo labels; "
            "the reach-30 head receives no training signal",
            file=sys.stderr,
        )
    if self_imitation_replay_fraction > 0 and buffer.self_imitation is None:
        print(
            "WARNING: self-imitation replay is enabled but no eligible winning rows were found; "
            "the auxiliary loss is zero",
            file=sys.stderr,
        )
    if reach30_value_coef > 0 and buffer.reach30_horizon is not None:
        existing_horizon = getattr(model, "reach30_horizon", None)
        if getattr(model, "reach30_trained", False) and existing_horizon != buffer.reach30_horizon:
            raise ValueError(
                f"reach30 checkpoint horizon {existing_horizon} does not match "
                f"training data horizon {buffer.reach30_horizon}"
            )
        model_horizons = tuple(getattr(model, "reach30_horizons", ()))
        if model_horizons:
            if model_horizons[-1] != buffer.reach30_horizon:
                raise ValueError(
                    f"reach30 model horizons {model_horizons} do not end at rollout "
                    f"horizon {buffer.reach30_horizon}"
                )
            missing_finish = (
                buffer.reach30_target_mask
                & (buffer.reach30_target > 0.5)
                & (buffer.reach30_finish_round <= 0)
            )
            if len(model_horizons) > 1 and bool(missing_finish.any()):
                raise ValueError(
                    "multi-horizon reach30 training requires endRound on every successful episode"
                )
    if buffer.solo_reach30_coef > 0 or buffer.solo_reach30_bands is not None:
        if not getattr(model, "reach30_trained", False):
            raise ValueError("solo_reach30_coef requires a trained behavior reach30 head")
        if getattr(model, "reach30_horizon", None) != buffer.reach30_horizon:
            raise ValueError(
                f"reach30 checkpoint horizon {getattr(model, 'reach30_horizon', None)} "
                f"does not match rollout horizon {buffer.reach30_horizon}"
            )
    # v2 (per-seat-token regression) and v1 (4-way CE) placement aux heads.
    use_placement = placement_coef > 0 and hasattr(model, "placement_logits")
    use_placement_v1 = placement_coef > 0 and hasattr(model, "placement_head")
    history: list[dict] = []
    last_finite = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    last_finite_reach30_trained = bool(getattr(model, "reach30_trained", False))
    last_finite_reach30_horizon = getattr(model, "reach30_horizon", None)
    halted = False

    for epoch in range(1, epochs + 1):
        frac = 0.0 if epochs <= 1 else (epoch - 1) / (epochs - 1)
        ent_coef = entropy_coef * (1.0 - frac) if entropy_anneal else entropy_coef
        if lr_schedule == "cosine":
            # lr -> 0.1*lr over the epochs; guards late-epoch overshoot on small buffers.
            lr_e = lr * (0.1 + 0.45 * (1.0 + math.cos(math.pi * frac)))
            for group in optimizer.param_groups:
                group["lr"] = lr_e
        if rows_per_epoch is None:
            # Historical/default path: preserve the exact in-place shuffle sequence.
            rng.shuffle(indices)
            epoch_indices = indices
            normalized_advantages = global_normalized_advantages
        else:
            epoch_indices = select_ppo_epoch_indices(
                buffer.continuation_mask,
                rng,
                rows_per_epoch=rows_per_epoch,
                continuation_fraction=continuation_fraction,
            )
            selected_mask = np.zeros(n, dtype=bool)
            selected_mask[epoch_indices] = True
            normalized_advantages = normalize_policy_advantages(
                buffer.advantages,
                buffer.policy_mask & selected_mask,
                buffer.strategic_mask
                if (
                    buffer.strategic_mc_coef > 0
                    or buffer.solo_strategic_mc_coef > 0
                    or buffer.solo_outcome_coef > 0
                    or buffer.solo_reach30_coef > 0
                    or buffer.solo_reach30_bands is not None
                    or buffer.strategic_outcome_coef > 0
                )
                else None,
            )
        selected_policy_mask = np.zeros(n, dtype=bool)
        selected_policy_mask[epoch_indices] = buffer.policy_mask[epoch_indices]
        epoch_round_policy_weights = normalized_round_policy_weights(
            buffer.round,
            selected_policy_mask,
            round_policy_bands,
        )
        model.train()

        tot_policy = tot_value = tot_entropy = tot_kl = tot_clip = tot_prob = 0.0
        tot_farm = tot_reward = tot_route = tot_reach30 = 0.0
        tot_placement = 0.0
        tot_kl_ref = 0.0
        tot_weighted_kl = tot_weighted_clip = 0.0
        tot_self_imitation = 0.0
        tot_terminal_teacher = 0.0
        tot_terminal_teacher_agreement = 0.0
        tot_strategic_value = tot_tactical_value = 0.0
        n_seen = 0
        n_policy_seen = 0
        n_strategic_seen = n_tactical_seen = 0
        n_continuation_seen = 0
        optimizer_steps = 0
        self_imitation_sampled = 0
        self_imitation_accepted = 0
        self_imitation_stale = 0
        self_imitation_phase_counts = {phase: 0 for phase in SELF_IMITATION_PHASES}
        terminal_teacher_rows = 0
        terminal_teacher_batches = 0
        option_policy_total = option_value_total = option_entropy_total = 0.0
        option_kl_total = option_clip_total = option_value_error_total = 0.0
        option_seen = option_updates = 0
        stop = False
        epoch_reach30_updated = False
        epoch_reach30_total_weight = float(buffer.reach30_weight[epoch_indices].sum())

        for start in range(0, len(epoch_indices), batch_size):
            mb = epoch_indices[start : start + batch_size]
            (
                obs,
                cands,
                candidate_mask,
                behavior_mask,
                chosen,
                policy_mask,
                logp_old,
                behavior_temperature,
                round_policy_weight,
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
                reach30_target,
                reach30_target_mask,
                reach30_weight,
                reach30_finish_round,
                placement,
                option,
            ) = _minibatch_tensors(
                buffer,
                mb,
                device,
                normalized_advantages,
                epoch_round_policy_weights,
            )

            logits, _, value = model(obs, cands, behavior_mask, option)
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
                    active_round_weight = round_policy_weight[policy_mask]
                    active_round_weight_sum = active_round_weight.sum().clamp_min(1e-8)
                    weighted_kl = (
                        (((ratio[policy_mask] - 1.0) - log_ratio[policy_mask]) * active_round_weight).sum()
                        / active_round_weight_sum
                    ).item()
                    weighted_clip = (
                        (
                            ((ratio[policy_mask] - 1.0).abs() > clip_eps).float()
                            * active_round_weight
                        ).sum()
                        / active_round_weight_sum
                    ).item()
                surr1 = ratio[policy_mask] * adv[policy_mask]
                surr2 = ratio[policy_mask].clamp(
                    1.0 - clip_eps, 1.0 + clip_eps
                ) * adv[policy_mask]
                if round_policy_bands is None:
                    policy_loss = -torch.min(surr1, surr2).mean()
                else:
                    policy_loss = -(
                        torch.min(surr1, surr2) * active_round_weight
                    ).sum() / active_round_weight_sum
            else:
                approx_kl = 0.0
                clip_frac = 0.0
                weighted_kl = 0.0
                weighted_clip = 0.0
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
            if policy_count and round_policy_bands is not None:
                entropy = (
                    entropy_per_row[policy_mask] * active_round_weight
                ).sum() / active_round_weight_sum
            else:
                entropy = (
                    entropy_per_row[policy_mask].mean()
                    if policy_count
                    else torch.zeros((), dtype=torch.float32, device=device)
                )

            kl_ref = torch.zeros((), dtype=torch.float32, device=device)
            if ref_model is not None:
                with torch.no_grad():
                    ref_logits, _, _ = ref_model(obs, cands, behavior_mask, option)
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
                if policy_count and round_policy_bands is not None:
                    kl_ref = (
                        kl_ref_per_row[policy_mask] * active_round_weight
                    ).sum() / active_round_weight_sum
                else:
                    kl_ref = (
                        kl_ref_per_row[policy_mask].mean()
                        if policy_count
                        else torch.zeros((), dtype=torch.float32, device=device)
                    )

            farm_loss = torch.zeros((), dtype=torch.float32, device=device)
            if farm_value_coef > 0 and farm_mask.any():
                pred_farm = model.farm_value(obs, option)
                farm_loss = F.mse_loss(pred_farm[farm_mask], farm_value[farm_mask])

            reward_loss = torch.zeros((), dtype=torch.float32, device=device)
            if reward_pick_coef > 0 and reward_mask.any():
                reward_logits = model.reward_pick_logits(obs, cands, candidate_mask, option)
                reward_log_probs = F.log_softmax(reward_logits, dim=-1)
                reward_per_row = -(reward_pi * reward_log_probs).sum(dim=-1)
                reward_loss = reward_per_row[reward_mask].mean()

            route_loss = torch.zeros((), dtype=torch.float32, device=device)
            if route_mode_coef > 0 and route_mask.any():
                route_logits = model.route_mode_logits(obs, option)
                route_loss = F.binary_cross_entropy_with_logits(
                    route_logits[route_mask], route_mode[route_mask]
                )

            reach30_loss = torch.zeros((), dtype=torch.float32, device=device)
            reach30_active = bool(reach30_value_coef > 0 and reach30_target_mask.any())
            if reach30_active:
                model_horizons = tuple(getattr(model, "reach30_horizons", ()))
                if len(model_horizons) > 1:
                    reach30_logits = model.reach30_all_logits(obs, option)
                    reach30_loss = reach30_multihorizon_minibatch_loss(
                        reach30_logits,
                        reach30_target,
                        reach30_target_mask,
                        reach30_weight,
                        reach30_finish_round,
                        model_horizons,
                        total_rows=len(epoch_indices),
                        total_episode_weight=epoch_reach30_total_weight,
                    )
                else:
                    reach30_logits = model.reach30_logits(obs, option)
                    # Unbiased minibatch estimator of the fixed full-buffer objective:
                    #   sum_i (BCE_i / episode_length_i) / labelled_episodes.
                    # A per-minibatch weight normalization would cancel 1/L in small
                    # batches and overtrain long episodes.
                    reach30_loss = reach30_minibatch_loss(
                        reach30_logits,
                        reach30_target,
                        reach30_target_mask,
                        reach30_weight,
                        total_rows=len(epoch_indices),
                        total_episode_weight=epoch_reach30_total_weight,
                    )

            placement_loss = torch.zeros((), dtype=torch.float32, device=device)
            if use_placement:
                placement_loss = placement_aux_loss(model, obs, placement, placement > 0)
            elif use_placement_v1:
                placement_loss = placement_aux_loss_v1(
                    model, obs, placement, placement > 0, option
                )

            self_imitation_loss = torch.zeros((), dtype=torch.float32, device=device)
            accepted = 0
            if self_imitation_replay_fraction > 0 and buffer.self_imitation is not None:
                replay_batch_size = max(
                    1, int(math.ceil(len(mb) * self_imitation_replay_fraction))
                )
                replay_idx = select_self_imitation_indices(
                    buffer.self_imitation, self_imitation_rng, replay_batch_size
                )
                self_imitation_loss, accepted, stale = self_imitation_minibatch_loss(
                    model,
                    buffer.self_imitation,
                    replay_idx,
                    device,
                    staleness_logp=self_imitation_staleness_logp,
                )
                self_imitation_sampled += len(replay_idx)
                self_imitation_accepted += accepted
                self_imitation_stale += stale
                for phase in SELF_IMITATION_PHASES:
                    self_imitation_phase_counts[phase] += int(
                        np.sum(buffer.self_imitation.phase[replay_idx] == phase)
                    )

            terminal_teacher_loss = torch.zeros(
                (), dtype=torch.float32, device=device
            )
            terminal_teacher_agreement = 0.0
            teacher_idx: np.ndarray | None = None
            if terminal_teacher is not None:
                teacher_idx = select_terminal_teacher_indices(
                    len(terminal_teacher),
                    terminal_teacher_batch_size,
                    seed=seed,
                    epoch=epoch,
                    minibatch=start // batch_size,
                )
                terminal_teacher_loss, terminal_teacher_agreement = (
                    terminal_teacher_minibatch_loss(
                        model, terminal_teacher, teacher_idx, device
                    )
                )

            loss = (
                policy_coef * policy_loss
                + value_coef * value_loss
                + farm_value_coef * farm_loss
                + reward_pick_coef * reward_loss
                + route_mode_coef * route_loss
                + reach30_value_coef * reach30_loss
                - ent_coef * entropy
                + placement_coef * placement_loss
                + kl_ref_coef * kl_ref
                + self_imitation_coef * self_imitation_loss
            )
            if terminal_teacher is not None:
                # The coefficient-zero control still executes the exact same
                # teacher forward graph and batches, but contributes exact zero.
                loss = loss + terminal_teacher_coef * terminal_teacher_loss
            optimizer.zero_grad()
            loss.backward()
            if max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
            optimizer.step()
            optimizer_steps += 1
            if not model_parameters_are_finite(model):
                print(
                    f"WARNING: non-finite weights after a PPO step in epoch {epoch} — "
                    "halting and restoring the last finite snapshot",
                    file=sys.stderr,
                )
                model.load_state_dict(last_finite)
                model.reach30_trained = last_finite_reach30_trained
                model.reach30_horizon = last_finite_reach30_horizon
                halted = True
                break
            if reach30_active:
                epoch_reach30_updated = True

            bs = len(mb)
            n_seen += bs
            n_policy_seen += policy_count
            tot_policy += policy_loss.item() * policy_count
            tot_value += value_loss.item() * bs
            tot_farm += farm_loss.item() * bs
            tot_reward += reward_loss.item() * bs
            tot_route += route_loss.item() * bs
            tot_reach30 += reach30_loss.item() * bs
            tot_entropy += entropy.item() * policy_count
            tot_kl += approx_kl * policy_count
            tot_clip += clip_frac * policy_count
            tot_weighted_kl += weighted_kl * policy_count
            tot_weighted_clip += weighted_clip * policy_count
            if policy_count:
                tot_prob += (
                    logp_new.detach().exp()[policy_mask].mean().item() * policy_count
                )
            tot_placement += placement_loss.item() * bs
            tot_kl_ref += kl_ref.item() * policy_count
            tot_self_imitation += self_imitation_loss.item() * accepted
            if teacher_idx is not None:
                terminal_teacher_rows += len(teacher_idx)
                terminal_teacher_batches += 1
                tot_terminal_teacher += (
                    terminal_teacher_loss.detach().item() * len(teacher_idx)
                )
                tot_terminal_teacher_agreement += (
                    terminal_teacher_agreement * len(teacher_idx)
                )
            tot_strategic_value += strategic_value_loss * strategic_count
            tot_tactical_value += tactical_value_loss * tactical_count
            n_strategic_seen += strategic_count
            n_tactical_seen += tactical_count
            n_continuation_seen += int(buffer.continuation_mask[mb].sum())

        # High-level SMDP PPO uses an independent deterministic row stream and
        # exactly the preregistered fixed event budget each epoch.
        events = buffer.option_events
        if not halted and events is not None and normalized_option_advantages is not None:
            event_count = len(events)
            if event_count < 1 or option_rows_per_epoch < 1 or option_batch_size < 1:
                raise ValueError("option PPO requires positive events and fixed row/batch budgets")
            replace = event_count < option_rows_per_epoch
            if replace:
                option_indices = option_rng.choice(
                    event_count, size=option_rows_per_epoch, replace=True
                )
            else:
                option_indices = option_rng.permutation(event_count)[:option_rows_per_epoch]
            for option_start in range(0, option_rows_per_epoch, option_batch_size):
                oi = option_indices[option_start : option_start + option_batch_size]
                option_obs = torch.from_numpy(events.obs[oi]).to(device)
                option_chosen = torch.from_numpy(events.chosen[oi]).to(device)
                option_mask = torch.from_numpy(events.behavior_mask[oi]).to(device)
                old_logp = torch.from_numpy(events.logp_old[oi]).to(device)
                old_value = torch.from_numpy(events.v_pred[oi]).to(device)
                targets = torch.from_numpy(events.returns[oi]).to(device)
                event_adv = torch.from_numpy(normalized_option_advantages[oi]).to(device)
                event_weight = torch.from_numpy(events.importance_weight[oi]).to(device)
                weight_sum = event_weight.sum().clamp_min(1e-8)

                option_logits = model.option_logits(option_obs).masked_fill(
                    ~option_mask, float("-inf")
                )
                option_log_probs = F.log_softmax(option_logits, dim=-1)
                option_probs = option_log_probs.exp()
                new_logp = option_log_probs.gather(1, option_chosen[:, None]).squeeze(1)
                log_ratio = (new_logp - old_logp).clamp(-20.0, 20.0)
                option_ratio = log_ratio.exp()
                surrogate = torch.minimum(
                    option_ratio * event_adv,
                    option_ratio.clamp(1.0 - option_clip_eps, 1.0 + option_clip_eps)
                    * event_adv,
                )
                option_policy_loss = -(surrogate * event_weight).sum() / weight_sum
                finite_log_probs = option_log_probs.masked_fill(~option_mask, 0.0)
                option_entropy = (
                    (-(option_probs * finite_log_probs).sum(dim=1) * event_weight).sum()
                    / weight_sum
                )
                predicted_value = model.option_value(option_obs)
                squared_error = (predicted_value - targets) ** 2
                option_value_loss = (squared_error * event_weight).sum() / weight_sum
                option_loss = (
                    option_policy_loss
                    + option_value_coef * option_value_loss
                    - option_entropy_coef * option_entropy
                )
                optimizer.zero_grad()
                option_loss.backward()
                if max_grad_norm > 0:
                    torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
                optimizer.step()
                option_updates += 1
                if not model_parameters_are_finite(model):
                    model.load_state_dict(last_finite)
                    halted = True
                    break
                bs_option = len(oi)
                with torch.no_grad():
                    k3 = ((option_ratio - 1.0) - log_ratio)
                    clipped = (option_ratio - 1.0).abs() > option_clip_eps
                    option_kl_total += float((k3 * event_weight).sum() / weight_sum) * bs_option
                    option_clip_total += float((clipped.float() * event_weight).sum() / weight_sum) * bs_option
                option_policy_total += option_policy_loss.detach().item() * bs_option
                option_value_total += option_value_loss.detach().item() * bs_option
                option_value_error_total += option_value_loss.detach().item() * bs_option
                option_entropy_total += option_entropy.detach().item() * bs_option
                option_seen += bs_option
        if halted:
            break
        active_option_heads: set[str] = set()
        if policy_coef > 0:
            active_option_heads.add("trunk")
        if value_coef > 0:
            active_option_heads.add("value")
        if farm_value_coef > 0:
            active_option_heads.add("farm_value")
        if reward_pick_coef > 0:
            active_option_heads.add("reward_pick")
        if route_mode_coef > 0:
            active_option_heads.add("route_mode")
        if reach30_value_coef > 0:
            active_option_heads.add("reach30")
        if placement_coef > 0 and use_placement_v1:
            active_option_heads.add("placement")
        option_column_norms = audit_low_level_option_columns(
            model,
            buffer,
            option_feature_cutoff,
            active_heads=active_option_heads,
        )
        if n_seen:
            if epoch_reach30_updated:
                model.reach30_trained = True
                model.reach30_horizon = buffer.reach30_horizon
            policy_denom = max(1, n_policy_seen)
            p30_metrics = reach30_training_metrics(model, buffer, device, batch_size)
            self_imitation_summary = ""
            if self_imitation_replay_fraction > 0:
                self_imitation_summary = (
                    f"self_imitation_loss="
                    f"{tot_self_imitation / max(1, self_imitation_accepted):.4f} "
                    f"(coef={self_imitation_coef:g}, accepted={self_imitation_accepted}/"
                    f"{self_imitation_sampled}, stale={self_imitation_stale}, "
                    "phases(route/build/convert/yield)="
                    + "/".join(
                        str(self_imitation_phase_counts[phase])
                        for phase in SELF_IMITATION_PHASES
                    )
                    + ") | "
                )
            terminal_teacher_summary = ""
            if terminal_teacher is not None:
                terminal_teacher_summary = (
                    "terminal_teacher_loss="
                    f"{tot_terminal_teacher / max(1, terminal_teacher_rows):.4f} "
                    f"(coef={terminal_teacher_coef:g}, agreement="
                    f"{tot_terminal_teacher_agreement / max(1, terminal_teacher_rows):.3f}, "
                    f"rows={terminal_teacher_rows}, batches={terminal_teacher_batches}) | "
                )
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
                f"reach30_train_nll={p30_metrics['nll']:.4f} "
                f"(brier={p30_metrics['brier']:.4f}, auc={p30_metrics['auc']:.4f}, "
                f"auprc={p30_metrics['auprc']:.4f}, ece={p30_metrics['ece']:.4f}) | "
                f"entropy={tot_entropy / policy_denom:.4f} (coef={ent_coef:.4f}) | "
                f"approx_kl={tot_kl / policy_denom:.4f} | "
                f"clip_frac={tot_clip / policy_denom:.3f} | "
                f"round_weighted_kl={tot_weighted_kl / policy_denom:.4f} | "
                f"round_weighted_clip_frac={tot_weighted_clip / policy_denom:.3f} | "
                f"placement_loss={tot_placement / n_seen:.4f} | "
                f"kl_ref={tot_kl_ref / policy_denom:.4f} | "
                + self_imitation_summary
                + terminal_teacher_summary
                + f"mean_p_chosen={tot_prob / policy_denom:.3f} | "
                f"policy_steps={n_policy_seen}/{n_seen} | "
                f"optimizer_steps={optimizer_steps}"
            )
            if buffer.option_events is not None:
                print(
                    f"Option PPO epoch {epoch}/{epochs} | "
                    f"policy_loss={option_policy_total / max(1, option_seen):.4f} | "
                    f"value_loss={option_value_total / max(1, option_seen):.4f} | "
                    f"entropy={option_entropy_total / max(1, option_seen):.4f} | "
                    f"approx_kl={option_kl_total / max(1, option_seen):.4f} | "
                    f"clip_frac={option_clip_total / max(1, option_seen):.4f} | "
                    f"events={option_seen} | option_optimizer_steps={option_updates} | "
                    f"support_violations={buffer.option_events.support_violations} | "
                    f"rejected_episodes={buffer.option_events.rejected_episodes}"
                )
            epoch_metrics = {
                "policy_loss": tot_policy / policy_denom,
                "value_loss": tot_value / n_seen,
                "strategic_value_loss": tot_strategic_value / max(1, n_strategic_seen),
                "tactical_value_loss": tot_tactical_value / max(1, n_tactical_seen),
                "strategic_steps": n_strategic_seen,
                "tactical_steps": n_tactical_seen,
                "farm_value_loss": tot_farm / n_seen,
                "reward_pick_loss": tot_reward / n_seen,
                "route_mode_loss": tot_route / n_seen,
                "reach30_loss": p30_metrics["nll"],
                "reach30_brier": p30_metrics["brier"],
                "reach30_auc": p30_metrics["auc"],
                "reach30_auprc": p30_metrics["auprc"],
                "reach30_ece": p30_metrics["ece"],
                "entropy": tot_entropy / policy_denom,
                "approx_kl": tot_kl / policy_denom,
                "clip_frac": tot_clip / policy_denom,
                "round_weighted_kl": tot_weighted_kl / policy_denom,
                "round_weighted_clip_frac": tot_weighted_clip / policy_denom,
                "placement_loss": tot_placement / n_seen,
                "kl_ref": tot_kl_ref / policy_denom,
                "mean_p_chosen": tot_prob / policy_denom,
                "policy_steps": n_policy_seen,
                "total_steps": n_seen,
                "continuation_steps": n_continuation_seen,
                "optimizer_steps": optimizer_steps,
                "option_policy_loss": option_policy_total / max(1, option_seen),
                "option_value_loss": option_value_total / max(1, option_seen),
                "option_value_error": option_value_error_total / max(1, option_seen),
                "option_entropy": option_entropy_total / max(1, option_seen),
                "option_approx_kl": option_kl_total / max(1, option_seen),
                "option_clip_frac": option_clip_total / max(1, option_seen),
                "option_events": option_seen,
                "option_optimizer_steps": option_updates,
                "option_support_violations": (
                    buffer.option_events.support_violations if buffer.option_events else 0
                ),
                "option_column_norms": option_column_norms,
            }
            if self_imitation_replay_fraction > 0:
                epoch_metrics.update(
                    {
                        "self_imitation_loss": tot_self_imitation
                        / max(1, self_imitation_accepted),
                        "self_imitation_coef": self_imitation_coef,
                        "self_imitation_sampled": self_imitation_sampled,
                        "self_imitation_accepted": self_imitation_accepted,
                        "self_imitation_stale": self_imitation_stale,
                        "self_imitation_phase_counts": dict(self_imitation_phase_counts),
                    }
                )
            if terminal_teacher is not None:
                epoch_metrics.update(
                    {
                        "terminal_teacher_loss": tot_terminal_teacher
                        / max(1, terminal_teacher_rows),
                        "terminal_teacher_coef": terminal_teacher_coef,
                        "terminal_teacher_agreement": tot_terminal_teacher_agreement
                        / max(1, terminal_teacher_rows),
                        "terminal_teacher_rows": terminal_teacher_rows,
                        "terminal_teacher_batches": terminal_teacher_batches,
                    }
                )
            history.append(epoch_metrics)
            last_finite = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            last_finite_reach30_trained = bool(getattr(model, "reach30_trained", False))
            last_finite_reach30_horizon = getattr(model, "reach30_horizon", None)
        if stop:
            break
    return history
