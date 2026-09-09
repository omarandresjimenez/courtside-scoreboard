# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Courtside Scoreboard: a LAN-based, real-time badminton match-scoring system.
An admin creates matches, an umpire scores them from a phone/tablet, and TV
screens per court display the live score — all over Socket.io on one local
machine, no internet required. Optional, additive features (degrade cleanly
with no config): a court-side phone can stream live video via WebRTC, and
scores/video can be mirrored to a public internet page via Firebase.

`docs/HANDOFF.md` is the authoritative "how it actually works and why" doc —
read it before touching non-trivial logic. `docs/STREAMING_UPGRADE.md` is the
equivalent for the streaming feature. `docs/architecture.html` is a visual
tour. Code comments frequently reference "Set 0X" (e.g. "Set 02 —
Architecture", "Set 06 — Data model") — these point into a private external
design-spec doc this project was scaffolded from; it isn't in this repo, so
treat those references as historical breadcrumbs, not something to chase down.

## Commands

```bash
npm install
npm run prisma:migrate --workspace packages/server   # create local SQLite file (first time only)

npm run dev:server   # http://localhost:3000
npm run dev:client   # http://localhost:5173 (proxies /api and /socket.io to the server)

npm run lint          # ESLint across every package
npm run format        # Prettier --write
npm run format:check  # Prettier --check
npm run typecheck     # tsc --noEmit across every package (the real type-safety gate)
npm test              # Jest --coverage in every package
npm run build         # builds every package that has a build script
```

Run a single package's checks with `--workspace`, e.g.
`npm run test --workspace packages/server`. To run one test file or test
name, `cd` into the package and use Jest directly:

```bash
cd packages/server && npx jest src/routes/matches.test.ts
cd packages/client && npx jest -t "renders the court diagram"
```

Each package enforces its own coverage floor via `coverageThreshold` in its
`jest.config.cjs`, ratcheted to what its suite actually achieves (not a round
number) — see the README's "Quality gates" section for the current numbers
and the documented, deliberately-unreachable branches behind each gap. Don't
"fix" a coverage shortfall by adding an istanbul-ignore or a fake test; if a
gap is real, either write the missing test or leave the documented comment
that explains why it can't be covered.

A Husky pre-commit hook runs lint-staged (ESLint --fix + Prettier) on staged
files automatically.

### Building for a real match / installers

```bash
npm run build --workspace packages/client   # -> packages/client/dist
npm run start --workspace packages/server   # tsx src/index.ts — one process: API + Socket.io + built UI
```

Desktop installers (`packages/desktop`, Electron) need three things built
first — see README "Desktop installers" for the full sequence:
`npm install`, `npm run build --workspace packages/client`,
`npx prisma generate --schema=packages/server/prisma/schema.prisma`. The
`dist:mac`/`dist:win` scripts then run `scripts/build-runtime-deps.js`, which
**replaces `packages/server/node_modules` with a production-only tree** —
run `npm install` again afterwards before running tests. Each installer must
be built on its target OS (`dist:win` refuses to run anywhere but Windows —
see `scripts/require-windows-build-host.js`).

## Architecture

Npm-workspaces monorepo, `packages/*`:

- **`shared`** — framework-free TypeScript: domain types (`types.ts`), the
  scoring/state-machine engine (`scoring.ts`), the Socket.io event contract
  (`events.ts`), CSV roster parsing (`csv.ts`), roster validation
  (`players.ts`). Both server and client depend on this so scoring logic
  lives in exactly one place. Consumed as TypeScript source directly (via
  `tsx` at runtime, `ts-jest` in tests) — never compiled to a separate `dist`
  that the other packages import.
- **`server`** — Node.js + Express + Socket.io + Prisma/SQLite (one embedded
  file, no external DB service). Single source of truth for every match.
- **`client`** — React + TypeScript + Vite, one app with role-scoped routes:
  `/admin`, `/umpire/:matchId`, `/tv/court/:courtId`,
  `/stream/court/:courtId` (camera broadcaster), `/stream/live/court/:courtId`
  (public viewer); `/umpire` and `/tv` with no id are join-code landing pages.
  See `packages/client/src/App.tsx`.
- **`desktop`** — Electron wrapper packaging server + built client into a
  double-click macOS/Windows app.

### Event-sourced scoring (the core invariant)

`ScoreEvent` rows in SQLite are an **append-only log** — the sole source of
truth (`packages/server/prisma/schema.prisma`). Every derived value (score,
set/match winner, serve position, interval flags) comes from replaying that
log through `deriveMatchState()` in `packages/shared/src/scoring.ts`. Server
and client both call this same pure function — **never maintain separate
score bookkeeping or mutate state directly**; add an event and re-derive.

- `UNDO_LAST_POINT` pops the event log rather than decrementing counters, so
  it correctly reopens a set that had already closed.
- Every event carries a client-generated `eventId`; replaying one twice must
  be a safe no-op (`createScoreEventIdempotent()` catches Prisma's P2002 on
  the unique `eventId` column) — this is what makes offline-queue replay
  safe. A regression here previously crashed the entire server process for
  every court, not just one match.
- Only `ADD_POINT`, `UNDO_LAST_POINT`, `RESUME_FROM_INTERVAL` are wired up in
  `packages/server/src/sockets/index.ts` today; `START_SET`, `RETIRE_MATCH`,
  and the `admin:*` events in `packages/shared/src/events.ts` are typed but
  their handlers are stubbed (see README "What's scaffolded vs. what's
  next").
- The event contract (`packages/shared/src/events.ts`) is the wire protocol
  between umpire, server, and TV — event names are typed constants, not raw
  strings, precisely so server and client can't drift out of sync at compile
  time. Extend it there first when adding a new socket event.

### Streaming (camera broadcast + public viewer) — additive, degrades cleanly

Two independent signaling paths, always one peer-to-peer WebRTC media path
(media never transits the app server):

- **LAN viewers**: Socket.io-relayed signaling
  (`packages/server/src/sockets/stream.ts`, `packages/client/src/lib/webrtc-stream.ts`).
  STUN-only ICE (`ice-config.ts`'s `LAN_ICE_SERVERS`). Connecting to the room
  *is* starting the stream; disconnecting *is* stopping it — there's no
  explicit start/stop socket event.
- **Internet viewers**: Firestore-document signaling
  (`packages/client/src/lib/firestore-signal.ts`, `public-viewer/index.html`),
  plus Cloudflare TURN credentials minted server-side
  (`GET /api/turn-credentials`, `packages/server/src/integrations/turn-credentials.ts`,
  24h TTL cached ~23h) since only the broadcaster needs relay credentials for
  ICE to succeed. Hard-capped around 5 concurrent internet viewers — it's a
  mesh, so each viewer costs the phone one more encode on its uplink.
- Camera capture needs a secure context, so the server runs a **second HTTPS
  listener** (`config.httpsPort`, default `PORT+1`) purely for this, backed
  by a persistent local CA rather than a fresh self-signed cert per boot
  (`packages/server/src/integrations/local-tls.ts`, keys under
  `~/.courtside-scoreboard/certs/`) — browsers validate the cert's SAN, and a
  QR-installed CA means a phone only ever sees the trust prompt once, across
  restarts. `GET /api/local-ca.pem` (plain HTTP, unauthenticated) serves the
  CA for that one-time install.
- `STREAM_EVENTS.MATCH_STARTED` / `MATCH_FINALIZED` (in `events.ts`) let a
  phone that already has camera permission start/stop transmitting on its
  own as the umpire starts/finalizes that court's match — no user gesture
  needed for a phone that granted permission before; one that never granted
  it does nothing, same as always.
- `STREAM_EVENTS.PAUSED` is a separate signal because pausing only flips
  `track.enabled` — the peer connection stays up and just sends black
  frames, indistinguishable to a viewer from a dark court without this flag.
- mDNS (`packages/server/src/integrations/mdns.ts`, `bonjour-service`)
  advertises `courtside.local` so links survive LAN IP changes; not
  universal (native support on iPhone/Android 13+ only, needs Bonjour on
  Windows) — set `MDNS_ENABLED=false` where multicast is blocked.

### Firebase — two unrelated concerns, both optional

Both require `FIREBASE_PROJECT_ID` / `FIREBASE_PRIVATE_KEY` /
`FIREBASE_CLIENT_EMAIL`; missing any of them logs a warning and disables
cloud features with the LAN app completely unaffected
(`packages/server/src/integrations/cloud-sync.ts`).

1. **Score mirroring** to the public viewer — `toPublicScoreboard()` is an
   explicit allow-list of fields (never a raw spread) so `umpireToken` /
   `umpireCode` can never leak onto a world-readable document.
2. **WebRTC signaling** for internet viewers (a separate, necessarily
   world-writable Firestore subtree) — unrelated to #1 beyond sharing a
   Firebase project.

`dotenv` needs the correct `cwd` to find `.env`; the desktop app explicitly
passes `cwd: serverRootPath()` for this reason.

### Known footguns

- **Never use CSS Grid `subgrid`** anywhere in the client — smart TV
  browsers silently collapse it to one column. Use identical explicit
  `grid-template-columns` per row instead (see `TvScreen.tsx`).
- Vite's `legacy()` plugin (`packages/client/vite.config.ts`) ships a second
  ES5 bundle behind `<script nomodule>` for old smart-TV browsers that choke
  on parsing (not just executing) modern syntax — explicit `ie 11` target
  forces Babel to actually down-level, and `terser` is forced as the
  minifier because Vite 8's default minifier re-introduces ES6+ syntax into
  that legacy chunk.
- `ADMIN_PASSWORD` defaults to `"change-me"` — fine for LAN-only use, but
  never tunnel this app to the public internet (ngrok/cloudflared/etc.)
  without changing it first; the admin dashboard and every mutating route
  sit behind that one password.
- Firestore `onSnapshot` listeners must be unsubscribed explicitly — closing
  an `RTCPeerConnection` does not detach them.
- Don't trust a reachable TURN host as proof it works — confirm an actual
  `relay`-type ICE candidate gets gathered (some free TURN services resolve
  but refuse to allocate).

## Code conventions

- TypeScript strict mode plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` (`tsconfig.base.json`) — handle the `undefined`
  these force into indexed access and optional properties; don't cast around
  them.
- ESM throughout (`"type": "module"`); relative imports use explicit `.js`
  extensions even in `.ts` source (NodeNext-style resolution) — Jest configs
  map that back to `.ts` via `moduleNameMapper`, don't remove it.
- Prettier: single quotes, semicolons, trailing commas, 100-char width
  (`.prettierrc.json`) — don't hand-format against it.
- No CSS Modules/Tailwind/styled-components — the client uses one
  hand-written `styles.css`.
- Comments in this codebase explain *why*, often at real length, including
  bugs a change fixed and alternatives already tried and rejected (see
  `jest.config.cjs` in each package for examples) — read the comment above a
  piece of logic before changing it, and preserve that context when you do.
