/**
 * Committed offline catalog fixture generated from the linked live database.
 * Captured 2026-08-04 from arc_spirits_assets.classes and the ACTIVE
 * arc_spirits_assets.hex_spirits table. Disabled spirits are intentionally absent.
 *
 * Refresh this fixture whenever Combined Spirit Data changes. The coverage test
 * compares every active class and spirit awaken condition with executable rules.
 */

import type { AwakenCondition } from '$lib/types';

export interface CatalogClassRow {
	id: string;
	name: string;
	class_type: string | null;
	is_special: boolean;
}

export interface CatalogSpiritRow {
	id: string;
	name: string;
	awaken_condition: AwakenCondition | null;
}

export const CATALOG_CLASSES: CatalogClassRow[] = [
	{ id: '91322cba-4201-48a3-86b1-2d6d034fce3f', name: 'Abyss Summoner', class_type: 'special', is_special: true },
	{ id: '89a2cec9-bdcd-4b48-9574-033098e74438', name: 'Battle Adept', class_type: 'human', is_special: false },
	{ id: '5ef93452-0c88-4710-83b9-bbebadbdd8cf', name: 'Relic Warden', class_type: 'special', is_special: true },
	{ id: '0d15066d-ab3b-4c84-b0d5-4562a1c5fbb7', name: 'Tide Warden', class_type: 'special', is_special: true },
	{ id: 'cd699d38-fea9-4bb9-9244-8acfa74f8e5a', name: 'Arcane Alchemist', class_type: 'human', is_special: false },
	{ id: 'cbbdd615-d54b-4aa3-b860-ef605df41f91', name: 'Arcane Ascendant', class_type: 'special', is_special: true },
	{ id: '33c7d413-1dd0-472f-be67-5505cd830084', name: 'Woundreaver', class_type: 'special', is_special: true },
	{ id: '85021637-3ad8-4476-a675-8187938dd7ee', name: 'Captain', class_type: 'human', is_special: false },
	{ id: 'dcf1dd2d-3369-468f-9475-5ffc5b7bc1ed', name: 'Wayfarer', class_type: 'special', is_special: true },
	{ id: 'aa90084b-a07a-4b00-9448-9f5dae83bd03', name: 'Cultivator', class_type: 'normal', is_special: false },
	{ id: '20d2a252-3655-4839-93a4-04db111c0617', name: 'Cursed Spirit', class_type: 'normal', is_special: false },
	{ id: '8015821c-08cd-4895-9b03-865ad09976aa', name: 'Aegis Weaver', class_type: 'special', is_special: true },
	{ id: '136bd398-5144-46d6-a128-371b2d39596a', name: 'Fatestriker', class_type: 'special', is_special: true },
	{ id: '1a894014-2829-480e-9c16-75c92aa05b47', name: 'Tide Stalker', class_type: 'special', is_special: true },
	{ id: 'bf04c279-bcff-41f0-a9e3-be3f9161b887', name: 'Disruptor', class_type: 'special', is_special: true },
	{ id: 'd94cc132-6e83-4527-9f15-2365fde69518', name: 'Arcane Vanguard', class_type: 'special', is_special: true },
	{ id: '173589ed-9bec-4965-94e6-dadbc6b5310a', name: 'Elementalist', class_type: 'normal', is_special: false },
	{ id: 'd4752205-1dcb-4f87-8b46-14c4b1bd97d5', name: 'Fairy', class_type: 'special', is_special: true },
	{ id: '41180098-1490-4223-9a5a-415a6ec89ca0', name: 'Runebound Vessel', class_type: 'special', is_special: true },
	{ id: 'dd17c072-159c-4b43-831f-1f51bb8b7720', name: 'Fighter', class_type: 'normal', is_special: false },
	{ id: 'e6cb39c6-eee0-47d2-b032-c2a992ab7378', name: 'Emberguard', class_type: 'special', is_special: true },
	{ id: 'f0aebe91-6217-4f9c-a85e-94ac2232f5b4', name: 'Golden Ruler', class_type: 'special', is_special: true },
	{ id: '1f880d9d-f0e7-4d2b-8e50-ce9883b1c102', name: 'Living Bastion', class_type: 'special', is_special: true },
	{ id: '46cf02f0-a3cd-4211-bde4-cc3c5417bd6f', name: 'Healer', class_type: 'human', is_special: false },
	{ id: '601d161f-0d86-4904-afe9-20dd096954c9', name: 'Cursed Fighter', class_type: 'special', is_special: true },
	{ id: '41a377bb-c49a-4675-8ecc-44105135ed5b', name: 'Monster Hunter', class_type: 'human', is_special: false },
	{ id: '72bf99e7-2cf1-497b-9a8e-1df58e37096d', name: 'Runic Duplicator', class_type: 'special', is_special: true },
	{ id: '2686944a-49f4-4a5e-ac3d-d10d14bb9609', name: 'Rune Mage', class_type: 'special', is_special: true },
	{ id: '97724d22-27de-490d-86d4-e87e83d25961', name: 'Sharpshooter', class_type: 'human', is_special: false },
	{ id: '17e08cde-f3d2-480b-8386-1e3047e2f85a', name: 'Soul Weaver', class_type: 'normal', is_special: false },
	{ id: 'f5438f3c-2052-4093-b402-893a45cf7046', name: 'Spirit Animal', class_type: 'normal', is_special: false },
	{ id: '4768cb25-60ac-4178-b9e3-25aca98f495a', name: 'Runic Bulwark', class_type: 'special', is_special: true },
	{ id: 'ae0ad0aa-9ab5-4872-9777-ebc21717adc2', name: 'The Corruptor', class_type: 'special', is_special: true },
	{ id: '8e156cb4-1461-411f-8b0c-79adacbc9d97', name: 'Growth Warden', class_type: 'special', is_special: true },
	{ id: '9e0b5091-19a9-464c-ad81-bd0e8a4dd48b', name: 'Relic Envoy', class_type: 'special', is_special: true },
	{ id: 'acbc0f6d-1514-45aa-85a0-a5d635db6e51', name: 'Void Sovereign', class_type: 'special', is_special: true },
	{ id: 'd02f42f6-6451-4f8a-a586-ac130f9885a9', name: 'Relic Sentinel', class_type: 'special', is_special: true }
];

