# Courtside Scoreboard — Project Handoff

Working notes for picking this project up cold — architecture, what's been
built, how it's configured, and what's still open. The bulk of it was
written after a long session that took the project from "scaffolded,
unstyled, a few bugs" to "styled, hardened, packaged as a desktop app";
a later session added tournaments, fixed a dead button in the desktop
launcher, and reworked how the installers are built (see "Later session"
below). Read this before README.md — README is the polished setup doc;
this is the "how it actually works and why" doc.

> **Companion document:** [STREAMING_UPGRADE.md](STREAMING_UPGRADE.md) covers
> everything about **video streaming and internet delivery** — WebRTC, the
> public Firebase-hosted scoreboard, cloud score sync, their configuration, and
> their gaps. That work is deliberately kept out of this file to stop it growing
> unbounded; this document remains the authority on the core LAN app.

## What this is

A LAN-based, real-time badminton match scoring system. An admin creates
matches from a dashboard; an umpire scores live from a phone; TV screens at
each court show the live score. Everything runs on one machine on the venue
Wi-Fi — no internet needed on match day.

Two capabilities have since been layered on top **without changing that**: a
court-side phone can stream live video to viewers, and scores can be mirrored to
a public web page anyone on the internet can open. Both are additive and
optional — with no internet, or with Firebase credentials absent, the LAN app
behaves exactly as before. See [STREAMING_UPGRADE.md](STREAMING_UPGRADE.md).

## Monorepo layout

npm workspaces, 4 packages:

```
packages/
  shared/   Framework-free TypeScript: domain types, the scoring engine
            (deriveMatchState), the Socket.io event contract. Consumed as
            raw .ts source (no build step) — both server and client import
            it directly, and tsx/Vite transpile it transparently.
  server/   Express + Socket.io + Prisma/SQLite. Single source of truth.
            Run via `tsx src/index.ts` — never compiled to JS for normal
            use (see "Why tsx, not tsc" below).
  client/   React + TypeScript + Vite. Three role screens (admin, umpire,
            TV) plus two "join" screens (see Join codes below), and the
            two video-streaming screens (broadcaster + viewer).
  desktop/  Electron wrapper that packages the whole thing as a
            double-click Mac/Windows app. See its own section.
```

Plus one directory outside the workspaces:

```
public-viewer/   The public, internet-facing scoreboard + video page.
                 Deliberately NOT a workspace and NOT built: plain HTML
                 loading the Firebase SDK from a CDN, deployed straight to
                 Firebase Hosting. See STREAMING_UPGRADE.md.
```

## Why tsx, not tsc, for the server

`@courtside/shared`'s package.json has `"main": "./src/index.ts"` — no
build step, no compiled output. The server imports it directly and runs
via `tsx`, which transpiles on the fly. This means:

- `npm run start --workspace packages/server` runs `tsx src/index.ts` —
  this is the **only** correct way to run the server in production. There
  is no "build the server" step in the normal flow.
- A `tsc -p tsconfig.json` build script exists on `packages/server` (used
  once this session to verify types compile cleanly — see `replay.ts` fix
  below) but its output is **not used at runtime** and was deleted after
  verification. If you see a stray `packages/server/dist/`, delete it —
  Jest will try to run the compiled `.test.js` files as if they were
  source and fail with syntax errors (this happened once this session).
- The Electron desktop app spawns `tsx` on the **source** `.ts` files too,
  for the same reason — see the Desktop section.

## Data model — event sourcing

Everything about a match (score, set winner, serve position, interval
state) is derived by replaying an append-only `ScoreEvent` log through one
pure function: `deriveMatchState()` in `packages/shared/src/scoring.ts`.
Server and client never keep their own separate bookkeeping — they both
call this same function. This matters most for undo: `UNDO_LAST_POINT` is
implemented by popping the event log, not by decrementing a counter, so it
correctly reopens a previous set if the undone point was the one that
closed it.

`ScoreEventType` = `START_SET | POINT | UNDO_LAST_POINT | RETIRE |
RESUME_INTERVAL` (the last one added this session — see below).

Only `ADD_POINT`, `UNDO_LAST_POINT`, and `RESUME_FROM_INTERVAL` are wired
end-to-end server-side (`packages/server/src/sockets/index.ts`).
`START_SET`, `RETIRE_MATCH`, and the `ADMIN_EVENTS` (edit details, cancel,
assign to court) are stubbed — event names/payloads exist in
`packages/shared/src/events.ts`, handlers don't.

## What was built/fixed in the first session, roughly in order

1. **Ran the app for the first time.** Fixed a platform-mismatch
   `node_modules` issue (Vite's Rolldown bundler had Linux native bindings
   only — `npm install` fixed it) and confirmed LAN access works.

2. **Full dark-theme styling pass** (`packages/client/src/styles.css`).
   The app had zero real styling before this — bare structural CSS only.
   Cyan (`--side-a`) / violet (`--side-b`) accent pair now runs through the
   whole app: TV score colors, umpire score buttons, the desktop app's own
   icon. Palette: `--bg: #0a0e1a`, `--side-a: #22d3ee`, `--side-b:
#c084fc`. Also added responsive breakpoints (TV score reflows to 2 rows
   under 700px, admin form stacks under 560px).

