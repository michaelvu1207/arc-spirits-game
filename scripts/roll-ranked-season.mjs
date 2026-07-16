#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

const args = new Map(process.argv.slice(2).filter((arg) => arg.startsWith('--') && arg.includes('='))
	.map((arg) => { const index = arg.indexOf('='); return [arg.slice(2, index), arg.slice(index + 1)]; }));
const confirmed = process.argv.includes('--confirm');
const current = args.get('current');
const next = args.get('next');
const name = args.get('name');
const starts = args.get('starts');
const ends = args.get('ends');

if (!confirmed || !current || !next || !name || !starts || !ends) {
	console.error('Usage: npm run ranked:roll -- --current=<id> --next=<id> --name=<name> --starts=<ISO> --ends=<ISO> --confirm');
	process.exit(2);
}
if (!Number.isFinite(Date.parse(starts)) || !Number.isFinite(Date.parse(ends)) || Date.parse(ends) <= Date.parse(starts)) {
	console.error('Invalid season timestamps.');
	process.exit(2);
}
const url = process.env.PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
	console.error('Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
	process.exit(2);
}

const admin = createClient(url, serviceKey, {
	db: { schema: 'arc_spirits_2d' }, auth: { persistSession: false, autoRefreshToken: false }
});
const { data, error } = await admin.rpc('roll_ranked_season', {
	p_current_season_id: current, p_next_season_id: next, p_next_name: name,
	p_starts_at: new Date(starts).toISOString(), p_ends_at: new Date(ends).toISOString()
});
if (error) {
	console.error(`Season rollover failed: ${error.message}`);
	process.exit(1);
}
console.log(JSON.stringify({ current, next, rolled: data?.rolled === true, alreadyActive: data?.already_active === true }));
