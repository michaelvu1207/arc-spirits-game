/**
 * Combat resolution (pure). Currently covers Arcane Abyss monster combat, fought
 * by each player independently. PvP reuses the same damage/corruption primitives
 * (P2).
 *
 * Determinism: all rolls come from the seeded RNG carried in game state, so a
 * combat replays identically and is unit-testable.
 */

import type {
	CombatSide,
	CombatState,
	MonsterState,
	PlayCatalog,
	PrivatePlayerState,
	PublicGameState,
	DiceTier,
	SeatColor
} from './types';
import { STATUS_LADDER, setCorruptionDiscardObligation } from './types';
import { nextInt, nextId } from './rng';
import { applyTrigger, awakenedClassCounts } from './effects/apply';
import { applyStatusChange } from './effects/status';
import type { EffectCombatInfo } from './effects/context';

/**
 * Per-combat effect flags that class effects (`inCombat`/`onTakeDamage`) set and
 * the combat primitives read. They MUST be cleared at the start of every combat so
 * a bonus/deflect granted in one fight never leaks into the next. `fightMonster`
 * and the PvP path both call this before any roll fires.
 */
export function resetCombatFlags(player: PrivatePlayerState): void {
	player.combatDamageBonus = 0;
	player.deflect = 0;
	player.damageReduction = 0;
	player.combatDamageMultiplier = 1;
	player.attackRollAdvantage = false;
	player.halveIncoming = false;
	player.skipTakeDamage = false;
	// `initiative` accumulates per combat (Disruptor compares stored values), so it
	// also resets to a clean baseline at the start of each combat.
	player.initiative = 0;
	// `stunImmune` is a per-combat passive granted by inCombat effects (Sharpshooter);
	// clear it so it does not persist into a later combat where the class is absent.
	player.stunImmune = false;
	// `stunned` is a per-combat knockout (zero barrier / corrupted); never leaks out.
	player.stunned = false;
}

/**
 * "Your side may always attack at the same time as the enemy." Granted by an awakened
 * Sharpshooter (count ≥1) or Soul Weaver (count ≥2). A player with this strikes
 * SIMULTANEOUSLY — a corrupting/zero-barrier hit cannot suppress their attack — so they
 * still roll and deal (and can kill with) their damage. Detected from awakened class counts
 * rather than the per-combat `stunImmune` flag, because Soul Weaver grants it on rest and
 * `resetCombatFlags` would otherwise wipe that grant before the fight resolves.
 */
function hasSimultaneousAttack(player: PrivatePlayerState): boolean {
	const c = awakenedClassCounts(player);
	return (c['Sharpshooter'] ?? 0) >= 1 || (c['Soul Weaver'] ?? 0) >= 2;
}

/**
 * The seat/state plumbing the `onTakeDamage` trigger needs. When present,
 * {@link takeDamage} fires the trigger BEFORE applying damage so class effects can
 * set reductions / halving / skip flags for this hit.
 */
export interface TakeDamageContext {
	state: PublicGameState;
	seat: SeatColor;
	catalog?: PlayCatalog;
	/** The opposing seat (PvP) — read by Disruptor to compare initiative. */
	opponent?: SeatColor;
	/** The opposing SIDE's pooled initiative (group Encounter). Disruptor prefers this
	 *  over the single representative seat's initiative so it judges the whole side. */
	opponentInitiative?: number;
}

/**
 * Numeric damage per face for each attack-dice tier. These match the live
 * `dice_sides` data (Basic 0,0,0,0,1,1 → avg .33; Enchanted; Exalted; Arcane).
 * Hard-coded here so combat is self-contained and deterministic.
 */
export const DICE_TIER_FACES: Record<DiceTier, number[]> = {
	basic: [0, 0, 0, 0, 1, 1],
	enchanted: [0, 0, 1, 1, 1, 1],
	exalted: [0, 1, 1, 1, 1, 2],
	arcane: [1, 2, 2, 2, 2, 3]
};

export interface FightResult {
	playerDamage: number;
	monsterDamage: number;
	barrierLost: number;
	corrupted: boolean;
	killed: boolean;
	/**
	 * VP granted directly by the fight. Always 0 now — defeating a monster opens a
	 * reward selection (`pendingReward`) where the player claims VP and other
	 * rewards from the monster's reward track instead of a flat kill bonus.
	 */
	vpGained: number;
	log: string[];
	/**
	 * Snapshot of the monster as it was fought (ending HP; hp 0 on a kill). The reward
	 * selection and the combat record read THIS rather than `state.monster`, because a
	 * kill advances `state.monster` to the next (stronger) rung of the ladder.
	 */
	fought: MonsterState | null;
}

