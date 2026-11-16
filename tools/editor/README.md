# Niji Batch

Local batch sender for Niji Journey. It sends requests to the Niji backend API
(`/api/submit-jobs`) with your browser session.

## Use

1. `npm run chrome` — starts the dedicated Chrome (profile in `chrome-profile/`,
   debugging port 9222 on 127.0.0.1). Log in to nijijourney.com one time. Keep it open.
2. `npm start` — starts the server.
3. Open http://127.0.0.1:8787 in any browser.

- Enter sends. Shift+Enter adds a line; each line is one prompt.
- `{a|b|c}` makes one prompt for each option. Lines that start with `#` are ignored.
- A flag that you type in the prompt (for example `--ar 16:9`) overrides the panel setting.

## The page

The page is a file explorer for `~/ArcSpiritsArt` (change it with `NIJI_WORKSPACE`).
The generator is a floating panel on the right (button **Generate**, or key `G`; `Esc` closes it).

- A generation belongs to the folder that is open when you send it. The folder shows
  loading tiles, and the images are saved into it when the job is done.
- You can start generations in many folders. The tree shows a counter on each busy folder.
- Drag an image or a folder from the explorer to a slot: it is uploaded to Niji and attached.
- Slots: Style reference (`--sref`), Image Prompts (in each job), Vary (one job for each image).
- A folder can have a `prompt.txt`. When you drop that folder on a slot, its text becomes
  the Style line, which is added to each prompt.
- `node tools/seed-arcspirits.mjs` makes the folders from the Arc Spirits Supabase data
  (read-only). `node tools/pull-folder.mjs <niji folder> <workspace folder>` downloads a Niji folder.

## Remote worker (queue on another computer)

The queue can run on an always-on PC while the Mac is off. The page, the workspace files,
pins and tags stay on the Mac.

- Worker (the remote PC, with the dedicated Chrome logged in to Niji): `npm run worker`
  (`NIJI_WORKER=1 node server.mjs`). It sends the jobs and watches them, but it writes no images.
  A finished job waits in its done list until a client copies the images.
- Client (the Mac): `npm run client` (`NIJI_REMOTE=home3090-linux node server.mjs`, or
  `node server.mjs --remote <ssh host>`). Open http://127.0.0.1:8787 as usual; the pill shows "Niji · remote".
  The client keeps the SSH tunnel `127.0.0.1:8788 -> <host>:8787` open, reads the worker state every 2 s,
  copies the images of finished jobs into the workspace, then tells the worker (`/api/ack`).
  It does not use Chrome. `NIJI_REMOTE_URL=http://127.0.0.1:<port>` goes to a worker without the tunnel (tests).
- Only one dispatcher per Niji account: do not run a single-computer server and a worker at the same time.

## How it works

- Cloudflare rejects requests that do not come from a browser. Thus the server sends
  each API request through the network stack of the dedicated Chrome (CDP `fetch`).
  Cookies stay in Chrome; the server does not store them.
- `niji.mjs` — API client. `server.mjs` — sends jobs immediately, HTTP, job state in `queue.json`.
  `remote.mjs` — the client role (tunnel, state poll, image copy).
  `public/` — the page. `tools/` — analysis tools (`record.mjs` records API traffic).

## Not included

Animate / video jobs, Conversational Mode, folders, search, the editor.

## Hex spirits: the Figma design, made by the generator (since 2026-11-11)

The arcane and non-arcane hex spirits use the design made in Figma (file "ARC SPIRITS DESIGN (LATEST)", page "Hex Spirits").
`tools/hex_generate.py` rebuilds that design in code, so a change of art or data makes a new card by itself:

- The fixed parts (borders, rim glow, outline texture, Arcane Fill panels, paint strokes, origin icons, non-arcane ring)
  were exported from Figma once into `~/ArcSpiritsArt/references/hex_template/` (the template kit, one set per origin).
- The generator adds what changes per spirit: art (placed with the art editor's transform, with the Figma blurs), name and
  name plate (sized to the name), class / rune / special-class icons, back text (awaken, class name, description) and the
  outline colour (Difference blend; its base colour is picked from the art like in Figma).
- Output per spirit: `references/hex_bases/<Name>/gen-<side>.png` (+ `-preview.png`), and a copy in
  `assets/exports/hex-spirits/<Name>_<side>.png`. `hexgen.json` records the inputs each card was made from.
- The server checks every 5 s (one spirit per check) for spirits whose art, transform, name, classes, icons, runes or back
  text changed, and makes those cards again. `NIJI_HEX_AUTOGEN=0` turns that off. `GET /api/game/hex-generate` shows the
  recent log and what is waiting; `POST /api/game/hex-generate { name, force }` makes one now (the art editor's Render does this).
- `figma-<side>.png` (the cards exported from Figma) are only shown until the generator has made that card.
- Sun and Moon are origins of their own (data and folders `assets/spirits/Sun`, `assets/spirits/Moon`, since 2026-11-11); the card look follows the origin.
- A design change in Figma (not a data change) needs a new template kit: export the layers again (see hex_generate.py's header).
- The heroes still use the old frame (tools/hex_render.py and the canvas icon placer).
- Backup of the files before these changes: `_backup_2026-11-11_before-figma-hexes/`.

## Monster cards: the merged Figma card, made by the generator (since 2026-11-11)

The monster cards use the merged card from Figma (page "Design Drafts", "Ash Puff — merged monster card", 2.75 x 4.75 in =
825 x 1425 px). `tools/monster_generate.py` rebuilds it: fixed parts from `references/monster_template/` (background, arch
window, art outline, overlay with badges / class pill / Kill Rewards ribbon); per monster the art (cover-fit, Figma's
progressive blur at the bottom), Health = barrier, Damage = damage, "CLASS <stage>", the name (shrinks to fit) and the
kill-reward icons (references/icons/icon_pool; rewards without an icon are left out and flagged on the Exports page).
Output: `references/monster_cards/<Name>/card.png` (+ preview, state.json) and `assets/exports/monster-cards/<Name>.png`.
The same 5-second background check as the hexes remakes a card when the art choice, values or reward icons change;
`POST /api/game/monster-generate { name }` makes one now.
