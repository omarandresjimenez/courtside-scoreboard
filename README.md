# Courtside Scoreboard

A LAN-based, real-time badminton match scoring system — an admin creates
matches, an umpire scores them from a phone or tablet, and TV screens at
each court display the live score. No internet connection is required on
match day; everything runs on one machine over a local Wi-Fi network.

Optionally, a court-side phone can also **stream live video** to viewers, and
scores can be mirrored to a **public web page** anyone on the internet can open.
Both are additive: with no internet — or no Firebase credentials configured —
the app behaves exactly as described above. Camera capture needs a secure
connection, so the first phone to open the broadcast link sees a one-time
security-certificate prompt; installing it (a QR code and short instructions
are right on the admin dashboard) means that phone never sees it again, even
across restarts — see STREAMING_UPGRADE.md section 7.6. The broadcast link is
one stable address per court (found on that court's row in the admin
dashboard, not regenerated per match), and once a phone has granted camera
permission once, it starts and stops transmitting on its own as each match on
that court starts and finishes — see STREAMING_UPGRADE.md section 9.4. See
[STREAMING_UPGRADE.md](STREAMING_UPGRADE.md) for how that works and what it
needs; [HANDOFF.md](HANDOFF.md) is the "how it actually works and why" doc for
everything else.

The full design spec (architecture, scoring rules, screens, data model,
event contract) lives in the private working doc this project was
scaffolded from — see your Courtside Scoreboard artifact for the complete
reasoning behind every decision below.

## Structure

This is an npm-workspaces monorepo:

```
packages/
  shared/   Framework-free TypeScript: domain types, the scoring/state-
            machine engine, and the Socket.io event contract. Both the
            server and client depend on this so scoring logic only ever
            lives in one place.
  server/   Node.js + Express + Socket.io + Prisma/SQLite. The single
            source of truth for every match; SQLite is one embedded file,
            no external database service to run on-site.
  client/   React + TypeScript + Vite. One app with three role screens —
            /admin, /umpire/:matchId, /tv/court/:courtId — plus /umpire
            and /tv with no id, which take a short join code instead.
  desktop/  Electron wrapper that packages the server and the built
            client into a double-click macOS/Windows app. See
            "Desktop installers" below.
```

## Getting started

Requires Node 20+ (see `.nvmrc`).

```bash
npm install
cp packages/server/.env.example packages/server/.env   # ADMIN_PASSWORD optional, see below
npm run prisma:migrate --workspace packages/server      # creates the local SQLite file
npm run dev:server                                       # http://localhost:3000
npm run dev:client                                        # http://localhost:5173, in a second terminal
```

The client dev server proxies `/api` and `/socket.io` to the server, so
open the client URL and it talks to the server automatically.

`ADMIN_PASSWORD` defaults to `change-me` if you don't set one. This is a
LAN-only, single-admin tool — the admin dashboard never shows a password
prompt, it just picks the password up automatically (from the desktop
app, or from this default), so there's nothing to type or configure for
normal use.

## Running this for a real match

```bash
npm run build --workspace packages/client   # produces packages/client/dist
npm run start --workspace packages/server   # one process: API + Socket.io + the built UI
```

`createApp()` (`packages/server/src/app.ts`) serves `packages/client/dist`
as static files once it exists, with any unmatched GET falling back to
`index.html` — so a deep link like `/umpire/:matchId?token=...` still
resolves after a hard refresh. This means umpire and TV devices only ever
need one address — `http://courtside.local:3000` where the network
supports mDNS (the desktop launcher prefers this and probes it before
using it, falling back to `http://<server's LAN IP>:3000` otherwise; see
HANDOFF.md). `start` runs the server through `tsx` rather than a `tsc`
build, since `@courtside/shared` is consumed as TypeScript source and
`tsx` resolves that transparently at both dev and run time — there's
nothing extra to compile for the server itself.

