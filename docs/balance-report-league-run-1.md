# Arc Spirits balance/strength report

## Pool summary — `../arc-league-run/ml/league/data/gen8/main-0/games-*.jsonl`

64 games; rounds mean 25.03 (p50 27, p90 30)

| candidate | seat-games | win % | mean VP | 1st % | corrupt % |
|---|---|---|---|---|---|
| main-0-gen7.json | 256 | 25.0 | 10.39 | 25.78 | 70.31 |

## League — `../arc-league-run/ml/league`

league-v1 | gen 8 | phase idle | 13 members | updated 2026-07-02T03:31:05.967Z

### Per-lane trajectory (Elo estimate / eval winrate)

| lane | gen | elo | win % | pairwise % | games | samples | promoted |
|---|---|---|---|---|---|---|---|
| league_exploiter-0 | 1 | 201 | 62.5 | 76.4 | 64 | 11385 | - |
| league_exploiter-0 | 2 | -103 | 16.67 | 35.4 | 64 | 11361 | - |
| league_exploiter-0 | 3 | -242 | 8.33 | 19.4 | 64 | 11214 | - |
| league_exploiter-0 | 4 | -140 | 8.33 | 30.6 | 64 | 10960 | - |
| league_exploiter-0 | 5 | -53 | 8.33 | 42.4 | 64 | 11026 | - |
| league_exploiter-0 | 6 | -48 | 4.17 | 43.1 | 64 | 10643 | - |
| league_exploiter-0 | 7 | 169 | 50.0 | 72.9 | 64 | 10982 | - |
| league_exploiter-0 | 8 | 310 | 75.0 | 86.1 | 64 | 11219 | - |
| main-0 | 1 | 300 | 75.0 | 85.4 | 64 | 11181 | - |
| main-0 | 2 | 390 | 83.33 | 91.0 | 64 | 11550 | - |
| main-0 | 3 | 282 | 66.67 | 84.0 | 64 | 10551 | - |
| main-0 | 4 | 221 | 66.67 | 78.5 | 64 | 11345 | - |
| main-0 | 5 | 250 | 70.83 | 81.2 | 64 | 11052 | - |
| main-0 | 6 | 291 | 75.0 | 84.7 | 64 | 11138 | - |
| main-0 | 7 | 242 | 62.5 | 80.6 | 64 | 11321 | - |
| main-0 | 8 | 242 | 75.0 | 80.6 | 64 | 11043 | - |
| main_exploiter-0 | 1 | 250 | 66.67 | 81.2 | 64 | 11533 | - |
| main_exploiter-0 | 2 | -364 | 4.17 | 10.4 | 64 | 11504 | - |
| main_exploiter-0 | 3 | -419 | 0.0 | 7.6 | 64 | 10919 | - |
| main_exploiter-0 | 4 | -453 | 0.0 | 6.2 | 64 | 9860 | - |
| main_exploiter-0 | 5 | -376 | 4.17 | 9.7 | 64 | 10234 | - |
| main_exploiter-0 | 6 | -495 | 0.0 | 4.9 | 64 | 10286 | - |
| main_exploiter-0 | 7 | -330 | 0.0 | 12.5 | 64 | 9888 | - |
| main_exploiter-0 | 8 | -473 | 0.0 | 5.6 | 64 | 10560 | - |

- **league_exploiter-0** Elo: 201 -> -103 -> -242 -> -140 -> -53 -> -48 -> 169 -> 310
- **main-0** Elo: 300 -> 390 -> 282 -> 221 -> 250 -> 291 -> 242 -> 242
- **main_exploiter-0** Elo: 250 -> -364 -> -419 -> -453 -> -376 -> -495 -> -330 -> -473

### PFSP matchup matrix (better-placement rate %, decided games)

