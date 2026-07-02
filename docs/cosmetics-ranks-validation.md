# Cosmetics, Currency, and Ranks Validation

## Incentives

- Abyss Credits: earned after every completed match, scaled by VP, placement, win, and match length.
- Leaderboard identity: equipped name/icon borders appear on the local player's live leaderboard row.
- Endgame ceremony: postgame shows the large rank crest, XP gain, credit payout, and promotion copy when a threshold is crossed.
- Guardian skins: first pass applies cosmetic treatments to guardian portrait previews; server-backed per-player skin ownership should later drive multiplayer visibility.
- Banners: postgame banner cosmetics give late-game collectors a high-price target after they own practical borders.

## Milestones

1. Local wallet and ranks: credits, lifetime credits, rank XP, owned items, equipped items, and claimed match ids persist in local storage.
2. Storefront: `/play/shop` renders wallet, category rail, featured preview, purchase/equip panel, and item strip on desktop and mobile landscape.
3. Match payout: a finished room grants credits and rank XP once per `roomCode:seat`, then never double-claims on refresh.
4. Leaderboard identity: the local player row renders the compact rank emblem and equipped border accent.
5. Endgame ceremony: postgame renders the large rank crest and promotion line when the match crosses a rank threshold.
6. Tests: progression math has deterministic unit coverage; shop/postgame/leaderboard have browser smoke coverage.

## Acceptance Gate

- `npm run check`
- `npx vitest run src/lib/cosmetics/progression.test.ts`
- Browser smoke: visit `/play/shop`, buy/equip one affordable item, verify the wallet changes and the equipped state survives reload.
- Game smoke: finish a local game or use an E2E fixture to enter postgame, verify the Abyss Credit payout appears once.
- Mobile simulator/web: verify `/play/shop` and postgame at landscape phone size without clipped text or overlapping controls.

## Server Follow-Up

The current slice is local-first. To make cosmetics visible to other players, add a server profile table for owned/equipped cosmetics, then project cosmetic ids through room membership alongside display names and selected guardians.
