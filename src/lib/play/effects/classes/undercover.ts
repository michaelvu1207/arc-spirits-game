import { nextId } from '../../rng';
import { relicOptions } from '../../locationInteractions';
import type { PrivatePlayerState } from '../../types';
import type { ClassAbility, ClassDecisions, ClassHandler } from './types';

function gainFairyRelic(player: PrivatePlayerState): void {
	const fairy = relicOptions().find((r) => r.name.startsWith('Fairy'));
	if (!fairy) return;
	player.mats.push({
		slotIndex: player.mats.length + 1,
		hasRune: true,
		id: fairy.runeId,
		name: fairy.name,
		type: 'relic',
		special: true
	});
	player.relics += 1;
}

/** When encountering a player, optionally give both players one Fairy Relic. */
const onPlayerInteraction: ClassHandler = (ctx) => {
	if (!ctx.opponent) return;
	ctx.player.pendingDecisions.push({
		id: nextId(ctx.state.rng, 'dec'),
		source: 'class',
		kind: 'undercoverFairyRelics',
		prompt: `Give ${ctx.opponent} and yourself 1 Fairy Relic?`,
		options: [
			{ id: `yes:${ctx.opponent}`, label: 'Give both players a Fairy Relic' },
			{ id: 'no', label: 'No' }
		]
	});
	ctx.log.push('Relic Envoy: may give both players a Fairy Relic.');
};

export const ability: ClassAbility[] = [{ on: 'onPlayerInteraction', run: onPlayerInteraction }];

export const decisions: ClassDecisions = {
	undercoverFairyRelics(ctx, optionId) {
		if (!optionId.startsWith('yes:')) return;
		const opponent = optionId.slice(4);
		const other = ctx.state.players[opponent as keyof typeof ctx.state.players];
		if (!other) return;
		gainFairyRelic(ctx.player);
		gainFairyRelic(other);
		ctx.log.push(`Relic Envoy: ${ctx.seat} and ${opponent} each gained a Fairy Relic.`);
	}
};
