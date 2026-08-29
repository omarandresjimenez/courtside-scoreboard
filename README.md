# Courtside Scoreboard

A LAN-based, real-time badminton match scoring system — an admin creates
matches, an umpire scores them from a phone or tablet, and TV screens at
each court display the live score. No internet connection is required on
match day; everything runs on one machine over a local Wi-Fi network.

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
cp packages/server/.env.example packages/server/.env   # set a real ADMIN_PASSWORD
npm run prisma:migrate --workspace packages/server      # creates the local SQLite file
npm run dev:server                                       # http://localhost:3000
npm run dev:client                                        # http://localhost:5173, in a second terminal
```

The client dev server proxies `/api` and `/socket.io` to the server, so
open the client URL and it talks to the server automatically.

## Running this for a real match

```bash
npm run build --workspace packages/client   # produces packages/client/dist
npm run start --workspace packages/server   # one process: API + Socket.io + the built UI
```

`createApp()` (`packages/server/src/app.ts`) serves `packages/client/dist`
as static files once it exists, with any unmatched GET falling back to
`index.html` — so a deep link like `/umpire/:matchId?token=...` still
resolves after a hard refresh. This means umpire and TV devices only ever
need one address: `http://<server's LAN IP>:3000`. `start` runs the
server through `tsx` rather than a `tsc` build, since `@courtside/shared`
is consumed as TypeScript source and `tsx` resolves that transparently at
both dev and run time — there's nothing extra to compile for the server
itself.

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

Each package enforces its own coverage floor in its `jest.config.cjs`
(`coverageThreshold`), ratcheted to what its suite actually achieves rather
than a round number:

- `shared` — 100% on every metric. The pure scoring engine (`scoring.ts`,
  `events.ts`, `types.ts`) has no untestable branches.
- `server` — 100% on every metric. Routes and Socket.io handlers are tested
  with `supertest` and a real `socket.io-client` against an ephemeral port;
  Prisma is swapped for an in-memory fake (`src/testUtils/fakePrisma.ts`)
  since `prisma generate` needs network access some environments block.
  `src/db/client.ts` and `src/index.ts` are excluded as bootstrap/wiring,
  not logic.
- `client` — 100% on statements/functions/lines, 98% on branches. React
  Testing Library covers every route screen and hook; the one open branch
  is a documented, currently-unreachable fallback in `AdminDashboard.tsx`
  for the not-yet-built "custom" scoring preset. `src/main.tsx` is excluded
  as bootstrap.

None of the above is gamed to hit a number: gaps are either genuinely
unreachable (and commented as such at the call site) or a real test was
added because the code path is real.

A pre-commit hook (Husky + lint-staged) runs lint and format automatically
on staged files.

## What's scaffolded vs. what's next

Working end-to-end: creating courts and matches from the admin dashboard
(optionally assigning a match to a court at creation), the umpire and TV
links surfaced right after creation (the umpire link only once — the server
never re-serves that token), the scoring engine (including undo,
configurable formats, and doubles serve rotation), and the umpire → server →
TV real-time score sync over Socket.io.

Stubbed for the next pass: reassigning an _existing_ match to a court after
the fact, `START_SET` (doubles first-server/court-position setup),
`RESUME_FROM_INTERVAL`, `RETIRE_MATCH`, and the admin `EDIT_*` /
`CANCEL_MATCH` / `ASSIGN_MATCH_TO_COURT` socket events — the event names and
payload shapes are already defined in `packages/shared/src/events.ts`, only
the handlers need writing in `packages/server/src/sockets/index.ts`.
