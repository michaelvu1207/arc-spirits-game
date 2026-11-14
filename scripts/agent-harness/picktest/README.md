# Pick test

A cheap balance check: instead of playing whole games, re-ask a model the SUMMON decisions that
AI players already made in recorded games, on changed game data, and count how often each spirit
is picked when it is offered. One model call per test (about 11k input tokens, mostly the rules
brief) instead of about 400 calls per seat per game.

How a test works:

1. The recorded game is replayed with the catalog it was played with, up to the summon decision.
2. The question is rebuilt with the harness's own code (`buildDecision`, `buildRulesBrief`) from
   the data folder you give (`--data`): spirit and class text, costs, awaken costs and the legal
   actions all come from that folder. Spirits already on the table are updated to the new data
   where it differs. The recent-events lines are the recorded ones.
3. The model gets it as a fresh question (rules brief + the decision, no strategy, no notebook,
   no plan note) and the harness's own parser reads the answer (one repair turn, like a seat).

A test is SKIPPED, not asked, when the changed data makes the recorded moment impossible: a spirit
in the hand or on the table was removed, a drawn spirit's new cost puts it in the other bag, or
the set of spirits you could summon (or the none / redraw options) changed. Smaller differences
are flagged and asked anyway (see `src/lib/play/agents/picktest/request.ts`).

## Desire (prompt `desire-v1`, the default)

Pick rate alone mixes two things. So in the same answer the model also scores EVERY offered
spirit 0-10 ("how much do you want this spirit for your board right now", plus a few words). The
pick is still parsed exactly as before. Each offer is also marked FIT or not: the board already has
2+ spirits of one of its origins, or 1+ of one of its classes when that class still has a higher
breakpoint to reach or scales per spirit ("1+"), or its awaken condition needs Fallen and the player
is Fallen (`src/lib/play/agents/picktest/desire.ts`). `refit <run>` recomputes the marks of a run
after the rule changes.

Per spirit: pick rate, average desire, pick rate and desire when it fits vs when it does not, and
the instant-pick rate (share of fitting offers scored >= 8 AND picked). Classes, checked in order:

- Generalist: pick rate at or above its group's pick rate (fair share: Abyss draws offer 3 and
  summon 1; Spirit World draws offer 4 and summon up to 2) AND desire >= 6.
- Build-around: otherwise, with >= 3 fitting offers, desire when it fits >= 7 OR instant-pick
  rate >= 35%.
- Dead: otherwise, with >= 3 fitting offers, desire when it fits below 4.
- Unclear: overall desire below 4 but fewer than 3 fitting offers (dead, or built around a board
  the records rarely reach). Ask more fitting decisions: `run --fit-only --spirit … --exclude <run>`.
- Situational: the rest.

`--prompt plain` gives the old question without scores. The prompts differ, so compare only runs
made with the same prompt (`compare` warns).

## Commands

Run from `~/arcspirits-harness/lab`. Output goes to `~/arcspirits-harness/experiments/picktest/`.

