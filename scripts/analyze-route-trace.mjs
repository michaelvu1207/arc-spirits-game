#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function usage() {
	console.error(`Usage: node scripts/analyze-route-trace.mjs [--out path] trace.json [...trace.json]

Analyzes AZEVAL route-proof trace files written by scripts/run-arc-route-proof-matrix.sh.
`);
	process.exit(2);
}

const args = process.argv.slice(2);
let outPath = '';
const inputs = [];
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === '--out') {
		outPath = args[++i] ?? '';
		if (!outPath) usage();
	} else if (arg === '-h' || arg === '--help') {
		usage();
	} else {
		inputs.push(arg);
	}
}
if (inputs.length === 0) usage();

const round2 = (n) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const pct = (num, den) => round2((100 * num) / Math.max(1, den));
const avg = (xs) => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;
const maxOf = (xs) => xs.length ? Math.max(...xs) : 0;
const minOf = (xs) => xs.length ? Math.min(...xs) : 0;
const countIssues = (records) => {
	const counts = {};
	for (const record of records) {
		for (const issue of record.issues) counts[issue] = (counts[issue] ?? 0) + 1;
	}
	return counts;
};

function readTraceFile(path) {
	const payload = JSON.parse(readFileSync(path, 'utf8'));
	const tracedGames = Array.isArray(payload)
		? payload
		: Array.isArray(payload.tracedGames)
			? payload.tracedGames
			: [];
	return tracedGames.flatMap((game) => expandTraceGame(game, path));
}

function expandTraceGame(game, path) {
	const trace = Array.isArray(game.trace) ? game.trace : [];
	const roleBySeat = game.seatNames && typeof game.seatNames === 'object'
		? game.seatNames
		: game.roleBySeat && typeof game.roleBySeat === 'object'
			? game.roleBySeat
			: {};
	const tracedSeats = Array.isArray(game.tracedSeats) && game.tracedSeats.length > 0
		? game.tracedSeats
		: game.plannerSeat
			? [game.plannerSeat]
			: [];
	const statsBySeat = game.plannerStatsBySeat && typeof game.plannerStatsBySeat === 'object'
		? game.plannerStatsBySeat
		: null;
	if (statsBySeat && tracedSeats.length > 1) {
		return tracedSeats.map((seat) => ({
			...game,
			sourcePath: path,
			sourcePlannerSeat: game.plannerSeat,
			plannerSeat: seat,
			roleName: roleBySeat[seat] ?? (seat === game.plannerSeat ? 'planner' : 'unknown'),
			tracedSeats: [seat],
			vp: game.finalVP?.[seat] ?? game.vp,
			plannerStats: statsBySeat[seat] ?? game.plannerStats,
			trace: trace.filter((event) => event.seat === seat)
		}));
	}
	const seat = game.plannerSeat;
	return [{
		...game,
		sourcePath: path,
		sourcePlannerSeat: game.plannerSeat,
		roleName: seat ? roleBySeat[seat] ?? 'planner' : 'unknown',
		trace: seat ? trace.filter((event) => !event.seat || event.seat === seat) : trace
	}];
}

function commandDestination(command) {
	const match = /^lockNavigation:(.+)$/.exec(command ?? '');
	return match?.[1] ?? '';
}

function vpGainEvents(trace) {
	const gains = [];
	let prev = trace[0]?.vp ?? 0;
	for (const event of trace) {
		const vp = event.vp ?? 0;
		if (vp > prev) gains.push({ round: event.round ?? 0, vp, delta: vp - prev });
		prev = Math.max(prev, vp);
	}
	return gains;
}

function sameDestinationRuns(events) {
	const runs = [];
	let current = null;
	for (const event of events) {
		const destination = commandDestination(event.command);
		if (!destination) continue;
		if (!current || current.destination !== destination) {
			current = { destination, startRound: event.round ?? 0, endRound: event.round ?? 0, count: 1 };
			runs.push(current);
		} else {
			current.endRound = event.round ?? current.endRound;
			current.count++;
		}
	}
	return runs;
}

