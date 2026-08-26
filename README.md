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
  client/   React + TypeScript + Vite. One app with three routes:
            /admin, /umpire/:matchId, and /tv/court/:courtId.
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
