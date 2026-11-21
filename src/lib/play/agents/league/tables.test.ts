/** league.json `tables` (Michael, 2026-11-21): predefined tables, each repeated in turn. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Seating } from './seating';
import type { LeagueAgent } from './agents';

const agent = (id: string): LeagueAgent => ({ id, dir: '', name: id, model: 'mock:random', effort: 'low', memory: 'fresh', learn: false, strategy: { id, name: id, text: '' } });
const agents = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'].map(agent);
const path = () => join(mkdtempSync(join(tmpdir(), 'tables-')), 'seating.json');

describe('league.json tables', () => {
	const tables = [
		['a1', 'a2', 'a3', 'a4'],
		['b1', 'b2', 'b3', 'b4'],
		['a1', 'b1', 'a2', 'b2']
	];
	it('game n seats table n modulo the list, in the given seat order, with the usual game seeds', () => {
		const s = new Seating(path(), agents, { seed: 100, tableSize: 4, tables }, () => false);
		for (let i = 0; i < 7; i++) expect(s.game(i)).toEqual({ index: i, seed: 100 + i, seats: tables[i % 3] });
	});
	it('a game that has started keeps its seats', () => {
		const file = path();
		const first = new Seating(file, agents, { seed: 100, tableSize: 4, tables }, () => false);
		first.record(first.game(1));
		const again = new Seating(file, agents, { seed: 100, tableSize: 4, tables: [tables[0]] }, () => false);
		expect(again.game(1).seats).toEqual(tables[1]);
		expect(again.game(2).seats).toEqual(tables[0]);
	});
	it('absent: the balanced schedule, as before', () => {
		const plain = new Seating(path(), agents, { seed: 100, tableSize: 4 }, () => false);
		const empty = new Seating(path(), agents, { seed: 100, tableSize: 4, tables: [] }, () => false);
		for (let i = 0; i < 8; i++) expect(empty.game(i)).toEqual(plain.game(i));
	});
});