function rollTier(state: PublicGameState, tier: DiceTier): number {
	const faces = DICE_TIER_FACES[tier];
	return faces[nextInt(state.rng, faces.length)];
}

/**
 * Apply `amount` damage to a player: flip barrier tokens to broken barrier; if the damage
 * reduces the player's barrier to ZERO (all tokens flipped to the broken barrier
 * side / 0 barrier), the player Corrupts (status drops one step and all barriers
 * are restored). Returns whether corruption happened.
 */
export function takeDamage(
	player: PrivatePlayerState,
	amount: number,
	ctx?: TakeDamageContext,
	log?: string[]
): { corrupted: boolean; barrierLost: number; discarded: number; deflected: number } {
	// Fire the onTakeDamage trigger BEFORE applying, so class effects (Aquamaiden,
	// Firekeeper, Disruptor, Guardian) can set reductions / halve / skip flags for
	// this hit. The incoming `amount` is exposed via combat.dealt so handlers that
	// branch on the raw hit (Guardian) can see it.
	if (ctx) {
		const combat: EffectCombatInfo = {
			dealt: amount,
			overkill: 0,
			killed: false,
			opponent: ctx.opponent,
			opponentInitiative: ctx.opponentInitiative
		};
		applyTrigger(ctx.state, ctx.seat, 'onTakeDamage', log ?? [], {
			catalog: ctx.catalog,
			combat,
			opponent: ctx.opponent
		});
	}

	// Guardian: skip the take-damage step entirely (it would have corrupted).
	if (player.skipTakeDamage) {
		return { corrupted: false, barrierLost: 0, discarded: 0, deflected: 0 };
	}

	// Mitigation primitives (default 0 ⇒ no change): reduce + deflect before barriers.
	// DEFLECTED damage is not just absorbed — it is dealt BACK to the opponent
	// (Michael's ruling, 2026-07-03): the caller receives `deflected` and applies it
	// (fightMonster counts it as damage dealt to the monster this combat; the PvP
	// strike hits the attacking side's representative). Reduction soaks first; only
	// damage that would have landed can be deflected.
	const deflected = Math.min(
		player.deflect ?? 0,
		Math.max(0, amount - (player.damageReduction ?? 0))
	);
	const mitigation = (player.damageReduction ?? 0) + (player.deflect ?? 0);
	amount = Math.max(0, amount - mitigation);
	// Disruptor: halve the (post-reduction) incoming damage, rounding up.
	if (player.halveIncoming) amount = Math.ceil(amount / 2);
	if (amount <= 0) return { corrupted: false, barrierLost: 0, discarded: 0, deflected };
	const barrierBefore = player.barrier;
	const barrierLost = Math.min(barrierBefore, amount);
	player.barrier = Math.max(0, barrierBefore - amount);
	player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);

	// Corruption fires when the hit empties the barrier — all tokens are now on the
	// broken barrier side (0 barrier). NOT on "overkill" (damage strictly exceeding barrier): being
	// ground down to EXACTLY zero must corrupt too, and a hit that only dents the barrier must not.
	// `player.barrier` was just clamped on the line above, so this is the post-hit value.
	const corrupted = player.barrier === 0;
	if (corrupted) {
		const oldStatus = player.statusLevel;
		player.statusLevel = Math.min(STATUS_LADDER.length - 1, player.statusLevel + 1);
		player.statusToken = STATUS_LADDER[player.statusLevel];
		// Corruption INSTANTLY restores all barrier (flip broken barrier back to barrier side) — then
		// bills the escalating SACRIFICE: bump the corruption counter and owe that many forced
		// spirit discards (1st corruption sheds 1, 2nd 2, 3rd 3, …; accumulates across one
		// exchange). The owner picks which spirits to shed; the deadline drain auto-resolves any
		// remainder. This is the single corruption site for combat.
		player.barrier = player.maxBarrier;
		player.brokenBarrier = 0;
		player.corruptionCount = (player.corruptionCount ?? 0) + 1;
		const vpCharged = setCorruptionDiscardObligation(player, undefined, {
			wasFallen: oldStatus === STATUS_LADDER.length - 1
		});
		if (vpCharged > 0) {
			log?.push(
				`Corruption while Fallen: ${vpCharged} owed sacrifice${vpCharged === 1 ? '' : 's'} could not be paid in spirits — ${vpCharged} VP lost instead.`
			);
		}
		// onStatusChange: record the crossed thresholds + fire the trigger (only when
		// we have the state/seat plumbing — `ctx` is absent for bare-player tests).
		if (ctx && player.statusLevel !== oldStatus) {
			applyStatusChange(ctx.state, ctx.seat, oldStatus, player.statusLevel, ctx.catalog, log ?? []);
		}
	}
	// `discarded` is retained for caller back-compat but is always 0 now: corruption no
	// longer auto-trims spirits here — it queues a forced player-chosen discard instead.
	return { corrupted, barrierLost, discarded: 0, deflected };
}