function classifyGame(game) {
	const stats = game.plannerStats ?? {};
	const trace = Array.isArray(game.trace) ? game.trace : [];
	const vp = Number(game.vp ?? stats.vp ?? 0);
	const navigationEvents = trace.filter((event) => event.phase === 'navigation');
	const combatEvents = trace.filter((event) => event.command === 'startCombat');
	const rewardEvents = trace.filter((event) => String(event.command ?? '').startsWith('resolveMonsterReward'));
	const pvpEvents = trace.filter((event) => event.command === 'initiatePvp');
	const pvpOpportunityEvents = trace.filter((event) => event.pvpOpportunity);
	const missedPvpEvents = pvpOpportunityEvents.filter((event) => event.command !== 'initiatePvp');
	const hardMonsterPvpEvents = pvpOpportunityEvents.filter((event) => event.pvpHardMonsterWindow);
	const goodTargetPivotEvents = pvpOpportunityEvents.filter((event) => event.pvpGoodTargetPivotWindow);
	const maxTracePvpBestTargetVp = maxOf(trace.map((event) => event.pvpBestTargetVp ?? 0));
	const maxTraceBestGoodTargetVp = maxOf(navigationEvents.map((event) => event.bestGoodTargetVp ?? 0));
	const gains = vpGainEvents(trace);
	const lastGain = gains.at(-1) ?? null;
	const lastVpGainRound = gains.at(-1)?.round ?? 0;
	const firstCombatRound = combatEvents[0]?.round ?? 0;
	const lastCombatRound = combatEvents.at(-1)?.round ?? 0;
	const abyssNavigation = navigationEvents.filter((event) => commandDestination(event.command) === 'Arcane Abyss');
	const firstHp4Event = trace.find((event) => (event.monsterMaxHp ?? event.monsterHp ?? 0) >= 4);
	const hp4Events = trace.filter((event) => (event.monsterMaxHp ?? event.monsterHp ?? 0) >= 4);
	const hp4Navigation = hp4Events.filter((event) => event.phase === 'navigation');
	const hp4Unsafe = hp4Navigation.filter((event) => (event.cleanKillProb ?? 0) < 0.5);
	const hp4FirepowerUnsafe = hp4Navigation.filter((event) => (event.firepowerKillProb ?? 0) < 0.5);
	const hp4SurvivalUnsafe = hp4Navigation.filter((event) => {
		const target = (event.monsterDamage ?? 0) + 1;
		return target > 0 && (event.barrier ?? 0) < target;
	});
	const hp4MaxBarrierUnsafe = hp4Navigation.filter((event) => {
		const target = (event.monsterDamage ?? 0) + 1;
		return target > 0 && (event.maxBarrier ?? 0) < target;
	});
	const postPlateauNavigation = lastVpGainRound > 0
		? navigationEvents.filter((event) => (event.round ?? 0) > lastVpGainRound)
		: [];
	const postPlateauRuns = sameDestinationRuns(postPlateauNavigation).sort((a, b) => b.count - a.count);
	const lowTail = vp < 18;
	const midTail = vp >= 18 && vp < 24;
	const high = vp >= 24;
	const farmMiss = (stats.missedFarmOpportunityVp ?? 0) > 0 || (stats.missedFarmableNavs ?? 0) > 0;
	const maxBarrier = stats.maxBarrier ?? maxOf(trace.map((event) => event.maxBarrier ?? 0));
	const maxCurrentBarrier = stats.maxCurrentBarrier ?? maxOf(trace.map((event) => event.barrier ?? 0));
	const maxAttack = stats.maxExpectedAttack ?? maxOf(trace.map((event) => event.expectedAttack ?? 0));
	const maxDice = stats.maxAttackDice ?? maxOf(trace.map((event) => event.attackDice ?? 0));
	const maxCultivator = stats.maxCultivator ?? maxOf(trace.map((event) => event.cultivator ?? 0));
	const kills = stats.kills ?? rewardEvents.length;
	const pvpOpportunities = stats.pvpOpportunities ?? pvpOpportunityEvents.length;
	const pvpAttacks = stats.pvpAttacks ?? pvpEvents.length;
	const pvpVp = stats.pvpVp ?? pvpAttacks * 3;
	const missedPvpOpportunities = stats.missedPvpOpportunities ?? missedPvpEvents.length;
	const pvpBestTargetVp = Math.max(stats.pvpBestTargetVp ?? 0, maxTracePvpBestTargetVp);
	const pvpHardMonsterOpportunities = stats.pvpHardMonsterOpportunities ?? hardMonsterPvpEvents.length;
	const pvpHardMonsterAttacks = stats.pvpHardMonsterAttacks ?? pvpEvents.filter((event) => event.pvpHardMonsterWindow).length;
	const missedPvpHardMonsterOpportunities =
		stats.missedPvpHardMonsterOpportunities ??
		hardMonsterPvpEvents.filter((event) => event.command !== 'initiatePvp').length;
	const pvpGoodTargetPivotOpportunities = stats.pvpGoodTargetPivotOpportunities ?? goodTargetPivotEvents.length;
	const pvpGoodTargetPivotAttacks = stats.pvpGoodTargetPivotAttacks ?? pvpEvents.filter((event) => event.pvpGoodTargetPivotWindow).length;
	const missedPvpGoodTargetPivotOpportunities =
		stats.missedPvpGoodTargetPivotOpportunities ??
		goodTargetPivotEvents.filter((event) => event.command !== 'initiatePvp').length;
	const pvpGoodTargetPivotBestTargetVp = Math.max(
		stats.pvpGoodTargetPivotBestTargetVp ?? 0,
		maxOf(goodTargetPivotEvents.map((event) => event.pvpBestTargetVp ?? 0))
	);
	const issues = [];
	if (farmMiss) issues.push('missed-farm-window');
	if (kills <= 5 && (stats.farmOpportunityVp ?? 0) >= 12 && !farmMiss) issues.push('low-rung-farmed-but-not-extended');
	if (firstHp4Event && hp4Unsafe.length > 0) issues.push('hp4-wall');
	if (firstHp4Event && hp4FirepowerUnsafe.length >= Math.max(1, Math.ceil(hp4Navigation.length * 0.4))) issues.push('hp4-firepower-deficit');
	if (firstHp4Event && hp4SurvivalUnsafe.length >= Math.max(1, Math.ceil(hp4Navigation.length * 0.4))) issues.push('hp4-current-barrier-deficit');
	if (firstHp4Event && hp4MaxBarrierUnsafe.length >= Math.max(1, Math.ceil(hp4Navigation.length * 0.4))) issues.push('hp4-max-barrier-deficit');
	if (maxCultivator < 2) issues.push('low-cultivator');
	if (maxDice < 1) issues.push('low-attack-dice');
	if (maxAttack < 4) issues.push('low-attack');
	if (postPlateauNavigation.length >= 8) issues.push('post-vp-plateau-navigation-churn');
	if (missedPvpHardMonsterOpportunities > 0) issues.push('missed-hp4-pvp-pivot');
	if (missedPvpGoodTargetPivotOpportunities > 0) issues.push('missed-good-target-pvp-pivot');
	if (pvpAttacks > 0 && pvpBestTargetVp > 0 && pvpBestTargetVp < 12) issues.push('low-value-pvp-targets');
	if (pvpOpportunities === 0 && maxTraceBestGoodTargetVp >= 12 && (stats.lastStatusLevel ?? game.status ?? 0) >= 3) {
		issues.push('fallen-good-target-not-met');
	}
	if (lowTail && issues.length === 0) issues.push('unclassified-low-tail');

	return {
			sourcePath: game.sourcePath,
			game: game.game,
			plannerSeat: game.plannerSeat,
			roleName: game.roleName ?? 'unknown',
			vp,
		status: game.status ?? stats.lastStatusLevel ?? 0,
		rounds: game.rounds ?? maxOf(trace.map((event) => event.round ?? 0)),
		band: lowTail ? 'low' : midTail ? 'mid' : high ? 'high' : 'unknown',
		reached30: vp >= 30,
		kills,
		abyssNavs: stats.abyss ?? abyssNavigation.length,
		firstAbyssRound: abyssNavigation[0]?.round ?? 0,
		firstCombatRound,
		lastCombatRound,
		lastVpGainRound,
		lastVpGain: lastGain ? {
			round: lastGain.round,
			vp: lastGain.vp,
			delta: lastGain.delta
		} : null,
		firstHp4Round: firstHp4Event?.round ?? 0,
		firstHp4NavigationRound: hp4Navigation[0]?.round ?? 0,
		maxAttack: round2(maxAttack),
		maxBarrier,
		maxCurrentBarrier,
		maxAttackDice: maxDice,
		maxSpiritAnimal: stats.maxSpiritAnimal ?? maxOf(trace.map((event) => event.spiritAnimal ?? 0)),
		maxCultivator,
		farmableNavs: stats.farmableNavs ?? navigationEvents.filter((event) => event.farmable).length,
		missedFarmableNavs: stats.missedFarmableNavs ?? 0,
		farmOpportunityVp: round2(stats.farmOpportunityVp ?? 0),
		missedFarmOpportunityVp: round2(stats.missedFarmOpportunityVp ?? 0),
		hp4NavigationEvents: hp4Navigation.length,
		hp4UnsafeEvents: hp4Unsafe.length,
		hp4FirepowerUnsafeEvents: hp4FirepowerUnsafe.length,
		hp4SurvivalUnsafeEvents: hp4SurvivalUnsafe.length,
		hp4MaxBarrierUnsafeEvents: hp4MaxBarrierUnsafe.length,
		postPlateauNavigationEvents: postPlateauNavigation.length,
		postPlateauTopRun: postPlateauRuns[0] ?? null,
			navigationDestinations: stats.navigationDestinations ?? {},
			locationInteractions: stats.locationInteractions ?? {},
			pvp: {
				opportunities: pvpOpportunities,
				attacks: pvpAttacks,
				vp: pvpVp,
				missedOpportunities: missedPvpOpportunities,
				bestTargetVp: pvpBestTargetVp,
				targetVp: round2(stats.pvpTargetVp ?? pvpOpportunityEvents.reduce((sum, event) => sum + (event.pvpTargetVp ?? 0), 0)),
				highValueOpportunities: stats.pvpHighValueOpportunities ?? pvpOpportunityEvents.filter((event) => (event.pvpBestTargetVp ?? 0) >= 12).length,
				hardMonsterOpportunities: pvpHardMonsterOpportunities,
				hardMonsterAttacks: pvpHardMonsterAttacks,
				hardMonsterVp: stats.pvpHardMonsterVp ?? pvpHardMonsterAttacks * 3,
				missedHardMonsterOpportunities: missedPvpHardMonsterOpportunities,
				hardMonsterBestTargetVp: Math.max(stats.pvpHardMonsterBestTargetVp ?? 0, maxOf(hardMonsterPvpEvents.map((event) => event.pvpBestTargetVp ?? 0))),
				goodTargetPivotOpportunities: pvpGoodTargetPivotOpportunities,
				goodTargetPivotAttacks: pvpGoodTargetPivotAttacks,
				goodTargetPivotVp: stats.pvpGoodTargetPivotVp ?? pvpGoodTargetPivotAttacks * 3,
				missedGoodTargetPivotOpportunities: missedPvpGoodTargetPivotOpportunities,
				goodTargetPivotBestTargetVp: pvpGoodTargetPivotBestTargetVp,
				maxPredictedGoodTargetVp: maxTraceBestGoodTargetVp
			},
			issues
		};
	}

