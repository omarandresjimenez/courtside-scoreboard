# Video Streaming & Internet Delivery

**Started:** 2026-09-03 · **Last updated:** 2026-09-04

**Status:**

- ✅ **WebRTC streaming** — replaces MJPEG. Verified phone → browser at 1280x720/30 FPS.
- ✅ **Public live scoreboard on the internet** — <https://courtside-scoreboard-86e96.web.app>
- ✅ **Live video to internet viewers** — WebRTC signalled over Firestore, score
  as an overlay bug on the video. STUN-only so far; TURN untested on cellular.

---

## Goal

Deliver smooth, low-latency video from a court-side phone to viewers, with a live
score overlay. The original MJPEG implementation managed ~2 FPS (one JPEG every
500 ms) — visibly jerky and not watchable as a match broadcast.

---

## 1. Architecture as built

### Pages

| Route                                                    | Who opens it                  | What it does                                 |
| -------------------------------------------------------- | ----------------------------- | -------------------------------------------- |
| `/stream/court/:courtId`                                 | court-side phone              | camera capture + Start/Pause/Stop. No score. |
| `/stream/live/court/:courtId`                            | LAN viewer                    | WebRTC video + live score overlay            |
| `https://courtside-scoreboard-86e96.web.app/?court=<id>` | **anyone, over the internet** | live video + score bug overlay               |

### Two independent paths

```
                    ┌── signalling (Socket.io) ──► desktop app ──┐
                    │                                  │ score   │
   phone (camera) ──┤                                  ▼         └─► LAN viewer
                    │                              Firestore          (video)
                    └── signalling (Firestore) ────────┼───────► internet viewer
                            media peer-to-peer ────────┘           (video + score)
```

Two signalling paths, one media path. The Socket.io path serves the venue and is
the only one that still works with no internet uplink; the Firestore path serves
everyone else. Score reaches the public page through Firestore independently of
either.

### Stack

| Layer               | Technology                                   | Where                                     | Notes                                                              |
| ------------------- | -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Media transport     | **WebRTC** (`RTCPeerConnection`), VP8        | browser-native                            | no library, no media server                                        |
| NAT traversal       | **STUN** — `stun.l.google.com:19302`         | `webrtc-stream.ts`, `firestore-signal.ts` | **no TURN yet** — see Gaps                                         |
| LAN signalling      | **Socket.io**                                | `server/src/sockets/stream.ts`            | rides the existing scoring socket server                           |
| Internet signalling | **Cloud Firestore**                          | `client/src/lib/firestore-signal.ts`      | offer/answer/ICE as documents                                      |
| Score sync          | **Firestore** (Admin SDK write, public read) | `server/src/integrations/cloud-sync.ts`   | one doc per court                                                  |
| Public page hosting | **Firebase Hosting**                         | `public-viewer/`                          | static, no build step                                              |
| Public page runtime | Firebase **JS SDK v12 via CDN**              | `public-viewer/index.html`                | plain ES modules, no bundler                                       |
| Camera capture      | `getUserMedia`                               | `client/src/lib/camera-stream.ts`         | needs a secure context → the HTTPS listener                        |
| Local TLS           | **`selfsigned`**                             | `server/src/index.ts`                     | second listener on `httpsPort` purely so phones can use the camera |

Deliberately _not_ used: any SFU/media server, any TURN provider, Cloud
Functions, and Cloud Storage. The only always-on infrastructure is Firebase
Hosting plus a Firestore collection.

---

## 2. Why WebRTC

| Option               | Latency        | Scale             | Verdict                                     |
| -------------------- | -------------- | ----------------- | ------------------------------------------- |
| MJPEG (what existed) | ~500 ms/frame  | poor              | ❌ ~2 FPS, unwatchable                      |
| **WebRTC**           | 50–200 ms      | mesh: 3–5 viewers | ✅ **chosen** — native, no deps, adaptive   |
| HLS                  | 6–30 s         | unlimited         | ❌ latency desynchronises the score overlay |
| DASH                 | similar to HLS | unlimited         | ❌ same problem                             |

WebRTC won on latency and on requiring no new infrastructure — signalling rides
the Socket.io server that already exists.

