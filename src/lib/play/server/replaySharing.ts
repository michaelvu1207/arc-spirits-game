import { randomBytes } from 'node:crypto';
import { error as kitError } from '@sveltejs/kit';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';

export type SnapshotRow = {
	game_id: string; navigation_count: number; game_timestamp: string;
	player_color: string; tts_username: string | null; navigation_destination: string | null;
	selected_character: string | null; victory_points: number | null; barrier: number | null;
	max_tokens: number | null; status_level: number | null; status_token: string | null;
	spirits: unknown; mats: unknown; spirit_augment_attachments: unknown;
};

export type PublicReplaySnapshot = SnapshotRow;

const PUBLIC_SNAPSHOT_FIELDS =
	'game_id,navigation_count,game_timestamp,player_color,tts_username,navigation_destination,selected_character,victory_points,barrier,max_tokens,status_level,status_token,spirits,mats,spirit_augment_attachments';
const PUBLIC_FRAME_FIELDS = 'game_id,revision,round,phase,public_state,created_at';

export type PublicReplayFrame = {
	game_id: string;
	revision: number;
	round: number;
	phase: string;
	public_state: Record<string, unknown>;
	created_at: string;
};

function historyAdmin() {
	const admin = getSupabaseAdmin('arc_spirits_game');
	if (!admin) throw kitError(503, 'Replay service is not configured.');
	return admin;
}

function playAdmin() {
	const admin = getSupabaseAdmin('arc_spirits_2d');
	if (!admin) throw kitError(503, 'Replay service is not configured.');
	return admin;
}

async function finishedParticipation(userId: string, gameId: string): Promise<boolean> {
	const result = await playAdmin().from('match_results').select('session_id').eq('game_id', gameId).maybeSingle();
	if (result.error || !result.data) return false;
	const player = await playAdmin().from('match_result_players').select('session_id')
		.eq('session_id', result.data.session_id).eq('user_id', userId).eq('is_bot', false).maybeSingle();
	return !player.error && player.data != null;
}

function code(): string {
	return randomBytes(12).toString('base64url');
}

export async function createReplayShare(userId: string, gameId: string, title?: string): Promise<{ code: string; url: string }> {
	if (!gameId || gameId.length > 100) throw kitError(400, 'A valid finished game is required.');
	if (!(await finishedParticipation(userId, gameId))) throw kitError(404, 'Finished game not found.');
	const admin = historyAdmin();
	const existing = await admin.from('replay_shares').select('code,visibility,revoked_at,expires_at').eq('owner_user_id', userId).eq('game_id', gameId).maybeSingle();
	if (existing.error) throw kitError(503, 'Replay sharing is unavailable.');
	if (existing.data?.code) {
		const reactivated = await admin.from('replay_shares').update({
			visibility: 'public', revoked_at: null, expires_at: null,
			title: title?.trim().slice(0, 80) || null
		}).eq('owner_user_id', userId).eq('code', existing.data.code);
		if (reactivated.error) throw kitError(503, 'Replay sharing is unavailable.');
		return { code: existing.data.code, url: `/replay/${existing.data.code}` };
	}
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const shareCode = code();
		const inserted = await admin.from('replay_shares').insert({
			code: shareCode, game_id: gameId, owner_user_id: userId,
			visibility: 'public', title: title?.slice(0, 80) || null
		});
		if (!inserted.error) return { code: shareCode, url: `/replay/${shareCode}` };
		const winner = await admin.from('replay_shares').select('code').eq('owner_user_id', userId).eq('game_id', gameId).maybeSingle();
		if (winner.data?.code) return { code: winner.data.code, url: `/replay/${winner.data.code}` };
	}
	throw kitError(503, 'Could not create a replay share.');
}