/**
 * Total attack damage from a player's dice pool (rolled via the seeded RNG),
 * plus any flat `combatDamageBonus` (default 0 ⇒ no change). This is the single
 * source of a player's dealt damage, so `fightMonster` inherits the bonus
 * through this call rather than re-adding it.
 */
export function rollAttack(state: PublicGameState, player: PrivatePlayerState): number {
	const rollOnce = (): number => {
		let total = 0;
		for (const die of player.attackDice) {
			total += rollTier(state, die.tier);
		}
		return total;
	};
	// Dark Fighter (Space Invader) rolls the whole attack twice and keeps the higher
	// total ("roll twice, take the higher roll"). Default ⇒ a single roll.
	const total = player.attackRollAdvantage ? Math.max(rollOnce(), rollOnce()) : rollOnce();
	// Flat bonus (combatBonus / Blood Hunter) added to the rolled dice, then the
	// whole sum scaled by the per-combat multiplier (Dark Assassin's odd-barrier
	// doubling). Default multiplier is 1 ⇒ no change.
	const withBonus = total + (player.combatDamageBonus ?? 0);
	return withBonus * (player.combatDamageMultiplier ?? 1);
}

/**
 * Expected (average) total damage of a player's attack roll AT REST: the mean of
 * each attack die's faces, plus the flat Spirit Animal bonus (+1 per awakened
 * Spirit Animal trait — its `inCombat` combatBonus, which only goes live mid-fight).
 * Situational modifiers (Blood Hunter, Dark Assassin) are excluded. Shared by the
 * scout dice-pool readout and the leaderboard so they always agree.
 */
export function expectedAttack(player: PrivatePlayerState): number {
	let dice = 0;
	for (const die of player.attackDice) {
		const faces = DICE_TIER_FACES[die.tier];
		dice += faces.reduce((a, b) => a + b, 0) / faces.length;
	}
	return dice + (awakenedClassCounts(player)['Spirit Animal'] ?? 0);
}

type EncounterCombatant = { seat: SeatColor; player: PrivatePlayerState };

/**
 * Resolve a single group Encounter (PvP) exchange at one location.
 *
 * EVIL (the co-located Fallen aggressors) and GOOD (co-located non-Fallen players)
 * each pool their initiative and dice. Rules:
 *  • Higher TOTAL initiative side strikes first; EQUAL initiative → both strike at
 *    once (both rolls are locked before either lands, so a stun can't suppress a
 *    simultaneous counter-strike).
 *  • A side's TOTAL rolled damage hits EVERY opposing player in full — no splitting.
 *  • A player reduced to zero barrier OR corrupted is STUNNED (unless `stunImmune`)
 *    and cannot strike back this exchange.
 *  • Single exchange — faster side, then the slower side's survivors. No looping.
 *
 * Pure w.r.t. the seeded RNG (replayable). Mutates the participants; VP and awaken
 * progress for the Evil side are applied by the caller. Returns the CombatState for
 * the overlay.
 */