function summarizeFinishGroup(records) {
	return {
		games: records.length,
		avgVp: round2(avg(records.map((record) => record.vp))),
		minVp: minOf(records.map((record) => record.vp)),
		maxVp: maxOf(records.map((record) => record.vp)),
		avgRounds: round2(avg(records.map((record) => record.rounds))),
		avgKills: round2(avg(records.map((record) => record.kills))),
		avgAbyssNavs: round2(avg(records.map((record) => record.abyssNavs))),
		avgFirstAbyssRound: round2(avg(records.map((record) => record.firstAbyssRound || 31))),
		avgFirstHp4Round: round2(avg(records.map((record) => record.firstHp4Round || 31))),
		avgLastVpGainRound: round2(avg(records.map((record) => record.lastVpGainRound || 31))),
		avgMissedFarmOpportunityVp: round2(avg(records.map((record) => record.missedFarmOpportunityVp))),
		avgMaxAttack: round2(avg(records.map((record) => record.maxAttack))),
		avgMaxBarrier: round2(avg(records.map((record) => record.maxBarrier))),
		avgMaxCurrentBarrier: round2(avg(records.map((record) => record.maxCurrentBarrier))),
		avgMaxAttackDice: round2(avg(records.map((record) => record.maxAttackDice))),
		avgMaxSpiritAnimal: round2(avg(records.map((record) => record.maxSpiritAnimal))),
		avgMaxCultivator: round2(avg(records.map((record) => record.maxCultivator))),
		issueCounts: countIssues(records)
	};
}