3. **Real bugs found via actual browser testing** (not just unit tests,
   which run in jsdom and don't model secure-context restrictions):
   - `crypto.randomUUID()` and `navigator.clipboard` both throw/are
     `undefined` on insecure origins (`http://<lan-ip>`, not localhost) —
     exactly how this app is meant to run on match day. Fixed with
     fallbacks: `packages/client/src/lib/id.ts` (falls back to
     `crypto.getRandomValues`) and `lib/clipboard.ts` (falls back to
     `document.execCommand('copy')`).
   - The mid-set interval banner never went away once triggered —
     `RESUME_FROM_INTERVAL` was defined but never implemented. Added
     `intervalResumed` to `SetResult` in `scoring.ts`, wired the socket
     handler, made the umpire's banner a tappable button.
   - **A real crash bug**: a duplicate `eventId` (the exact scenario the
     schema's own doc comment promises is safe — "replaying a queued
     offline action twice is safe") threw inside an un-awaited handler and
     crashed the **entire server process**, taking every court down.
     Fixed with `createScoreEventIdempotent()` in `sockets/index.ts`,
     which catches Prisma's P2002 (unique constraint) and treats a
     duplicate as a no-op instead of an unhandled rejection.

4. **Short join codes** — instead of copy-pasting long URLs between the
   admin machine and a TV/umpire device: `Court.tvCode` and
   `Match.umpireCode`, 6-char codes from a 32-char unambiguous alphabet (no
   `0/O/1/I/L`), generated via `generateJoinCode()` in
   `packages/server/src/match/tokens.ts`. New public, unauthenticated
   resolve endpoints: `GET /api/courts/resolve/:code`, `GET
/api/matches/resolve/:code`. New client route component
   `JoinScreen.tsx` at `/tv` and `/umpire` (no ID) — type a code, land on
   the real screen. `tvCode` is low-stakes and shown permanently in the
   admin dashboard; `umpireCode` carries scoring authority so it follows
   the same shown-once policy as `umpireToken`.
   - **Known pre-existing gap, not fixed**: `GET /api/matches/:matchId`
     (unauthenticated) returns the full `Match` object including
     `umpireToken` and now `umpireCode`. It's covered by an explicit test
     asserting "without auth," so it reads as intentional rather than an
     oversight I introduced — but it's a real credential leak and nothing
     in the client actually calls this route. Flagged to the user, not
     touched (out of scope of what was asked).

5. **On-screen error surfacing.** A TV showed a black screen with no way
   to see why (no dev tools on a smart TV). Added:
   - An inline, plain (non-module, ES5-syntax) `<script>` in
     `packages/client/index.html` that sets up `window.onerror` /
     `unhandledrejection` and shows a full-screen error overlay — runs
     independently of the React bundle, so it works even if the module
     script never loads. Includes a 5-second "the app never started"
     timeout check for the case where nothing throws at all (see next
     point — this is exactly what was happening).
   - A React `ErrorBoundary` (`packages/client/src/lib/ErrorBoundary.tsx`)
     wrapping `<App />` in `main.tsx`, for graceful in-app crash display
     after React has mounted.

6. **Old-browser (smart TV) support — the actual fix for the black
   screen.** Root cause: the TV's browser choked while just _parsing_
   modern JS syntax (`?.`, `??`, class fields) used throughout the app —
   a parse-time `SyntaxError` that fires before any error handler can run.
   Fixed with `@vitejs/plugin-legacy` in `packages/client/vite.config.ts`,
   which builds a second, ES5-transpiled + polyfilled bundle behind
   `<script nomodule>`, auto-selected by browsers that can't run the
   modern one. Two non-obvious gotchas hit along the way, both fixed in
   `vite.config.ts`:
   - The plugin's default browserslist target (`defaults`) already
     assumes browsers that support `?.`/`??` natively, so Babel left them
     untouched — fixed by setting `legacy({ targets: ['defaults', 'ie
11'] })`.
   - This project's Vite (v8) uses the newer Rolldown/`oxc` minifier by
     default, which ignores `terserOptions` and re-introduced ES6+ syntax
     (template literals) into the "legacy" output regardless of Babel's
     work — fixed by forcing `build.minify: 'terser'` explicitly. Verified
     by grepping the actual output for `?.`/`??`/arrow-functions/`let`/
     `const` (all zero) and by executing the legacy bundle directly as a
     plain classic script to confirm it really mounts the app.

7. **Desktop app packaging** — see its own section below.

8. **Small UX fixes along the way**: the admin dashboard's password field
   now auto-fills from a URL query param (`?adminPassword=...`) and hides
   itself once a password is known — used by the desktop app's "Open Admin
   Dashboard" button so the person running it never types or sees a
   password (see Desktop section). The field only reappears if no password
   is known yet at mount (tracked via a separate `showPasswordField` state
   captured once, not derived live from `adminPassword`, so it doesn't
   vanish mid-keystroke while someone's actually typing one in).

## Later session — tournaments, the dead dashboard button, Windows packaging

Everything above is the first long session. This is what changed after it.

1. **`Open Admin Dashboard` did nothing at all.** The renderer passed the
   selected tournament through the `contextBridge`, but the main-process
   handler declared no parameters and dropped it:

   ```js
   ipcMain.handle('open-dashboard', () => openDashboard()); // tournament === undefined
   ```

   `openDashboard()` starts with `if (!tournament) return;`, so every click
   hit that guard and returned silently — no error, no window, nothing.
   `ipcMain.handle` callbacks receive `(event, ...args)`; the two handlers
   either side of it (`create-tournament`, `list-tournaments`) take `_event`
   first, so this one was simply the odd one out. Fixed in `main.js` by
   taking `(_event, tournament)` and forwarding it.

   Verified by driving the real app with Playwright's `_electron`: the click
   now reaches `shell.openExternal`, the URL it builds returns `200 text/html`
   with the client's `#root` in it, and the `adminPassword` embedded in that
   URL is accepted by `GET /api/tournaments`. Worth knowing for next time:
   the first verification pass stubbed `shell.openExternal` to avoid
   hijacking the browser, which means it proved the URL was _built_ but not
   that the OS handoff worked — if you test this path again, exercise the
   real `openExternal` at least once.

2. **Tournaments.** New `packages/server/src/routes/tournaments.ts`
   (`GET`/`POST /api/tournaments`, admin-authenticated), a `Tournament`
   model in the Prisma schema with `Court.tournamentId` pointing at it, and
   a tournament picker in the desktop launcher. The launcher creates or
   selects one, then passes `tournamentId`/`tournamentName`/`tournamentDate`
   to the admin dashboard as query params alongside the password. The
   "Open Admin Dashboard" button stays disabled until a tournament is
   selected — `updateOpenButton()` in `launcher.html` gates on both
   `serverRunning` and `selectedTournament()`.

3. **Windows builds are now blocked on non-Windows hosts** —
   `scripts/require-windows-build-host.js`, wired in as `predist:win`.
   See the Desktop section's "what's still open" for why, and for the
   stale cross-built `.exe` that may still be in `release/`.

4. **`scripts/build-runtime-deps.js`** replaced the "ship the whole hoisted
   root `node_modules`" approach with a production-only server dependency
   closure. Cuts the installer by roughly 15%, and has a working-copy side
   effect documented under "Rebuilding the installers" above.

5. **`scripts/pack-windows-source.js`** (`npm run pack:win-source
--workspace packages/desktop`) zips the source tree for carrying to a
   Windows machine, defaulting to `~/Downloads`. It picks files via
   `git ls-files --cached --others --exclude-standard`, so the exclusion
   list is gitignore itself rather than a second list that can drift —
   `node_modules/`, `release/`, `client/dist/`, `server/generated/`, `*.db`
   and `.env` all fall out for free, while new uncommitted files are still
   included. It writes a `WINDOWS-BUILD.md` into the zip with the four
   build commands. Verified by extracting the zip and running the first
   three of those steps on macOS (`npm install`, client build,
   `prisma generate` — which does emit `query_engine-windows.dll.node`);
   the fourth, `dist:win`, correctly refuses to run off Windows.
   Note the zip has no `.git`, so root `prepare: husky` prints
   "`.git can't be found`" during `npm install` — husky v9 returns that as
   a message and still exits 0, so the install succeeds. Harmless.

**Still open after this session:**

- **`lanAddresses()[0]` is a guess.** `openDashboard()` builds the URL from
  the first non-internal IPv4 interface the OS happens to list. That was
  correct on the dev machine, but with a VPN or a VM adapter up it can pick
  an address the local browser cannot reach — which presents as "the
  browser opens and the page never loads". The local browser could just use
  `localhost` while the launcher keeps showing the LAN address for other
  devices. Not changed, since it alters what the dashboard link points at.
- **Stale artifacts in `packages/desktop/release/`.** That directory is
  gitignored build output and electron-builder only overwrites what the
  current config targets, so older builds linger: an x64 `.dmg` and a
  `mac/` directory from a config that built both Mac architectures, plus
  the cross-built Windows `.exe` and `win-unpacked/`. All predate the
  `open-dashboard` fix, so shipping one would ship the dead button. Only
  `Courtside Scoreboard-0.1.0-arm64.dmg` is current.
- **`packages/desktop` still has no automated tests**, and the surface that
  broke this session — the `ipcMain.handle` signature — is exactly the kind
  a small unit test would have caught.

## Later session — umpires, a real scoring bug, and TV screens that actually work on a TV

Everything above predates this session. Test count is now **388** (90
shared / 112 server / 186 client), up from 202.

1. **Umpires are now a managed resource, same shape as courts.** New
   `Umpire` Prisma model (`id`, `tournamentId`, `name`), a full CRUD route
   (`packages/server/src/routes/umpires.ts`: `POST`/`GET /api/umpires`,
   `DELETE /api/umpires/:id`, all admin-authenticated), and an "Umpires"
   card in the admin dashboard mirroring the courts card. `Match` gained
   `assignedUmpireId`; creating a match now **requires** picking an umpire,
   and the server enforces the same one-at-a-time rule courts already had
   (`findFirst` over `CREATED`/`IN_PROGRESS` matches) — an umpire already
   on a live match shows as "busy" and can't be double-booked. The umpire's
   name and the court's label now both show on the umpire screen and the
   TV screen (`match.umpireName ?? umpires.find(...)`, same fallback
   pattern courts already used for `courtLabel`).

2. **The mid-game interval only ever fired once per match — a real
   scoring bug, not a display glitch.** `SetResult.intervalResumed` was a
   single boolean, set `true` by _any_ `RESUME_INTERVAL` event — including
   the one that dismisses the between-games break at the start of a new
   set. Since the umpire always resumes that opening break before scoring
   can continue, the flag flipped true at 0-0, which then permanently
   suppressed that same set's own mid-game interval later on. In practice:
   the interval worked in set 1, and never again. Confirmed against real
   match data (13 `RESUME_INTERVAL` events across 3 sets, only 1 mid-game
   interval ever fired) before fixing. Fixed by splitting the flag in two
   — `intervalResumed` (mid-game) and `openingBreakResumed` (between-games)
   — with `RESUME_INTERVAL`'s handler deciding which one to set based on
   the score at the moment it's processed (0-0 with a prior completed set
   is unambiguously the opening break, since `intervalAt` is always > 0).
   See `packages/shared/src/scoring.ts` and the regression test in
   `scoring.test.ts` ("still fires the mid-game interval in set 2 after
   the between-games break was resumed") — the _previous_ test covering
   this exact scenario never actually exercised the between-games resume,
   which is exactly how a 100%-coverage suite still shipped the bug.

3. **The TV screen's score table silently degraded to one column per row
   on a real smart TV.** Confirmed on an actual LG TV (photo evidence): a
   two-set match showed sets stacked vertically instead of in columns.
   Root cause — the table used CSS Grid **`subgrid`** (`.tv-set-labels`,
   `.tv-player-row`) so header and player rows shared the parent's column
   tracks. Smart TV browsers are typically years behind desktop Chrome;
   `subgrid` needs Chromium 117+/Safari 16+, and an unsupported value for
   `grid-template-columns` falls back to `none` — one implicit column,
   exactly the collapse seen on the TV. **Do not use CSS `subgrid`
   anywhere in this codebase** — it will not degrade gracefully on the
   hardware this app targets. Fixed by going back to the pre-subgrid
   technique: every row independently declares the _identical_ explicit
   `grid-template-columns` (driven by a `--set-count` CSS custom property
   set inline per match, so the column count matches how many sets have
   actually been played instead of a hardcoded `repeat(3, ...)` that used
   to leave an empty phantom column on any match not yet in set 3).
   Verified via CDP that all rows still compute pixel-identical column
   positions with zero use of `subgrid`. Same fix applied to the admin
   history table (`.history-scoreboard`) and the umpire's end-of-match
   summary (`.umpire-scoreboard`), which had the same hardcoded-3 and
   subgrid dependency respectively.

4. **TV screen resized to actually use a TV.** It was capped at a fixed
   `1100px` width regardless of screen size. Now `width: 90vw`. Player
   names and the score of the set _in progress_ are both much larger
   (`.tv-player-row > strong.current-set`, a new rule keyed off the same
   class the "which set is live" highlight already used); completed-set
   scores stay comparatively small so the live number is what reads from
   across a room. Row heights and label text scale with `vh` via `clamp()`
   rather than fixed `rem`, so this scales with the actual screen instead
   of just being "bigger."

5. **Retirement is now labeled everywhere a match summary appears** — the
   umpire's end-of-match table, the TV screen's result line, and the admin
   history list all show which side retired (`derived.retiredSide`,
   distinguished in `scoring.ts` from a `RETIRE` event that merely signs
   off a match already decided on court — only the former sets it).

6. **No more admin password, anywhere.** The desktop app generated a
   random per-install password; the admin dashboard had a visible password
   field that showed until one was known. Both are gone. `main.js` now
   uses one fixed `ADMIN_PASSWORD = 'change-me'` constant (matching the
   server's own existing fallback in `config.ts`), migrating any existing
   install's old random password to it on next launch (`loadOrCreateConfig`
   always writes the fixed value now, regardless of what's already on
   disk). `AdminDashboard.tsx` never renders a password input; it resolves
   the password from the URL, then `localStorage`, then the same fixed
   default. This is a deliberate simplification for a LAN-only,
   single-admin tool — not a security hardening.
   - A real bug surfaced by this: the admin dashboard's status/error
     message (`role="status"`) was a single shared piece of state used by
     _every_ action (add/remove a court or umpire, create a match, copy a
     link) but only ever rendered in one place, tucked inside the "Create
     match" card. Clicking "Add court" with an invalid password produced
     a real 401 and a real error, just displayed nowhere near the button
     that was clicked — looked exactly like "Add court doesn't work."
     Fixed by moving the single status line to the top of the page, right
     under the (now-gone) password field's old position, so every action's
     feedback lands in the same predictable spot.

7. **Admin dashboard layout, several iterations.** The courts/umpires
   column and the "Create match" column started as an even 50/50 split,
   which left the (much simpler) courts/umpires side mostly empty; it's
   now a proportional `minmax(400px, 1fr) minmax(0, 1.2fr)` split that
   favors Create Match without pinning courts/umpires to a fixed narrow
   width. Each court/umpire card lost a redundant heading (it used to be
   "Add a court" as a `<legend>` _and_ "Courts" as a section heading for
   the same block — now just one heading, add-row, list, in that order).
   The court list item is explicitly two rows now (name/status/code, then
   TV-link-input/Copy/Remove as one full-width flex group each — same
   `width: 100%`-on-a-flex-child trick already used for `.match-team-fields`),
   instead of the TV-link `<label>` wrapping onto its own cramped line.
   Both `.court-header` (umpire rows) and `.court-row-info` (court rows)
   needed explicit `gap` — the umpire name/status pair had none at all
   (plain inline `<span>`s touch with zero gap unless a layout rule gives
   them one).

8. **Desktop app icon + web favicon**, wiring only — the icon files
   themselves (`build-assets/icon.icns`/`.ico`/`icon-1024.png`) already
   existed from an earlier pass and were already wired into
   electron-builder's `build.mac.icon`/`build.win.icon` for **packaged**
   builds. Neither the Dock icon nor any browser tab showed anything while
   running from source, though. Fixed: `app.dock.setIcon()` (macOS) and
   the launcher `BrowserWindow`'s `icon` option now run in dev mode only
   (`devIconPath()` returns `null` when `app.isPackaged`, since
   `build-assets` isn't copied into a packaged app's resources and a
   packaged build already gets its icon from electron-builder). For the
   web pages, a 128×128 PNG derived from the same source
   (`packages/client/public/favicon.png`, via `sips -z 128 128`) plus a
   `<link rel="icon">` in `packages/client/index.html` — Vite's `public/`
   convention copies it to `dist/` root untouched, so every route sharing
   that one `index.html` (admin, TV, umpire, join) gets it for free.

## Later session — video streaming and internet delivery

Full detail lives in **[STREAMING_UPGRADE.md](STREAMING_UPGRADE.md)**; this is
the short version of what changed in _this_ repo and what to watch out for.

**What it added.** A court-side phone streams live video over WebRTC to LAN
viewers, and — separately — scores and video reach a public Firebase-hosted page
that anyone on the internet can open. The MJPEG implementation that preceded it
(~2 FPS) is deleted.

**What it did _not_ change.** The LAN app is untouched in behaviour. No internet,
or no Firebase credentials, and everything works exactly as before: cloud sync
logs a warning and disables itself, and the Socket.io signalling path keeps
serving venue viewers. That was a deliberate constraint, not a happy accident —
the venue network is the one that has to work.

**A later pass added full-screen support, Add to Home Screen, and a screen wake
lock** for the broadcaster and viewer phones, plus full unit coverage for the
streaming code that previously had none — three real bugs surfaced doing that
(a Firestore listener leak, a reconnecting broadcaster tearing down its own
live stream, a StrictMode double pause-emit caught before it shipped). See
STREAMING_UPGRADE.md sections 5b, 6c and 11.

**A further pass added a Cloudflare TURN relay** after internet viewers failed
to connect from two different networks — the exact gap section 9.1 had
predicted. The relay is minted server-side (the TURN key is a long-term secret
that must never reach a browser) and handed to the broadcaster only, since one
side offering a relay candidate is enough for ICE. The public viewer also
gained an **on-page connection log** (`?debug=1`), because the devices that
fail are phones on other people's networks that nobody can attach a debugger
to. Configuration is in STREAMING_UPGRADE.md 7.2b; the mechanism and the
measurements are in 6d.

**Touch points in existing code, worth knowing about:**

- `sockets/index.ts` — one added call at the single broadcast choke point pushes
  each state change to Firestore. Fire-and-forget and _after_ the LAN emit, so a
  slow uplink can never delay a point reaching the umpire's screen.
- `main.js` — now passes `cwd` when spawning the server. Without it `dotenv`
  never found `packages/server/.env` (see the Configuration reference warning).
- `AdminDashboard.tsx` — each court row gained a public-link row.
  `PUBLIC_SCOREBOARD_ORIGIN` there must match `.firebaserc`.
- `firestore.rules` — scores are world-readable and **client-write-denied**;
  the signalling subtree is open by necessity. `toPublicScoreboard()` is an
  allow-list keeping `umpireToken` out of public documents.
- `sockets/stream.ts` — the broadcaster's `disconnect` handler now checks it is
  still the _current_ broadcaster for the court before announcing the stream
  over, so a stale socket timing out after a reconnect can't kill a live one.
- `manifest.webmanifest` / Apple meta tags (`packages/client/index.html`,
  `public-viewer/index.html`) — installable-app support. The public viewer,
  served over a real cert, installs fully on both platforms; the LAN pages,
  served over the desktop app's self-signed cert, only get it on iPhone.

**The most useful lessons**, both the hard way:

1. **Don't verify playback with `--autoplay-policy=no-user-gesture-required`.**
   It suppresses the exact failure real users hit; a black-screen bug was
   measured as "working" because of it.
2. **A viewer document is only cleaned up on `pagehide`**, which does not fire on
   a crash or a force-quit — so abandoned entries accumulated and silently
   consumed every connection slot. Anything holding per-client state in Firestore
   needs a TTL, not just a tidy-up handler.
3. **Closing an `RTCPeerConnection` does not detach a Firestore `onSnapshot`
   listener.** Every discarded unsubscribe function from a since-closed peer was
   a permanent, still-billing listener. Track and call every unsubscribe
   explicitly — see `firestore-signal.ts`'s `PeerSession`.
4. **`npm run build` compiles the server's `*.test.ts` files into `dist/` too**,
   and Jest with no `dist/` ignore pattern discovers and re-runs them, producing
   a wall of failures that have nothing to do with the code. Build-then-test
   order matters until `testPathIgnorePatterns` excludes it.
5. **A reachable TURN host is not a working TURN server.** The free
   `openrelayproject` credentials resolve, accept TCP, and then refuse the
   allocation (`code=400`, zero relay candidates) — configuring them would have
   looked like a fix and changed nothing. Always verify a `relay` candidate is
   actually gathered before believing a relay works.

## Later session — player roster import, category-aware matches, and two bugs found

**What it added.** An admin can import a tournament's player list from a CSV
export (MemberID, FirstName, LastName, Gender, Country, Club, BirthDate,
Category, Status — a new `TournamentPlayer` table, additive like the
earlier `Player`/`Match` column additions) instead of typing names per
match. Once imported: creating a match picks players from a searchable
dropdown (`PlayerAutocomplete` — opens the full list on focus, filters as
you type from the first character, pre-filtered to whoever is registered
for the category picked above it) instead of free-typed first/last name,
and category becomes a closed `<select>` of the codes the roster actually
carries instead of free text. A new validation service
(`packages/shared/src/players.ts`, `validateMatchEligibility`) parses a
category code (e.g. "MS U19") into gender/discipline/age-cap and checks the
proposed line-up against it server-side at creation time — using whatever
roster data is actually present, so a manually-typed player (or one with a
blank field) just skips the checks that need it. A tournament with no
imported roster falls back to the original manual form entirely.

**Touch points in existing code, worth knowing about:**

- `schema.prisma` — new `TournamentPlayer` model; `Player` gained a
  `tournamentPlayerId` column (traceability only, not a formal relation —
  a roster row can be edited or removed later without touching match
  history already recorded).
- `db/ensure-columns.ts` — now also creates missing _tables_
  (`CREATE TABLE IF NOT EXISTS`), not just columns, so an existing
  database upgrades in place the same way the `Player.lastName`/
  `Match.category` additions did.
- `routes/matches.ts` — `POST /matches` now resolves each player either by
  `tournamentPlayerId` (looked up server-side, names copied from the
  roster rather than trusted from the client) or the old `name`/`lastName`
  shape; runs `validateMatchEligibility` before creating; rejects a
  category not among the tournament's imported ones once a roster exists.
- `AdminDashboard.tsx` — new "Import players" card; the create-match form
  branches its player/category fields on whether `tournamentPlayers` is
  non-empty.

**Two real bugs found while building and testing this, both fixed:**

1. **The admin Courts list showed a court as permanently "Live"** once it
   had ever hosted a match. It read `Court.currentMatchId`, which the
   server only ever _sets_ (at match creation) and never clears — the
   field actually means "which match should this court's TV follow", not
   "is a match live right now". Switched to the same occupied-court signal
   (derived from the polled match list's `status`) already used correctly
   to disable that same court in the "Create match" dropdown, and renamed
   the labels to Busy/Available to match the umpire list.
2. **A failed `fetch` whose response body wasn't JSON silently swallowed
   the error** — reproduced live: a not-yet-restarted server returned its
   default HTML 404 page for the new import route, `res.json()` threw
   inside an `async` handler with no `catch`, and the admin saw no status
   message at all. Every "show the server's error" call site in
   `AdminDashboard.tsx` went through the same bare
   `(await res.json()).error` pattern, so this could have bitten any of
   them. Added a shared `readErrorMessage()` fallback and a `catch` around
   the import handler for network-level failures too.

Also fixed: the internet viewer (`public-viewer/index.html`) was missing
the `category ?? matchType` fallback the other three score screens (TV,
Umpire, LAN Stream Viewer) already had, so a match with no category hid
the badge instead of showing "singles"/"doubles" — deployed straight to
Firebase Hosting since this page has no build step.

## Later session — a persistent, CA-signed camera cert + mDNS, instead of a fresh self-signed one every boot

Full detail lives in **STREAMING_UPGRADE.md section 7.6**; short version here.

**The problem:** the camera-capture HTTPS listener's cert was regenerated
from scratch on every server start with only `commonName: localhost` set —
so even a phone that had clicked through the "not private" warning once saw
a brand new one the very next restart, and modern browsers validate hostname
against the certificate's SAN (which didn't exist), not the CN.

**What shipped:**

- `integrations/local-tls.ts` — a small local Certificate Authority,
  generated once and persisted to `~/.courtside-scoreboard/certs/`, signing
  a long-lived leaf cert whose SAN lists `localhost`, `127.0.0.1`, `::1`,
  `config.mdnsHostname`, and every LAN IPv4 address the machine had at first
  boot.
- `integrations/mdns.ts` — advertises the server at `config.mdnsHostname`
  (`courtside.local` by default) via `bonjour-service`, so a device relies
  on a name instead of a DHCP-assigned IP that can change between matches.
- `routes/local-ca.ts` — `GET /api/local-ca.pem`, unauthenticated, serves
  only the CA's certificate (never its key) with
  `Content-Type: application/x-x509-ca-cert` so iOS/Android offer to
  install it as a trusted profile. Reachable over **plain HTTP** — it can't
  itself require a trust the phone doesn't have yet.
- `AdminDashboard.tsx` — a standing "Trust this phone for camera streaming"
  card (not tied to any match) with a QR code for that download link and
  collapsed install steps for iOS/Android.

**The real gap this doesn't close:** `.local` resolution isn't universal —
native on iPhone, only Android 13+, and Windows needs Apple's Bonjour
service installed separately (researched before building this, since it
changes whether mDNS alone is "the fix" or just "the best case"). A device
that can't resolve it falls back to the LAN-IP link exactly as before; the
persistent cert (its SAN includes the IP too) still means that fallback
survives an app restart, just not a change in the IP itself.

`MDNS_ENABLED=false` disables mDNS entirely for a venue that blocks
multicast; `MDNS_HOSTNAME` and `LOCAL_TLS_DIR` are both overridable — see
the Configuration reference below.

## Later session — admin dashboard reorganization, per-court broadcast link, and automatic start/stop

**Admin dashboard reorganization.** The page had grown long enough that
several pieces needed reworking:

- **Match history** gained pagination — a rows-per-page `<select>` (10/20/50,
  10 by default) above the table, Previous/Next controls below it once
  there are more matches than fit on one page.
- The history list's topline showed `matchType` _and_ `category` side by
  side; every other screen (TV, Umpire, LAN Stream Viewer, public viewer)
  already replaces "singles"/"doubles" with the category when one is set.
  Fixed to match.
- **Courts** became a single-open accordion (`<details>`/`<summary>`,
  controlled by one `expandedCourtId` piece of state so opening one closes
  whichever else was open) — collapsed by default, showing only the
  court's name and Busy/Available status; everything else (join code, TV
  link, public link, broadcast link) is behind the click. A small rotating
  `.court-chevron` marks each row as expandable, since the flex layout
  suppresses the browser's own disclosure triangle.
- **Umpires** capped to a ~4-row scrollable list (`.umpire-list`, a
  `max-height`/`overflow-y: auto` pair) instead of growing the page
  indefinitely — the height is an estimate, worth a visual check on a real
  screen.
- **"Trust this phone for camera streaming"** moved from a standing card
  above everything else to directly under Umpires, in its own collapsed-
  by-default accordion (`.section-accordion-summary`/`.section-chevron` —
  a generic version of the Courts pattern, for a single card rather than a
  per-item list). Side effect worth knowing: it now only renders once a
  tournament is selected, since Umpires (and the rest of that column) does.

**Broadcast (camera) link moved from per-match to per-court.** It used to
be regenerated and shown in the "created match" panel every time a new
match started, labelled "Viewer link (internet)" even though — traced
through `useMatchState`/`useStreamViewer.ts`/`webrtc-stream.ts`'s
`startViewing` — it was LAN-only the whole time (Socket.io), not
internet-facing at all; the actual internet-facing viewer is the separate
Firebase-hosted `public-viewer`. Since `streamBroadcastLinkFor()` is keyed
by `courtId`, not `matchId`, the URL itself never changes across matches on
the same court — it now lives once, permanently, on each court's row in
the Courts list (`.broadcast-link-row`), with a deliberately small
(`size={32}`) QR code so a tournament running half a dozen-plus courts at
once doesn't turn the list into a wall of QR codes. `StreamViewer.tsx`/
`useStreamViewer.ts` and the LAN-viewer half of `webrtc-stream.ts`/
`sockets/stream.ts` were left in place, unlinked, rather than deleted — an
explicit choice in case that path gets a real use later.

**`GET /api/config`** (new, public, unauthenticated — `routes/config.ts`)
exposes `{ mdnsHostname, mdnsEnabled }` so the client never hardcodes or
guesses a value that could drift from a customised `MDNS_HOSTNAME` env var.
`streamBroadcastLinkFor()` prefers the advertised mDNS hostname over
`window.location.hostname` when available, for the same reason the
persistent cert above exists: an IP a phone already trusted can change
between matches, `courtside.local` doesn't.

**The court's camera now starts and stops itself with the match**, instead
of relying on someone to remember to press the phone's Start/Stop button:

- `STREAM_EVENTS.MATCH_FINALIZED` — the server (`sockets/index.ts`) emits
  it to a court's stream room the moment the umpire finalises the match on
  it (the same transition that flips `Match.status` to `COMPLETED`); the
  broadcasting phone (`useCameraBroadcast.ts`) reacts by releasing the
  camera and both peer meshes automatically, same as pressing Stop, with a
  distinct on-screen notice ("Transmission stopped automatically…") instead
  of the error styling.
- `STREAM_EVENTS.MATCH_STARTED` — emitted the moment the umpire's first
  serve flips the match to `IN_PROGRESS`. A phone sitting on a court's
  broadcast page while idle now holds a lightweight, non-transmitting
  **`stream-standby`** socket connection (`sockets/stream.ts` — joins the
  room, no camera, no peer connections, no viewer/broadcaster bookkeeping)
  just to hear this. On receiving it, the phone tries to start itself
  silently. **This only works if that phone already holds camera
  permission** for this origin — browsers won't prompt for a new
  permission without a user gesture, so a phone that has never pressed
  Start manually stays idle and needs the first press as before; there's
  no visible error either way, since nothing was expected to happen
  automatically on a phone that was never primed. This closes part of the
  gap documented in STREAMING_UPGRADE.md §9.4 ("the broadcast does not
  resume by itself") — specifically the "someone has to remember to press
  Start" half; a restarted server or a phone that never granted permission
  still needs a manual press, unchanged.

**Team/country moved under Players, and auto-fill from the roster.** These
used to be their own "Sides" fieldset ahead of Players, always manually
typed. They now render directly under each side's player field(s) inside
Players (`SIDE_SLOTS`, `.side-fieldset`), and — once a roster is imported —
fill in automatically from the selected player's own `club`/`country`
(`TournamentPlayer.club`/`.country`) the moment they're picked, rather than
being retyped. Still fully editable: an admin's manual edit sticks unless a
different player is subsequently picked for that side, and re-typing the
player search (which clears the selection — see `PlayerAutocomplete`)
leaves whatever was already filled in alone, since a mid-search state
isn't "this side no longer has a team."

**Create match's status feedback moved off the page-top banner.** The
single `status` state at the top of the page (used by every admin action —
add/remove court or umpire, copy a link, import a roster) is shared across
what has become a long page; an error from Create match, at the bottom,
rendered off-screen above wherever the admin was scrolled to, which looked
exactly like no error appeared. Create match now has its own
`matchStatus`, rendered right under its own submit button — no scrolling
either way.

## Later session — admin-only English/Spanish i18n, and courtside.local everywhere instead of a LAN IP

**Admin dashboard is now bilingual (English/Spanish), the rest of the app
untouched.** New `packages/client/src/i18n/`:

- `locale.ts` — `detectLocale()` picks the browser's first supported
  language from `navigator.languages` (matched on the primary subtag, so
  `es-MX` and `es-ES` both resolve to `es`), falling back to English.
- `en.ts` / `es.ts` — full string dictionaries for the admin screen, kept
  from drifting apart by a test that fails on a missing key, a mismatched
  `{{placeholder}}` between locales, or an empty string.
- `useTranslation()` — deliberately **not** a Context provider. The
  "current locale" is a pure function of `localStorage` (a stored
  preference) falling back to the browser language, read via
  `useSyncExternalStore`; every call site (AdminDashboard, and
  `PlayerAutocomplete` separately) subscribes to the same source, so a
  `setLocale()` call from the new language `<select>` in AdminDashboard's
  header is reflected everywhere on the page immediately, with no provider
  element needed anywhere in the tree.

Every user-facing string in `AdminDashboard.tsx` and `PlayerAutocomplete.tsx`
now goes through `t()` — English wording was kept character-for-character
identical to what existed before, specifically so the entire pre-existing
test suite kept passing unmodified (jsdom defaults to `en-US`). TV, Umpire,
StreamViewer and the public viewer are all still English-only; that was a
deliberate scope line, not an oversight.

**`courtside.local` is now the address the whole app uses, not just the
camera-broadcast link.** Traced back to exactly one place:
`packages/desktop/src/main.js`'s `openDashboard()` picked the first LAN IPv4
address and opened the admin dashboard there (via `shell.openExternal`),
and every link the dashboard builds (TV, Umpire — via `absoluteUrl()`,
`tvLinkFor()`, `umpireLinkFor()`) derives from `window.location.origin`.
Fixing that one call site fixes all of them for free — none of those
client-side functions needed to change.

`main.js` now has `resolveDashboardHost()`, called once right after the
server logs "listening on port": it probes `http://courtside.local:3000/api/health`
for real (not just assumed reachable because the server publishes it — see
`probeHost()`) and prefers it, falling back to the first LAN IPv4 address
exactly as before whenever it doesn't resolve here. **Retries rather than
probing once** — the server logs "listening on port" _before_ it even calls
`publishMdns()` (see `index.ts`), and this OS's own multicast-DNS resolver
needs a further moment beyond that to actually pick up the freshly-announced
record. A single immediate probe was observed to fail on a real launch even
though `courtside.local` resolved fine about a second later; up to 8
attempts, 500ms apart, closes that gap. `launcher.html`'s displayed address
now shows this resolved host too, once it lands (briefly shows the LAN IP
until then, so the launcher is never blocked on the probe).

**Known, not yet decided:** the "Trust this phone for camera streaming" QR
(`/api/local-ca.pem`) inherits `courtside.local` the same way TV/Umpire
links do, purely as a side effect of "everywhere" — but that link's only
job is getting the CA onto a brand-new phone that hasn't trusted anything
yet, and an IP address is arguably the more bulletproof choice for that one
specific bootstrap step regardless of whether `.local` resolution works.
Left as-is (flagged to the user, not yet acted on either way) — revisit if
a phone that can otherwise reach the server fails specifically at this QR.

## Later session — admin-only dark/light theme toggle

New `packages/client/src/theme/useTheme.ts`, deliberately the same shape as
`i18n/useTranslation.ts` from the session above it: the "current theme" is
a pure function of a `localStorage` key (`courtside:theme`), read via
`useSyncExternalStore` so every call site shares one value with no Context
provider, and `setTheme()` just writes the key and notifies. The one real
difference from language: there's no "browser preference" to fall back to
— the default is simply `dark` until an admin picks otherwise, since that
was the explicit ask, not "match the OS".

**Scoping "admin only" took more than just a CSS class.** The existing
palette lives entirely in `:root` custom properties, and `body`'s own rule
paints the actual page background (a radial gradient using `--bg`) — a
class scoped somewhere under `.admin-dashboard` can't override that,
because `body` is an _ancestor_ of the dashboard, not a descendant, and
custom properties only cascade downward. The light theme is therefore a
`body[data-theme='light']` rule (higher specificity than the plain `body`
rule, so it wins regardless of source order) that redefines every palette
variable and repaints `background`/`color` itself. `AdminDashboard.tsx`
sets `document.body.dataset.theme` in a `useEffect` keyed on `theme` — and,
critically, **clears it again in that effect's cleanup function**, so
navigating away (or just closing the tab) never leaves a leftover
`data-theme` attribute for whatever screen opens next in the same tab to
inherit. TV, umpire, stream-viewer and the public viewer never set this
attribute at all, so `body[data-theme='light']` never matches for them
regardless.

Not separately audited line-by-line: a few small UI accents (status/category
pill backgrounds, the current-set highlight in the score table) are
hand-picked low-opacity `rgba()` tints rather than theme variables. Checked
that each one still reads fine against a light background as a paler wash
of the same color rather than clashing outright, but they weren't
rebalanced specifically for light mode — worth a visual pass if one looks
off in practice. The QR code's own white plate/dark-module background
(`.qr-code svg`) is deliberately hardcoded regardless of theme, unrelated
to this — see the earlier note in this file about scanner contrast
requirements.

## Later session — retirement vs walkover

Item 5 of the earlier session above added a `retiredSide` label everywhere a
match summary appears, but only ever meant one thing: a player retired
mid-match. There was no way to record the other real early-ending case — the
opponent never showing up at all — so this session added a second reason
alongside it rather than a new mechanism.

`RetireReason = 'RETIREMENT' | 'WALKOVER'` (`packages/shared/src/types.ts`)
travels the same path `retiredSide` already did: an optional `reason` on
`RetireMatchPayload` (the socket payload), an optional `retireReason` on
`ScoreEvent`, and a required-but-nullable `retireReason` on
`DerivedMatchState`/`DerivedMatchSummary` (null under the same conditions
`retiredSide` is null — a normal win, or a RETIRE event that just finalises
an already-decided match, has no reason because nobody retired).
`deriveMatchState`'s `RETIRE` case defaults a missing reason to `RETIREMENT`,
so every match recorded before this change (whose RETIRE events obviously
carry no reason) still renders with a label instead of none.

**Persistence reused the existing `payload` JSON column on `ScoreEvent`**
rather than adding a dedicated column/migration — the same column
`START_SET` already stores its own extra fields in
(`firstServerSide`/`firstServerPlayerId`/`courtPositions`). `RETIRE` already
spends its one dedicated column (`side`) on the winner; the reason is
optional, so it goes in `payload: JSON.stringify({ reason })` instead
(`packages/server/src/sockets/index.ts`'s `RETIRE_MATCH` handler), decoded
back out in `packages/server/src/match/replay.ts` the same way START_SET's
extra fields already were.

**Umpire flow is now two steps instead of one.** "End match" used to open a
single dialog asking which side the match is awarded to. It now asks _why_
first (Retirement vs Walkover — opponent no-show), then which side, so the
reason is known before the side-choice dialog needs it. Finalising an
already-decided match (the winner is already on the board; the umpire is
just signing it off) skips both — nobody retired, so there's nothing to ask.

**Labels centralized the same way `INTERVAL_LABELS` already was** — two new
maps in `packages/shared/src/scoring.ts`, `RETIRE_REASON_TAGS` (short tag:
"Retired" / "W.O.") and `RETIRE_REASON_HEADLINES` (verb phrase for the "X
wins the match — {phrase}" headline: "retired" / "did not show up (W.O.)"),
so a third reason would only ever need updating in one place. Consumed by
the TV screen, the umpire's own end-of-match summary, and the stream viewer.
The admin dashboard's history list and status tag are the one localized
surface — new `matchHistory.walkover` and `status.finalizedWalkover` keys in
`en.ts`/`es.ts` — since everywhere else on this app still renders plain
hardcoded English strings, matching each screen's existing (lack of) i18n
rather than localizing screens this change didn't otherwise touch.

**Found and fixed while at it:** the stream viewer (`StreamViewer.tsx`, the
internet-facing broadcast overlay) never showed a retirement label at all,
even before this session — a pre-existing gap in "everywhere a result is
shown." It now shows the same "— {side} retired/did not show up" suffix as
the TV screen. `public-viewer/index.html` (the no-build-step internet
viewer) keeps its own mirrored copy of `RETIRE_REASON_HEADLINES`, same
reasoning as its existing `INTERVAL_LABELS` mirror.

## Desktop app (`packages/desktop/`) — Electron wrapper

**Why:** running the server required Node install + `npm install` + hand-
editing `.env` + Prisma migrate + build + start — not friendly for a non-
technical match-day admin. This wraps all of it into a double-click app.

**Architecture — deliberately a thin wrapper, not a rewrite:**

- `src/main.js` (Electron main process, plain CommonJS) spawns the **real,
  unmodified server** as a child process by running `tsx` against
  `server/src/index.ts` directly — the exact same code path as `npm run
start --workspace packages/server`. It does NOT compile the server or
  require it as a module.
- The subprocess runs through **Electron's own bundled Node** via the
  `ELECTRON_RUN_AS_NODE=1` env var trick — this is what lets the packaged
  app run on a machine with no Node.js installed at all.
- On first launch: generates a random admin password (stored in
  `app.getPath('userData')/config.json`), copies a pre-migrated empty
  SQLite database (`resources/template.db`) into
  `userData/courtside.db` if one doesn't exist yet, then starts the
  server with `DATABASE_URL`/`ADMIN_PASSWORD`/`PORT`/`CLIENT_DIST_PATH`
  set via env vars.
- Shows a small launcher window (`src/launcher.html`, plain HTML/CSS/JS,
  not part of the React app) with the LAN address and an "Open Admin
  Dashboard" button. That button opens the system browser at
  `http://<lan-ip>:3000/admin?adminPassword=<pw>&tournamentId=...&tournamentName=...&tournamentDate=...`
  — the admin dashboard
  picks the password up from the URL once, stores it in localStorage, and
  scrubs it back out of the address bar (see AdminDashboard.tsx). The
  launcher itself never displays a password field or regenerate control —
  that whole flow was deliberately removed partway through this session
  per explicit feedback ("not require admin password.. hide those
  controls").

**Why the database is a pre-built template, not a live migration:**
`prisma migrate dev` refuses to run non-interactively, and bundling the
full Prisma CLI/migration engine into a packaged Electron app is heavy for
zero benefit here. Instead, `scripts/build-template-db.js` (a build-time
script, run via `npm run build:template-db`, itself invoked automatically
by the `dist:*` scripts) runs `prisma db push` against a fresh empty file
and drops it into `resources/template.db`. The packaged app just copies
this file at first launch — no Prisma CLI needed at runtime, only
`@prisma/client`.

**The packaging config (`packages/desktop/package.json`'s `"build"`
block) took several real iterations to get right — this is the fiddliest
part of the whole session. In order, the actual failures hit and fixes:**

1. Electron version couldn't be auto-detected from a hoisted monorepo
   `node_modules` → pinned an exact version (`"electron": "33.4.11"`, not
   a caret range).
2. electron-builder's default dependency-rebuild step tried to run `npm
install --production` in `packages/desktop`, which bubbled up to the
   **root** `prepare` (husky) script, failed, and **pruned all
   devDependencies from the root `node_modules` as a side effect**
   (deleted `electron-builder` itself mid-build). Fixed with `"npmRebuild":
false` — there are no native Node addons here needing an Electron-ABI
   rebuild (Prisma's query engine is a spawned subprocess, not a native
   addon, so this is safe).
3. Declaring `@courtside/server` as a `dependency` in `desktop/package.json`
   made electron-builder try to auto-bundle that entire sibling workspace
   package (including files like `.env.example` that broke its
   asar-relative-path logic). Removed the dependency entirely — root
   `npm install` already hoists everything needed regardless.
4. The bulk `../../node_modules` → `node_modules` `extraResources` copy
   preserves npm workspaces' **symlink** for `@courtside/shared`, which
   then collided with an explicit real-copy of the same package. Fixed by
   excluding it from the bulk copy filter (`"!@courtside/shared"`,
   `"!@courtside/shared/**"`) so only the explicit copy populates it.
5. **The big one**: `main.js` lives inside `app.asar` once packaged.
   Node's module resolution, walking up from a file inside an asar,
   continues onto the real filesystem once it exits the archive — landing
   at `Contents/Resources/`, not at whatever custom subfolder you might
   pick. The very first layout nested everything under `Resources/app/`,
   which broke `require.resolve('tsx/package.json')` from `main.js`
   specifically (the spawned server process, running from
   `Resources/server/src/index.ts`, would have resolved fine from a
   sibling `Resources/server/node_modules`-adjacent layout — it was only
   `main.js`'s own resolution that needed the flatter path). Fixed by
   flattening: `server/`, `client-dist/`, `node_modules/`, and
   `template.db` all live directly under `Resources/`, so both `main.js`
   (from the asar) and the spawned server process resolve the **same**
   single `node_modules`.
6. **Prisma's query engine is platform-specific**, and it had only ever
   been generated for this dev machine (darwin-arm64) — the Windows build
   would have installed fine and then crashed the instant anyone tried to
   touch the database. Fixed by adding `binaryTargets = ["native",
"darwin", "darwin-arm64", "windows"]` to
   `packages/server/prisma/schema.prisma`'s generator block and re-running
   `prisma generate`.
7. The first Windows/Mac builds defaulted to **this build machine's own
   CPU architecture** for both platforms (arm64 for Windows too, which is
   nearly useless — almost all real Windows PCs are x64). Fixed via
   electron-builder's array target syntax: `"win": { "target": [{
"target": "nsis", "arch": ["x64"] }] }`, and correspondingly built both
   `x64` and `arm64` for Mac.
8. `configuration.mac`/`.win` don't accept a top-level `arch` key (only
   inside a `target` object) — a validation error caught this immediately,
   easy fix.
9. Electron's `require('electron')` returns a plain path **string**
   instead of the API object (`app`, `BrowserWindow`, etc. all
   `undefined`) if `ELECTRON_RUN_AS_NODE` happens to already be set in the
   _launching_ shell's environment — this is a footgun specific to dev/
   testing environments, not the packaged app in the wild, but cost real
   debugging time this session since the sandbox this was built in had it
   leaking into every shell. If Electron ever silently behaves like plain
   Node, check this first.
10. ESLint started reporting 8000+ errors — it had begun scanning the
    huge minified JS inside `packages/desktop/release/` (the electron-
    builder output, which isn't covered by `.gitignore`'s effect on
    ESLint — those are separate ignore lists). Added
    `'packages/desktop/release/**'` to `eslint.config.js`'s `ignores`.

**Verified for real, not assumed working**, at each stage: ran the actual
packaged `.app` standalone (not dev mode), confirmed config/database
auto-created correctly, ran a full Playwright pass through the packaged
binary's own server (umpire scoring, live TV sync, join-code flow) with
zero console errors. Executed the ES5 "legacy" client bundle directly as a
classic script to prove browser-compat fixes actually work, not just that
the build didn't error.

**What's still open on the desktop app:**

- **Unsigned.** No Apple Developer ID or Windows code-signing certificate
  available in this environment. macOS Gatekeeper and Windows SmartScreen
  will both warn on first launch (right-click → Open on Mac; "More info" →
  "Run anyway" on Windows). Getting rid of these warnings requires the
  project owner's own paid developer certificates — not something to fix
  from here.
- **Windows installers must now be built on Windows.** Cross-building from
  macOS is blocked outright by `scripts/require-windows-build-host.js`,
  wired in as `predist:win`, which throws unless `process.platform` is
  `win32`. Earlier in the project a `.exe` _was_ cross-built here via
  electron-builder's auto-downloaded `wine`, and the stale artifact may
  still be sitting in `release/` — but that path packages the build host's
  own native runtime dependencies, so the embedded server crashes on a real
  Windows machine. Don't remove the guard to "just get an exe".
  To build one, run `npm run pack:win-source --workspace packages/desktop`
  (see below), carry the zip to a Windows box, and build there.
- **The Windows build has still never been launched and clicked through.**
  The guard means it can only be produced on hardware not available here,
  so nothing Windows-specific has been verified end-to-end.
- **Bundle size — the follow-up below is now DONE.** It used to ship the
  whole hoisted root `node_modules` (~250–300MB per installer). It now
  copies `../server/node_modules`, which `scripts/build-runtime-deps.js`
  rebuilds from scratch as a production-only closure of just the server's
  seven runtime dependencies. The arm64 `.dmg` is ~138MB. Still fat by
  normal standards — it carries Electron itself plus three Prisma query
  engine binaries (darwin, darwin-arm64, windows), and every platform's
  engine ships in every installer rather than only its own. Trimming
  `binaryTargets` per build would be the next honest win.
- **Custom app icon**: done. Two glowing dots (cyan/violet, either side of
  a center divider — echoes the app's own Side A/B color language),
  rendered via a headless-browser screenshot of
  `packages/desktop/build-assets/icon-source.html` at 1024×1024, then
  converted with macOS's built-in `sips`/`iconutil` (no ImageMagick/PIL
  available in this environment) — `icon.icns` (full iconset, 10 sizes)
  for Mac, `icon.ico` for Windows. One `sips` gotcha: `-z <size>
--out foo.ico` alone does **not** actually change format despite the
  extension — it silently writes PNG bytes with a `.ico` name unless you
  also pass `-s format ico` explicitly. Wired into
  `packages/desktop/package.json`'s `build.mac.icon` /
  `build.win.icon`, and confirmed present in the built `.app`'s
  `Contents/Resources/icon.icns`. To change it later, edit
  `build-assets/icon-source.html` and regenerate (see the render+convert
  commands in this session's history, or just redo the same
  Playwright-screenshot → `sips -z <N> <N> ... --out icon.iconset/iconNAME.png`
  loop → `iconutil -c icns` → `sips -s format ico ...` pipeline).

**Rebuilding the installers:**

Three inputs must exist on disk first, because `extraResources` copies all
of them into the app. Two are gitignored, so a fresh clone has neither and
the build fails on the missing path:

```bash
npm install
npm run build --workspace packages/client                            # packages/client/dist
npx prisma generate --schema=packages/server/prisma/schema.prisma    # packages/server/generated
```

Then:

```bash
cd packages/desktop
npm run dist:mac   # arm64 .dmg only — see build.mac.target in package.json
npm run dist:win   # x64 .exe (NSIS) — refuses to run anywhere but Windows
npm run dist       # whatever the host platform defaults to
```

Each `dist:*` runs `build:template-db` (regenerates `resources/template.db`)
then `build:runtime-deps` before electron-builder. `build-template-db.js`
only syncs schema-to-database — it does not regenerate the Prisma client,
which is why the `prisma generate` above is a separate step whenever the
schema changes.

**`scripts/build-runtime-deps.js` has a side effect on your working copy**
that will bite you: it deletes `packages/server/node_modules` and reinstalls
only the production dependencies (`--omit=dev --ignore-scripts`). After any
`dist:*` run, that workspace has no Jest, no Prisma CLI and no TypeScript —
`npm test` and `npm run typecheck` will fail until you re-run `npm install`
at the root. This is what finally implemented the "build a minimal
production-only node_modules" follow-up listed below; the arm64 `.dmg` went
from ~151MB to ~138MB.

**Running in dev mode** (no packaging, fastest iteration loop):

```bash
cd packages/desktop
npm run start   # runs `electron .`
```

Gotcha hit repeatedly this session: if `ELECTRON_RUN_AS_NODE` is already
set in your shell (check with `echo $ELECTRON_RUN_AS_NODE`), Electron will
silently run as plain Node and every `require('electron')` call will
return a useless string. Launch with `env -u ELECTRON_RUN_AS_NODE npm run
start` if that happens.

## Configuration reference

**`packages/server/.env`** (never committed; copy from `.env.example`):

```
PORT=3000                          # optional, defaults to 3000
HTTPS_PORT=3001                    # optional, defaults to PORT + 1 (camera/secure-context listener)
ADMIN_PASSWORD=<real password>     # optional, falls back to 'change-me' (insecure — always set this)
DATABASE_URL="file:./dev.db"       # REQUIRED, no fallback — Prisma throws without it
CLIENT_DIST_PATH=<path>            # optional, defaults to ../client/dist relative to CWD
MDNS_HOSTNAME=courtside.local      # optional — the name advertised over mDNS, see the
                                    # "persistent camera cert + mDNS" session below
MDNS_ENABLED=true                  # optional — "false" disables mDNS (blocked-multicast venues)
LOCAL_TLS_DIR=<path>               # optional, defaults to ~/.courtside-scoreboard/certs

# Optional — cloud score sync only. Absent, the server logs
# "[Cloud] Firebase credentials not found" and runs normally on the LAN.
# All three are REQUIRED together; see STREAMING_UPGRADE.md section 7.
FIREBASE_PROJECT_ID=<id>
FIREBASE_PRIVATE_KEY="<pem with \n escapes>"
FIREBASE_CLIENT_EMAIL=<service account email>
```

⚠️ `dotenv` resolves `.env` from `process.cwd()`, **not** from the file's own
location. The desktop app therefore passes `cwd: serverRootPath()` when spawning
the server (`packages/desktop/src/main.js`). Anything else that launches the
server must run it from `packages/server` or pass the variables explicitly —
otherwise `.env` is silently ignored and cloud sync appears broken with no error.

Note `.env.example` does **not** include `DATABASE_URL` — it has to be
added by hand. This tripped me up once this session; worth fixing in
`.env.example` itself as a small follow-up.

**Prisma** (`packages/server/prisma/schema.prisma`): SQLite, one file.
`binaryTargets = ["native", "darwin", "darwin-arm64", "windows"]` (added
this session, see Desktop section point 6). After changing the schema:
`npx prisma generate` (regenerates `packages/server/generated/prisma`,
gitignored) and `npx prisma db push` or `migrate dev` against your local
`dev.db`.

**`packages/client/vite.config.ts`**: `@vitejs/plugin-legacy` with
explicit `targets: ['defaults', 'ie 11']` and `additionalLegacyPolyfills:
['whatwg-fetch']`, plus `build.minify: 'terser'` with `terserOptions: {
ecma: 5 }` forced globally (see item 6 in the what-was-built list above —
the legacy-browser fix). Don't remove or "simplify" these without
re-verifying the legacy bundle output is still the syntax it's supposed to
be — they look redundant/over-specified until you know why each one is
there.

**`eslint.config.js`**: has a scoped override for
`packages/desktop/**/*.js` (Node/CommonJS globals — the only plain-JS
files in an otherwise all-TypeScript repo) and an ignore for
`packages/desktop/release/**` (build output, not source).

## Testing / quality gates

```bash
npm run lint          # ESLint across every package
npm run format:check  # Prettier
npm run typecheck     # tsc --noEmit across every package
npm test              # Jest --coverage in every package
```

741 tests total across shared/server/client (142/213/386). Shared is 100%
statements/functions/lines, 98.1% branches; server is 99.7% statements /
98.6% branches — `local-tls.ts`, `mdns.ts` and `local-ca.ts` (the persistent
camera cert + mDNS work) are all at 100%; client is 98.4% statements / 96.4%
branches — the
remaining gaps are one intentionally-uncovered, documented branch in
`AdminDashboard.tsx` (the not-yet-built "custom" scoring preset — see the
comment at its call site), one branch in `matches.ts` documented as an
istanbul coverage-merge artifact in `packages/server/jest.config.cjs`, and
a handful of no-op `.catch(() => {})` handlers in `firestore-signal.ts` and
`AdminDashboard.tsx`.

✅ **The video-streaming and cloud-sync code, previously excluded from that
claim, now has full unit coverage.** `webrtc-stream.ts`, `firestore-signal.ts`,
`sockets/stream.ts`, `integrations/cloud-sync.ts`, both Stream screens, and the
newer `useFullscreen.ts`/`useWakeLock.ts` are all at or near 100% (see
STREAMING_UPGRADE.md section 5b and 11 for the before/after numbers and the
three real bugs the new tests found — a Firestore listener leak, a
reconnecting broadcaster tearing down its own live stream, and a StrictMode
double-emit caught before it shipped). `toPublicScoreboard()` in
`cloud-sync.ts` — the allow-list that keeps the umpire's write token out of a
world-readable Firestore document — now has a test asserting the token never
reaches the serialised output. Manual browser driving (STREAMING_UPGRADE.md)
remains how the _first four_ streaming bugs were found and is still how the
actual WebRTC handshake gets verified — these unit tests mock
`RTCPeerConnection` and `onSnapshot`, they don't replace a real phone-to-viewer
test.

The
`packages/desktop` Electron app has **no automated tests** — it was
validated manually (dev mode + actual packaged binaries + CDP against the
real running server, and against a real smart TV for the `subgrid` fix),
not via a test suite. Adding some (at minimum, unit tests for the pure
path-resolution functions in `main.js`) would be a reasonable next step
if this app keeps evolving.

## Quick "where do I look for X" index

| Want to change...                    | Look in                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Scoring rules / win conditions       | `packages/shared/src/scoring.ts`                                              |
| Socket.io event names/payloads       | `packages/shared/src/events.ts`                                               |
| Admin API routes                     | `packages/server/src/routes/{courts,matches,umpires,tournament-players}.ts`   |
| Player roster import / CSV parsing   | `packages/shared/src/{csv,players}.ts`, `routes/tournament-players.ts`        |
| Match eligibility validation         | `packages/shared/src/players.ts` (`validateMatchEligibility`)                 |
| Player search dropdown               | `packages/client/src/lib/PlayerAutocomplete.tsx`                              |
| Live scoring socket handlers         | `packages/server/src/sockets/index.ts`                                        |
| Umpire/TV/Admin screens              | `packages/client/src/routes/*.tsx`                                            |
| Umpire court diagram                 | `packages/client/src/routes/CourtDiagram.tsx`                                 |
| Umpire's spoken call text            | `packages/shared/src/calls.ts`                                                |
| Confirm-before-acting dialog         | `packages/client/src/lib/ConfirmDialog.tsx`                                   |
| Interval/break countdown             | `packages/client/src/lib/useCountdown.ts`                                     |
| App-wide styling/theme               | `packages/client/src/styles.css`                                              |
| Join-code entry flow                 | `packages/client/src/routes/JoinScreen.tsx`                                   |
| Error overlay (pre-React)            | `packages/client/index.html`                                                  |
| Web page favicon                     | `packages/client/public/favicon.png` (Vite copies `public/` verbatim)         |
| Desktop app main process             | `packages/desktop/src/main.js`                                                |
| Desktop app packaging config         | `packages/desktop/package.json` (`"build"` block)                             |
| Desktop launcher window UI           | `packages/desktop/src/launcher.html` (plain HTML/JS, not the React app)       |
| Tournament API routes                | `packages/server/src/routes/tournaments.ts`                                   |
| Windows source zip helper            | `packages/desktop/scripts/pack-windows-source.js`                             |
| Desktop app icon                     | `packages/desktop/build-assets/` (`icon-source.html` is the editable source)  |
| **Video streaming (any of it)**      | **[STREAMING_UPGRADE.md](STREAMING_UPGRADE.md)** — start there, not here      |
| Broadcaster / viewer screens         | `packages/client/src/routes/Stream{Broadcast,Viewer}.tsx`                     |
| WebRTC over the LAN                  | `packages/client/src/lib/webrtc-stream.ts` + `server/src/sockets/stream.ts`   |
| WebRTC to internet viewers           | `packages/client/src/lib/firestore-signal.ts`                                 |
| Public internet scoreboard           | `public-viewer/index.html` (static, no build step)                            |
| Cloud score sync to Firestore        | `packages/server/src/integrations/cloud-sync.ts` (hook at `sockets/index.ts`) |
| Camera cert / local CA               | `packages/server/src/integrations/local-tls.ts`                               |
| mDNS advertisement (courtside.local) | `packages/server/src/integrations/mdns.ts`                                    |
| CA cert download route               | `packages/server/src/routes/local-ca.ts`                                      |
| Firebase project / rules             | `.firebaserc`, `firebase.json`, `firestore.rules`                             |

## Packaged desktop recovery: `tsx`, legacy SQLite databases, and a broken Mac signature

Found on a real Windows install; both fixes below are now implemented in
`packages/desktop/src/main.js` and verified (see each section). They're
platform-neutral on purpose — both problems happen because Electron runs a
packaged application differently from `npm start`, not because of Windows
itself, and a third, Mac-only signing bug turned up while verifying the fix
actually launches a real packaged app rather than just reading the diff.

### 1. Resolve `tsx` from the external resource directory when packaged

The server is launched with Electron's bundled Node runtime and `tsx`:

```js
spawn(process.execPath, [tsxCliPath(), serverEntryPath()], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' /* runtime configuration */ },
});
```

`electron-builder` copies production server dependencies, including `tsx`, to
`resources/node_modules`. The Electron main process itself runs from
`resources/app.asar`, so `require.resolve('tsx/package.json')` searches the
wrong place in a packaged build and fails before the server can start.

`tsxCliPath()` now branches on `app.isPackaged`:

```js
if (app.isPackaged) {
  return path.join(process.resourcesPath, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}
```

`process.resourcesPath` is the Electron-supported cross-platform location, so
this covers both the Windows installer and the macOS `.app` bundle from one
code path — confirmed the file exists at exactly that path in a freshly built
macOS `.app`'s `Contents/Resources/node_modules/tsx/dist/cli.mjs`. Before
shipping a new platform target, do the same check for its own build.

### 2. Upgrade an old per-user database once, with a backup

The launcher used to copy `resources/template.db` to the user's data
directory only when `courtside.db` didn't already exist yet — so an older
install kept whatever database it was created with even after an app update
added a new Prisma model. The observed result was Prisma error `P2021`:
`The table main.Tournament does not exist`.

`DATABASE_TEMPLATE_VERSION` (a constant in `main.js`) and
`databaseTemplateVersion` (persisted in `config.json`) make this upgrade
explicit. When the stored version differs from the bundled version,
`ensureDatabase(cfg)`:

1. Renames the existing `courtside.db` to `courtside.legacy-<timestamp>.db`.
2. Copies the current bundled `template.db` into place.
3. Saves the new template version in `config.json`.

The upgrade runs once per template version; it does not touch the database on
ordinary launches once the versions match. Increment
`DATABASE_TEMPLATE_VERSION` only when a release needs to replace an
incompatible empty or legacy database — for a future migration where
user-entered data must be retained, add a real migration path instead of
bumping this version; the recovery mechanism deliberately keeps the old
database as a backup file but never merges its contents into the new one.

**Verified directly**, not just read: copied this project's own
pre-Tournament-model backup database (`courtside.db.pre-tournament-model.bak`,
missing both `Tournament` and `Umpire`) into an isolated `--user-data-dir`
with no `config.json`, launched `electron .` against it, and confirmed —
`config.json` was created with `databaseTemplateVersion` at the current
value, the old file was renamed to `courtside.legacy-<timestamp>.db` (not
deleted), the new `courtside.db` has every current table, and
`GET /api/tournaments` returned `[]` instead of throwing P2021. Also
confirmed the _non_-upgrade path is a no-op: pre-seeding `config.json` with
today's `databaseTemplateVersion` on a real, already-current database left
it completely untouched on the next launch.

### 3. A separate bug found while verifying the above: the Mac build's signature was corrupted, not just unsigned

Discovered by actually launching a freshly built `.app` rather than trusting
that a successful `electron-builder` run means a working one.
`spctl --assess` reported:

```
code has no resources but signature indicates they must be present
```

That's a different, worse failure than the "unsigned app" warning documented
below — Gatekeeper refuses to even show the warning for a corrupted
signature, so the ordinary right-click → Open override doesn't help, and the
app fails to launch with **no window and no error output at all**. Root
cause: with no Developer ID identity available, `electron-builder` skips its
own signing step (`mac.identity: null` in `package.json`'s `build` config
makes this explicit rather than an auto-detected fallback), but the
_prebuilt_ `Electron.app` binary it repackages already carries its own
baked-in ad-hoc signature from Electron's own build. `extraResources`
(the server, `node_modules`, `template.db`, the icon, ...) get copied into
`Contents/Resources` _after_ that signature was applied, which invalidates
its resource seal without replacing it — setting `identity: null` alone does
**not** fix this, since the stale signature was never electron-builder's own
to control.

Fixed with an `afterSign` hook
(`packages/desktop/scripts/fix-mac-signature.js`, wired via
`build.afterSign` in `package.json`) that re-signs the packaged `.app`
ad-hoc (`codesign --force --deep --sign -`) after `electron-builder` finishes
copying everything into place. Confirmed the verdict changes from the
corrupted-signature error above to the ordinary `rejected` — the ordinary
"this app is from an unidentified developer, right-click → Open to run it
anyway" state documented in README.md's "Code signing" section, not a hard
failure.

**Not fully verified end-to-end**: launching the rebuilt `.app` from this
environment still hits Gatekeeper's block, and the CLI escape hatch
(`spctl --add`) has been removed on this macOS version — overriding it
requires the actual GUI right-click → Open flow (or the System Settings →
Privacy & Security → "Open Anyway" button), which needs a human at the
keyboard. Whoever picks this up next should do that once, by hand, on a
freshly built `.app`, and confirm the launcher window actually appears and
the server actually starts — the `spctl` verdict alone only proves the
signature is no longer corrupted, not that the app runs.

### macOS handoff checklist

- Preserve all three fixes in `packages/desktop/src/main.js` /
  `package.json` / `scripts/fix-mac-signature.js`; do not fork the launcher
  logic by operating system.
- Build the client and generate Prisma before packaging:
  `npm run build --workspace packages/client` and
  `npx prisma generate --schema=packages/server/prisma/schema.prisma`.
- Build macOS with `npm run dist:mac --workspace packages/desktop`.
- Run `spctl --assess --verbose` on the built `.app` — it should say
  `rejected`, never the "code has no resources..." message. If that message
  comes back, the `afterSign` hook isn't running or isn't finding the app
  (check `context.packager.appInfo.productFilename` still matches the actual
  built folder name if `productName` ever changes).
- **Actually launch the built `.app`** (right-click → Open the first time)
  and confirm the launcher window appears — a clean `electron-builder` exit
  code does not mean the app opens; this is exactly how the signature bug
  above went unnoticed until someone actually tried.
- On a clean install, confirm the launcher reaches its running state and
  `GET /api/tournaments` returns an empty array with the admin-password header.
- For upgrade coverage, launch an older build first (or place a deliberately
  schema-less `courtside.db` in the app user-data folder), then launch the new
  build. Confirm a timestamped `courtside.legacy-*.db` backup exists and the
  new database serves `/api/tournaments` without Prisma `P2021`.
