/**
 * Committed offline catalog fixture. GENERATED 2026-11-11 from the November 2026 design data
 * (~/ArcSpiritsArt/game/classes.json and hex_spirits.json, including rows marked `local` that
 * are not in the database yet). Before this it mirrored the live database of 2026-08-04.
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
	{ id: "46cf02f0-a3cd-4211-bde4-cc3c5417bd6f", name: "Healer", class_type: "human", is_special: false },
	{ id: "dd17c072-159c-4b43-831f-1f51bb8b7720", name: "Fighter", class_type: "normal", is_special: false },
	{ id: "173589ed-9bec-4965-94e6-dadbc6b5310a", name: "Elementalist", class_type: "normal", is_special: false },
	{ id: "aa90084b-a07a-4b00-9448-9f5dae83bd03", name: "Cultivator", class_type: "normal", is_special: false },
	{ id: "17e08cde-f3d2-480b-8386-1e3047e2f85a", name: "Mystic", class_type: "normal", is_special: false },
	{ id: "f5438f3c-2052-4093-b402-893a45cf7046", name: "Beast", class_type: "normal", is_special: false },
	{ id: "20d2a252-3655-4839-93a4-04db111c0617", name: "Cursed Spirit", class_type: "normal", is_special: false },
	{ id: "91322cba-4201-48a3-86b1-2d6d034fce3f", name: "Summoner", class_type: "special", is_special: true },
	{ id: "d4752205-1dcb-4f87-8b46-14c4b1bd97d5", name: "Fairy", class_type: "special", is_special: true },
	{ id: "2686944a-49f4-4a5e-ac3d-d10d14bb9609", name: "Mage", class_type: "special", is_special: true },
	{ id: "bf04c279-bcff-41f0-a9e3-be3f9161b887", name: "Monk", class_type: "special", is_special: true },
	{ id: "ae0ad0aa-9ab5-4872-9777-ebc21717adc2", name: "Corruptor", class_type: "special", is_special: true },
	{ id: "5ef93452-0c88-4710-83b9-bbebadbdd8cf", name: "Cleric", class_type: "special", is_special: true },
	{ id: "97724d22-27de-490d-86d4-e87e83d25961", name: "Sharpshooter", class_type: "human", is_special: false },
	{ id: "601d161f-0d86-4904-afe9-20dd096954c9", name: "Ram", class_type: "special", is_special: true },
	{ id: "dcf1dd2d-3369-468f-9475-5ffc5b7bc1ed", name: "Nomad", class_type: "special", is_special: true },
	{ id: "33c7d413-1dd0-472f-be67-5505cd830084", name: "Woundreaver", class_type: "special", is_special: true },
	{ id: "cd699d38-fea9-4bb9-9244-8acfa74f8e5a", name: "Arcane Alchemist", class_type: "human", is_special: false },
	{ id: "f0aebe91-6217-4f9c-a85e-94ac2232f5b4", name: "King", class_type: "special", is_special: true },
	{ id: "9e0b5091-19a9-464c-ad81-bd0e8a4dd48b", name: "Relic Envoy", class_type: "special", is_special: true },
	{ id: "85021637-3ad8-4476-a675-8187938dd7ee", name: "Captain", class_type: "human", is_special: false },
	{ id: "89a2cec9-bdcd-4b48-9574-033098e74438", name: "Battle Adept", class_type: "human", is_special: false },
	{ id: "acbc0f6d-1514-45aa-85a0-a5d635db6e51", name: "Queen", class_type: "special", is_special: true },
	{ id: "d02f42f6-6451-4f8a-a586-ac130f9885a9", name: "Relic Sentinel", class_type: "special", is_special: true },
	{ id: "8e156cb4-1461-411f-8b0c-79adacbc9d97", name: "Druid", class_type: "special", is_special: true },
	{ id: "e6cb39c6-eee0-47d2-b032-c2a992ab7378", name: "Sentinel", class_type: "special", is_special: true },
	{ id: "41180098-1490-4223-9a5a-415a6ec89ca0", name: "Herder", class_type: "special", is_special: true },
	{ id: "72bf99e7-2cf1-497b-9a8e-1df58e37096d", name: "Smith", class_type: "special", is_special: true },
	{ id: "136bd398-5144-46d6-a128-371b2d39596a", name: "Assassin", class_type: "special", is_special: true },
	{ id: "1a894014-2829-480e-9c16-75c92aa05b47", name: "Huntress", class_type: "special", is_special: true },
	{ id: "41a377bb-c49a-4675-8ecc-44105135ed5b", name: "Monster Hunter", class_type: "human", is_special: false },
	{ id: "4768cb25-60ac-4178-b9e3-25aca98f495a", name: "Bastion", class_type: "special", is_special: true },
	{ id: "8015821c-08cd-4895-9b03-865ad09976aa", name: "Paladin", class_type: "special", is_special: true },
	{ id: "0d15066d-ab3b-4c84-b0d5-4562a1c5fbb7", name: "Warden", class_type: "special", is_special: true },
	{ id: "d94cc132-6e83-4527-9f15-2365fde69518", name: "Spellblade", class_type: "special", is_special: true },
	{ id: "1f880d9d-f0e7-4d2b-8e50-ce9883b1c102", name: "Titan", class_type: "special", is_special: true },
	{ id: "cbbdd615-d54b-4aa3-b860-ef605df41f91", name: "Sorcerer", class_type: "special", is_special: true },
	{ id: "7f97fa53-872c-4bc3-9ba5-bd6adbabb5ed", name: "Falconer", class_type: "special", is_special: true },
	{ id: "ecb8faea-28db-4251-8763-c6c2153e5829", name: "Princess", class_type: "special", is_special: true },
	{ id: "a2882c00-a986-4ac3-aad4-1747819115ce", name: "Feral", class_type: "special", is_special: true },
	{ id: "ef0cfa25-8073-41a1-8a85-e5f0e63e50cb", name: "Trader", class_type: "special", is_special: true },
	{ id: "1efbeaf7-fbbc-4952-8fdb-4b50e536f7ae", name: "Master", class_type: "special", is_special: true },
	{ id: "023ccfe2-115f-4af8-a6b6-f2f4ea7026cb", name: "Wildling", class_type: "special", is_special: true },
	{ id: "ea5c337c-744c-4959-be6a-ffe21605dfe2", name: "Wanderer", class_type: "special", is_special: true },
	{ id: "cb9401ba-634e-49e4-ba24-06220dc5ad9b", name: "Prince", class_type: "special", is_special: true },
	{ id: "215e1c8d-ee21-4200-a99b-aad7709016cc", name: "Hunter", class_type: "special", is_special: true },
	{ id: "e54aee76-cd22-4bde-b67c-bf05cf50d3c7", name: "Rider", class_type: "special", is_special: true },
	{ id: "31d81f29-7ea1-4e5c-9cda-aa3606e94925", name: "Salamander", class_type: "special", is_special: true },
	{ id: "c1a39792-b5b9-4749-830b-72f553a60ced", name: "Firetail", class_type: "special", is_special: true },
	{ id: "69fb73b4-ff0b-43f4-9654-52a9480e5ff4", name: "Chorus", class_type: "special", is_special: true },
	{ id: "05856e77-32d9-4e07-89e9-773d5452e677", name: "Witch", class_type: "special", is_special: true },
	{ id: "8bba23af-6104-4cd9-8dbd-af62f7e1958f", name: "Cultist", class_type: "special", is_special: true },
	{ id: "ff60a2fc-5228-490f-be21-65fb1ea11f6a", name: "Acolyte", class_type: "special", is_special: true },
	{ id: "43096e04-36b0-460d-b4b5-dbb4230f514f", name: "Shieldbearer", class_type: "special", is_special: true },
	{ id: "2c65f0d1-2ac6-42a3-8212-9067d29a7231", name: "Gardener", class_type: "special", is_special: true },
];

export const CATALOG_SPIRITS: CatalogSpiritRow[] = [
	{ id: "57b06434-0eeb-4e9e-a17f-c2bdce613e52", name: "Hero Captain", awaken_condition: null },
	{ id: "cfccc89f-06fe-4bd7-85f9-c5f9416cd1b4", name: "Hero Ironmane", awaken_condition: null },
	{ id: "a6c24fba-940e-4aa9-8729-a361f7209f9c", name: "Hero Ivern", awaken_condition: null },
	{ id: "aa541f5d-f648-4964-9e8b-db891c2bbd81", name: "Hero Mintyheart", awaken_condition: null },
	{ id: "3aefb245-b1d8-43ab-8aa2-cb2210abbb72", name: "Hero Nyra", awaken_condition: null },
	{ id: "f043914f-9259-481f-960d-ab83a48b06ba", name: "Hero Zarek", awaken_condition: null },
	{ id: "47504f4d-bfab-4e7c-98d7-3476b28d922d", name: "Ashblade", awaken_condition: null },
	{ id: "ee907abd-2f0a-4b8b-a004-f6012d2ab6ad", name: "Ashweaver", awaken_condition: null },
	{ id: "cb20dc2d-f486-45ac-a1b7-3f7d97805d09", name: "Blackflame Novice", awaken_condition: null },
	{ id: "1781a426-913b-4446-a062-a0ecfe401027", name: "Blacklily", awaken_condition: null },
	{ id: "5f719599-3914-440e-b518-2426ab1e83c5", name: "Blightshard", awaken_condition: null },
	{ id: "afcb8700-c12e-45b5-b844-bf4339354e76", name: "Briarblade", awaken_condition: null },
	{ id: "a5e1965a-4b51-4de4-ad42-2f8ac085ff0e", name: "Briarfox", awaken_condition: null },
	{ id: "7e3d88c0-6854-4c13-882c-ddf78c0d2b58", name: "Cragfist", awaken_condition: null },
	{ id: "e368f98d-fa19-47b0-bb54-1dd26d902b23", name: "Dandelion", awaken_condition: null },
	{ id: "9ef2c6f9-c6b3-4ec0-8e6e-4ddd5b26b344", name: "Frostfang", awaken_condition: null },
	{ id: "9707edd6-fbc3-4433-99f2-a687f39505fd", name: "Geode Tender", awaken_condition: null },
	{ id: "b5ceee38-e08f-44e4-b87a-93cb024cbfd8", name: "Hearthling", awaken_condition: null },
	{ id: "241c977c-d1c8-4ef5-856b-8100ef228f72", name: "Inkweaver", awaken_condition: null },
	{ id: "e95c775b-0677-4884-bc59-12ae2762ca8b", name: "Reefrunner", awaken_condition: null },
	{ id: "c6548ffd-4852-4e62-9c5a-9329e40d222e", name: "River Guide", awaken_condition: null },
	{ id: "d19f66b7-787b-4c5b-b498-e1f8fb7688e0", name: "Sporecap", awaken_condition: null },
	{ id: "25848694-6c69-408c-9b78-94948c6df3a6", name: "Ashveil, the Rekindled Blade", awaken_condition: {"type": "rune_cost", "rune_ids": ["480cd5f7-adea-481d-8ea9-aad776599d7b", "480cd5f7-adea-481d-8ea9-aad776599d7b"]} },
	{ id: "ed612933-fd19-4b68-993e-6e61b52eb4ce", name: "Aureate Runeweaver", awaken_condition: {"type": "rune_cost", "rune_ids": ["7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "a77653c5-69fa-4351-833d-59d302722365", name: "Aurelion, Crown of the Undying Sun", awaken_condition: {"type": "rune_cost", "rune_ids": ["7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "ae827012-29ff-406e-bcbe-afe3a5258607", name: "Briarwing Regent", awaken_condition: {"type": "text", "text": "Cultivate."} },
	{ id: "c0d12557-4615-4c60-a93c-622e5fc70eae", name: "Cinderwing Regent", awaken_condition: {"type": "text", "text": "Cultivate."} },
	{ id: "36bb656c-49fe-4d50-a037-b29dbd1bfa91", name: "Crestwing Regent", awaken_condition: {"type": "text", "text": "Cultivate."} },
	{ id: "e24e9f91-7333-44c0-968e-15b900af3385", name: "Dawn Chorus, Heralds of First Light", awaken_condition: {"type": "rune_cost", "rune_ids": ["7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "3a2277ba-056f-4471-9f96-e69ceaa5d8be", name: "Dawn Knight", awaken_condition: {"type": "rune_cost", "rune_ids": ["7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "728c5151-2da6-4202-b5b0-aae13dec68be", name: "Dawnborn, Child of Two Suns", awaken_condition: {"type": "rune_cost", "rune_ids": ["7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "78831740-f85c-4100-96d2-460a5eb819e5", name: "Eagle Keeper", awaken_condition: {"type": "rune_cost", "rune_ids": ["356f3ad2-4cac-4b69-a3cc-7559f8891d8e"]} },
	{ id: "18154c10-1422-4655-a7cd-c637ac947916", name: "Elderhorn, the Living Bastion", awaken_condition: {"type": "rune_cost", "rune_ids": ["34b2a963-f8c6-4fc0-8272-ddc50b0036a8", "34b2a963-f8c6-4fc0-8272-ddc50b0036a8"]} },
	{ id: "f32acd75-2242-489b-82fe-bbc789de5ba5", name: "Feral Beast", awaken_condition: {"type": "rune_cost", "rune_ids": ["5eba8681-16b8-4563-b017-22c80a84b35b"]} },
	{ id: "9a69825b-f604-487e-a35b-10c0b7312334", name: "Fire Fox", awaken_condition: {"type": "rune_cost", "rune_ids": ["480cd5f7-adea-481d-8ea9-aad776599d7b"]} },
	{ id: "d3d2decc-9cf6-4ff1-9b6e-c03cf1f82394", name: "Fire Salamander", awaken_condition: {"type": "rune_cost", "rune_ids": ["480cd5f7-adea-481d-8ea9-aad776599d7b"]} },
	{ id: "0f4383ca-3ad8-40ea-a74a-3408fa11719d", name: "Fox Wanderer", awaken_condition: {"type": "rune_cost", "rune_ids": ["34b2a963-f8c6-4fc0-8272-ddc50b0036a8"]} },
	{ id: "6b1cf338-490e-46ee-ae0b-b217c3cb2d3f", name: "Jungle Girl", awaken_condition: {"type": "rune_cost", "rune_ids": ["34b2a963-f8c6-4fc0-8272-ddc50b0036a8"]} },
	{ id: "d89f5d3a-5519-4b96-baf0-1f0a49c0ada1", name: "Keeper of the Twin Pyres", awaken_condition: {"type": "text", "text": "Discard 2 Fire Runes, or discard 5 of any attack dice."} },
	{ id: "2f15b8f6-9ef0-4d6b-a495-a44730fcb5a2", name: "Moon Cultist", awaken_condition: {"type": "text", "text": "While Fallen, sacrifice a spirit."} },
	{ id: "b3068fcf-d197-4030-ba55-29ac1621f9a9", name: "Moonrend, the Twice-Striking", awaken_condition: {"type": "text", "text": "While Fallen, attack another player."} },
	{ id: "6ecd8ca5-3449-4f01-b224-95519a65d6ba", name: "Mountain Goat", awaken_condition: {"type": "rune_cost", "rune_ids": ["356f3ad2-4cac-4b69-a3cc-7559f8891d8e", "356f3ad2-4cac-4b69-a3cc-7559f8891d8e"]} },
	{ id: "9f457095-6b6f-4175-a426-097ee9dd2a64", name: "Mountain Monk", awaken_condition: {"type": "rune_cost", "rune_ids": ["356f3ad2-4cac-4b69-a3cc-7559f8891d8e", "356f3ad2-4cac-4b69-a3cc-7559f8891d8e"]} },
	{ id: "fc667265-edd6-4c28-b96e-6e505188ce72", name: "Nhal, the World Unwoven", awaken_condition: {"type": "text", "text": "Navigate to the Arcane Abyss, but don't fight the monster."} },
	{ id: "f5b691f1-f0e7-411c-adda-8c724d7c1a36", name: "Night Witch", awaken_condition: {"type": "text", "text": "Become Corrupted while Fallen."} },
	{ id: "3b196b06-a047-4505-aad6-bf0c9fe05ac0", name: "Oathroot Ancient", awaken_condition: {"type": "rune_cost", "rune_ids": ["34b2a963-f8c6-4fc0-8272-ddc50b0036a8", "34b2a963-f8c6-4fc0-8272-ddc50b0036a8"]} },
	{ id: "9f6ccbfb-e278-44cd-87de-b418fd96eee8", name: "Ocean Princess", awaken_condition: {"type": "rune_cost", "rune_ids": ["5eba8681-16b8-4563-b017-22c80a84b35b"]} },
	{ id: "d2af57b4-3c6a-472b-8371-bb00b827f5f8", name: "Old Master", awaken_condition: {"type": "rune_cost", "rune_ids": ["34b2a963-f8c6-4fc0-8272-ddc50b0036a8"]} },
	{ id: "75a235e9-65bb-4fbf-ba80-5a09b155bd56", name: "Snow Hunter", awaken_condition: {"type": "rune_cost", "rune_ids": ["356f3ad2-4cac-4b69-a3cc-7559f8891d8e"]} },
	{ id: "7ea7209a-b779-4a8d-9007-775c5e90a398", name: "Stubborn Prince", awaken_condition: {"type": "rune_cost", "rune_ids": ["480cd5f7-adea-481d-8ea9-aad776599d7b"]} },
	{ id: "67d51bbd-a964-4bea-b7c3-7d8c7d616af1", name: "Sunflower Maiden", awaken_condition: {"type": "rune_cost", "rune_ids": ["7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "e75cb10c-fee4-488b-a213-e663c0fecae7", name: "The Argent Loom", awaken_condition: {"type": "text", "text": "Be Fallen in the Awakening Phase."} },
	{ id: "cafb6cfb-11f8-476c-a275-a5b8179630d2", name: "The Huntress of All Tides", awaken_condition: {"type": "rune_cost", "rune_ids": ["5eba8681-16b8-4563-b017-22c80a84b35b", "5eba8681-16b8-4563-b017-22c80a84b35b", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "5dc44c85-8224-4c49-89ff-90a37aa10040", name: "The Solar Reliquarian", awaken_condition: {"type": "rune_cost", "rune_ids": ["7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312", "7ca279f0-1ca8-484a-a86e-0a87aaa7b312"]} },
	{ id: "955abfc0-fa04-4ab3-bcaf-5dc2839ddec0", name: "Tidewarden, the Unbroken Current", awaken_condition: {"type": "rune_cost", "rune_ids": ["5eba8681-16b8-4563-b017-22c80a84b35b", "5eba8681-16b8-4563-b017-22c80a84b35b", "5eba8681-16b8-4563-b017-22c80a84b35b"]} },
	{ id: "ac981bdb-c271-46df-be9e-55f698cd3f55", name: "Traveling Trader", awaken_condition: {"type": "text", "text": "Navigate to the Water Region and do no location interactions."} },
	{ id: "b8314d8f-ea32-44de-a3ad-62944e5ccecb", name: "Twinforge Runemaster", awaken_condition: {"type": "rune_cost", "rune_ids": ["356f3ad2-4cac-4b69-a3cc-7559f8891d8e"]} },
	{ id: "1dbf151e-6c27-470c-b3fe-e32a6f735b93", name: "Veiled Acolyte", awaken_condition: {"type": "text", "text": "While Fallen, deal damage to another player."} },
	{ id: "e4822f18-98f0-44fd-8711-756f946f6cd5", name: "Vespera, Empress of the Last Moon", awaken_condition: {"type": "text", "text": "Cultivate while Fallen."} },
	{ id: "c122e431-3792-4b21-bf3a-87ccbed2c123", name: "Wolf Rider", awaken_condition: {"type": "rune_cost", "rune_ids": ["356f3ad2-4cac-4b69-a3cc-7559f8891d8e", "356f3ad2-4cac-4b69-a3cc-7559f8891d8e"]} },
	{ id: "1a09511f-a928-4bda-8a1f-af8f03346087", name: "Yak Herder", awaken_condition: {"type": "rune_cost", "rune_ids": ["356f3ad2-4cac-4b69-a3cc-7559f8891d8e", "356f3ad2-4cac-4b69-a3cc-7559f8891d8e"]} },
	{ id: "504c77b5-8f46-427d-a339-1ef11160b0d7", name: "Caldera, the Sixfold Inferno", awaken_condition: {"text": "Have 7 Fire Spirits, or discard 3 Arcane Abyss Spirits.", "type": "text"} },
	{ id: "e5dff9be-ac58-47bb-bd9d-69efb03dc393", name: "Hollowbloom, Gate of the First Forest", awaken_condition: {"text": "Have 7 Forest Spirits, or discard 3 Arcane Abyss Spirits.", "type": "text"} },
	{ id: "be2072ea-ccdb-4941-b1b3-26890a7b64cf", name: "Sovereign of the Drowned Sky", awaken_condition: {"text": "Have 7 Water Spirits, or discard 3 Arcane Abyss Spirits.", "type": "text"} },
];