export function resolveEncounterCombat(
	state: PublicGameState,
	catalog: PlayCatalog | undefined,
	evilSeats: SeatColor[],
	goodSeats: SeatColor[]
): CombatState {
	const collect = (seats: SeatColor[]): EncounterCombatant[] =>
		seats
			.map((seat) => ({ seat, player: state.players[seat] }))
			.filter((c): c is EncounterCombatant => !!c.player);
	const evil = collect(evilSeats);
	const good = collect(goodSeats);

	// Clear per-combat flags, then fire `inCombat` for every participant so class
	// effects (initiative, combatBonus, deflect, stunImmune, …) land before any roll.
	// Each participant is threaded a representative opposing seat (first in seat order)
	// for effects that read the opponent (e.g. Disruptor's initiative compare).
	const repGood = good[0]?.seat;
	const repEvil = evil[0]?.seat;
	// The combat log is built up-front so the pre-roll triggers below write into it —
	// otherwise class-buff lines (Spirit Animal's +dmg/+init, Dark Assassin's doubling,
	// Dark Fighter's +init) would be discarded and the PvP overlay would show damage
	// change with no explanation (PvE already threads its real log into inCombat).
	const log: string[] = [];
	for (const { player } of [...evil, ...good]) resetCombatFlags(player);
	// onPlayerInteraction fires for each Evil aggressor BEFORE the exchange (e.g.
	// Infiltrator's pre-combat dice swap), threaded the representative Good opponent.
	for (const { seat } of evil)
		applyTrigger(state, seat, 'onPlayerInteraction', log, { catalog, opponent: repGood });
	for (const { seat } of evil) applyTrigger(state, seat, 'inCombat', log, { catalog, opponent: repGood });
	for (const { seat } of good) applyTrigger(state, seat, 'inCombat', log, { catalog, opponent: repEvil });

	const sumInit = (group: EncounterCombatant[]): number =>
		group.reduce((s, { player }) => s + (player.initiative ?? 0), 0);
	const initE = sumInit(evil);
	const initG = sumInit(good);

	const dealt = new Map<SeatColor, number>();
	const rolledSeats = new Set<SeatColor>();
	const corruptedSeats = new Set<SeatColor>();

	const rollSide = (group: EncounterCombatant[]): number => {
		let total = 0;
		for (const { seat, player } of group) {
			const r = rollAttack(state, player);
			dealt.set(seat, r);
			rolledSeats.add(seat);
			total += r;
		}
		return total;
	};

	const strike = (
		defenders: EncounterCombatant[],
		dmg: number,
		attackerRep: SeatColor | undefined,
		attackerInit: number,
		attackerLabel: string,
		defenderLabel: string
	): void => {
		log.push(`${attackerLabel} deals ${dmg} to each ${defenderLabel} player.`);
		for (const { seat, player } of defenders) {
			// opponentInitiative = the attacking SIDE's pooled total, so Disruptor judges
			// against the whole side (not just the representative seat).
			const { corrupted, deflected } = takeDamage(
				player,
				dmg,
				{ state, seat, catalog, opponent: attackerRep, opponentInitiative: attackerInit },
				log
			);
			if (corrupted) corruptedSeats.add(seat);
			// Deflected damage is dealt BACK to the attacking side's representative.
			// Applied without a trigger context so it cannot chain (a reflection is
			// never itself deflected — takeDamage only reports; callers reflect).
			if (deflected > 0 && attackerRep) {
				const attacker = state.players[attackerRep];
				if (attacker) {
					const bounce = takeDamage(attacker, deflected, undefined, log);
					if (bounce.corrupted) corruptedSeats.add(attackerRep);
					log.push(
						`${seat} deflects ${deflected} damage back at ${attackerRep}` +
							(bounce.corrupted ? ` — ${attackerRep} is corrupted!` : '.')
					);
				}
			}
			const attacksSimultaneously = player.stunImmune || hasSimultaneousAttack(player);
			if ((corrupted || player.barrier === 0) && !attacksSimultaneously) {
				player.stunned = true;
				log.push(`${seat} is stunned and cannot strike back.`);
			} else if (corrupted) {
				log.push(`${seat} attacks at the same time despite corruption.`);
			}
		}
	};

	if (initE === initG) {
		// Simultaneous: lock BOTH rolls (full rosters) before either hit lands.
		const dmgE = rollSide(evil);
		const dmgG = rollSide(good);
		log.push(`Initiative is tied at ${initE} — both sides strike at once.`);
		strike(good, dmgE, repEvil, initE, 'Evil', 'Good');
		strike(evil, dmgG, repGood, initG, 'Good', 'Evil');
	} else {
		const evilFaster = initE > initG;
		const first = evilFaster ? evil : good;
		const second = evilFaster ? good : evil;
		const firstRep = evilFaster ? repEvil : repGood;
		const secondRep = evilFaster ? repGood : repEvil;
		const firstInit = evilFaster ? initE : initG;
		const secondInit = evilFaster ? initG : initE;
		const firstLabel = evilFaster ? 'Evil' : 'Good';
		const secondLabel = evilFaster ? 'Good' : 'Evil';
		log.push(`${firstLabel} is faster (initiative ${firstInit} vs ${secondInit}) and strikes first.`);
		strike(second, rollSide(first), firstRep, firstInit, firstLabel, secondLabel);
		// Only un-stunned members of the slower side strike back.
		const retaliators = second.filter(({ player }) => !player.stunned);
		if (retaliators.length > 0) {
			strike(first, rollSide(retaliators), secondRep, secondInit, secondLabel, firstLabel);
		} else {
			log.push(`${secondLabel} is fully stunned — no retaliation.`);
		}
	}

	const sideFor = (group: EncounterCombatant[], side: 'evil' | 'good'): CombatSide[] =>
		group.map(({ seat, player }) => ({
			seat,
			side,
			initiative: player.initiative ?? 0,
			rolled: rolledSeats.has(seat),
			damageDealt: dealt.get(seat) ?? 0,
			stunned: !!player.stunned,
			corrupted: corruptedSeats.has(seat)
		}));

	return {
		id: nextId(state.rng, 'pvp'),
		kind: 'pvp',
		step: 'resolved',
		killed: false,
		sides: [...sideFor(evil, 'evil'), ...sideFor(good, 'good')],
		monster: null,
		log
	};
}

