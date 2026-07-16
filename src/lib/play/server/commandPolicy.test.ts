/**
 * Deny-by-default command admission — the adversarial matrix for the ONE policy
 * gate both transports run before the reducer (commandPolicy.ts).
 */
import { describe, expect, it } from 'vitest';
import {
	admitCommand,
	isValidCmdId,
	validateCommandShape,
	INTEGRITY_TOOLS,
	PLAYER_COMMANDS,
	LOBBY_COMMANDS,
	HOST_TOOLS,
	RANKED_FORBIDDEN_LEDGER_TYPES,
	type CommandAdmissionContext
} from './commandPolicy';

const seatedCasualPlayer: CommandAdmissionContext = {
	mode: 'casual',
	role: 'player',
	seated: true,
	isBot: false,
	allowIntegrityTools: false
};
const seatedRankedPlayer: CommandAdmissionContext = { ...seatedCasualPlayer, mode: 'ranked' };
const casualHost: CommandAdmissionContext = { ...seatedCasualPlayer, role: 'host' };
const rankedHost: CommandAdmissionContext = { ...casualHost, mode: 'ranked' };
const spectator: CommandAdmissionContext = {
	...seatedCasualPlayer,
	role: 'spectator',
	seated: false
};

function admit(ctx: CommandAdmissionContext, type: string, extra: Record<string, unknown> = {}) {
	return admitCommand(ctx, { type, ...extra });
}

describe('deny-by-default classification', () => {
	it('every GameCommand type is deliberately classified in exactly one tier', () => {
		const tiers = [PLAYER_COMMANDS, LOBBY_COMMANDS, HOST_TOOLS, INTEGRITY_TOOLS];
		const all = new Set<string>();
		for (const tier of tiers) {
			for (const type of tier) {
				expect(all.has(type), `"${type}" classified twice`).toBe(false);
				all.add(type);
			}
		}
	});

	it('an unknown/new command type is DENIED until classified', () => {
		for (const ctx of [seatedCasualPlayer, casualHost, seatedRankedPlayer]) {
			const verdict = admit(ctx, 'brandNewCommand');
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.code).toBe('unknown_command');
		}
	});

	it('internal/synthetic ledger types never admit from the wire', () => {
		for (const type of ['enforceDeadline', '$effects', '$rematch', 'chatMessage']) {
			expect(admit(casualHost, type).ok).toBe(false);
		}
	});
});

describe('rules-driven play commands stay green', () => {
	it('seated players may submit every player command in BOTH modes', () => {
		for (const type of PLAYER_COMMANDS) {
			expect(admit(seatedCasualPlayer, type).ok, `casual ${type}`).toBe(true);
			expect(admit(seatedRankedPlayer, type).ok, `ranked ${type}`).toBe(true);
		}
	});

	it('an unseated spectator may not submit play commands', () => {
		const verdict = admit(spectator, 'passEncounter');
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.code).toBe('spectators_cannot_command');
	});

	it('casual lobby assembly works: members claim seats, host starts', () => {
		expect(admit(spectator, 'claimSeat', { seatColor: 'Red' }).ok).toBe(true);
		expect(admit(seatedCasualPlayer, 'selectGuardian', { guardianName: 'x' }).ok).toBe(true);
		expect(admit(casualHost, 'startGame').ok).toBe(true);
		expect(admit(casualHost, 'setNavigationTimer', { durationMs: null }).ok).toBe(true);
	});

	it('host-only lobby commands reject non-hosts', () => {
		for (const type of ['startGame', 'setNavigationTimer']) {
			const verdict = admit(seatedCasualPlayer, type);
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.code).toBe('host_only');
		}
	});
});