**The catch, understood from the start:** WebRTC's mesh means the phone encodes
and uploads _one independent stream per viewer_. Fine for a court. It does not
scale to an audience — see [Gaps](#9-gaps).

---

## 3. What shipped — WebRTC migration

**Created**

- `packages/server/src/sockets/stream.ts` — signalling. Landed as a Socket.io
  handler, **not** the HTTP route `routes/webrtc-signal.ts` originally sketched:
  signalling is inherently bidirectional, so reusing the existing socket server
  avoided standing up a second transport.
- `packages/client/src/lib/webrtc-stream.ts` — peer connections + signalling client.

**Modified**

- `packages/server/src/app.ts` — registers `registerStreamSocketHandlers(io)`
- `packages/shared/src/events.ts` — `STREAM_EVENTS` + payload types
- `StreamBroadcast.tsx` / `StreamViewer.tsx` — WebRTC instead of frame upload/polling
- `packages/client/src/lib/camera-stream.ts` — reduced to a `getUserMedia` wrapper

**Deleted** — `routes/video-stream.ts` and its tests (MJPEG, obsolete).

**Kept, contrary to the original plan** — `selfsigned`. Phones need a secure
context for `getUserMedia`, and the HTTPS listener in `index.ts` is what provides
it on a LAN address.

### Signalling events

Role and court are declared once in the socket handshake query
(`{ role: 'stream-broadcaster' | 'stream-viewer', courtId }`), and each court gets
a room (`stream:<courtId>`). Connecting _is_ starting; disconnecting _is_ stopping,
so there is no separate start/stop event.

```typescript
'stream:viewer_joined'    { peerId }   // server → broadcaster; also replayed for
                                       // viewers already waiting when it connects
'stream:viewer_left'      { peerId }
'stream:broadcaster_left'              // server → viewers

'stream:offer' / 'stream:answer' / 'stream:ice_candidate'
   // sent as { targetId, data }, delivered as { fromId, data }

'stream:paused'           { paused }   // see bug 3 below
```

---

## 4. Measured results

Real phone broadcasting to a Chrome viewer over the LAN:

| Metric          | Result                                             |
| --------------- | -------------------------------------------------- |
| Resolution      | **1280x720**                                       |
| Frame rate      | **30 FPS** (121 frames / 4 s) — vs ~2 FPS on MJPEG |
| Frames dropped  | 0                                                  |
| Throughput      | ~2.6 Mbps                                          |
| Round-trip time | 9–13 ms                                            |
| Codec           | VP8                                                |

Also verified: two simultaneous viewers each get their own peer connection,
pause/resume/stop propagate, and a viewer joining _during_ a pause is told.

---

## 5. Bugs found by actually running it

Four real defects, none of which unit tests would have caught. All fixed.

**1. The viewer silently dropped the stream if video arrived before the score.**
`onStream` assigned `videoRef.current.srcObject` imperatively, but the `<video>`
sat behind an early `return` waiting on match state. When the WebRTC track won
that race the ref was still `null`, the assignment no-opped, and nothing ever
re-attached it — permanently black video. The stream now lives in React state and
attaches from an effect, so neither ordering can lose.

**2. A court with no match yet showed no video at all** — just "Waiting for
match…" while the broadcaster transmitted happily. Video no longer waits on the
scoreboard; the overlay is omitted until there's a match to draw.

**3. Pause was invisible to viewers.** Pausing only flips `track.enabled`, which
keeps the connection up and sends _black frames_. Viewers kept decoding (80 frames
during a "pause") with no indication anything had happened. Added `stream:paused`,
held server-side per court so late joiners get it too.

**4. The viewer showed a black screen in a normal browser.** The `<video>` had
`autoPlay playsInline` but not `muted`. Browsers refuse to autoplay audible media
without a user gesture, and a viewer arriving by QR code has made none — so the
element sat at `paused: true` on a black first frame while a healthy 30 FPS stream
arrived behind it. `StreamBroadcast.tsx` already had `muted`; the viewer didn't.

> ⚠️ **How #4 was missed, and the lesson.** The first verification pass ran Chrome
> with `--autoplay-policy=no-user-gesture-required`, which suppresses exactly this
> failure. Everything measured perfectly and was reported as working. **Never
> verify playback with that flag** — it disables the policy real users are subject
> to. Removing it reproduced the black screen instantly:
>
> | Under default autoplay policy | Before | After     |
> | ----------------------------- | ------ | --------- |
> | `video.paused`                | `true` | `false`   |
> | Lit pixels (of 6400)          | **0**  | 6005–6149 |
>
> Fixed with `muted` plus a defensive `element.play().catch(...)`, since some
> smart-TV browsers ignore `autoPlay` when `srcObject` is assigned after mount.

### 5b. Bugs found during the later refactor (by test, not by hand)

A separate pass applied the `realtime-video-react` and `react-firebase-architecture`
skills, adding unit tests for code that had none. That coverage work surfaced three
more real defects — a different discovery method from section 5's manual browser
driving, worth calling out because each was **confirmed by running its new test
against the pre-fix code and watching it fail**, not just written and trusted:

**5. Firestore listener leak.** `broadcastToInternet` created two `onSnapshot`
subscriptions per viewer (its answer doc, its ICE candidates) and discarded both
unsubscribe functions. Closing the `RTCPeerConnection` does not detach a Firestore
listener, so every viewer that came and went left two live listeners billing reads
for the rest of the broadcast. Fixed by collecting each viewer's teardown callbacks
in a `PeerSession` and releasing them together on disconnect, timeout, or `stop()`.

**6. A reconnecting broadcaster killed its own live stream.** The server's
broadcaster `disconnect` handler fired `STREAM_EVENTS.BROADCASTER_LEFT`
unconditionally. A phone that drops wifi and reconnects leaves two broadcaster
sockets briefly alive on the same court; when the _stale_ one finally timed out,
its disconnect handler told every viewer the stream had ended — tearing down
connections to the broadcaster that was still live. Fixed by checking
`broadcasterByCourtId.get(courtId) === socket.id` before announcing the stream
over, so only the current broadcaster's departure counts.

**7. A pause would have fired its viewer notice twice (caught before shipping).**
An early draft of the pause toggle computed the next state and called
`broadcaster.setVideoEnabled(...)` inside a `setStatus` updater function. React
StrictMode (already enabled in `main.tsx`) invokes updaters twice, which would have
emitted the pause signal to every viewer twice per press. Moved the side effect
out of the updater before it ever reached a commit.

**The internet-only viewer pause gap.** Not a bug in shipped code so much as an
incomplete feature: `stream:paused` only ever travelled over Socket.io, so an
internet viewer watching via Firestore signalling saw a frozen black frame with
no explanation when the court paused — indistinguishable from their own
connection breaking. Closed by adding `paused` to the `streams/{courtId}`
Firestore document (`InternetBroadcastHandle.setPaused`), read by both
`StreamViewer.tsx` and the public viewer, each showing an explicit _"Camera
paused — nothing is wrong with your connection"_ card rather than the old bare
badge. See section 6c.

---

## 6. ✅ Internet delivery, Stage 1 — public live scoreboard

**Live: <https://courtside-scoreboard-86e96.web.app/?court=&lt;courtId&gt;>**

### The constraint that shaped this

**Firebase cannot relay live video.** Not a config gap — no Firebase product
forwards a media stream:

| Product               | Purpose                          | Live video?                 |
| --------------------- | -------------------------------- | --------------------------- |
| Hosting               | static files + free HTTPS domain | ❌                          |
| Firestore / RTDB      | JSON sync                        | ❌ — but ideal for score    |
| Cloud Storage         | file blobs                       | ❌                          |
| Functions / Cloud Run | short-lived handlers             | ❌ no long-lived media path |

So the job splits three ways, and Firebase genuinely solves two: the public URL
and the live score. Video needs its own answer.

### What shipped

- `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`
- `public-viewer/` — dependency-free page (Firebase CDN only) that live-renders
  `matches/{courtId}` via `onSnapshot`. Uses explicit per-row
  `grid-template-columns`, **not** subgrid, for the same smart-TV reason as the
  TV screen.
- `toPublicScoreboard()` in `cloud-sync.ts` + the sync hook at
  `packages/server/src/sockets/index.ts:251`
- A registered web app; its config lives in `public-viewer/firebase-config.js`
  (public by design — access is governed by rules, not by those values)

### Where the public link is surfaced

The admin dashboard shows it per court, on its own row beneath the TV link,
tinted and labelled **🌐 Public score** (`publicScoreLinkFor()` in
`AdminDashboard.tsx`). Kept visually distinct on purpose: every other link on
that screen points back at the LAN server, and this is the only one that leaves
the venue — mixing it in unlabelled invites handing someone a `192.168.x` address
that will never work from home, or this one to the TV.

`PUBLIC_SCOREBOARD_ORIGIN` in `AdminDashboard.tsx` must match the project in
`.firebaserc` if the site is ever redeployed elsewhere.

Both copy buttons carry distinct `aria-label`s ("Copy TV link for X" / "Copy
public internet link for X") — two buttons both reading as just "Copy" were
indistinguishable by voice.

### The sync hook

`syncScoreToCloud()` already existed in `cloud-sync.ts` and had **never been
called**. It's now invoked from the single choke point every score change passes
through — after the LAN broadcast, and fire-and-forget:

> The local network is the source of truth on match day. A slow or unreachable
> internet connection must never delay a point reaching the umpire's screen, nor
> throw into the scoring path. A failed sync is logged and ignored; the next point
> re-sends full state, so a dropped update self-heals without a retry queue.

### 🔒 Security: the allow-list

`Match` carries **`umpireToken`** — the secret authorising scoring — and
`umpireCode`. The `matches/{courtId}` documents are world-readable by design, so
the obvious implementation (`{...matchData}`) would have **published the umpire's
write credentials to the internet**, letting any viewer score the match.

`toPublicScoreboard()` is therefore an explicit **allow-list**, not a delete-list:
a field added to `Match` later must be opted _in_, and cannot leak by being
forgotten.

Verified from a genuinely unauthenticated client (not the Admin SDK, which
bypasses rules):

| Check                              | Result                          |
| ---------------------------------- | ------------------------------- |
| Public read of score               | ✅ allowed                      |
| Umpire credentials readable        | ✅ **none present**             |
| Public **write** (score tampering) | ✅ denied (`permission-denied`) |
| Any other collection               | ✅ denied                       |

Rules: public read on `matches/{courtId}`, **writes denied to everyone**. The
server writes via the Admin SDK, which bypasses rules — so closing client writes
costs the app nothing.

### Verified end-to-end

Scored through the real umpire socket on `localhost` while watching the deployed
page in a browser:

```
[before match]     Waiting for a match on this court…
[after start set]  Center Court 2 — Juan [serving], Carlos   0-0
[point 1 -> A]     1-0   Juan [serving]
[point 2 -> A]     2-0   Juan [serving]
[point 3 -> B]     2-1   Carlos [serving]    <- serve indicator follows play
[point 4 -> A]     3-1   Juan [serving]
page errors: none
```

---

## 6b. ✅ Internet delivery, Stage 2 — live video on the public page

Video now reaches internet viewers, signalled through Firestore instead of the
venue's Socket.io server (which is on a private LAN address no outside viewer
can reach). Media still flows peer-to-peer, phone → viewer.

Verified: LAN broadcaster → public URL, real video (all 6400 sampled pixels
lit), ramping to 1280x720, on **STUN only — no TURN needed** on this network.

- `packages/client/src/lib/firestore-signal.ts` — broadcaster side
- `public-viewer/index.html` — viewer side, `muted` + explicit `play()` from
  the outset (the same autoplay trap bug 4 documents)
- Runs **alongside** the Socket.io path, not instead of it, and inside a
  try/catch: the LAN path is the only one that survives a venue with no uplink,
  and a Firebase failure must not take local streaming down with it.

### The score bug

The score sits over the video's top-left corner as a translucent panel
(`rgba(10,14,26,0.62)`, blurred) rather than a table below it — 1.6% of the
stage on desktop, so the picture keeps the screen. Measured on desktop, phone
portrait and phone landscape; no horizontal scroll in any of them.

### 🐛 Stale viewers were silently blocking real ones

Found by inspecting Firestore after a viewer inexplicably failed to connect:
**ten abandoned viewer documents, the oldest over three hours old**, occupying
every one of the `MAX_INTERNET_VIEWERS` slots. The broadcaster was dutifully
dialling peers that no longer existed and refusing everyone real.

The cause is that a viewer document is only deleted on `pagehide`, which does
not fire on a crash, a force-quit, a phone evicting a background tab, or a
network drop. In other words the leak is the normal case, not the edge case.

Three defences, all now in `firestore-signal.ts`:

| Guard                          | What it does                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Start-up purge                 | anything already in `viewers/` predates this broadcast, so it is deleted before listening |
| `VIEWER_REQUEST_TTL_MS` (60 s) | an unanswered request older than this is treated as abandoned, not given a slot           |
| `CONNECT_TIMEOUT_MS` (30 s)    | a peer that never reaches `connected` is dropped and its slot freed                       |

Proved by planting six corpses (more than the cap of five) and confirming both
a desktop and a phone viewer still connected, with all six purged.

---

## 6c. Full screen, home-screen install & screen wake lock

Phones are the primary device for two of these screens — the court-side
broadcaster and the LAN/internet viewer — so their chrome (URL bar, tab strip)
and their tendency to sleep mid-match are real usability problems, not
cosmetic ones.

### Full screen: `useFullscreen`

`packages/client/src/lib/useFullscreen.ts`. The one platform-specific trap:
**iPhone Safari has no `Element.requestFullscreen()` at all** — only
`HTMLVideoElement.webkitEnterFullscreen()`. The hook detects support by
probing both `document.fullscreenEnabled` and that video method, and falls
back to fullscreening just the `<video>` when the container itself cannot go
fullscreen. On that fallback path the page never actually enters fullscreen
(iOS draws its own chrome for it), so `isFullscreen` correctly stays `false`
and no `fullscreenchange` fires. `FullscreenButton.tsx` renders nothing at
all where neither route exists, rather than offering a control that silently
does nothing when tapped.

Wired into `StreamViewer.tsx` (fullscreens the video container) and
`StreamBroadcast.tsx` (fullscreens the whole panel, so Pause/Stop stay
reachable) and the public viewer (plain JS, same fallback logic inlined).

### Add to Home Screen (true chrome-less UI on iPhone)

Full-screen video is not the same as hiding the address bar around a control
panel — iPhone Safari has no API for that at all. The only route is
installing the page: `manifest.webmanifest` + `apple-mobile-web-app-*` meta
tags on both `packages/client/index.html` and `public-viewer/index.html`,
with 192px/512px icons generated from the desktop app's existing 1024px icon.

**This only fully works on the Firebase-hosted public viewer.** The LAN pages
are served over the desktop app's self-signed HTTPS cert, and Chrome on
Android refuses to offer a PWA install over an untrusted certificate — so on
Android, the LAN broadcaster/viewer get the fullscreen button only, while
Add to Home Screen is iPhone-only there. The public viewer, with a real
certificate, gets both routes on both platforms.

`viewport-fit=cover` plus `env(safe-area-inset-*)` padding in `styles.css`
and the public viewer's inline CSS keep content clear of the notch and home
indicator once installed with `apple-mobile-web-app-status-bar-style:
black-translucent` — without the insets, the score overlay and the
fullscreen button render underneath both.

### Screen wake lock

`useWakeLock.ts` holds `navigator.wakeLock.request('screen')` while a flag is
true — on the broadcaster while `status` is `live` or `paused`, on the viewer
only while a stream is actually playing. Exists because a sleeping phone
suspends camera capture, which kills the broadcast in a way that looks from
outside exactly like a crash.

Two things worth knowing before debugging a "sleep" report:

- The browser **silently drops the lock whenever the tab is backgrounded**
  and does not restore it on return — the hook re-acquires it on
  `visibilitychange`, but a wake lock alone will not survive a phone call or
  a swipe to another app for long stretches.
- The API **needs a secure context**. It works on the HTTPS broadcaster page
  (port 3001) and the public viewer, but silently no-ops (with a console
  warning, not a thrown error) on the plain-HTTP LAN viewer (port 3000).

### Camera-paused message on every screen, not just the LAN one

`stream:paused` (Socket.io) already reached the LAN viewer, which showed a
small badge. The Firestore path (`streams/{courtId}.paused`, set via
`InternetBroadcastHandle.setPaused`) now carries the same fact to internet
viewers, and both screens — plus the public viewer — show an explicit card:
**"Camera paused — nothing is wrong with your connection."** Before this, an
internet viewer watching a paused camera saw a frozen black frame
indistinguishable from their own connection breaking. See bug note in 5b.

---

## 6d. TURN relay & on-page connection diagnostics

### The failure this solves

Internet viewers on two different networks both reported _"Could not reach the
camera"_. That string is only reachable from `connectionState === 'failed'`,
which is diagnostic in itself: signalling had already succeeded (an offer was
received and answered) and **ICE** was what failed. STUN reports a peer its own
public address but cannot forward packets, so when either side is behind
symmetric NAT or carrier CGNAT — normal on mobile data — there is simply no
direct path. A relay is the only fix.

### ⚠️ The free public TURN servers are dead — verify before trusting one

The obvious fix, OpenRelay's shared `openrelayproject` credentials, **does not
work**. The host resolves and accepts TCP, but the allocation is refused:

```
turn:openrelay.metered.ca:80?transport=udp  -> code=400 TURN allocate error
turn:openrelay.metered.ca:443?transport=udp -> code=400 TURN allocate error
relay candidates gathered: 0
```

Measured by driving headless Chrome through a real ICE gather. STUN worked in
the same run (`srflx: 1`), so the probe was sound. Configuring those credentials
would have _looked_ like a fix and changed nothing — worth repeating for any
future relay: **confirm a `relay` candidate is actually gathered**, never assume
a reachable host means a working relay.

### What shipped: Cloudflare Realtime TURN, minted server-side

| Piece                                      | File                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| Mints + caches credentials from Cloudflare | `packages/server/src/integrations/turn-credentials.ts`                           |
| Serves them to the broadcaster             | `packages/server/src/routes/turn.ts` (`GET /api/turn-credentials`)               |
| Fetches before broadcasting                | `packages/client/src/lib/turn-credentials.ts`                                    |
| Static STUN, split by topology             | `packages/client/src/lib/ice-config.ts` (+ `public-viewer/ice-config.js` mirror) |

**The TURN key never reaches a browser.** It is a long-term secret that mints
unlimited credentials, so the server holds it and hands out only short-lived
(24h TTL) username/credential pairs. Credentials are cached for 23h — a 1h
refresh margin, so a match never starts with a pair about to lapse.

**Only the broadcaster gets a relay.** In ICE, one side offering a relay
candidate is enough for the other to connect through it, so no credential ever
goes near the static public viewer page. See 9.1 for the one case this does not
cover.

**Everything degrades to today's behaviour.** No credentials, or Cloudflare
unreachable, and `getTurnIceServers()` returns `[]`, the endpoint answers
`{"iceServers":[],"configured":false}`, and the client falls back to STUN. A
missing relay must never stop a broadcast from starting.

Verified end of the chain: the endpoint mints 2 entries (a STUN pair and a TURN
entry with 6 URLs spanning UDP/TCP/TLS on ports 3478, 53, 80, 443), and a real
Chrome ICE gather against them produced **8 relay candidates**. Notably every
**UDP** path failed on the test network (`701 host lookup`) while the TCP/TLS
ones succeeded — exactly what Cloudflare's port-443/80/53 variants exist for,
and something OpenRelay had no answer to.

`ice-config.ts` deliberately splits the two topologies: `LAN_ICE_SERVERS` is
STUN-only (that path must survive a venue with **no uplink**, where listing an
unreachable relay only delays gathering), `INTERNET_ICE_SERVERS` is the one the
relay is appended to.

### On-page connection diagnostics

The public viewer runs on devices nobody can attach a debugger to — someone
else's phone, on someone else's network, which is exactly where WebRTC breaks.
So the log is **on the page**, not in a console:

```
https://courtside-scoreboard-86e96.web.app/?court=<courtId>&debug=1
```

It reveals itself automatically on failure even without `?debug=1`, and has a
Copy button so a log can be pasted out of a phone. It records the environment
(including wifi vs cellular via `navigator.connection`), whether Firestore
reads and signalling writes were permitted, every handshake step, ICE candidate
types gathered by kind, per-server ICE errors with their codes, and the winning
candidate pair — including whether a **relay** carried it, which is the only way
to confirm TURN is doing anything rather than merely being configured.

### Score bug stays visible in full screen

The score overlay is a child of `.stage`, so element full screen always kept it.
iPhone Safari was the exception: it has no `Element.requestFullscreen()`, and
the old fallback called `video.webkitEnterFullscreen()` — which hands the page
to the native iOS player and shows the video **alone**, dropping every overlay
including the score.

That fallback is gone. Where element full screen is unavailable the stage now
fills the viewport manually (`position: fixed; inset: 0`, `100dvh` — `vh` on
mobile Safari counts the area behind the browser chrome and pushes the bottom of
the video off-screen). Overlays survive on every platform; the score bug also
scales up and honours the safe-area insets, since a full screen is read from
further away. On iPhone this cannot hide Safari's own chrome — Add to Home
Screen (section 6c) is what does that.

---

## 7. Configuration required

Everything needed to stand this up on a fresh machine or a new Firebase project.

### 7.1 Server environment — `packages/server/.env`

Gitignored and untracked; never commit it. Added for streaming/cloud sync on top
of the existing `PORT` / `ADMIN_PASSWORD` / `DATABASE_URL` (see HANDOFF.md's
configuration reference):

```
HTTPS_PORT=3001                    # optional, defaults to PORT + 1

FIREBASE_PROJECT_ID=<id>           # REQUIRED for cloud sync
FIREBASE_PRIVATE_KEY="<pem>"       # REQUIRED — keep the \n escapes; unescaped at runtime
FIREBASE_CLIENT_EMAIL=<email>      # REQUIRED — cert() needs all three
FIREBASE_PRIVATE_KEY_ID=<id>       # optional, unused by cert()
FIREBASE_CLIENT_ID=<id>            # optional, unused by cert()

CLOUDFLARE_TURN_KEY_ID=<id>        # optional — enables the TURN relay
CLOUDFLARE_TURN_API_TOKEN=<token>  # optional — both required together
```

Without the `CLOUDFLARE_TURN_*` pair the app behaves exactly as it did before
the relay existed: STUN only, which works whenever at least one side has a cone
NAT. With it, viewers behind symmetric NAT and carrier CGNAT can connect too.

All three `FIREBASE_*` required values come from a **service account JSON**
(Firebase console → Project settings → Service accounts → Generate new private
key). Without them the server logs
`[Cloud] Firebase credentials not found - cloud sync disabled` and runs
normally — cloud sync is optional, and the app is fully functional on the LAN
without it.

> ⚠️ `dotenv` resolves `.env` from `process.cwd()`. The desktop app therefore
> passes `cwd: serverRootPath()` when spawning the server (`main.js`). Anything
> else that launches the server must run it from `packages/server` or pass the
> variables explicitly.

### 7.2 Firebase project — one-time setup

Four steps, and **they fail differently**, which cost real time to untangle:

1. **Create the project** (or reuse one).
2. **Enable the Firestore API** — otherwise every write returns
   `7 PERMISSION_DENIED … SERVICE_DISABLED`.
3. **Create the Firestore database** — separate from step 2. Without it writes
   return a bare `5 NOT_FOUND`. **The region is permanent.** Start in
   _production mode_; the rules below replace the defaults.
4. **Register a Web App** → `firebase apps:create web "<name>"`, then copy its
   SDK config into **both**:
   - `public-viewer/firebase-config.js`
   - `packages/client/src/lib/firebase-config.ts`

   These values are public by design (they identify the project, they authorise
   nothing); access is governed entirely by `firestore.rules`.

### 7.2b Cloudflare TURN — one-time setup

Needed only for internet viewers on restricted networks (see 6d). LAN streaming
never touches it.

1. Sign up at <https://dash.cloudflare.com/sign-up>. **No domain required** —
   skip the "add a site" onboarding entirely.
2. Dashboard → **Realtime** (called _Calls_ until recently) → **TURN** →
   **Create TURN key**.
3. Put the two values in `packages/server/.env` as `CLOUDFLARE_TURN_KEY_ID` and
   `CLOUDFLARE_TURN_API_TOKEN`, then restart the desktop app.
4. Confirm: `curl -s http://localhost:3000/api/turn-credentials` should report
   `"configured":true` with `turn:turn.cloudflare.com` URLs.

**Pricing:** 1,000 GB/month free, shared across TURN and SFU, then $0.05/GB;
only egress is billed. At ~2.6 Mbps a relayed viewer costs roughly **1.2
GB/hour**, so a 4-hour tournament with 3 relayed viewers is ~14 GB — comfortably
inside the free tier. Note that only viewers who _need_ a relay consume it;
anyone who can connect directly costs nothing.

The API token is a long-term secret that mints unlimited credentials. It lives
in `.env` (gitignored), never in a client bundle, and is never written to a log
— including when Cloudflare echoes the request back in an error body, which
there is a regression test for.

### 7.3 Repo-level Firebase config

| File                     | Purpose                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `.firebaserc`            | pins the default project — change when deploying elsewhere                                                        |
| `firebase.json`          | Hosting (serves `public-viewer/`) + Firestore rules/indexes                                                       |
| `firestore.rules`        | public read on `matches/{courtId}`, **all client writes denied**; open `streams/{courtId}` subtree for signalling |
| `firestore.indexes.json` | empty; no composite indexes needed                                                                                |

Also update `PUBLIC_SCOREBOARD_ORIGIN` in `AdminDashboard.tsx` if the Hosting
site changes — that constant is what the admin dashboard hands out as the public
link, and nothing derives it automatically.

### 7.4 Deploying

```bash
npx firebase-tools login                      # once, interactive
npx firebase-tools deploy --only hosting      # the public viewer page
npx firebase-tools deploy --only firestore:rules
```

The public page is plain static files — **no build step**, so a Hosting deploy
is independent of `npm run build`. The React client _does_ need
`npm run build --workspace packages/client` for the admin/TV/umpire screens.

### 7.5 Network requirements on match day

| Need                                                    | Why                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Phone reaches the laptop's **HTTPS** listener (`:3001`) | `getUserMedia` requires a secure context; the self-signed cert warning must be accepted once |
| Laptop has internet                                     | to push scores to Firestore                                                                  |
| Phone has internet                                      | to signal to internet viewers via Firestore                                                  |
| —                                                       | Internet viewers need **no** access to the venue network at all                              |

If the venue has no uplink, everything still works on the LAN; only the public
page goes stale.

---

## 8. Considerations & gotchas

Operational landmines hit during this work. Each cost real time.

**`firebase-admin` v14 broke the old init style.** `cloud-sync.ts` used
`import admin from 'firebase-admin'` then `admin.credential.cert(...)`, which
throws `Cannot read properties of undefined (reading 'cert')` under ESM — the
default export carries no `.credential`. Every credential was correct and cloud
sync was _still_ silently disabled. Now uses `firebase-admin/app` and
`firebase-admin/firestore`. Its guard also didn't check `FIREBASE_CLIENT_EMAIL`,
which `cert()` requires.

**Firestore setup is two separate steps that fail differently.** Enabling the API
gives `7 PERMISSION_DENIED / SERVICE_DISABLED`; the database not existing gives a
bare `5 NOT_FOUND`. Enabling the API is _not_ enough. The database **region is
permanent**.

**Firestore rejects document IDs matching `__*__`** as reserved. Irrelevant for
real court cuids, but it will bite a hand-written probe.

**✅ Fixed — the desktop app could not read `.env`.** `config.ts` does
`import 'dotenv/config'`, which reads from `process.cwd()`, and `main.js` spawned
the server child **without setting `cwd`** — so it inherited `packages/desktop`
(or `/` when packaged) and never found `packages/server/.env`. Firebase
credentials worked under `tsx` from `packages/server` and were silently invisible
to the real app, which would have left the new public link showing "waiting for a
match" forever. `main.js` now passes `cwd: serverRootPath()`. Verified by
replicating the exact spawn (Electron's own node + `ELECTRON_RUN_AS_NODE=1` +
that cwd), which prints `[Cloud] Firebase initialized`.

**`ELECTRON_RUN_AS_NODE=1` leaking into the shell breaks `npm start`.** It makes
Electron run as plain Node, so `require('electron')` returns a path string and
every binding (`app`, `ipcMain`, …) is `undefined` — surfacing as
`Cannot read properties of undefined (reading 'handle')`. Launch with
`env -u ELECTRON_RUN_AS_NODE npx electron .`. The app itself is correct: it sets
that flag deliberately, but only for the _child_ server process.

**Socket events race the authorisation that gates them.** `handleUmpireConnection`
sets `socket.data.authorizedMatchId` only _after_ an async DB lookup, so an event
emitted immediately on `connect` is correctly rejected. Not an app bug — the real
client waits for state — but any test harness must wait, and must listen for
`server:error` or the rejection is silent.

**✅ Fixed — dead code removed.** `uploadFrameToCloud()` and `updateFrameUrl()`
in `cloud-sync.ts` had no callers — they took a `jpegBuffer` and belonged to the
MJPEG design WebRTC replaced — and dragged in the `cloudinary` dependency for
nothing. Both functions and the dependency are gone.

**Admin password is still the default.** `packages/desktop/src/main.js` sets
`ADMIN_PASSWORD = 'change-me'`. Harmless on a trusted LAN; **must change before
any public exposure**.

**Building the server pollutes its own test run.** `npm run build` compiles
`packages/server/src/**/*.test.ts` into `dist/` alongside the compiled source.
Jest had no ignore pattern for that directory, so it discovered the compiled
copies too and ran every server suite twice — the duplicates failing on module
resolution paths that only exist post-build. The failure only appears **after a
build**, so a `test`-then-`build` order looked fine and `build`-then-`test`
produced a wall of unrelated-looking red. Fixed with
`testPathIgnorePatterns: ['/node_modules/', '/dist/']` in
`packages/server/jest.config.cjs`.

---

## 9. Gaps

Ordered by how likely each is to bite during a real tournament.

### 9.1 ⚠️ Partly closed: viewers on restricted networks

This gap predicted the failure that then happened for real: internet viewers on
both a phone and a second laptop reported _"Could not reach the camera"_. That
message comes only from `connectionState === 'failed'`, which means signalling
**succeeded** — an offer arrived and was answered — and ICE itself found no
path. Textbook missing-relay.

A Cloudflare TURN relay is now wired in (section 6d) and **verified to gather
relay candidates**. What is _not_ yet confirmed is an end-to-end viewer session
over mobile data; that still needs a real phone on cellular to sign off.

One thing that remains open even with the relay configured: **the relay is on
the broadcaster only.** In ICE that is normally enough — a viewer simply
connects to the broadcaster's relayed address. But a relayed transport address
is always **UDP**, so a viewer on a network that blocks outbound UDP entirely
still cannot reach it. If that turns up, the fix is giving the viewer its own
relay by publishing short-lived credentials into the `streams/{courtId}`
document it already reads — deliberately not done pre-emptively, because that
puts credentials in a world-readable document (see 9.3).

### 9.2 Hard ceiling of ~5 internet viewers

WebRTC mesh: the phone encodes and uploads a _separate_ stream per viewer, so its
uplink — not the server — is the bottleneck. `MAX_INTERNET_VIEWERS = 5` makes the
ceiling explicit rather than letting the picture quietly degrade for everyone.

Beyond a handful of viewers this needs an **SFU** (LiveKit Cloud, Daily,
Cloudflare Calls): the phone publishes once, the server fans out. That is a
different broadcaster implementation, not a config change.

### 9.3 Signalling documents are world-writable

`streams/{courtId}` must accept unauthenticated writes, because a viewer has to
put its SDP answer somewhere the phone can read it and there are no user accounts.
Mitigated by: cuid court ids (not guessable), the viewer cap, and the fact that
the subtree holds only SDP/ICE blobs. **Scores remain read-only — nobody can
alter a match.** Hardening path: Firebase Anonymous Auth plus
`request.auth.uid == viewerId`.

### 9.4 The broadcast does not resume by itself

If the desktop app restarts (or the server drops), the phone's Socket.io
connection goes with it and **the broadcast does not restart** — someone must
re-open the page and press Start. Observed for real during this work. Every
viewer correctly shows "Waiting for the court to start streaming…", which is
accurate but easy to misread as a bug.

### 9.5 `ADMIN_PASSWORD` still defaults to `change-me`

Harmless while everything is LAN-only and the public surface is read-only, but it
must change before the app is ever exposed directly.

### 9.6 Smaller ones

- **No cleanup of `matches/{courtId}`** — documents persist in Firestore after a
  tournament ends.
- **Public page shows one court** — no index or multi-court view.

**Fixed since this list was written:**

- ~~No automated tests for the streaming/signalling paths~~ — closed by the
  skill-driven refactor: client coverage 68.9% → 98.1% statements, server
  82.5% → 99.6%, streaming/signalling files at or near 100%. See section 5b
  and 11. `toPublicScoreboard()` in particular now has a test asserting
  `umpireToken`/`umpireCode` never reach the serialised output.
- ~~Pause is not reflected on the public page~~ — closed; see section 6c.
- ~~Dead Cloudinary code~~ — removed from `cloud-sync.ts` along with the
  `cloudinary` dependency; it had zero importers left after the WebRTC
  migration replaced the JPEG-frame relay it existed for.

### ⚠️ Do not simply tunnel the app to the internet

The quickest public URL is `cloudflared`/`ngrok` at port 3000, with zero code
change — but it publishes **the whole app**, including `/admin` and every mutating
`/api/*` route, behind a password defaulting to `change-me`. Anyone who finds the
URL can create and score matches.

The Firebase route is safer by construction: it publishes only the data pushed to
it and never exposes the local server.

---

## 10. What's next

Scope for the POC: **3–5 simultaneous viewers**, which keeps WebRTC mesh viable
and rules out needing an SFU for now. Firestore signalling, the video panel on
the public page, and the `.env`/`cwd` fix are all done (sections 6–6c, 7) — what
remains:

1. **Confirm a viewer on cellular now connects.** The Cloudflare relay is wired
   in and verified to gather relay candidates (section 6d), but an end-to-end
   session over mobile data has not been signed off yet. Open the viewer with
   `?debug=1` and check the `selected candidate pair` line: `relay` on either
   end means TURN carried it. If it still fails, section 9.1 has the one
   remaining case and its fix.
2. **Change `ADMIN_PASSWORD`** before anything is publicly reachable.
3. **Try full screen / Add to Home Screen / wake lock on a real iPhone and a
   real Android phone** (section 6c). The unit tests mock every platform API
   involved — `requestFullscreen`, `wakeLock` — so the actual platform
   behaviour is still unverified outside a browser.

If the audience ever grows past a handful, move to an SFU (LiveKit Cloud, Daily,
Cloudflare Calls): the phone publishes once and the server fans out. Avoid
RTMP→HLS despite its unlimited scale — its 5–30 s latency would land the Firestore
score seconds _ahead_ of the video showing the rally that produced it.

---

## 11. Reference

### Commands

```bash
# Deploy the public viewer + rules
npx firebase-tools deploy --only hosting
npx firebase-tools deploy --only firestore:rules

# Run the desktop app (note the env override)
cd packages/desktop && env -u ELECTRON_RUN_AS_NODE npx electron .

# Run the server standalone so dotenv finds packages/server/.env
cd packages/server && npx tsx src/index.ts

# Is the TURN relay live? (credentials are redacted from this output)
curl -s http://localhost:3000/api/turn-credentials \
  | node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>{const b=JSON.parse(r);
      console.log('configured:',b.configured,'entries:',b.iceServers.length);});"

# Open the public viewer with its on-page connection log
open "https://courtside-scoreboard-86e96.web.app/?court=<courtId>&debug=1"
```

### Test coverage

```bash
npm test   # jest --coverage in every workspace
```

| Workspace | Tests | Statements | Branches |
| --------- | ----- | ---------- | -------- |
| `client`  | 335   | 98.2%      | 97.3%    |
| `server`  | 157   | 99.6%      | 98.7%    |
| `shared`  | 90    | 100%       | 100%     |

Up from 186/112/90 (68.9%/82.5% statements on client/server) before the
skill-driven refactor — see section 5b. Every streaming and signalling file
(`webrtc-stream.ts`, `firestore-signal.ts`, `sockets/stream.ts`,
`cloud-sync.ts`, both Stream screens, `useFullscreen`, `useWakeLock`) is now at
or near 100%, closing the gap **HANDOFF.md** used to call out explicitly.

### Environment (`packages/server/.env`, gitignored)

`FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` (all three
required by `cert()`), plus optional `FIREBASE_PRIVATE_KEY_ID`,
`FIREBASE_CLIENT_ID`, and `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_API_TOKEN`
(both required together; see 7.2b). Never commit these.

### Firestore

`matches/{courtId}` — one document per court, written by the server on every
score change, world-readable, client-writes denied. Payload shape is
`PublicScoreboard` in `cloud-sync.ts`.

### Links

- [MDN: WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [MDN: RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
- [WebRTC Samples](https://github.com/webrtc/samples)
- [Firebase console](https://console.firebase.google.com/project/courtside-scoreboard-86e96/overview)
