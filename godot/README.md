# Arc Spirits — Godot 4 client

Native cross-platform client (Steam desktop + iOS/Android) for Arc Spirits.
The TypeScript engine in `../src/lib/play/` stays the authoritative rules
engine; this client renders room projections and sends commands, exactly like
the SvelteKit client — so the bot/ML stack and the 900-test engine suite keep
working unchanged.

## Agentic workflow (no editor GUI)

Everything in this project is authored as text and verified via CLI:

- **Scenes** are `.tscn` files; **scripts** are `.gd`; complex layouts are
  built programmatically in scripts (reviewable logic instead of hand-placed
  coordinates).
- **Import / cache refresh** after adding assets:
  `godot --headless --import` (from this directory).
- **Visual verification**: run any scene with the screenshot arg and inspect
  the PNG —
  `godot --path . -- --screenshot=/tmp/shot.png`
  (`scripts/main.gd` shows the capture pattern: 2 frames → save → quit).
- **Exports** (once presets exist): `godot --headless --export-release <preset>`.

`godot` here = `/Applications/Godot.app/Contents/MacOS/Godot` (4.5.x).

## Design decisions

- **Renderer**: `mobile` on all platforms — one performance envelope so the
  Steam build never drifts from what phones can do.
- **Canvas**: 1280×720 design space, `canvas_items` stretch — one layout,
  identical on desktop/phone/Steam Deck.
- **Language**: GDScript (no build step, instant CLI iteration; the client is
  view/input/animation only — game rules stay server-side TS).