export async function revokeReplayShare(userId: string, shareCode: string): Promise<{ revoked: true }> {
	if (!/^[A-Za-z0-9_-]{16}$/.test(shareCode)) throw kitError(404, 'Replay not found.');
	const result = await historyAdmin().from('replay_shares')
		.update({ visibility: 'private', revoked_at: new Date().toISOString() })
		.eq('code', shareCode).eq('owner_user_id', userId).select('code').maybeSingle();
	if (result.error || !result.data) throw kitError(404, 'Replay not found.');
	return { revoked: true };
}

/**
 * Defense in depth: PostgREST is asked for an explicit projection, but a test
 * double, view change, or future query refactor must still be unable to copy a
 * private history column into the public response. Face-down spirit identity is
 * also blanked; a replay may show that a hidden card existed without revealing
 * information the live public board withheld.
 */
export function sanitizeReplaySnapshot(row: Record<string, unknown>): PublicReplaySnapshot {
	const projectRecord = (value: unknown, keys: string[]) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
		return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, structuredClone((value as Record<string, unknown>)[key])]));
	};
	const spirits = Array.isArray(row.spirits)
		? row.spirits.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
			const spirit = entry as Record<string, unknown>;
			if (spirit.isFaceDown !== true) return projectRecord(spirit, ['slotIndex', 'id', 'name', 'cost', 'classes', 'origins', 'isFaceDown']);
			return {
				slotIndex: spirit.slotIndex ?? null,
				isFaceDown: true
			};
		})
		: [];
	return {
		game_id: String(row.game_id ?? ''),
		navigation_count: Number(row.navigation_count ?? 0),
		game_timestamp: String(row.game_timestamp ?? ''),
		player_color: String(row.player_color ?? ''),
		tts_username: typeof row.tts_username === 'string' ? row.tts_username : null,
		navigation_destination: typeof row.navigation_destination === 'string' ? row.navigation_destination : null,
		selected_character: typeof row.selected_character === 'string' ? row.selected_character : null,
		victory_points: row.victory_points == null ? null : Number(row.victory_points),
		barrier: row.barrier == null ? null : Number(row.barrier),
		max_tokens: row.max_tokens == null ? null : Number(row.max_tokens),
		status_level: row.status_level == null ? null : Number(row.status_level),
		status_token: typeof row.status_token === 'string' ? row.status_token : null,
		spirits,
		mats: Array.isArray(row.mats) ? row.mats.map((entry) => projectRecord(entry, [
			'slotIndex', 'hasRune', 'guid', 'id', 'name', 'type', 'originId', 'classId', 'special'
		])) : [],
		spirit_augment_attachments: Array.isArray(row.spirit_augment_attachments)
			? row.spirit_augment_attachments.map((entry) => projectRecord(entry, [
				'runeId', 'spiritId', 'spiritSlotIndex', 'name', 'classId', 'className', 'localPos', 'localRotY'
			]))
			: []
	};
}

const FORBIDDEN_FRAME_KEYS = new Set([
	'roomCode', 'stateHash', 'viewer', 'memberId', 'handDraws', 'pendingDraw', 'pendingReward',
	'pendingAwakenReward', 'pendingCorruptionDiscard', 'pendingDestination', 'manualPrompts',
	'pendingDecisions', 'lastAction', 'unplacedAugments', 'scenario', 'rng'
]);

function sanitizeFrameValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeFrameValue);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !FORBIDDEN_FRAME_KEYS.has(key))
			.map(([key, member]) => [key, sanitizeFrameValue(member)])
	);
}

export function sanitizeReplayFrame(row: Record<string, unknown>): PublicReplayFrame {
	return {
		game_id: String(row.game_id ?? ''),
		revision: Number(row.revision ?? 0),
		round: Number(row.round ?? 0),
		phase: String(row.phase ?? ''),
		public_state: sanitizeFrameValue(row.public_state) as Record<string, unknown>,
		created_at: String(row.created_at ?? '')
	};
}

