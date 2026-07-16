# Packaging Arc Spirits as a native app (Capacitor)

This repo ships the 2D play game to the **App Store** via [Capacitor](https://capacitorjs.com/)
as an **iOS-only** shell, while the web app keeps running as-is (SSR on Vercel).

> **Android is intentionally not scaffolded.** The product's mobile client is Godot, so no
> Android shell is built here — the `@capacitor/android` dependency and the `cap:android`
> script have been removed, and `cap add android` is deliberately never run. If that ever
> changes, the `com.arcspirits.app://auth/callback` scheme would need an Android intent
> filter to match the iOS `CFBundleURLTypes` registration.

## Architecture

Two build targets, one codebase:

- **Web** (`npm run build`) → `adapter-vercel`, SSR + serverless API. Unchanged.
- **App** (`npm run build:app`) → `adapter-static` (SPA), a static client bundle that
  Capacitor wraps in a native iOS shell (`ssr` is disabled for this target in
  `src/routes/+layout.ts`; the play routes load client-side, so no SvelteKit server is
  needed inside the bundle). The shell talks to the **same Vercel backend** over HTTPS
  for all `/api/play/*` calls and the room WebSocket.

```
┌──────────────── Native app (Capacitor, iOS) ──────────┐      ┌──── Vercel ────┐
│  WKWebView                                            │      │                │
│   • static SPA bundle (build/)                        │ ───▶ │  /api/play/*   │
│   • PUBLIC_API_BASE_URL = https://<your-app>.vercel…  │ HTTPS│  room WS       │
│   • identity: Supabase session (Bearer access token)  │      │  (authority)   │
└───────────────────────────────────────────────────────┘      └────────────────┘
```

## Identity model (no member ids)

The ONLY identity channel is the **validated Supabase account**. On the web every
`/api/play/*` request is authenticated same-origin by the httpOnly session cookie; in the
native shell — which runs cross-origin from `capacitor://localhost` and has no cookie jar
for the backend — the same validated session travels as the
`Authorization: Bearer <access token>` header (`src/lib/stores/playStore.svelte.ts`).
There are no room credentials, no member ids, nothing identity-bearing in URLs. The old
`X-Play-Member` header / `?member=` query mechanism is **retired** — do not reintroduce it.
`src/lib/play/apiBase.ts` prefixes every API call with `PUBLIC_API_BASE_URL` (empty on web).

## What's already done (in this repo)

- **`capacitor.config.ts`** — appId `com.arcspirits.app`, `webDir: build`, background `#050310`.
- **`ios/`** — the iOS platform project is checked in (scheme registered in
  `ios/App/App/Info.plist`); no `cap init` / `cap add ios` needed.
- **`svelte.config.js`** — env-gated adapter: `BUILD_TARGET=capacitor` switches to `adapter-static`.
- **`src/hooks.server.ts`** — CORS for `/api/play/*` from Capacitor origins
  (`capacitor://localhost`, etc.) incl. OPTIONS preflight. Web requests are same-origin
  so they're unaffected.
- **Plugins installed** — exactly `@capacitor/{core,cli,ios,app,browser}`. `app` + `browser`
  power the native OAuth round trip. No status-bar, splash-screen, or screen-orientation
  plugins are installed — don't configure them in `capacitor.config.ts` (dead config) or
  call them from app code.
- **Native OAuth (guest-account claim, same uid)** — see the deep-link lifecycle below.
- **PWA shell** (manifest, icons, service worker, install prompt) — already shipped for the
  web/installable path.

## Native OAuth deep-link lifecycle (`src/lib/auth/nativeOAuth.ts`)

The static shell has no `/auth/callback` server route, so OAuth runs a fully client-held
PKCE round trip — canonical identity preserved, no server callback needed:

1. **Begin** in the webview: `linkIdentity` (guest-account claim — SAME uid, all progress
   kept) or `signInWithOAuth`, with `skipBrowserRedirect` — supabase-js stores the PKCE
   `code_verifier` locally and returns the provider URL without navigating. In **link
   mode** the canonical uid is captured up front so it can be verified afterwards.
2. **Open** the provider URL in the SYSTEM browser (`@capacitor/browser`) — credentials are
   typed into the real browser, never the webview. The `appUrlOpen` listener registration
   is **awaited before** the browser opens, so a fast redirect can't outrun it.
3. **Return** via the private scheme `com.arcspirits.app://auth/callback?flow=<nonce>&code=…`
   — every flow rides its own nonce through the redirect URL (callback OWNERSHIP: a
   delivered callback names the flow it belongs to, so a stale callback from an
   abandoned earlier flow is quarantined instead of being exchanged against — and
   thereby destroying — the live flow's stored verifier; a marker-less callback from an
   older app version is still accepted). Delivery happens through one of TWO channels:
   - **Warm** — the app stayed alive behind the sheet: the callback arrives as a
     `@capacitor/app` `appUrlOpen` event and settles the pending flow.
   - **Cold** — iOS killed the app while the sheet was up: the callback arrives as the
     LAUNCH URL of the next process. `resumeColdStartOAuth()` (invoked once at startup
     from `src/routes/+layout.svelte`, native-only) reads `App.getLaunchUrl()` and
     finishes the exchange — the `code_verifier` survived in storage.
4. **Exchange** `exchangeCodeForSession(code)` — **exactly once**: a module-level
   consumed-code ledger dedupes duplicate warm+cold delivery of the same code. Foreign
   deep links never settle the flow and are never consumed at cold start; timeout,
   provider error, and open failure all tear down completely (no listener leak); link
   mode **verifies** the post-exchange uid equals the captured one and fails loudly on a
   mismatch; authorization codes/tokens never appear in logs or error messages.

⚠️ The Supabase project must allow-list `com.arcspirits.app://auth/callback` under
Auth → URL Configuration → Redirect URLs — and the entry must tolerate query params
(the native flow appends `?flow=<nonce>`, exactly like the web flow's
`/auth/callback?next=…` already does; use `com.arcspirits.app://auth/callback*` if the
project matches redirect URLs exactly).

## Build & run (macOS + Xcode; `ios/` is already scaffolded)

```bash
# 1. Point the app at the deployed backend (build:app already defaults to the
#    production URL; override via the environment if needed)
echo 'PUBLIC_API_BASE_URL=https://<your-app>.vercel.app' >> .env

# 2. Build the static bundle
npm run build:app            # writes build/

# 3. Each iteration: rebuild + copy web assets into the native project
npm run cap:sync             # build:app + cap sync
npm run cap:ios              # cap:sync + opens Xcode
```

## Store submission notes

- **Apple Developer Program** ($99/yr) + code signing in Xcode.
- Apple rejects "just a website" wrappers — the native shell + standalone UX (already
  responsive/touch-hardened) should clear this, but ensure it feels app-native (no
  browser chrome, offline-friendly shell).
- Review any reward/loot mechanics for gambling-adjacent policy flags; declare data use.
- No push notifications are wired (product decision — players actively watch the game). If
  that changes, add `@capacitor/push-notifications` + APNs + a server turn-change trigger.

## Don't cache heavy media on device

The service worker already excludes `/music`, `/splats`, `/sfx`. Keep it that way — iOS
PWA/WebView storage is ~50MB and would evict a bloated cache. These stream from the network.
