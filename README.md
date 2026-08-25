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
open the client URL and it talks to the server automatically. For real
match-day use, `npm run build` both packages and serve the client's static
`dist/` from the server (see `packages/server/src/index.ts`) so umpire and
TV devices only need one address on the LAN.

## Quality gates

```bash
npm run lint         # ESLint across every package
npm run format:check # Prettier
npm run typecheck    # tsc --noEmit across every package
npm test             # vitest — currently covers the scoring engine
```

A pre-commit hook (Husky + lint-staged) runs lint and format automatically
on staged files.

## What's scaffolded vs. what's next

Working end-to-end: match creation, the scoring engine (including undo,
configurable formats, and doubles serve rotation), and the umpire → server →
TV real-time score sync over Socket.io.

Stubbed for the next pass: `START_SET` (doubles first-server/court-position
setup), `RESUME_FROM_INTERVAL`, `RETIRE_MATCH`, and the admin `EDIT_*` /
`CANCEL_MATCH` / `ASSIGN_MATCH_TO_COURT` events — the event names and
payload shapes are already defined in `packages/shared/src/events.ts`, only
the handlers need writing in `packages/server/src/sockets/index.ts`.
