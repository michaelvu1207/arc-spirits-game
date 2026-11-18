import { describe, expect, it } from 'vitest';
import { ability } from './abyssSummoner';

describe('Summoner', () => {
	// The old Summoner is handled at the runtime summon/discard bag boundaries; the class file
	// holds only the rule `summonerCultivate` handler (tested in worldEnder.test.ts).
	it('has one handler, on Cultivate', () => expect(ability.map((a) => a.on)).toEqual(['onCultivate']));
});