| lane \ opponent | frozen-routeexecq-shared-allseat | frozen-traceq-damage-nearmiss | heur-cultivator | heur-hard | heur-insane | heur-medium | heur-paragon | heur-pvphunter | heur-rushpatient | heur-survivor | league_exploiter-0 | main-0 | main_exploiter-0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| league_exploiter-0 | 91.13% (136) | 92.62% (128) | 95.19% (192) | 75.68% (320) | 80.93% (208) | 78.34% (344) | 94.85% (144) | 40.12% (360) | 90.2% (160) | 94.83% (120) | - | - | - |
| main-0 | 100.0% (40) | 92.86% (72) | 95.12% (88) | 96.04% (216) | 92.14% (144) | 95.82% (256) | 100.0% (8) | 71.61% (1160) | 95.83% (48) | 94.64% (56) | 100.0% (8) | - | 100.0% (16) |
| main_exploiter-0 | - | - | - | 18.44% (192) | - | 20.11% (192) | - | 8.47% (192) | - | - | - | 78.68% (1536) | - |

### Training exposure (pool games by opponent)

| lane \ opponent | frozen-routeexecq-shared-allseat | frozen-traceq-damage-nearmiss | heur-cultivator | heur-hard | heur-insane | heur-medium | heur-paragon | heur-pvphunter | heur-rushpatient | heur-survivor | league_exploiter-0 | main-0 | main_exploiter-0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| league_exploiter-0 | 136 | 128 | 192 | 320 | 208 | 344 | 144 | 360 | 160 | 120 | - | - | - |
| main-0 | 40 | 72 | 88 | 216 | 144 | 256 | 8 | 1160 | 48 | 56 | 8 | - | 16 |
| main_exploiter-0 | - | - | - | 192 | - | 192 | - | 192 | - | - | - | 1536 | - |

### Corruption attractor (finalStatus==3), training pools per lane/gen

| lane | gen | games | corrupt seats % | winner corrupt % |
|---|---|---|---|---|
| league_exploiter-0 | 1 | 64 | 35.94 | 82.81 |
| league_exploiter-0 | 2 | 64 | 37.5 | 98.44 |
| league_exploiter-0 | 3 | 64 | 27.73 | 78.12 |
| league_exploiter-0 | 4 | 64 | 28.12 | 75.0 |
| league_exploiter-0 | 5 | 64 | 26.17 | 87.5 |
| league_exploiter-0 | 6 | 64 | 24.22 | 70.31 |
| league_exploiter-0 | 7 | 64 | 33.59 | 90.62 |
| league_exploiter-0 | 8 | 64 | 27.73 | 92.19 |
| main-0 | 1 | 64 | 44.92 | 87.5 |
| main-0 | 2 | 64 | 58.59 | 92.19 |
| main-0 | 3 | 64 | 58.98 | 100.0 |
| main-0 | 4 | 64 | 71.48 | 100.0 |
| main-0 | 5 | 64 | 71.88 | 96.88 |
| main-0 | 6 | 64 | 77.34 | 98.44 |
| main-0 | 7 | 64 | 70.7 | 98.44 |
| main-0 | 8 | 64 | 70.31 | 100.0 |
| main_exploiter-0 | 1 | 64 | 25.0 | 95.31 |
| main_exploiter-0 | 2 | 64 | 25.0 | 93.75 |
| main_exploiter-0 | 3 | 64 | 24.61 | 76.56 |
| main_exploiter-0 | 4 | 64 | 15.23 | 23.44 |
| main_exploiter-0 | 5 | 64 | 21.09 | 37.5 |
| main_exploiter-0 | 6 | 64 | 19.53 | 53.12 |
| main_exploiter-0 | 7 | 64 | 15.62 | 39.06 |
| main_exploiter-0 | 8 | 64 | 23.05 | 70.31 |

_corrupt seats % = share of ALL seats in the lane's pool games (GameSummary has no per-seat policy attribution); winner corrupt % = share of finished games whose winner ended corrupted._

## Gauntlet (fixed gauntlet-v1 anchors) — `ml/gauntlet_results`

| candidate | elo | score % | games | run | win % | mean place | worst anchor | best anchor |
|---|---|---|---|---|---|---|---|---|
| ml--policy-weights | 221 | 78.2 | 800 | full | 59.8 | 1.49375 | traceq-damage-nearmiss (12) | survivor (354) |
| routeexecq-shared-allseat-candidate-20260701ttra | 192 | 75.1 | 800 | full | 54.8 | 1.5625 | traceq-damage-nearmiss (-54) | survivor (350) |
| profile-pvphunter | 190 | 74.9 | 800 | full | 53.9 | 1.6225 | routeexecq-shared-allseat (-57) | paragon (379) |

_no nightly history.jsonl yet — table above is per-candidate results._

