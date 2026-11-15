# Game packages

The website (https://arcspirits.com) runs on ONE published game-data package at a time. It never
reads working data: a change reaches players only when a package is published.

| Where | What it reads |
|---|---|
| Local game on the laptop (`npm run local`, port 5317) | the working data folder `~/ArcSpiritsArt/game`, live |
| Website | the live package in `packages/` (this repo), fixed at deploy time |

## Workflow

1. Change the data in `~/ArcSpiritsArt/game` (and the engine, if the change needs code) and play
   it in the local game.
2. Make a package (nothing goes live yet):

       npm run package:release -- 0.2.0 --notes "Sun spirits cost 2 runes; monsters have initiative"

   It checks the data with the engine (random players, no AI model), writes
   `packages/0.2.0/` and a change list against the live package. `--from <dir>` takes the data
   from another folder (for example an experiment folder).
3. Publish it:

       npm run package:publish -- 0.2.0

   It marks the package live, commits and pushes `main`. Vercel deploys the push in about two
   minutes. Engine code committed on `main` ships in the same deploy, so data and code cannot
   get out of step.
4. Roll back: `npm run package:publish -- 0.1.0` (any older version).

The site lists every package, which one is live, and its change list at `/versions`.

## What a package is

`packages/<version>/tables.json` (the design tables: spirits, classes, monsters, locations,
dice, guardians, rule switches…), `manifest.json` and `CHANGES.md`. A package is immutable.
`packages/index.json` lists them and names the live one.

Art is part of a release. `package:release` takes the latest local exports and icons in
`~/ArcSpiritsArt` (found the same way the local game finds them, so the web shows what the local
game shows), makes display-size WebP copies and uploads them to the play project's storage under
`game_assets/art/<art id>/`. Art with no local export (guardian mats, location backgrounds, dice)
is copied from the old project's bucket. It also rebuilds the printed monster card faces
(`static/monster-cards`). `--no-art` skips this and reuses the art of the live package.

## Before a release, when these change

- **Monster Barrier, Damage or rewards** (`monsters_v2.json`): remake the printed monster cards
  first: `python3 ~/niji-batch/tools/regen_monsters.py` (the niji-batch server must run on
  port 8787; code only, about a minute for all cards). The site shows a printed card only while
  its numbers match the game; a stale card is replaced by a plain drawn one. The release prints
  "card differs from the local row" for every card that still needs this.
- **A class rule** (a rule switch that changes what a class does): write the new text into
  `classes.json` as well. Players read the class text from the data, not from the rule switch.
- **A spirit's rune cost, awaken text or class text** (`hex_spirits.json`, `classes.json`): remake
  the spirit cards that print it (the card back shows the runes, the class name and the class
  text): `python3 ~/niji-batch/tools/regen_hexes.py x "" "Name One|Name Two"` (server on port
  8787; code only, about 4 s a card). The automatic remake is off on the laptop. To list the
  cards that differ from the data, compare each `references/hex_bases/<Name>/gen-back.spec.json`
  with `GET /api/game/hex-spirits`.
- **Spirit names**: `hex_spirits.json` `name` is the card name (since 2026-11-14 there is one name
  per spirit). `~/niji-batch/spirit-names.json` still maps the old long names and is no longer
  needed for them.

## Checking a deployment

    SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/package/web-smoke.mjs https://arcspirits.com

plays a whole game with the built-in bots over HTTP (guest sign-in, room, bots, postgame record).

## Limits to know

- A deploy changes the game data for rooms that are in progress. Publish when nobody is playing.
- Play data (accounts, rooms, finished games, replays) lives in the Supabase project
  `arc-spirits-play`; the game data does not.
