# Scripted players (`script:fe`, `script:beast`)

Fixed, rule-based players with no model calls. Each plays one build only and is meant as a fixed
baseline: when the rules change, play it again and compare.

- `script:fe`, Fighter + Elementalist: Fighter 5 for attack dice on Rest, Elementalist 5 for dice
  upgrades, points from killing monsters. Policy: `src/lib/play/agents/scripted/fePolicy.ts`.
- `script:beast`, Beast: three spirits of one origin so that Cultivate pays a rune, runes spent on
  Beast Spirit Augments at the Water Region, Beast spirits from summons, Max Barrier from
  Cultivator traits and Powers, points from killing monsters with Beast's flat damage. It never
  attacks a player. Policy: `beastPolicy.ts`; its planning model: `beastPlan.ts`.

Shared:

- Seat: `src/lib/play/agents/scripted/scriptedSeat.ts` (`ScriptedSeatController`, a
  `SeatController` like the mock and LLM seats). It reads the seat's own projection
  (`DecideContext.view`, the same data the LLM seats get as text): no hidden information.
- Games and numbers: `feGames.ts` (one table, one seed), `feSummary.ts` (averages).
- Tests: `npx vitest run src/lib/play/agents/scripted`.

## Run it

```bash
DATA=../balance/scripted/rules-2026-11-22a/game     # a design data folder

# Four Beast players at one table, 100 seeds
npx tsx scripts/agent-harness/scripted/run-scripted.ts --data $DATA --table beast4 \
    --seeds 1-100 --out ../balance/scripted/beast4.json

# Two Beast and two Fighter + Elementalist players, seats alternating. Every seed is played
# twice, the second time with the two kinds' seats swapped.
npx tsx scripts/agent-harness/scripted/run-scripted.ts --data $DATA --table beast-fe --seeds 1-100

# One Beast player against three Fighter + Elementalist players (its seat is seed % 4)
npx tsx scripts/agent-harness/scripted/run-scripted.ts --data $DATA --table beast-vs-fe --seeds 1-100

# Four Fighter + Elementalist players (run-fe.ts is the same runner with this table as default)
npx tsx scripts/agent-harness/scripted/run-fe.ts --data $DATA --table fe4 --seeds 1-100

# One scripted player against three mock seats (its seat is seed % 4)
npx tsx scripts/agent-harness/scripted/run-scripted.ts --data $DATA --table beast-vs-greedy --seeds 1-100

# Any table, seats in seat order
npx tsx scripts/agent-harness/scripted/run-scripted.ts --data $DATA \
    --seats script:beast,mock:random,script:fe,mock:greedy --seeds 1-20

# A/B test of two parameter sets of one policy: two seats each, every seed played twice with
# the seats swapped
npx tsx scripts/agent-harness/scripted/run-scripted.ts --data $DATA --table ab --policy beast \
    --seeds 1-100 --variants '{"a":{},"b":{"pace":2}}'

# In the general harness (with transcripts; slower, it computes the LLM engine facts)
npx tsx scripts/agent-harness/run.ts --catalog $DATA --seats script:beast,script:fe,mock:greedy
```

Options: `--data` (a design data folder, `local`, `frozen`, or a catalog JSON); `--table`
(`fe4`, `beast4`, `beast-fe`, `beast-vs-fe`, `fe-vs-beast`, `fe-vs-greedy|random|first`,
`beast-vs-greedy|random|first`, `ab`) or `--seats`; `--policy` (`fe` or `beast`, for `ab`);
`--seeds` (`1-100`, `5,9,12`); `--jobs` (worker processes, default 8); `--params` (policy
overrides for every scripted seat, JSON); `--variants` (named overrides: for `ab`, or for seats
written `script:beast#name`); `--out` (JSON file); `--quiet` (print the summary only).

A game depends only on its seed, the seats and the parameters: the same command gives the same
games. A four-player game takes 2 to 5 seconds of processor time (the Beast player plans ahead,
so it is the slower one); 100 games take about 40 seconds with 11 workers.

## The JSON result

- `summary`: games, finished, stop reasons, fallbacks (must be 0), end round (median, min, max).
  - `byKind`: per seat kind (`script:beast`, `script:fe`, `mock:…`; a variant counts under its
    kind): players, wins, win share, final points, corruptions per player, and the average
    points at rounds 4 / 8 / 12 / 16 / 20 / 22 / 24. For the scripted kinds also, at the same
    rounds: the engine's expected attack (the dice's average plus 1 per Beast trait), attack
    dice by tier, Beast / Fighter / Elementalist trait counts, Barrier and Max Barrier; and the
    kills per player by level (Abyss Lurker, Difficulty 1 / 2 / 3) and fights per player. A
    player keeps the final value after the game ends.
  - `scripted`: all scripted seats together (wins, final points, points and attack at rounds
    8 / 16 / 24, the round and share of players reaching Fighter 5, Elementalist 5 and 10
    Exalted dice, kills, fights, Arcane Blood taken, corruptions).
  - `bySpec`: per seat spec (the two sides of an A/B test); `others`: the non-scripted seats.
- `games[]`: per game the seed, end round, winner, and per seat the spec, final points, points
  at every round (`vpByRound`), corruptions, fights and kills; for scripted seats also
  `scripted.byRound` (the seat's state at the end of each round: points, dice by tier, expected
  attack, the dice's part of it, Beast, Fighter, Elementalist, Barrier, Max Barrier), kills by
  level, fights started, and the rounds Fighter 5 / Elementalist 5 / 10 Exalted were reached.

Round states and kills are read from the game state after every command, so they are exact
also when the seat's last moves of a round were forced (one legal action).

## How the Beast player decides

`beastPlan.ts` reduces the seat's own board to a few numbers: damage, Barrier, Max Barrier,
runes, spirits that can still take an augment, the monster cards in hand and the cards left in
the decks. A round in that model is one of: fight at the Arcane Abyss, Rest, Summon and buy
augments, Cultivate. For every option the player is offered, the model answers "how many points
would this board have by the expected end of the game": it tries every choice for the next few
rounds, then plays on by a fixed habit (fight when the Barrier allows it, else Rest). The option
with the most points wins. Points count for slightly less each round later, so nothing is put
off.

- Every rule number comes from the catalog or the engine: dice faces, the Barrier a Rest
  restores, the Cultivator ladder, Beast's damage per trait, monster cards and rewards, deck
  sizes, the Spirit World bag, the carry limit, the winning score. The amounts of the Navigation
  Powers are the exception: the engine keeps them as literals in `navigationPowerEffects.ts`,
  so `beastPolicy.ts` repeats them in one table (`POWER`).
- It never takes a fight whose hit is as large as its Barrier (monsters strike first).
- Random things are replaced by their expectation: a draw from a monster deck is the better of
  two cards, a Summon adds the expected number of Beast spirits.
- Outside the plan it takes a safe default: it declines trades, passes encounters, keeps
  relics it has no use for, and answers other classes' decision cards with Max Barrier, a Beast
  augment or "no". It leaves Arcane spirits face-down (parameter `awaken`; awakening them made
  no measurable difference).
- Limits: it knows only Beast, Cultivator, Monster Hunter and Battle Adept among the classes;
  it looks three rounds ahead, so a build that pays only after four or more rounds is not
  found; it never attacks a player and never chooses a corruption.

The tunable numbers are `DEFAULT_BEAST_PARAMS` in `beastPolicy.ts` (each has a comment).