/**
 * Resolve one full monster fight for `seat`. Monsters have infinite initiative,
 * so the monster strikes first; a corrupted player cannot strike back. Monster HP
 * does NOT carry between combats — every fight is against a FULL-strength monster, so
 * the player must deal its full maxHp in THIS one combat to kill it (no shared/chipped
 * health pool). On a kill the player gains a reward pick, the monster spends one life,
 * and the next, stronger monster is drawn at the round boundary once its lives are
 * exhausted. Mutates state; returns a result for the UI.
 */
export function fightMonster(
	state: PublicGameState,
	seat: SeatColor,
	catalog?: PlayCatalog
): FightResult | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return null;

	const log: string[] = [];

	// 0. Fresh combat: clear any per-combat flags from a previous fight, then fire
	//    the `inCombat` trigger so this player's class effects (combatBonus,
	//    initiative, deflect, damageReduction, Dark Assassin doubling, …) apply to
	//    THIS combat before any roll happens.
	resetCombatFlags(player);
	applyTrigger(state, seat, 'inCombat', log, { catalog });

	// 1. Monster attacks first. The take-damage context lets onTakeDamage class
	//    effects (Aquamaiden/Firekeeper/Guardian) fire before the hit is applied.
	const { corrupted, barrierLost, discarded, deflected } = takeDamage(player, monster.damage, {
		state,
		seat,
		catalog
	}, log);
	log.push(`${monster.name} attacks for ${monster.damage} (${barrierLost} barrier lost).`);
	if (deflected > 0)
		log.push(`Deflected ${deflected} damage back at ${monster.name}.`);
	if (corrupted) log.push(`You were corrupted — status is now ${player.statusToken}.`);
	if (discarded > 0) log.push(`Discarded ${discarded} spirit(s) to meet the new limit.`);

	// 2. Player counter-attacks against a FULL-strength monster. Monster HP never carries between
	//    combats, so the kill is judged against `maxHp` and we never leave partial HP in shared
	//    state. Normally a corrupted player cannot strike back — but a player with "attack at the
	//    same time as the enemy" (Sharpshooter / Soul Weaver ≥2) strikes SIMULTANEOUSLY, so even a
	//    corrupting hit still lands their damage (and can kill).
	let playerDamage = 0;
	const hpBeforeStrike = monster.maxHp;
	const simultaneous = hasSimultaneousAttack(player);
	if (!corrupted || simultaneous) {
		playerDamage = rollAttack(state, player);
		log.push(
			corrupted
				? `You attack at the same time as the monster for ${playerDamage} damage (despite corruption).`
				: `You roll ${player.attackDice.length} attack dice for ${playerDamage} damage.`
		);
	} else {
		log.push(`Corrupted players cannot strike back this combat.`);
	}

	// 3. Resolve the outcome against the monster's FULL health — a kill needs maxHp damage in this
	//    single combat. DEFLECTED damage from the monster's opening strike counts as damage
	//    dealt to it (it is passive reflection, so it lands even for a corrupted player who
	//    cannot strike back). The `onMonsterKill` trigger fires on EVERY combat resolution
	//    (carrying `killed`), so Adaptive Fighter's no-kill branch runs; Fairy's rune is gated
	//    behind `killed`.
	const endingHp = Math.max(0, monster.maxHp - playerDamage - deflected);
	const killed = endingHp <= 0;
	const vpGained = 0; // VP now comes from the reward selection, not a flat kill bonus.
	if (killed) {
		log.push(`${monster.name} defeated! Claim your rewards.`);
	}
	applyTrigger(state, seat, 'onMonsterKill', log, {
		catalog,
		combat: {
			dealt: playerDamage,
			overkill: Math.max(0, playerDamage + deflected - hpBeforeStrike),
			killed
		}
	});

	// Snapshot the monster AS FOUGHT (this combat's ending HP; 0 on a kill) for the reward + combat
	// record. Shared state is then restored to full HP so damage never persists to the next combat.
	const fought: MonsterState = { ...monster, hp: endingHp };
	monster.hp = monster.maxHp;
	if (killed) {
		// Consume one life. Floored at 0 so excess kills never go negative. The next, stronger
		// monster only comes out at the round boundary (enterCleanup) — every player fights the
		// same listed monster all round.
		monster.livesRemaining = Math.max(0, monster.livesRemaining - 1);
		log.push(
			monster.livesRemaining > 0
				? `${monster.livesRemaining} more ${monster.livesRemaining === 1 ? 'kill' : 'kills'} to drive it off.`
				: `Its lives are spent — a stronger monster arrives next round.`
		);
	}

	return {
		playerDamage,
		monsterDamage: monster.damage,
		barrierLost,
		corrupted,
		killed,
		vpGained,
		log,
		fought
	};
}