function summarizeRole(records) {
	return {
		games: records.length,
		avgVp: round2(avg(records.map((record) => record.vp))),
		reach30Pct: pct(records.filter((record) => record.reached30).length, records.length),
		avgKills: round2(avg(records.map((record) => record.kills))),
		avgMaxAttack: round2(avg(records.map((record) => record.maxAttack))),
		avgMaxBarrier: round2(avg(records.map((record) => record.maxBarrier))),
		avgMaxCurrentBarrier: round2(avg(records.map((record) => record.maxCurrentBarrier))),
		avgPvpVp: round2(avg(records.map((record) => record.pvp.vp))),
		avgPvpAttacks: round2(avg(records.map((record) => record.pvp.attacks))),
		bestPvpTargetVp: maxOf(records.map((record) => record.pvp.bestTargetVp)),
		avgGoodTargetPivotVp: round2(avg(records.map((record) => record.pvp.goodTargetPivotVp))),
		goodTargetPivotBestTargetVp: maxOf(records.map((record) => record.pvp.goodTargetPivotBestTargetVp)),
		issueCounts: countIssues(records)
	};
}

function diffGroup(a, b, key) {
	return round2((a[key] ?? 0) - (b[key] ?? 0));
}

function summarize(records) {
	const bandCounts = {};
	for (const record of records) {
		bandCounts[record.band] = (bandCounts[record.band] ?? 0) + 1;
	}
	const issueCounts = countIssues(records);
	const low = records.filter((record) => record.band === 'low');
	const mid = records.filter((record) => record.band === 'mid');
	const high = records.filter((record) => record.band === 'high');
	const roleGroups = {};
	for (const record of records) {
		const role = record.roleName ?? 'unknown';
		(roleGroups[role] ??= []).push(record);
	}
	const roles = Object.fromEntries(
		Object.entries(roleGroups)
			.sort((a, b) => avg(b[1].map((record) => record.vp)) - avg(a[1].map((record) => record.vp)))
			.map(([role, roleRecords]) => [role, summarizeRole(roleRecords)])
	);
	const lowIssueCounts = countIssues(low);
	const finish = records.filter((record) => record.reached30);
	const nearFinish = records.filter((record) => record.vp >= 28 && record.vp < 30);
	const finishGroup = summarizeFinishGroup(finish);
	const nearFinishGroup = summarizeFinishGroup(nearFinish);
	const highTail = {
		finishGames: finish.length,
		nearFinishGames: nearFinish.length,
		finishPctAmongVp28Plus: pct(finish.length, finish.length + nearFinish.length),
		finish: finishGroup,
		nearFinish: nearFinishGroup,
		finishMinusNearFinish: {
			avgKills: diffGroup(finishGroup, nearFinishGroup, 'avgKills'),
			avgAbyssNavs: diffGroup(finishGroup, nearFinishGroup, 'avgAbyssNavs'),
			avgFirstHp4Round: diffGroup(finishGroup, nearFinishGroup, 'avgFirstHp4Round'),
			avgLastVpGainRound: diffGroup(finishGroup, nearFinishGroup, 'avgLastVpGainRound'),
			avgMissedFarmOpportunityVp: diffGroup(finishGroup, nearFinishGroup, 'avgMissedFarmOpportunityVp'),
			avgMaxAttack: diffGroup(finishGroup, nearFinishGroup, 'avgMaxAttack'),
			avgMaxCurrentBarrier: diffGroup(finishGroup, nearFinishGroup, 'avgMaxCurrentBarrier')
		}
	};
	const recommendations = [];
	if ((lowIssueCounts['missed-farm-window'] ?? 0) === 0 && (lowIssueCounts['hp4-wall'] ?? 0) > 0) {
		recommendations.push('Low-tail is not primarily missed Abyss farm. Focus next collector/gate on HP4+ wall execution.');
	}
	if ((lowIssueCounts['hp4-current-barrier-deficit'] ?? 0) > 0) {
		recommendations.push('Add or strengthen restore-timing micro for states with enough damage but current barrier below monster damage + 1.');
	}
	if ((lowIssueCounts['hp4-max-barrier-deficit'] ?? 0) > 0 || (lowIssueCounts['low-cultivator'] ?? 0) > 0) {
		recommendations.push('Add Cultivator/max-barrier acquisition and preservation labels before more farm-now training.');
	}
	if ((lowIssueCounts['hp4-firepower-deficit'] ?? 0) > 0 || (lowIssueCounts['low-attack'] ?? 0) > 0) {
		recommendations.push('Add damage assembly labels for the transition from HP1/HP2 farming to HP4 monsters.');
	}
		if ((lowIssueCounts['post-vp-plateau-navigation-churn'] ?? 0) > 0) {
			recommendations.push('Audit navigation priors after the last VP gain; repeated build destinations can hide a stalled micro/action-value loop.');
		}
		if ((issueCounts['missed-good-target-pvp-pivot'] ?? 0) > 0) {
			recommendations.push('The bot is missing legal high-value Good-target PvP windows. Add policy-correction labels around initiatePvp/passEncounter choices in HP4+ states.');
		}
		if ((issueCounts['fallen-good-target-not-met'] ?? 0) > 0) {
			recommendations.push('Fallen bots can see valuable Good targets but do not meet them. Mine navigation labels for predicted target interception, not more encounter-force micro.');
		}
		if ((issueCounts['low-value-pvp-targets'] ?? 0) > 0 && (issueCounts['missed-good-target-pvp-pivot'] ?? 0) === 0) {
			recommendations.push('PvP is firing, but targets are low value. Improve Good target-field quality or target selection before adding more attack force.');
		}
	if (finish.length > 0 && nearFinish.length > 0) {
		recommendations.push('Clean route is possible in the traced high tail. Focus next collector on converting VP28-29 near-misses into one more HP4 kill, not proving route existence again.');
	}
	if (finish.length > 0 && nearFinish.length > 0 && highTail.finishMinusNearFinish.avgKills >= 0.5) {
		recommendations.push('VP28-29 near-misses average at least half a kill below finishers. Train success-prefix/contrast labels around the final HP4 reward-life cycle.');
	}
	if (nearFinish.length > 0 && (nearFinishGroup.issueCounts['missed-farm-window'] ?? 0) > 0) {
		recommendations.push('Some high-tail near-misses still skip farmable VP. Keep missed-farm checks active during finish-loop training.');
	}
	return {
		generatedAt: new Date().toISOString(),
		inputs,
		games: records.length,
		vp: {
			avg: round2(avg(records.map((record) => record.vp))),
			min: minOf(records.map((record) => record.vp)),
			max: maxOf(records.map((record) => record.vp)),
			lowTailPct: pct(low.length, records.length),
			midTailPct: pct(mid.length, records.length),
			highPct: pct(high.length, records.length)
		},
		build: {
			avgKills: round2(avg(records.map((record) => record.kills))),
			avgAbyssNavs: round2(avg(records.map((record) => record.abyssNavs))),
			avgMaxAttack: round2(avg(records.map((record) => record.maxAttack))),
			avgMaxBarrier: round2(avg(records.map((record) => record.maxBarrier))),
			avgMaxCurrentBarrier: round2(avg(records.map((record) => record.maxCurrentBarrier))),
			avgMaxAttackDice: round2(avg(records.map((record) => record.maxAttackDice))),
			avgMaxCultivator: round2(avg(records.map((record) => record.maxCultivator)))
		},
			farm: {
				avgFarmOpportunityVp: round2(avg(records.map((record) => record.farmOpportunityVp))),
				avgMissedFarmOpportunityVp: round2(avg(records.map((record) => record.missedFarmOpportunityVp))),
				missedFarmGames: records.filter((record) => record.missedFarmOpportunityVp > 0).length
			},
			pvp: {
				avgOpportunities: round2(avg(records.map((record) => record.pvp.opportunities))),
				avgAttacks: round2(avg(records.map((record) => record.pvp.attacks))),
				avgVp: round2(avg(records.map((record) => record.pvp.vp))),
				avgMissedOpportunities: round2(avg(records.map((record) => record.pvp.missedOpportunities))),
				bestTargetVp: maxOf(records.map((record) => record.pvp.bestTargetVp)),
				avgHighValueOpportunities: round2(avg(records.map((record) => record.pvp.highValueOpportunities))),
				avgHardMonsterOpportunities: round2(avg(records.map((record) => record.pvp.hardMonsterOpportunities))),
				avgHardMonsterAttacks: round2(avg(records.map((record) => record.pvp.hardMonsterAttacks))),
				avgHardMonsterVp: round2(avg(records.map((record) => record.pvp.hardMonsterVp))),
				avgGoodTargetPivotOpportunities: round2(avg(records.map((record) => record.pvp.goodTargetPivotOpportunities))),
				avgGoodTargetPivotAttacks: round2(avg(records.map((record) => record.pvp.goodTargetPivotAttacks))),
				avgGoodTargetPivotVp: round2(avg(records.map((record) => record.pvp.goodTargetPivotVp))),
				goodTargetPivotBestTargetVp: maxOf(records.map((record) => record.pvp.goodTargetPivotBestTargetVp)),
				maxPredictedGoodTargetVp: maxOf(records.map((record) => record.pvp.maxPredictedGoodTargetVp))
			},
			roles,
			bandCounts,
		issueCounts,
		lowIssueCounts,
		highTail,
		recommendations,
		gamesDetail: records
	};
}

