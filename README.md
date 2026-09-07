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
across restarts — see docs/STREAMING_UPGRADE.md section 7.6. The broadcast link is
one stable address per court (found on that court's row in the admin
dashboard, not regenerated per match), and once a phone has granted camera
permission once, it starts and stops transmitting on its own as each match on
that court starts and finishes — see docs/STREAMING_UPGRADE.md section 9.4.
Internet viewers are served either by Cloudflare Stream, which takes one upload
from the phone and fans it out to any number of viewers, or — with no Cloudflare
account configured — by a direct peer-to-peer mesh capped at five viewers, since
each one costs the phone a separate upload. The public page also holds the score
back to match the video's own delay, so the scoreboard cannot spoil the rally you
are still watching. See
[docs/STREAMING_UPGRADE.md](docs/STREAMING_UPGRADE.md) for how all of that works and what it
needs; [docs/HANDOFF.md](docs/HANDOFF.md) is the "how it actually works and why" doc
for everything else, and [docs/architecture.html](docs/architecture.html) is a
visual tour of how every piece fits together.

The full design spec (architecture, scoring rules, screens, data model,
event contract) lives in the private working doc this project was
scaffolded from — see your Courtside Scoreboard artifact for the complete
reasoning behind every decision below.

## 🧪 About this branch — `streaming-clouflare-subscription-token`

**Status: complete and tested, but parked pending a cost decision. Not merged.**

### Why it exists

Internet video on `develop` is a WebRTC **mesh**: the court-side phone opens a
separate peer connection, with its own encoder output, for every viewer. That is
why viewers are capped at five. It is not a safety margin — a phone uplink is
5–15 Mbps, a viewer costs ~2.6 Mbps, and the sixth viewer does not merely fail,
it degrades the picture for the five already watching and for the LAN screens
sharing the same radio.

Serving dozens of viewers is a different shape of problem. The upload has to
happen **once**. This branch does that with Cloudflare Stream Live.

### What it adds

- **One upload, unlimited viewers.** The phone publishes a single stream over
  WHIP; Cloudflare fans it out over WHEP from its own edge. Latency stays under
  500 ms — better than the 5–15 s an HLS design would have cost.
- **The mesh is kept as the fallback**, not replaced. With no Cloudflare
  configured the app behaves exactly as it does on `develop`. That path needs no
  account and no billing, which is the case this app is built to survive.
- **The score now waits for the video.** The two arrive by unrelated routes and
  the score almost always wins, so the page used to spoil its own rallies — the
  point appeared before you saw it won. Score updates are held back by the
  video's own measured delay (from WebRTC jitter-buffer and RTT stats), but only
  while video is actually on screen.
- **A remote off-switch**, so the paid path can be turned off from a phone
  without touching the venue machine. See "Turning it off" below.

### What it costs

Two parts, and the first one is easy to miss:

|                                |                                                                      |
| ------------------------------ | -------------------------------------------------------------------- |
| Cloudflare Stream subscription | **$5/month**, unavoidable, and **never used** by this app            |
| Delivery                       | **$1 per 1,000 minutes** — ~$1.80 for a 1-hour match with 30 viewers |

Stream has no pay-per-use-only plan. Activating it forces you through a
"Configure storage" screen selling storage in $5 blocks of 1,000 minutes, and
that purchase is what switches the product on. **This app never writes a single
minute of it** — Cloudflare cannot record WebRTC broadcasts, and `recording.mode`
is set to `off` explicitly — so treat it as an activation fee and leave the
quantity at the minimum of 1.

So: a month with no matches still costs $5; a month with one busy tournament day
is about $19. **That is the open decision this branch is parked on.**

### Configuring it

Everything below is optional. Skip it entirely and the app runs exactly as it
does on `develop`, on the five-viewer mesh.