```sh
# 1. Index every summon decision of the finished recorded games (league, benchmark, tournament).
#    Writes decisions.jsonl, historic.csv / historic.json (pick rate when offered in the original
#    games) and extract-summary.json. No model calls.
npx tsx scripts/agent-harness/picktest/picktest.ts extract

# 2. Ask. Default model anthropic/claude-opus-5-5 on the Claude gateway (found in league.json /
#    benchmark/league.json), effort medium, 6 calls at a time. Resumable: run the same command
#    again to finish a stopped run.
npx tsx scripts/agent-harness/picktest/picktest.ts run --name before --data ~/ArcSpiritsArt/game --per-spirit 12 --n 600

#    Check a changed data folder first without any calls (prints valid / skipped counts):
npx tsx scripts/agent-harness/picktest/picktest.ts run --name after --data <changed dir> --points-from before --dry-run

#    The same decisions on the changed data (paired with "before"), only those offering a spirit:
npx tsx scripts/agent-harness/picktest/picktest.ts run --name after --data <changed dir> --points-from before --spirit "Aureate Runeweaver"

# 3. Compare two runs (markdown to stdout and runs/<B>/compare-<A>.md).
npx tsx scripts/agent-harness/picktest/picktest.ts compare before after

# 4. Desire table (2 axes, classes, Dead list with reasons) for one desire-v1 run:
npx tsx scripts/agent-harness/picktest/picktest.ts run --name desire-fit --fit-only --exclude desire-baseline --per-spirit 3 --spirit "Night Witch" …
npx tsx scripts/agent-harness/picktest/picktest.ts desire-report desire-baseline desire-fit --out ~/arcspirits-harness/experiments/picktest/desire-baseline.md

# 5. Full pick-rate table for one run (all spirits, by class, by group, reliability), e.g. the baseline:
npx tsx scripts/agent-harness/picktest/picktest.ts report baseline --noise noise-a,noise-b --out ~/arcspirits-harness/experiments/picktest/baseline.md
```

`run` options:

| Option | Default | Meaning |
|---|---|---|
| `--name` | (required) | run folder `runs/<name>/` |
| `--data` | `~/ArcSpiritsArt/game` | game-data folder (JSON tables) to build the question from; never written |
| `--model` | `anthropic/claude-opus-5-5` | `anthropic/…` or `openai-codex/…` only (subscription gateways); `openrouter/…` is refused |
| `--effort` | `medium` | reasoning effort sent to the gateway |
| `--prompt` | `desire` | `desire` (desire-v1: pick + a 0-10 score per offered spirit) or `plain` (pick only) |
| `--n` | 600 | most tests in the run |
| `--per-spirit` | 9 | stratified sample: each spirit gets up to this many decisions that offer it (rarest first) |
| `--spirit <name>` | all | only decisions that offer this spirit (repeatable) |
| `--seed` | 1 | sample seed |
| `--points-from <run>` | - | ask the decisions of another run (paired comparison) |
| `--same-questions-as <run>` | - | send that run's stored questions again byte for byte (noise test) |
| `--concurrency` | 6 | calls at a time |
| `--gateway <label>` | first matching | gateway label from league.json |
| `--dry-run` | off | prepare and validate only, no calls |

Files of a run (`experiments/picktest/runs/<name>/`): `config.json`, `plan.json` (decision keys),
`requests.jsonl` + `brief.txt` (the exact questions), `results.jsonl` (one line per test: offered
spirits, the pick, the model's reason, the original player's pick, flags), `summary.json`
(per-spirit rates with 95% intervals, agreement with the original players, tokens), `quota.jsonl`
(the gateway quota before and after).

## Good practice

- Compare runs made with the same harness code. The harness is still being edited (prompt wording
  changes); after a code change, re-run the "before" side for the spirits you test
  (`--points-from <old run> --spirit …`) right before the "after" side.
- Use `--points-from` so both sides ask the same decisions: then the paired line in `compare`
  shows how many answers changed, which is more sensitive than two independent rates.
- About 12 tests per spirit give a 95% interval of roughly ±25 points; a change is only clear
  when it is large (e.g. 0/12 to 6/12). Ask more decisions for the spirits you changed.
- Skips are reported per reason in `compare`; many `bag-changed` skips mean the change moved a
  spirit to the other bag, which a pick test cannot judge (no recorded draws offer it there).

## Limits

- It shows whether a spirit LOOKS worth taking at the moment of choice, not whether it wins.
- One cold question: no strategy or plan, so build-around spirits are judged without the plan.
- The game before the decision is the recorded (old-data) game: earlier choices, dice, Barrier,
  VP and class effects already applied are not replayed with the new data.
- Only spirits that were drawn in the records can be tested; draws depend on the old costs.
- Games the current engine no longer replays exactly are left out (`extract-summary.json`).
