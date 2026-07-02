import type { Cookies } from '@sveltejs/kit';

const ROOM_COOKIE_PREFIX = 'arc_spirits_play_member_';
const LAST_ROOM_COOKIE = 'arc_spirits_play_last_room';
const MEMBER_HEADER = 'x-play-member';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function normalizeRoomCode(roomCode: string): string {
	return roomCode.trim().toUpperCase();
}

function cookieName(roomCode: string): string {
	return `${ROOM_COOKIE_PREFIX}${normalizeRoomCode(roomCode)}`;
}

const baseOptions = {
	httpOnly: true,
	path: '/',
	sameSite: 'lax' as const,
	secure: false,
	maxAge: MAX_AGE_SECONDS
};

export function getRoomMemberCookie(cookies: Cookies, roomCode: string): string | null {
	return cookies.get(cookieName(roomCode)) ?? null;
}

export function getRoomMemberHeader(request: Request): string | null {
	const value = request.headers.get(MEMBER_HEADER)?.trim();
	return value || null;
}

export function getRoomMemberId(
	cookies: Cookies,
	roomCode: string,
	request?: Request
): string | null {
	return getRoomMemberCookie(cookies, roomCode) ?? (request ? getRoomMemberHeader(request) : null);
}

export function setRoomMemberCookie(cookies: Cookies, roomCode: string, memberId: string) {
	const normalized = normalizeRoomCode(roomCode);
	cookies.set(cookieName(normalized), memberId, baseOptions);
	cookies.set(LAST_ROOM_COOKIE, normalized, baseOptions);
}

export function clearRoomMemberCookie(cookies: Cookies, roomCode: string) {
	cookies.delete(cookieName(roomCode), { path: '/' });
}

export function getLastRoomCookie(cookies: Cookies): string | null {
	return cookies.get(LAST_ROOM_COOKIE) ?? null;
}

export function setLastRoomCookie(cookies: Cookies, roomCode: string) {
	cookies.set(LAST_ROOM_COOKIE, normalizeRoomCode(roomCode), baseOptions);
}