1. **Subscribe to Cloudflare Stream.** Same account as the existing TURN setup —
   no new account, no domain needed. Dashboard → Stream → check **Cloudflare
   Stream**, quantity **1**, Continue.
2. **Create an API token** with **Stream → Edit**. The existing
   `CLOUDFLARE_TURN_API_TOKEN` will _not_ work — it is scoped to TURN.
3. **Copy your Account ID** from the right-hand sidebar of any dashboard page.
   (This is not the TURN _Key ID_; they are different things.)
4. **Add both to `packages/server/.env`:**

   ```
   CLOUDFLARE_ACCOUNT_ID=<account id>
   CLOUDFLARE_STREAM_API_TOKEN=<Stream:Edit token>
   ```

   Both are required together — either alone leaves the feature off.

5. **Restart and verify:**

   ```bash
   curl -s http://localhost:3000/api/stream-input/<courtId>
   ```

   Expect `"configured":true` with a `publishUrl` and `playbackUrl` on
   `customer-<code>.cloudflarestream.com`. The first call for a court is slower —
   that is it creating the court's live input. Before configuring, the same call
   returns `{"configured":false,"enabled":true,...}`, which is the healthy
   "falling back to the mesh" answer, not an error.

### Running it end to end

```bash
npm install
npm run build --workspace packages/client
npm run start --workspace packages/server
```

Then, as with any broadcast on this app: open the court's broadcast link on a
phone (the QR code is on that court's row in the admin dashboard), press
**Start**, and open the public viewer link on another device.

The broadcast screen tells you which path it chose:

- **"🌐 Streaming to the internet"** — Cloudflare. No viewer count, because
  Cloudflare reports none for WebRTC.
- **"🌐 N internet viewers"** — the peer mesh. That number is a warning about
  the phone's uplink, not a vanity counter.
- **"🌐 Reconnecting to the internet…"** — the single upload dropped and is being
  re-published on a backoff.

Add `?debug=1` to the public viewer URL for an on-page connection log, which
reports whether delivery is `cloudflare` or `peer-to-peer`.

### Turning it off

The off-switch is one field in Firestore, edited by hand in the Firebase console:

```
config/streaming  ->  { cloudflareStreamEnabled: false }
```

The next broadcast started on any court uses the free mesh instead. It is
deliberately not in the admin dashboard: this is an operator decision about
billing, not a match-day setting.

- **Defaults to on.** Missing document, missing field, non-boolean value, no
  Firebase configured, or a failed/slow read all mean "enabled". Only an explicit
  `false` disables it — a Firestore hiccup must never silently drop every court
  to five viewers.
- **Takes effect on the next broadcast**, not mid-transmission.
- **Nothing is spent while off.** The flag is checked _before_ any Cloudflare
  call, so it cannot leave new live inputs being created on an account you have
  stopped paying for.
- **It controls usage, not billing.** The $5/month continues until you cancel
  the subscription in Cloudflare.

### What is verified, and what is not

Verified: 919 tests pass (90 new, 100% coverage on every new file), typecheck
clean, lint and formatting unchanged from the base branch. The endpoint was
smoke-tested against a live server, including the off-switch defaulting to
enabled against real Firestore with no flag document present.

**Not verified:** the configured Cloudflare path has never run against real
credentials, because Stream has no free tier. Everything up to "Cloudflare
accepts the credentials" is tested; the actual WHIP publish and WHEP playback
need a real subscription. **That is the first thing to do if this branch is
picked up.**

Full detail: [docs/STREAMING_UPGRADE.md](docs/STREAMING_UPGRADE.md) sections 6e
(Cloudflare Stream), 6f (score/video sync), 7.2c (setup) and 7.2d (the
off-switch).

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
`docs/HANDOFF.md`). `start` runs the server through `tsx` rather than a `tsc`
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

919 tests across the three packages (523 client / 254 server / 142
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
`subgrid`, which most smart TV browsers don't support (see `docs/HANDOFF.md`).

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