export const CATALOG_SPIRITS: CatalogSpiritRow[] = [
	{ id: '57b06434-0eeb-4e9e-a17f-c2bdce613e52', name: 'Hero Captain', awaken_condition: null },
	{ id: 'cfccc89f-06fe-4bd7-85f9-c5f9416cd1b4', name: 'Hero Ironmane', awaken_condition: null },
	{ id: 'a6c24fba-940e-4aa9-8729-a361f7209f9c', name: 'Hero Ivern', awaken_condition: null },
	{ id: 'aa541f5d-f648-4964-9e8b-db891c2bbd81', name: 'Hero Mintyheart', awaken_condition: null },
	{ id: '3aefb245-b1d8-43ab-8aa2-cb2210abbb72', name: 'Hero Nyra', awaken_condition: null },
	{ id: 'f043914f-9259-481f-960d-ab83a48b06ba', name: 'Hero Zarek', awaken_condition: null },
	{ id: '9707edd6-fbc3-4433-99f2-a687f39505fd', name: 'CyberDive', awaken_condition: null },
	{ id: '9ef2c6f9-c6b3-4ec0-8e6e-4ddd5b26b344', name: 'Cyberwolf', awaken_condition: null },
	{ id: 'e368f98d-fa19-47b0-bb54-1dd26d902b23', name: 'Dandelion', awaken_condition: null },
	{ id: 'a5e1965a-4b51-4de4-ad42-2f8ac085ff0e', name: 'Firefox', awaken_condition: null },
	{ id: 'c6548ffd-4852-4e62-9c5a-9329e40d222e', name: 'Fish Guide', awaken_condition: null },
	{ id: 'afcb8700-c12e-45b5-b844-bf4339354e76', name: 'Floral Fighter', awaken_condition: null },
	{ id: 'd19f66b7-787b-4c5b-b498-e1f8fb7688e0', name: 'Flowercracker', awaken_condition: null },
	{ id: 'cb20dc2d-f486-45ac-a1b7-3f7d97805d09', name: 'Forbidden Child', awaken_condition: null },
	{ id: 'ee907abd-2f0a-4b8b-a004-f6012d2ab6ad', name: 'Girl of Souls', awaken_condition: null },
	{ id: '7e3d88c0-6854-4c13-882c-ddf78c0d2b58', name: 'KO Fighter', awaken_condition: null },
	{ id: 'b5ceee38-e08f-44e4-b87a-93cb024cbfd8', name: 'Lantern Child', awaken_condition: null },
	{ id: '47504f4d-bfab-4e7c-98d7-3476b28d922d', name: 'Lantern Fighter', awaken_condition: null },
	{ id: '1781a426-913b-4446-a062-a0ecfe401027', name: 'Pond Girl', awaken_condition: null },
	{ id: '241c977c-d1c8-4ef5-856b-8100ef228f72', name: 'Squid Girl', awaken_condition: null },
	{ id: '5f719599-3914-440e-b518-2426ab1e83c5', name: 'SUPERBUG', awaken_condition: null },
	{ id: 'e95c775b-0677-4884-bc59-12ae2762ca8b', name: 'Turtle', awaken_condition: null },
	{ id: '955abfc0-fa04-4ab3-bcaf-5dc2839ddec0', name: 'Aquamaiden', awaken_condition: { type: 'rune_cost', rune_ids: ['a6111d01-2c55-4b1f-854a-32887d92b8e1', 'a6111d01-2c55-4b1f-854a-32887d92b8e1', 'a6111d01-2c55-4b1f-854a-32887d92b8e1'] } },
	{ id: 'e75cb10c-fee4-488b-a213-e663c0fecae7', name: 'Arcane Synthesizer', awaken_condition: { type: 'text', text: 'Discard 2 Arcane Abyss Spirits.' } },
	{ id: '67c591ab-4227-4656-8697-247243975076', name: 'Astrobiologist', awaken_condition: { type: 'text', text: 'Discard 2 Arcane Abyss Spirits.' } },
	{ id: '18154c10-1422-4655-a7cd-c637ac947916', name: 'Beefender', awaken_condition: { type: 'rune_cost', rune_ids: ['690a7e3b-5737-4494-bb8a-b58bee13f473', '690a7e3b-5737-4494-bb8a-b58bee13f473'] } },
	{ id: '728c5151-2da6-4202-b5b0-aae13dec68be', name: 'Child Prodigy', awaken_condition: { type: 'rune_cost', rune_ids: ['19d72567-4ac8-4214-a21f-596bc88de8f7', '19d72567-4ac8-4214-a21f-596bc88de8f7', '19d72567-4ac8-4214-a21f-596bc88de8f7'] } },
	{ id: 'ed612933-fd19-4b68-993e-6e61b52eb4ce', name: 'Comet Caller', awaken_condition: { type: 'rune_cost', rune_ids: ['19d72567-4ac8-4214-a21f-596bc88de8f7', '19d72567-4ac8-4214-a21f-596bc88de8f7'] } },
	{ id: '40016186-6b98-4dbb-8364-b50d27e9f394', name: 'ENCODER', awaken_condition: { type: 'rune_cost', rune_ids: ['ee1486a0-8b61-499c-809b-b4de9920aa8f', 'ee1486a0-8b61-499c-809b-b4de9920aa8f'] } },
	{ id: '5c864c2d-20bd-4134-a829-09a2cc793e41', name: 'Fairy Droid', awaken_condition: { type: 'rune_cost', rune_ids: ['ee1486a0-8b61-499c-809b-b4de9920aa8f', 'ee1486a0-8b61-499c-809b-b4de9920aa8f'] } },
	{ id: '0a775e09-555f-43a7-ac5b-06aaeaa4b69c', name: 'Firewall', awaken_condition: { type: 'rune_cost', rune_ids: ['ee1486a0-8b61-499c-809b-b4de9920aa8f', 'ee1486a0-8b61-499c-809b-b4de9920aa8f'] } },
	{ id: 'ae827012-29ff-406e-bcbe-afe3a5258607', name: 'Floral Fairy', awaken_condition: { type: 'text', text: 'Cultivate with 4 Unique Forest Spirits.' } },
	{ id: '70ed3fcd-a7c2-4443-b5e7-9b6de8491917', name: 'Hollow Eyes', awaken_condition: { type: 'text', text: 'In combat, fail to defeat the enemy AND get yourself corrupted.' } },
	{ id: 'c0d12557-4615-4c60-a93c-622e5fc70eae', name: 'Lantern Fairy', awaken_condition: { type: 'text', text: 'Cultivate with 4 Unique Lantern Spirits.' } },
	{ id: '25848694-6c69-408c-9b78-94948c6df3a6', name: 'Lightcatcher', awaken_condition: { type: 'rune_cost', rune_ids: ['8a0d54ca-aeab-405c-9e5c-1c1425d1aa86', '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86'] } },
	{ id: '5dc44c85-8224-4c49-89ff-90a37aa10040', name: 'Meteor Shower', awaken_condition: { type: 'text', text: 'Discard 2 unique relics.' } },
	{ id: 'b8314d8f-ea32-44de-a3ad-62944e5ccecb', name: 'Mod Injector', awaken_condition: { type: 'rune_cost', rune_ids: ['7ca279f0-1ca8-484a-a86e-0a87aaa7b312', 'ee1486a0-8b61-499c-809b-b4de9920aa8f', 'ee1486a0-8b61-499c-809b-b4de9920aa8f'] } },
	{ id: '3b196b06-a047-4505-aad6-bf0c9fe05ac0', name: 'Rootguard', awaken_condition: { type: 'rune_cost', rune_ids: ['690a7e3b-5737-4494-bb8a-b58bee13f473', '690a7e3b-5737-4494-bb8a-b58bee13f473'] } },
	{ id: 'b3068fcf-d197-4030-ba55-29ac1621f9a9', name: 'Space Invader', awaken_condition: { type: 'text', text: 'Discard 4 of any attack dice.' } },
	{ id: 'e24e9f91-7333-44c0-968e-15b900af3385', name: 'Stellar Songbird', awaken_condition: { type: 'rune_cost', rune_ids: ['19d72567-4ac8-4214-a21f-596bc88de8f7', '19d72567-4ac8-4214-a21f-596bc88de8f7'] } },
	{ id: '36bb656c-49fe-4d50-a037-b29dbd1bfa91', name: 'Tidal Fairy', awaken_condition: { type: 'text', text: 'Cultivate with 4 Unique Tidal Spirits.' } },
	{ id: 'd89f5d3a-5519-4b96-baf0-1f0a49c0ada1', name: 'Wish Maker', awaken_condition: { type: 'rune_cost', rune_ids: ['8a0d54ca-aeab-405c-9e5c-1c1425d1aa86', '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86'] } },
	{ id: 'cafb6cfb-11f8-476c-a275-a5b8179630d2', name: 'Arcane Huntress', awaken_condition: { type: 'text', text: 'Cultivate with 10 potential, with status Fallen.' } },
	{ id: 'e4822f18-98f0-44fd-8711-756f946f6cd5', name: 'Contessa', awaken_condition: { type: 'text', text: 'Cultivate while Evil.' } },
	{ id: 'e9e12faa-0add-4fab-b251-a9dec5a8bae9', name: 'Cosmic Guardian', awaken_condition: { type: 'text', text: 'Get corrupted from combat.' } },
	{ id: 'e5dff9be-ac58-47bb-bd9d-69efb03dc393', name: 'Florality', awaken_condition: { type: 'rune_cost', rune_ids: ['690a7e3b-5737-4494-bb8a-b58bee13f473', '690a7e3b-5737-4494-bb8a-b58bee13f473', '690a7e3b-5737-4494-bb8a-b58bee13f473'] } },
	{ id: 'a77653c5-69fa-4351-833d-59d302722365', name: 'Golden Ruler', awaken_condition: { type: 'rune_cost', rune_ids: ['19d72567-4ac8-4214-a21f-596bc88de8f7', '19d72567-4ac8-4214-a21f-596bc88de8f7', '19d72567-4ac8-4214-a21f-596bc88de8f7'] } },
	{ id: '504c77b5-8f46-427d-a339-1ef11160b0d7', name: 'Golem of Embers', awaken_condition: { type: 'rune_cost', rune_ids: ['8a0d54ca-aeab-405c-9e5c-1c1425d1aa86', '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86', '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86'] } },
	{ id: 'fc667265-edd6-4c28-b96e-6e505188ce72', name: 'Shadowtaker', awaken_condition: { type: 'text', text: 'Navigate to the Arcane Abyss, but don\'t fight the monster.' } },
	{ id: 'be2072ea-ccdb-4941-b1b3-26890a7b64cf', name: 'Water Dragon', awaken_condition: { type: 'rune_cost', rune_ids: ['a6111d01-2c55-4b1f-854a-32887d92b8e1', 'a6111d01-2c55-4b1f-854a-32887d92b8e1', '19d72567-4ac8-4214-a21f-596bc88de8f7'] } }
];
