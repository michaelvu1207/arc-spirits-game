import type { ClassTrait, OriginTrait, ResolvedSpiritAsset } from '$lib/types';

type SpiritSeed = readonly [
	id: string,
	name: string,
	cost: number,
	classes: readonly string[],
	origins: readonly string[]
];

const SEEDS: readonly SpiritSeed[] = [
	['57b06434-0eeb-4e9e-a17f-c2bdce613e52', 'Hero Captain', 1, ['Captain'], ['Human Enclave']],
	['cfccc89f-06fe-4bd7-85f9-c5f9416cd1b4', 'Hero Ironmane', 1, ['Ironmane'], ['Human Enclave']],
	['a6c24fba-940e-4aa9-8729-a361f7209f9c', 'Hero Ivern', 1, ['Sharpshooter'], ['Human Enclave']],
	['aa541f5d-f648-4964-9e8b-db891c2bbd81', 'Hero Mintyheart', 1, ['Healer'], ['Human Enclave']],
	['3aefb245-b1d8-43ab-8aa2-cb2210abbb72', 'Hero Nyra', 1, ['Arc Mage'], ['Human Enclave']],
	[
		'f043914f-9259-481f-960d-ab83a48b06ba',
		'Hero Zarek',
		1,
		['Adaptive Fighter'],
		['Human Enclave']
	],
	['9707edd6-fbc3-4433-99f2-a687f39505fd', 'CyberDive', 3, ['Elementalist'], ['Cyber City']],
	['9ef2c6f9-c6b3-4ec0-8e6e-4ddd5b26b344', 'Cyberwolf', 3, ['Spirit Animal'], ['Cyber City']],
	['e368f98d-fa19-47b0-bb54-1dd26d902b23', 'Dandelion', 3, ['Soul Weaver'], ['Floral Patch']],
	['a5e1965a-4b51-4de4-ad42-2f8ac085ff0e', 'Firefox', 3, ['Spirit Animal'], ['Floral Patch']],
	['c6548ffd-4852-4e62-9c5a-9329e40d222e', 'Fish Guide', 3, ['Cultivator'], ['Moon Tide']],
	[
		'afcb8700-c12e-45b5-b844-bf4339354e76',
		'Floral Fighter',
		3,
		['Fighter', 'Cursed Spirit'],
		['Floral Patch']
	],
	['d19f66b7-787b-4c5b-b498-e1f8fb7688e0', 'Flowercracker', 3, ['Elementalist'], ['Floral Patch']],
	[
		'cb20dc2d-f486-45ac-a1b7-3f7d97805d09',
		'Forbidden Child',
		3,
		['Cultivator', 'Cursed Spirit'],
		['Lantern Lights']
	],
	['ee907abd-2f0a-4b8b-a004-f6012d2ab6ad', 'Girl of Souls', 3, ['Soul Weaver'], ['Lantern Lights']],
	['7e3d88c0-6854-4c13-882c-ddf78c0d2b58', 'KO Fighter', 3, ['Fighter'], ['Cyber City']],
	['b5ceee38-e08f-44e4-b87a-93cb024cbfd8', 'Lantern Child', 3, ['Cultivator'], ['Lantern Lights']],
	['47504f4d-bfab-4e7c-98d7-3476b28d922d', 'Lantern Fighter', 3, ['Fighter'], ['Lantern Lights']],
	[
		'1781a426-913b-4446-a062-a0ecfe401027',
		'Pond Girl',
		3,
		['Elementalist', 'Cursed Spirit'],
		['Moon Tide']
	],
	[
		'241c977c-d1c8-4ef5-856b-8100ef228f72',
		'Squid Girl',
		3,
		['Soul Weaver', 'Cursed Spirit'],
		['Moon Tide']
	],
	[
		'5f719599-3914-440e-b518-2426ab1e83c5',
		'SUPERBUG',
		3,
		['Cursed Spirit', 'Cursed Spirit'],
		['Cyber City']
	],
	['e95c775b-0677-4884-bc59-12ae2762ca8b', 'Turtle', 3, ['Spirit Animal'], ['Moon Tide']],
	['955abfc0-fa04-4ab3-bcaf-5dc2839ddec0', 'Aquamaiden', 7, ['Aquamaiden'], ['Moon Tide']],
	['e75cb10c-fee4-488b-a213-e663c0fecae7', 'Arcane Synthesizer', 7, ['Arcane Advisor'], ['Void']],
	[
		'67c591ab-4227-4656-8697-247243975076',
		'Astrobiologist',
		7,
		['Elementalist', 'Elementalist', 'Elementalist'],
		['Astral Zone']
	],
	['18154c10-1422-4655-a7cd-c637ac947916', 'Beefender', 7, ['Strategist'], ['Floral Patch']],
	['fc5835e9-156b-44fd-8037-832124df724c', 'Blood Hound', 7, ['Blood Hunter'], ['Void']],
	['728c5151-2da6-4202-b5b0-aae13dec68be', 'Child Prodigy', 7, ['Child Prodigy'], ['Royal Family']],
	['ed612933-fd19-4b68-993e-6e61b52eb4ce', 'Comet Caller', 7, ['Rune Mage'], ['Astral Zone']],
	['40016186-6b98-4dbb-8364-b50d27e9f394', 'ENCODER', 7, ['Infiltrator'], ['Cyber City']],
	[
		'5c864c2d-20bd-4134-a829-09a2cc793e41',
		'Fairy Droid',
		7,
		['Fairy Droid', 'Fairy'],
		['Cyber City']
	],
	['0a775e09-555f-43a7-ac5b-06aaeaa4b69c', 'Firewall', 7, ['Disruptor'], ['Cyber City']],
	['ae827012-29ff-406e-bcbe-afe3a5258607', 'Floral Fairy', 7, ['Fairy'], ['Floral Patch']],
	['487e38c3-0c11-4879-a5f2-4370dec9a680', 'Golden Retriever', 7, ['Undercover'], ['Royal Family']],
	[
		'70ed3fcd-a7c2-4443-b5e7-9b6de8491917',
		'Hollow Eyes',
		7,
		['Spirit Animal', 'Spirit Animal', 'Spirit Animal'],
		['Void']
	],
	['c0d12557-4615-4c60-a93c-622e5fc70eae', 'Lantern Fairy', 7, ['Fairy'], ['Lantern Lights']],
	[
		'25848694-6c69-408c-9b78-94948c6df3a6',
		'Lightcatcher',
		7,
		['Dark Assassin'],
		['Lantern Lights']
	],
	['5dc44c85-8224-4c49-89ff-90a37aa10040', 'Meteor Shower', 7, ['Ancient Magus'], ['Astral Zone']],
	['b8314d8f-ea32-44de-a3ad-62944e5ccecb', 'Mod Injector', 7, ['Mod Injector'], ['Cyber City']],
	['3b196b06-a047-4505-aad6-bf0c9fe05ac0', 'Rootguard', 7, ['Purifier'], ['Floral Patch']],
	['b3068fcf-d197-4030-ba55-29ac1621f9a9', 'Space Invader', 7, ['Dark Fighter'], ['Void']],
	[
		'e24e9f91-7333-44c0-968e-15b900af3385',
		'Stellar Songbird',
		7,
		['Spirit Animal', 'Spirit Animal', 'Spirit Animal'],
		['Astral Zone']
	],
	['36bb656c-49fe-4d50-a037-b29dbd1bfa91', 'Tidal Fairy', 7, ['Fairy'], ['Moon Tide']],
	['2d7981eb-440d-45ec-b058-d495e703c71e', 'Undercover Maid', 7, ['Undercover'], ['Royal Family']],
	['d89f5d3a-5519-4b96-baf0-1f0a49c0ada1', 'Wish Maker', 7, ['Firekeeper'], ['Lantern Lights']],
	[
		'cafb6cfb-11f8-476c-a275-a5b8179630d2',
		'Arcane Huntress',
		9,
		['Deep Sea Hunter'],
		['Moon Tide']
	],
	['e4822f18-98f0-44fd-8711-756f946f6cd5', 'Contessa', 9, ['World Ender'], ['Void']],
	[
		'e9e12faa-0add-4fab-b251-a9dec5a8bae9',
		'Cosmic Guardian',
		9,
		['World Guardian'],
		['Astral Zone']
	],
	['e5dff9be-ac58-47bb-bd9d-69efb03dc393', 'Florality', 9, ['Abyss Summoner'], ['Floral Patch']],
	['a77653c5-69fa-4351-833d-59d302722365', 'Golden Ruler', 9, ['Golden Ruler'], ['Royal Family']],
	[
		'504c77b5-8f46-427d-a339-1ef11160b0d7',
		'Golem of Embers',
		9,
		['Golem of Wishes'],
		['Lantern Lights']
	],
	['fc667265-edd6-4c28-b96e-6e505188ce72', 'Shadowtaker', 9, ['The Corruptor'], ['Void']],
	['be2072ea-ccdb-4941-b1b3-26890a7b64cf', 'Water Dragon', 9, ['Dragon Warrior'], ['Moon Tide']]
];

