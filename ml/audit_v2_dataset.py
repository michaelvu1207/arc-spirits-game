"""Fail-closed integrity audit for an actor-pool obs-v2 solo dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit(
    data_dir: Path,
    *,
    seed0: int,
    games: int,
    obs_dim: int,
    act_dim: int,
    catalog: Path | None = None,
    weights: Path | None = None,
) -> dict:
    errors: list[str] = []
    meta = json.loads((data_dir / "meta.json").read_text())
    expected_meta = {
        "obs_version": 2,
        "obs_dim": obs_dim,
        "act_dim": act_dim,
        "games": games,
    }
    for key, expected in expected_meta.items():
        if meta.get(key) != expected:
            errors.append(f"meta.{key}={meta.get(key)!r}, expected {expected!r}")
    flat_length = int(meta.get("obs_v2", {}).get("flatLength", -1))
    if flat_length <= 0:
        errors.append("meta.obs_v2.flatLength is missing")

    rows = malformed = 0
    game_rows: dict[str, int] = {}
    game_max_step: dict[str, int] = {}
    terminal_rows: dict[str, list[tuple[int, dict]]] = {}
    for path in sorted(data_dir.glob("shard-*.jsonl")):
        with open(path) as handle:
            for line_number, line in enumerate(handle, 1):
                try:
                    record = json.loads(line)
                    game_id = record["gameId"]
                    step = int(record["stepIdx"])
                    obs = record["obs"]
                    obs_v2 = record["obsV2"]
                    cands = record["cands"]
                    chosen = int(record["chosen"])
                    if (
                        not isinstance(game_id, str)
                        or len(obs) != obs_dim
                        or len(obs_v2) != flat_length
                        or not cands
                        or any(len(candidate) != act_dim for candidate in cands)
                        or not 0 <= chosen < len(cands)
                    ):
                        raise ValueError("row shape/support mismatch")
                except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                    malformed += 1
                    if len(errors) < 20:
                        errors.append(f"{path.name}:{line_number}: {exc}")
                    continue
                rows += 1
                game_rows[game_id] = game_rows.get(game_id, 0) + 1
                game_max_step[game_id] = max(step, game_max_step.get(game_id, -1))
                if "reach30Target" in record:
                    terminal_rows.setdefault(game_id, []).append((step, record))

    if rows != meta.get("samples"):
        errors.append(f"rows={rows}, meta.samples={meta.get('samples')!r}")
    if malformed:
        errors.append(f"malformed rows={malformed}")
    if len(game_rows) != games:
        errors.append(f"trajectory game ids={len(game_rows)}, expected {games}")
    if set(terminal_rows) != set(game_rows):
        errors.append(
            f"terminal-labelled games={len(terminal_rows)}, trajectory games={len(game_rows)}"
        )
    true_wins = 0
    for game_id, labelled in terminal_rows.items():
        if len(labelled) != 1:
            errors.append(f"{game_id}: {len(labelled)} terminal objective rows")
            continue
        step, record = labelled[0]
        if step != game_max_step[game_id]:
            errors.append(f"{game_id}: objective label at step {step}, final={game_max_step[game_id]}")
        target = record.get("reach30Target")
        final_vp = record.get("finalVP")
        if (
            target not in (0, 1, False, True)
            or record.get("reach30Horizon") != 30
            or record.get("objectiveDone") not in (1, True)
            or not isinstance(final_vp, int)
            or not isinstance(record.get("endRound"), int)
            or bool(target) != (final_vp >= 30)
        ):
            errors.append(f"{game_id}: malformed/inconsistent terminal objective metadata")
        true_wins += int(bool(target))

    summaries = []
    for path in sorted(data_dir.glob("games-*.jsonl")):
        with open(path) as handle:
            for line_number, line in enumerate(handle, 1):
                try:
                    summaries.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    errors.append(f"{path.name}:{line_number}: {exc}")
    seeds = [summary.get("seed") for summary in summaries]
    expected_seeds = list(range(seed0, seed0 + games))
    if len(summaries) != games:
        errors.append(f"summaries={len(summaries)}, expected {games}")
    if sorted(seeds) != expected_seeds:
        errors.append("summary seeds do not exactly match the preregistered block")
    stalls = sum(int(bool(summary.get("stalled"))) for summary in summaries)
    if stalls:
        errors.append(f"stalled games={stalls}")

    report = {
        "schemaVersion": "arc-v2-dataset-audit-v1",
        "data": str(data_dir),
        "valid": not errors,
        "errors": errors,
        "meta": {
            "obsVersion": meta.get("obs_version"),
            "obsDim": meta.get("obs_dim"),
            "obsV2FlatLength": flat_length,
            "actDim": meta.get("act_dim"),
            "samples": meta.get("samples"),
            "games": meta.get("games"),
        },
        "observed": {
            "rows": rows,
            "games": len(game_rows),
            "terminalLabels": len(terminal_rows),
            "trueWins": true_wins,
            "trueWinRate": true_wins / games if games else 0.0,
            "stalls": stalls,
            "malformedRows": malformed,
            "seedMin": min(seeds) if seeds else None,
            "seedMax": max(seeds) if seeds else None,
        },
        **({"catalog": str(catalog), "catalogSha256": sha256(catalog)} if catalog else {}),
        **({"weights": str(weights), "weightsSha256": sha256(weights)} if weights else {}),
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--seed0", type=int, required=True)
    parser.add_argument("--games", type=int, required=True)
    parser.add_argument("--obs-dim", type=int, required=True)
    parser.add_argument("--act-dim", type=int, required=True)
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    report = audit(
        args.data,
        seed0=args.seed0,
        games=args.games,
        obs_dim=args.obs_dim,
        act_dim=args.act_dim,
        catalog=args.catalog,
        weights=args.weights,
    )
    rendered = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered)
    print(rendered, end="")
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