const games = inputs.flatMap(readTraceFile);
const records = games.map(classifyGame).sort((a, b) => a.vp - b.vp || a.sourcePath.localeCompare(b.sourcePath) || a.game - b.game);
const report = summarize(records);

if (outPath) {
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`[route-trace] games=${report.games} VP avg=${report.vp.avg} min=${report.vp.min} max=${report.vp.max} low=${report.vp.lowTailPct}%`);
console.log(`[route-trace] build kills=${report.build.avgKills} abyss=${report.build.avgAbyssNavs} attack=${report.build.avgMaxAttack} barrier=${report.build.avgMaxCurrentBarrier}/${report.build.avgMaxBarrier} dice=${report.build.avgMaxAttackDice} cult=${report.build.avgMaxCultivator}`);
console.log(`[route-trace] farm opp=${report.farm.avgFarmOpportunityVp} missed=${report.farm.avgMissedFarmOpportunityVp} missedGames=${report.farm.missedFarmGames}`);
console.log(`[route-trace] pvp opp=${report.pvp.avgOpportunities} attacks=${report.pvp.avgAttacks} vp=${report.pvp.avgVp} missed=${report.pvp.avgMissedOpportunities} bestTarget=${report.pvp.bestTargetVp} highValue=${report.pvp.avgHighValueOpportunities}`);
console.log(`[route-trace] pvp-hp4 opp=${report.pvp.avgHardMonsterOpportunities} attacks=${report.pvp.avgHardMonsterAttacks} vp=${report.pvp.avgHardMonsterVp} goodPivotOpp=${report.pvp.avgGoodTargetPivotOpportunities} goodPivotAttacks=${report.pvp.avgGoodTargetPivotAttacks} goodPivotVp=${report.pvp.avgGoodTargetPivotVp} goodBest=${report.pvp.goodTargetPivotBestTargetVp} predictedGood=${report.pvp.maxPredictedGoodTargetVp}`);
for (const [role, summary] of Object.entries(report.roles)) {
	console.log(`[route-trace] role ${role}: games=${summary.games} VP=${summary.avgVp} reach30=${summary.reach30Pct}% kills=${summary.avgKills} pvpVp=${summary.avgPvpVp} goodPivotVp=${summary.avgGoodTargetPivotVp} issues=${JSON.stringify(summary.issueCounts)}`);
}
console.log(`[route-trace] highTail finish=${report.highTail.finishGames} near=${report.highTail.nearFinishGames} finishPct=${report.highTail.finishPctAmongVp28Plus}% killDelta=${report.highTail.finishMinusNearFinish.avgKills}`);
console.log(`[route-trace] issues=${JSON.stringify(report.issueCounts)}`);
if (report.recommendations.length) {
	for (const recommendation of report.recommendations) console.log(`[route-trace] recommendation: ${recommendation}`);
}
if (outPath) console.log(`[route-trace] wrote ${outPath}`);
