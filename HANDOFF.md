# Courtside Scoreboard — Project Handoff

Working notes for picking this project up cold — architecture, what's been
built, how it's configured, and what's still open. The bulk of it was
written after a long session that took the project from "scaffolded,
unstyled, a few bugs" to "styled, hardened, packaged as a desktop app";
a later session added tournaments, fixed a dead button in the desktop
launcher, and reworked how the installers are built (see "Later session"
below). Read this before README.md — README is the polished setup doc;
this is the "how it actually works and why" doc.

## What this is

A LAN-based, real-time badminton match scoring system. An admin creates
matches from a dashboard; an umpire scores live from a phone; TV screens at
each court show the live score. Everything runs on one machine on the venue
Wi-Fi — no internet needed on match day.

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
            TV) plus two "join" screens (see Join codes below).
  desktop/  Electron wrapper that packages the whole thing as a
            double-click Mac/Windows app. See its own section.
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
ADMIN_PASSWORD=<real password>     # optional, falls back to 'change-me' (insecure — always set this)
DATABASE_URL="file:./dev.db"       # REQUIRED, no fallback — Prisma throws without it
CLIENT_DIST_PATH=<path>            # optional, defaults to ../client/dist relative to CWD
```

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

202 tests total across shared/server/client, 100% coverage on every
metric except one intentionally-uncovered, documented branch in
`AdminDashboard.tsx` (the not-yet-built "custom" scoring preset — see the
comment at its call site). The `packages/desktop` Electron app has **no
automated tests** — it was validated manually this session (dev mode +
actual packaged binaries + Playwright against the real running server),
not via a test suite. Adding some (at minimum, unit tests for the pure
path-resolution functions in `main.js`) would be a reasonable next step
if this app keeps evolving.

## Quick "where do I look for X" index

| Want to change...              | Look in                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Scoring rules / win conditions | `packages/shared/src/scoring.ts`                                             |
| Socket.io event names/payloads | `packages/shared/src/events.ts`                                              |
| Admin API routes               | `packages/server/src/routes/{courts,matches}.ts`                             |
| Live scoring socket handlers   | `packages/server/src/sockets/index.ts`                                       |
| Umpire/TV/Admin screens        | `packages/client/src/routes/*.tsx`                                           |
| App-wide styling/theme         | `packages/client/src/styles.css`                                             |
| Join-code entry flow           | `packages/client/src/routes/JoinScreen.tsx`                                  |
| Error overlay (pre-React)      | `packages/client/index.html`                                                 |
| Desktop app main process       | `packages/desktop/src/main.js`                                               |
| Desktop app packaging config   | `packages/desktop/package.json` (`"build"` block)                            |
| Desktop launcher window UI     | `packages/desktop/src/launcher.html` (plain HTML/JS, not the React app)      |
| Tournament API routes          | `packages/server/src/routes/tournaments.ts`                                  |
| Windows source zip helper      | `packages/desktop/scripts/pack-windows-source.js`                            |
| Desktop app icon               | `packages/desktop/build-assets/` (`icon-source.html` is the editable source) |
