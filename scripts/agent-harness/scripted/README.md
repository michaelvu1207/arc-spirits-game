# Scripted Fighter + Elementalist player (`script:fe`)

A fixed, rule-based player with no model calls. It plays one build only — Fighter 5 for attack
dice on Rest, Elementalist 5 for dice upgrades — and scores by killing monsters. It is meant as a
fixed baseline: when the rules change, play it again and compare.

- Policy: `src/lib/play/agents/scripted/fePolicy.ts` (every decision the engine asks of a seat).
- Seat: `src/lib/play/agents/scripted/scriptedSeat.ts` (`ScriptedSeatController`, a
  `SeatController` like the mock and LLM seats). It reads the seat's own projection
  (`DecideContext.view`, the same data the LLM seats get as text): no hidden information.
- Games and numbers: `src/lib/play/agents/scripted/feGames.ts`, `feSummary.ts`.
- Tests: `npx vitest run src/lib/play/agents/scripted`.

## Run it

```bash
# Four scripted players at one table, 100 seeds, on Test 33's rule set
npx tsx scripts/agent-harness/scripted/run-fe.ts --data ../balance/z22a/game \
    --table fe4 --seeds 1-100 --out ../balance/scripted/fe4.json

# One scripted player against three mock:greedy seats (its seat moves with the seed: seed % 4)
npx tsx scripts/agent-harness/scripted/run-fe.ts --data ../balance/z22a/game \
    --table fe-vs-greedy --seeds 1-100 --out ../balance/scripted/fe-vs-greedy.json

# Any table, seats in seat order
npx tsx scripts/agent-harness/scripted/run-fe.ts --data ../balance/z22a/game \
    --seats script:fe,mock:random,script:fe,mock:greedy --seeds 1-20

# A/B test of two parameter sets: two seats each; every seed is played twice with the seats swapped
npx tsx scripts/agent-harness/scripted/run-fe.ts --data ../balance/z22a/game --table ab \
    --seeds 1-200 --variants '{"a":{},"b":{"chip":0.7}}'

# In the general harness (with transcripts; slower, it computes the LLM engine facts)
npx tsx scripts/agent-harness/run.ts --catalog ../balance/z22a/game --seats script:fe,mock:greedy
```

Options: `--data` (a design data folder, `local`, `frozen`, or a catalog JSON), `--table`
(`fe4`, `ab`, `fe-vs-greedy`, `fe-vs-random`, `fe-vs-first`) or `--seats`, `--seeds` (`1-100`,
`5,9,12`), `--jobs` (worker processes, default 8), `--params` (policy overrides, JSON),
`--variants` (for `ab`), `--out` (JSON file), `--quiet` (print the summary only).

A game depends only on its seed, the seats and the parameters: the same command gives the same
games. About 2 seconds per 4-player game; 100 games take about 20 seconds with 10 workers.

## The JSON result

- `summary`: games, finished, stop reasons, fallbacks (must be 0); end round (median, min, max);
  for the scripted seats: wins and win rate, final points, average points at rounds 8 / 16 / 24
  (a player keeps their final value after the game ends), average expected attack at rounds
  8 / 16 / 24, the median round and share of players reaching Fighter 5, Elementalist 5 and 10
  Exalted dice, kills per player by level (Abyss Lurker, Difficulty 1 / 2 / 3), fights, Arcane
  Blood taken, corruptions; `bySpec` per seat spec; `others` for the non-scripted seats.
- `games[]`: per game the seed, end round, winner, and per seat the spec, final points, points
  at every round (`vpByRound`), corruptions, fights and kills; for scripted seats also
  `scripted.byRound` (per round: points, dice by tier, expected attack, Fighter, Elementalist,
  Max Barrier), kills by level, and the rounds Fighter 5 / Elementalist 5 / 10 Exalted were
  reached.