describe('integrity tools (counters, flips, dice/mat spawning, market, commitRound, debugGrant)', () => {
	it('are NEVER admissible for production external callers, any role, any mode', () => {
		for (const type of INTEGRITY_TOOLS) {
			for (const ctx of [seatedCasualPlayer, casualHost, seatedRankedPlayer, rankedHost]) {
				const verdict = admit({ ...ctx, allowIntegrityTools: false }, type);
				expect(verdict.ok, `${type} must be denied`).toBe(false);
			}
		}
	});

	it('are admissible ONLY under the explicit dev/test opt-in — and never in ranked even then', () => {
		expect(
			admit({ ...casualHost, allowIntegrityTools: true }, 'adjustVictoryPoints', { amount: 1 }).ok
		).toBe(true);
		for (const type of INTEGRITY_TOOLS) {
			expect(admit({ ...rankedHost, allowIntegrityTools: true }, type).ok, type).toBe(false);
			expect(
				admit({ ...seatedRankedPlayer, allowIntegrityTools: true }, type).ok,
				type
			).toBe(false);
		}
	});
});

describe('ranked rejects every host/admin/rescue path', () => {
	it('forceAdvancePhase is rejected in ranked for EVERYONE (including the host)', () => {
		for (const ctx of [rankedHost, seatedRankedPlayer]) {
			const verdict = admit(ctx, 'forceAdvancePhase');
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.code).toBe('ranked_forbids_host_tools');
		}
	});

	it('ranked rejects all wire lobby commands (assembly is server-internal)', () => {
		for (const type of LOBBY_COMMANDS) {
			expect(admit(rankedHost, type).ok, type).toBe(false);
			expect(admit(seatedRankedPlayer, type).ok, type).toBe(false);
		}
	});

	it('forceAdvancePhase stays available to the CASUAL host only', () => {
		expect(admit(casualHost, 'forceAdvancePhase').ok).toBe(true);
		const verdict = admit(seatedCasualPlayer, 'forceAdvancePhase');
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.code).toBe('host_only');
	});

	it('RANKED_FORBIDDEN_LEDGER_TYPES covers every integrity + host tool (quarantine list)', () => {
		for (const type of [...INTEGRITY_TOOLS, ...HOST_TOOLS]) {
			expect(RANKED_FORBIDDEN_LEDGER_TYPES.has(type), type).toBe(true);
		}
		for (const type of PLAYER_COMMANDS) {
			expect(RANKED_FORBIDDEN_LEDGER_TYPES.has(type), type).toBe(false);
		}
	});
});

describe('bot identities', () => {
	it('a bot member arriving over the wire is refused outright', () => {
		const verdict = admit({ ...seatedCasualPlayer, isBot: true }, 'passEncounter');
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.code).toBe('bot_identity_forbidden');
	});
});

describe('wire schema (identical on HTTP and WS)', () => {
	it('cmdId: bounded printable ASCII, no whitespace, ≤128', () => {
		expect(isValidCmdId('c1a2-3')).toBe(true);
		expect(isValidCmdId('a')).toBe(true);
		expect(isValidCmdId('x'.repeat(128))).toBe(true);
		expect(isValidCmdId('x'.repeat(129))).toBe(false);
		expect(isValidCmdId('')).toBe(false);
		expect(isValidCmdId('has space')).toBe(false);
		expect(isValidCmdId('tab\there')).toBe(false);
		expect(isValidCmdId('émoji✨')).toBe(false);
		expect(isValidCmdId(null)).toBe(false);
		expect(isValidCmdId(42)).toBe(false);
		expect(isValidCmdId({ toString: () => 'x' })).toBe(false);
	});

	it('command shape: plain object, bounded string type, bounded total size', () => {
		expect(validateCommandShape({ type: 'passEncounter' })).toBe(true);
		expect(validateCommandShape(null)).toBe(false);
		expect(validateCommandShape('passEncounter')).toBe(false);
		expect(validateCommandShape([{ type: 'passEncounter' }])).toBe(false);
		expect(validateCommandShape({})).toBe(false);
		expect(validateCommandShape({ type: 42 })).toBe(false);
		expect(validateCommandShape({ type: 'x'.repeat(65) })).toBe(false);
		expect(validateCommandShape({ type: 'passEncounter', junk: 'x'.repeat(20_000) })).toBe(false);
		const circular: Record<string, unknown> = { type: 'passEncounter' };
		circular.self = circular;
		expect(validateCommandShape(circular)).toBe(false);
	});

	it('a malformed command is rejected by admission before any tier logic', () => {
		const verdict = admitCommand(seatedCasualPlayer, { notAType: true });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.code).toBe('malformed_command');
	});
});
