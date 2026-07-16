import { error as kitError } from '@sveltejs/kit';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';

export type ProgressionSnapshot = Record<string, unknown>;

function admin() {
	const value = getSupabaseAdmin('arc_spirits_2d');
	if (!value) throw kitError(503, 'Progression service is not configured.');
	return value;
}

function safeMessage(error: { message?: string } | null): string {
	const message = error?.message ?? '';
	if (message.includes('insufficient_credits')) return 'Not enough Abyss Credits.';
	if (message.includes('cosmetic_not_owned')) return 'Own this cosmetic before equipping it.';
	if (message.includes('cosmetic_not_found')) return 'That cosmetic is unavailable.';
	return 'Progression service is temporarily unavailable.';
}

async function call(fn: string, args: Record<string, unknown>): Promise<ProgressionSnapshot> {
	const result = await admin().rpc(fn, args);
	if (result.error) throw kitError(409, safeMessage(result.error));
	if (!result.data || typeof result.data !== 'object') throw kitError(503, 'Progression snapshot was unavailable.');
	return result.data as ProgressionSnapshot;
}

export function loadProgression(userId: string): Promise<ProgressionSnapshot> {
	return call('reconcile_player_progression', { p_user_id: userId });
}

export function purchaseCosmetic(userId: string, itemId: string): Promise<ProgressionSnapshot> {
	return call('purchase_cosmetic', { p_user_id: userId, p_item_id: itemId });
}

export function equipCosmetic(userId: string, itemId: string, guardianName?: string | null): Promise<ProgressionSnapshot> {
	return call('equip_cosmetic', {
		p_user_id: userId, p_item_id: itemId, p_guardian_name: guardianName ?? null
	});
}
