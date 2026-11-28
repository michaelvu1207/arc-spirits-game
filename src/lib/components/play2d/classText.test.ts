/**
 * The class text the game screens print follows the rules in force (classText.ts), checked on the
 * working tables: lab/data/classes.json still carries the texts of earlier rules for some classes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRules } from '$lib/play/rules';
import type { ClassTrait } from '$lib/types';
import { classTextInForce } from './classText';

const classes = JSON.parse(readFileSync('data/classes.json', 'utf8')) as ClassTrait[];
const rules = { rules: parseRules(JSON.parse(readFileSync('data/rules.json', 'utf8'))).rules };
const cls = (name: string) => classes.find((c) => c.name === name)!;
const text = (name: string, catalog: typeof rules | null) =>
	classTextInForce(catalog, cls(name)).schema.map((tier) => (tier.effects ?? []).map((e) => e.description).join(' '));

describe('classTextInForce', () => {
	it('without rules the card data is printed as it is', () => {
		const hunter = classTextInForce(null, cls('Monster Hunter'));
		expect(hunter.changed).toBe(false);
		expect(hunter.schema).toBe(cls('Monster Hunter').effect_schema);
	});

	it('Monster Hunter reads as a battle action under the fight-or-summon rule', () => {
		expect(text('Monster Hunter', rules)).toEqual(['You have 1 extra battle action each round.']);
		expect(classTextInForce(rules, cls('Monster Hunter')).changed).toBe(true);
	});

	it('no class text names an initiative number under the initiative die', () => {
		for (const c of classes) {
			for (const line of text(c.name, rules)) expect(line, c.name).not.toMatch(/\d+ (combat )?[Ii]nitiative/);
		}
	});

	it('Firetail is the new damage text, and a class no rule touches is unchanged', () => {
		expect(text('Firetail', rules)).toEqual(['In a round when another player is at your location, deal 3 more damage in combat.']);
		expect(classTextInForce(rules, cls('Healer')).changed).toBe(false);
	});
});
