import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { upsertGameNotes } from '$lib/supabase';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { gameId, hostSecret, summary, improvements } = body;

		// Validate required fields
		if (!gameId) {
			throw error(400, 'Game ID is required');
		}

		if (!hostSecret) {
			throw error(400, 'Host secret is required');
		}

		// Validate secret against environment variable
		if (!env.HOST_SECRET_KEY || hostSecret !== env.HOST_SECRET_KEY) {
			throw error(403, 'Invalid host secret');
		}

		await upsertGameNotes({
			gameId,
			summary: summary || null,
			improvements: improvements || []
		});

		return json({ success: true, message: 'Notes saved' });
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) {
			throw err; // Re-throw SvelteKit errors
		}
		console.error('Unexpected error:', err);
		throw error(500, 'An unexpected error occurred');
	}
};