A full step-by-step walkthrough for the network side (router, static IP,
firewall, generating each match's QR codes, and a pre-match checklist)
lives in the companion setup guide.

## Desktop installers

`packages/desktop` wraps the server and the built client into a
double-click Electron app, so a match-day admin never touches a terminal.
Build each installer **on its target operating system** — the packaged
server ships native runtime dependencies that must match the platform.

Three things have to exist before `electron-builder` runs, because the
packaging config copies all of them into the app as `extraResources`:

```bash
npm install
npm run build --workspace packages/client                 # -> packages/client/dist
npx prisma generate --schema=packages/server/prisma/schema.prisma  # -> packages/server/generated
```

`packages/server/generated/` is gitignored, so a fresh clone does **not**
have it and the build fails on the missing directory until you run
`prisma generate`. It emits a query engine per entry in the schema's
`binaryTargets`, which is why a Windows build needs that step too.

Then build:

```bash
npm run dist:mac --workspace packages/desktop # macOS, arm64 .dmg
npm run dist:win --workspace packages/desktop # Windows x64 .exe, run on Windows
```

Both `dist:*` scripts first regenerate `packages/desktop/resources/template.db`
(a pre-migrated empty SQLite file the app copies on first launch) and then
run `scripts/build-runtime-deps.js`, which **replaces
`packages/server/node_modules` with a production-only tree** so the
installer doesn't ship Jest, Prisma's CLI and TypeScript. That is a real
side effect on your working copy: run `npm install` afterwards to get the
dev tooling back before running tests or typechecks.

Output lands in `packages/desktop/release/` (gitignored).

### Building the Windows installer

`dist:win` refuses to run anywhere but Windows — see
`packages/desktop/scripts/require-windows-build-host.js`. A Windows
installer cross-built on macOS would package macOS-native dependencies and
crash when its embedded server starts.

To build it, copy the repository to a Windows machine (a zip of the source
tree, minus `node_modules` and `release/`, is enough — there is a helper at
`packages/desktop/scripts/pack-windows-source.js`), then, with Node 20+
installed:

```powershell
npm install
npm run build --workspace packages/client
npx prisma generate --schema=packages/server/prisma/schema.prisma
npm run dist:win --workspace packages/desktop
```

The installer appears at
`packages\desktop\release\Courtside Scoreboard Setup <version>.exe`.

### Code signing

Neither installer is signed. macOS Gatekeeper and Windows SmartScreen both
warn on first launch — on macOS, right-click the app and choose **Open**;
on Windows, choose **More info** then **Run anyway**. Removing those
warnings requires an Apple Developer ID and a Windows code-signing
certificate.

## Quality gates

```bash
npm run lint         # ESLint across every package
npm run format:check # Prettier
npm run typecheck    # tsc --noEmit across every package
npm test             # Jest --coverage in every package
```

829 tests across the three packages (467 client / 220 server / 142
shared). Each package enforces its own coverage floor in its
`jest.config.cjs` (`coverageThreshold`), ratcheted to what its suite
actually achieves rather than a round number:

- `shared` — 100% on statements/functions/lines, 98% on branches. The pure
  scoring, validation and CSV-parsing engines (`scoring.ts`, `events.ts`,
  `types.ts`, `players.ts`, `csv.ts`) have no untestable branches; the one
  open gap is a documented, pre-existing branch in `names.ts`.
- `server` — 100% on functions/lines, 99% on statements, 98% on branches.
  Routes and Socket.io handlers are tested with `supertest` and a real
  `socket.io-client` against an ephemeral port; Prisma is swapped for an
  in-memory fake (`src/testUtils/fakePrisma.ts`) since `prisma generate`
  needs network access some environments block — except
  `db/ensure-columns.test.ts`, which needs the _real_ SQLite upgrade
  behaviour (raw `ALTER TABLE`/`CREATE TABLE`) and runs against a
  throwaway on-disk database instead. `src/db/client.ts` and `src/index.ts`
  are excluded as bootstrap/wiring, not logic.
- `client` — 100% on statements/functions/lines, 98% on branches. React
  Testing Library covers every route screen, hook, and the roster-picking
  `PlayerAutocomplete` component; the open branches are a documented,
  currently-unreachable fallback in `AdminDashboard.tsx` for the
  not-yet-built "custom" scoring preset, plus a couple of pre-existing
  `onFocus`/link-copy handlers. `src/main.tsx` is excluded as bootstrap.

None of the above is gamed to hit a number: gaps are either genuinely
unreachable (and commented as such at the call site) or a real test was
added because the code path is real.

A pre-commit hook (Husky + lint-staged) runs lint and format automatically
on staged files.

## What's scaffolded vs. what's next

Working end-to-end: creating courts, umpires, and matches from the admin
dashboard (a match requires picking both a court and an umpire, each
blocked from double-booking while they're on a live match), optional team
name/country per side (auto-filled from a picked roster player's own
club/country, still editable), the umpire and TV links surfaced right after
creation (the umpire link only once — the server never re-serves that
token), the full scoring engine (undo, configurable formats, doubles serve
rotation and court-position setup, mid-game and between-games intervals
with a countdown the umpire can resume early, retirement with the retired
side labeled on every summary screen), and the umpire → server → TV
real-time score sync over Socket.io. The umpire screen is a visual court
diagram modeled on official umpire apps — see
`docs/umpire-screen-spec.md` for the reference behaviour it follows. The
TV screen scales to the actual display and is built without CSS Grid
`subgrid`, which most smart TV browsers don't support (see HANDOFF.md).

A tournament's player list can be imported from a CSV export (MemberID,
FirstName, LastName, Gender, Country, Club, BirthDate, Category, Status)
instead of typing names per match — see the "Import players" card on the
admin dashboard. Once imported, creating a match picks players from a
searchable dropdown (pre-filtered to whoever is registered for the
category selected above it) instead of free-typed names, and category
becomes a closed list of the codes the roster actually carries. A
validation service (`packages/shared/src/players.ts`) checks a proposed
line-up's gender, discipline (singles/doubles), and any age cap (e.g.
"U13") against the category being assigned, using whatever roster data is
actually present. A tournament with no imported roster falls back to the
original manual name-entry form untouched.

The admin dashboard is bilingual (English/Spanish) — see
`packages/client/src/i18n/`. It defaults to the browser's own language,
falling back to English, and a language picker in the dashboard's header
lets the admin override that, remembered for next time. Scoped to the admin
screen only; the TV, umpire, stream-viewer and public-viewer screens are
still English-only.

The admin dashboard also has its own light/dark theme toggle (defaulting
to dark) next to the language picker — see `packages/client/src/theme/`.
Same admin-only scoping: the choice is applied to `document.body` only
while the dashboard is mounted and removed on unmount, so it can never
leak into the TV, umpire, or any other screen opened afterwards in the
same tab.

Stubbed for the next pass: reassigning an _existing_ match to a court after
the fact, and the admin `EDIT_MATCH_DETAILS` / `EDIT_SCORING_CONFIG` /
`CANCEL_MATCH` / `ASSIGN_MATCH_TO_COURT` socket events — the event names
and payload shapes are already defined in `packages/shared/src/events.ts`,
only the handlers need writing in `packages/server/src/sockets/index.ts`.
