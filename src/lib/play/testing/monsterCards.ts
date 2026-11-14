/**
 * Test helpers for the Arcane Abyss monster CARDS. A monster card belongs to the player who
 * drew it: it sits in `player.monsterHand`, and the player fights it from there. Two routes:
 *
 * - `dealTestMonster` writes a card-shaped `MonsterState` straight into a seat's hand
 *   (unit tests, or tests that only need "this player holds a monster card").
 * - `drawMonsterViaCommands` drives the real `drawMonsterCards → keepMonsterCard` reducer path
 *   (end-to-end tests; the player must be at the Abyss in the location phase).
 */
import { applyGameCommand, monsterDifficulty } from '../runtime';
import type { GameActor, MonsterState, PlayCatalog, PlayCatalogMonster, PublicGameState, SeatColor } from '../types';

export interface TestMonsterOptions extends Partial<MonsterState> {
	/** Catalog monster to copy. Default: the first catalog monster. */
	catalogId?: string;
}

const FALLBACK_MONSTER: PlayCatalogMonster = {
	id: 'test-monster',
	name: 'Test Monster',
	damage: 1,
	barrier: 5,
	rewardTrack: [],
	dicePool: [],
	chooseAmount: 2,
	stage: 1,
	order: 0
};

/**
 * A card-shaped monster built from a catalog entry: its catalog Barrier (damage to defeat it)
 * becomes hp/maxHp. Any `MonsterState` field can be overridden.
 */
export function testMonsterCard(catalog?: PlayCatalog | null, opts: TestMonsterOptions = {}): MonsterState {
	const { catalogId, ...overrides } = opts;
	const monsters = catalog?.monsters ?? [];
	const source =
		(catalogId ? monsters.find((m) => m.id === catalogId) : monsters[0]) ?? FALLBACK_MONSTER;
	if (catalogId && source.id !== catalogId) throw new Error(`catalog monster ${catalogId} not found`);
	const difficulty = monsterDifficulty(source);
	return {
		id: source.id,
		name: source.name,
		hp: source.barrier,
		maxHp: source.barrier,
		difficulty,
		damage: source.damage,
		rewardTrack: [...source.rewardTrack],
		chooseAmount: source.chooseAmount,
		livesRemaining: 1,
		livesTotal: 1,
		ladderIndex: source.order,
		ladderMax: 0,
		...overrides
	};
}

/** Put a test monster card into `seat`'s hand. Returns the card (it is the hand's last entry). */
export function dealTestMonster(
	state: PublicGameState,
	seat: SeatColor,
	catalog?: PlayCatalog | null,
	opts: TestMonsterOptions = {}
): MonsterState {
	const player = state.players[seat];
	if (!player) throw new Error(`no player in seat ${seat}`);
	const card = testMonsterCard(catalog, opts);
	(player.monsterHand ??= []).push(card);
	return card;
}

export interface DrawViaCommandsOptions {
	/** Deck to draw from. Default: the deck of `catalogId`, else the lowest non-empty deck. */
	difficulty?: 1 | 2 | 3;
	/** Keep this catalog monster when it is revealed (else keep the first revealed card). */
	catalogId?: string;
}

/**
 * Draw → keep through the real reducer. `actor` must be seated at the Arcane Abyss in the
 * location phase with no monster draw used this round. Throws on any rejected command. The kept
 * card is the last entry of the actor's hand.
 */
export function drawMonsterViaCommands(
	state: PublicGameState,
	actor: GameActor,
	catalog: PlayCatalog,
	opts: DrawViaCommandsOptions = {}
): PublicGameState {
	const deck = state.bags.monsters.contents;
	const wanted = opts.catalogId ? (catalog.monsters ?? []).find((m) => m.id === opts.catalogId) : undefined;
	if (opts.catalogId && !wanted) throw new Error(`catalog monster ${opts.catalogId} not found`);
	const difficulty =
		opts.difficulty ??
		(wanted ? monsterDifficulty(wanted) : ([1, 2, 3] as const).find((d) => deck.some((e) => e.difficulty === d)));
	if (!difficulty) throw new Error('every monster deck is empty');
	const run = (s: PublicGameState, command: Parameters<typeof applyGameCommand>[2]) => {
		const result = applyGameCommand(s, actor, command, catalog);
		if (!result.ok) throw new Error(`${command.type} failed: ${result.error.message}`);
		return result.state;
	};
	const s = run(state, { type: 'drawMonsterCards', difficulty });
	const seat = actor.seatColor;
	const revealed = (seat ? s.players[seat]?.pendingMonsterDraw?.cards : undefined) ?? [];
	const keep = opts.catalogId ? revealed.findIndex((card) => card.id === opts.catalogId) : 0;
	if (keep < 0) throw new Error(`monster ${opts.catalogId} was not revealed by the Difficulty ${difficulty} draw`);
	return run(s, { type: 'keepMonsterCard', index: keep });
}