const ORIGIN_COLORS: Record<string, string> = {
	'Astral Zone': '#4a7ad9',
	'Cyber City': '#3b82f6',
	'Floral Patch': '#10b981',
	'Human Enclave': '#6b7280',
	'Lantern Lights': '#a95189',
	'Moon Tide': '#64748b',
	'Royal Family': '#f59e0b',
	Void: '#6b7280'
};

function key(name: string): string {
	return `bundled-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function classTrait(name: string): ClassTrait {
	return {
		id: key(name),
		name,
		position: 0,
		icon_png: null,
		color: name === 'Fighter' ? '#059669' : name === 'Healer' ? '#88a1d3' : '#8b5cf6',
		description: null,
		effect_schema: null
	};
}

function originTrait(name: string): OriginTrait {
	return {
		id: key(name),
		name,
		position: 0,
		icon_png: null,
		icon_token_png: null,
		color: ORIGIN_COLORS[name] ?? '#6b7280',
		description: null
	};
}

/** Always-available roster for menu tools; live Supabase assets replace it when available. */
export const BUNDLED_SPIRIT_CATALOG: ResolvedSpiritAsset[] = SEEDS.map(
	([id, name, cost, classes, origins]) => ({
		id,
		name,
		cost,
		imageUrl: null,
		traits: {
			classes: classes.map(classTrait),
			origins: origins.map(originTrait)
		}
	})
);