/** VP an Evil attacker earns from a PvP exchange: 2 for engaging, plus 2 per opposing
 *  player corrupted during the exchange. (Michael's ruling, 2026-07-07 — flat engage
 *  fee + corruption bounty; no roll-scaling, no target-VP scaling.) */
export function pvpVpForAttack(corruptedOpponents: number): number {
	return 2 + 2 * Math.max(0, corruptedOpponents);
}

/** Kills needed to defeat a monster — every rung of the ladder, including the final one —
 *  scaled by player count: 1 player → 1 life, 2-3 players → 2 lives, 4+ players → 3 lives.
 *  (Michael's rulings, 2026-07-07: the 2p bump keeps the monster pool rich enough that
 *  someone can reach 30 VP without PvP at every table size.) */
export function monsterLivesForPlayerCount(playerCount: number): number {
	if (playerCount >= 4) return 3;
	if (playerCount >= 2) return 2;
	return 1;
}

/**
 * At the round boundary, if the Arcane Abyss monster's lives are spent (all the kills it
 * needed have landed), bring out the next, stronger rung of the ladder — full HP, its own
 * damage + reward track, and a fresh kill requirement (scaled by player count). The ladder
 * is `catalog.monsters` (sorted weakest-first by stage then order). At the top of the
 * ladder (or with no catalog) the strongest returns at full strength so combat never
 * stalls. No-op while the monster still has lives, or when there is no monster. Called
 * from `enterCleanup` so the monster never changes mid-fight.
 */
export function advanceMonsterIfDefeated(state: PublicGameState, catalog?: PlayCatalog): void {
	const cur = state.monster;
	if (!cur || cur.livesRemaining > 0) return;
	const ladder = catalog?.monsters ?? [];
	const idx = ladder.findIndex((m) => m.id === cur.id);
	const next = idx >= 0 ? ladder[idx + 1] : undefined;
	if (next) {
		const lives = monsterLivesForPlayerCount(state.activeSeats.length);
		state.monster = {
			id: next.id,
			name: next.name,
			hp: next.barrier,
			maxHp: next.barrier,
			damage: next.damage,
			rewardTrack: [...next.rewardTrack],
			chooseAmount: next.chooseAmount,
			livesRemaining: lives,
			livesTotal: lives,
			ladderIndex: idx + 1,
			ladderMax: ladder.length
		};
	} else if (ladder.length === 0) {
		// No catalog (bare unit-test states): keep combat alive — return at full strength.
		cur.hp = cur.maxHp;
		cur.livesRemaining = 1;
		cur.livesTotal = 1;
		cur.ladderIndex = Math.min(cur.ladderIndex + 1, Math.max(0, cur.ladderMax - 1));
	} else {
		// The FINAL monster is defeated — the spirit world is saved. Clear the Abyss and
		// flag the game to end at this cleanup with final scoring (tryAdvanceFromCleanup).
		state.monster = null;
		state.spiritWorldSaved = true;
	}
}