export function computeFramePivotalMoments(frames: PublicReplayFrame[]) {
	const previous = new Map<string, number>();
	const best = new Map<string, { playerColor: string; round: number; revision: number; gain: number }>();
	for (const frame of [...frames].sort((a, b) => a.revision - b.revision)) {
		const players = frame.public_state.players;
		if (!players || typeof players !== 'object') continue;
		for (const [playerColor, raw] of Object.entries(players as Record<string, unknown>)) {
			if (!raw || typeof raw !== 'object') continue;
			const vp = Number((raw as Record<string, unknown>).victoryPoints ?? 0);
			const gain = vp - (previous.get(playerColor) ?? 0);
			const current = best.get(playerColor);
			if (!current || gain > current.gain) best.set(playerColor, {
				playerColor, round: frame.round, revision: frame.revision, gain
			});
			previous.set(playerColor, vp);
		}
	}
	return [...best.values()].sort((a, b) => a.playerColor.localeCompare(b.playerColor));
}

export function computePivotalRounds(rows: PublicReplaySnapshot[]) {
	const byPlayer = new Map<string, SnapshotRow[]>();
	for (const row of rows) {
		const list = byPlayer.get(row.player_color) ?? [];
		list.push(row); byPlayer.set(row.player_color, list);
	}
	return [...byPlayer.entries()].map(([playerColor, list]) => {
		list.sort((a, b) => a.navigation_count - b.navigation_count);
		let previous = 0; let best = { round: list[0]?.navigation_count ?? 0, gain: 0 };
		for (const row of list) {
			const gain = Number(row.victory_points ?? 0) - previous;
			if (gain > best.gain) best = { round: row.navigation_count, gain };
			previous = Number(row.victory_points ?? 0);
		}
		return { playerColor, ...best };
	});
}

export async function loadSharedReplay(shareCode: string) {
	if (!/^[A-Za-z0-9_-]{16}$/.test(shareCode)) throw kitError(404, 'Replay not found.');
	const admin = historyAdmin();
	const share = await admin.from('replay_shares')
		.select('code,game_id,title,visibility,revoked_at,expires_at,created_at')
		.eq('code', shareCode).maybeSingle();
	if (share.error || !share.data || share.data.visibility !== 'public' || share.data.revoked_at ||
		(share.data.expires_at && Date.parse(share.data.expires_at) <= Date.now())) throw kitError(404, 'Replay not found.');
	const snapshots = await admin.from('game_state_snapshots').select(PUBLIC_SNAPSHOT_FIELDS)
		.eq('game_id', share.data.game_id).order('navigation_count', { ascending: true }).order('player_color', { ascending: true });
	if (snapshots.error) throw kitError(503, 'Replay is temporarily unavailable.');
	const rows = ((snapshots.data ?? []) as Record<string, unknown>[])
		.map(sanitizeReplaySnapshot)
		.sort((a, b) => a.navigation_count - b.navigation_count || a.player_color.localeCompare(b.player_color));
	const frameResult = await admin.from('replay_frames').select(PUBLIC_FRAME_FIELDS)
		.eq('game_id', share.data.game_id).order('revision', { ascending: true });
	if (frameResult.error) throw kitError(503, 'Replay is temporarily unavailable.');
	const frames = ((frameResult.data ?? []) as Record<string, unknown>[])
		.map(sanitizeReplayFrame)
		.sort((a, b) => a.revision - b.revision);
	if (rows.length === 0 && frames.length === 0) throw kitError(404, 'Replay not found.');
	return {
		code: share.data.code, gameId: share.data.game_id, title: share.data.title,
		createdAt: share.data.created_at,
		mode: frames.length > 0 ? 'command-revision' as const : 'round-snapshot' as const,
		frames,
		snapshots: rows,
		pivotalRounds: frames.length > 0 ? computeFramePivotalMoments(frames) : computePivotalRounds(rows),
		privacy: { hiddenFields: ['hand_draws', 'bags', 'scenario', 'pending choices', 'private prompts'] }
	};
}
