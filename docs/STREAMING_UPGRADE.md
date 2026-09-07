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

| Guard                          | What it does                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Start-up purge                 | anything older than `VIEWER_REQUEST_TTL_MS` is deleted before listening — see the correction below |
| `VIEWER_REQUEST_TTL_MS` (60 s) | an unanswered request older than this is treated as abandoned, not given a slot                    |
| `CONNECT_TIMEOUT_MS` (30 s)    | a peer that never reaches `connected` is dropped and its slot freed                                |

Proved by planting six corpses (more than the cap of five) and confirming both
a desktop and a phone viewer still connected, with all six purged.

**⚠️ Correction, found later:** the first version of the start-up purge
deleted **every** document in `viewers/` unconditionally, on the theory
that anything predating this broadcast must be abandoned. That silently
broke the ordinary case of a viewer opening the link _before_ the court
pressed Start — their document was deleted, so the `onSnapshot` listener
below never saw it as `added`, and they waited forever on a broadcast that
was actually live. Reloading the page "fixed" it, which is exactly how it
was reported. The purge is now scoped to the TTL, same as the row above:
a recent, unanswered request is left alone and gets its offer the moment
the broadcast starts.

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

## 6e. ✅ Internet delivery, Stage 3 — Cloudflare Stream, past the viewer cap

### The ceiling this removes

Stage 2 (6b) delivers internet video as a **WebRTC mesh**: the court-side phone
opens a separate peer connection, with its own encoder output, for every viewer.
That is why `MAX_INTERNET_VIEWERS` is 5. It is not a arbitrary safety margin —
a phone uplink is typically 5–15 Mbps, a viewer costs ~2.6 Mbps, and the sixth
viewer does not merely fail, it degrades the picture for the five already
watching and for the LAN viewers sharing the same radio.

Dozens of viewers is a different shape of problem, and no amount of tuning the
mesh reaches it. It needs the upload to happen **once**.

### What shipped

The phone publishes a single stream to a **Cloudflare Stream live input**, and
Cloudflare fans it out from its own edge. The court's uplink now carries one
stream whether two people are watching or two hundred.

|                        | Mesh (6b)                  | Cloudflare (this)  |
| ---------------------- | -------------------------- | ------------------ |
| Uploads from the phone | one **per viewer**         | **one**, total     |
| Viewer ceiling         | `MAX_INTERNET_VIEWERS` = 5 | no fixed limit     |
| Latency                | ~200–500 ms                | < 500 ms           |
| Needs an account       | no                         | yes                |
| Viewer count reported  | yes                        | **no** (see below) |

Both paths still exist. Cloudflare is preferred when configured; the mesh is the
fallback, because it needs no account, no billing and no configuration, and a
venue with neither is exactly the case this app is built to survive.

### 🔬 WHIP/WHEP, and why not HLS

The original plan was WHIP ingest → HLS playback, on the reasoning that HLS is
plain HTTP and caches on any CDN. **Cloudflare does not allow that combination**:

> "We do not yet support inputs using RTMP/SRT to be played using WHEP, or
> inputs using WHIP to be recorded and played using HLS/DASH."

HLS playback would require RTMP or SRT ingest, and a browser cannot speak either
without a native encoder such as OBS. That would destroy the property the whole
broadcaster design rests on — someone at the court opens a link on a phone and
presses Start. So the phone publishes over **WHIP** and viewers subscribe over
**WHEP**: WebRTC end to end.

That turned out better than the plan it replaced. HLS would have added 5–15
seconds of delay; WHEP stays under 500 ms, which for a sport scored point by
point matters more than it first appears (see 6f).

Three consequences, all accepted deliberately:

- **No recording**, and therefore **no storage billed** — Cloudflare does not
  record WebRTC broadcasts at all.
- **No viewer count.** Cloudflare reports none for WebRTC, and the broadcast
  screen shows the delivery path instead. Inventing a number would be worse than
  showing none — and unlike the mesh, where the count is a warning about the
  phone's uplink, here it would not mean anything actionable.
- **No simulcast/restream** to YouTube or similar.

### Why not Jitsi, or a self-hosted SFU

Jitsi Videobridge, mediasoup and LiveKit all solve the fan-out problem — they
are SFUs, which is the same shape as what Cloudflare provides. They were not
chosen because every one of them means operating a publicly reachable server:
provisioning it, scaling it, patching it, and keeping it up on match day. Jitsi
in particular is built for many-to-many conferences rather than one-to-many
broadcast, and its own live-streaming path exports via RTMP to YouTube, which
puts the HLS delay straight back.

The trade is real, not free: this couples internet delivery to one vendor. The
mesh fallback is what keeps that from being a single point of failure.

### How the pieces fit

The awkward part is that the court-side phone can reach both the venue's LAN
server and the internet, while an internet viewer can reach **only** Firestore.
So the routing information travels with the presence document that already
exists:

```
GET /api/stream-input/:courtId   (LAN only)  -> { publishUrl, playbackUrl }
      |                                             |
      | phone publishes here (WHIP)                 | phone writes this to
      v                                             v  streams/{courtId}.whepUrl
  Cloudflare live input  ------ fans out ------>  viewers subscribe (WHEP)
```

`streams/{courtId}` gains one field, `whepUrl`. A viewer that finds it plays
from Cloudflare; a viewer that does not falls back to the mesh, unchanged. The
mesh path writes `whepUrl: null` on every announce, so a court that used
Cloudflare last time cannot strand viewers on a stream it is no longer feeding.

### 🔒 Security

- **`publishUrl` is a credential.** Cloudflare's words: "the broadcast secret is
  part of this URL, so treat it like a stream key." It is served only by the
  LAN-only server and is **never** written to Firestore, where the rules make it
  world-readable. There is a regression test asserting exactly that.
- **`whepUrl` is validated on the way in.** `streams/{courtId}` is
  world-_writable_ (a viewer must be able to write its own SDP answer, and there
  are no accounts to scope that to), so a stranger who knew a court id could
  otherwise plant a URL there and point every viewer's WebRTC session at a host
  of their choosing. The public viewer accepts a playback URL only over `https`
  on `*.cloudflarestream.com`; anything else is ignored and the mesh is used.
- The **Cloudflare API token** can create and delete live inputs across the whole
  account, so it stays in `.env` and never crosses the wire — same discipline as
  the TURN key, including never logging a response body that could echo it back.

### Live inputs are adopted, not recreated

One live input per court, reused for every match on it, tagged with
`meta.courtsideCourtId`. On a cache miss the server **lists** the account's
inputs and adopts the one already tagged for that court before creating
anything. Without that, every restart of the desktop app would leave another
orphaned input behind in the Cloudflare account.

### Reconnection

WHIP has none of its own: a dropped session simply stops transmitting. On a
phone on venue wifi that is a matter of when, not if — and unlike the mesh,
where each viewer reconnects independently, here one dropped upload takes
_every_ viewer down at once. So `cloudflare-broadcast.ts` watches the peer
connection and re-publishes on a capped backoff (2s, 5s, 10s, 20s), re-announcing
presence each time it succeeds. The broadcast screen says "Reconnecting to the
internet…" while it is down, rather than showing a confident "live" while
nothing is reaching Cloudflare.

### Files

| File                                                    | Role                                       |
| ------------------------------------------------------- | ------------------------------------------ |
| `packages/server/src/integrations/cloudflare-stream.ts` | creates/adopts the per-court live input    |
| `packages/server/src/routes/stream-input.ts`            | `GET /api/stream-input/:courtId`           |
| `packages/client/src/lib/whip-client.ts`                | WHIP publish (protocol only)               |
| `packages/client/src/lib/cloudflare-stream.ts`          | asks the LAN server for the court's input  |
| `packages/client/src/lib/cloudflare-broadcast.ts`       | publish + presence + reconnect             |
| `packages/client/src/lib/useCameraBroadcast.ts`         | picks Cloudflare, else the mesh            |
| `public-viewer/index.html`                              | WHEP playback, and the delay queue from 6f |

## 6f. ✅ Keeping the score in step with the picture

### The bug this prevents

The score and the video reach a viewer by completely unrelated routes: the score
is a Firestore document write, a few hundred milliseconds behind the umpire's
tap; the video is a media stream carrying whatever the network and the jitter
buffer add. The score is almost always the faster of the two.

The result is a page that **spoils its own video**: the scoreboard ticks over
before the viewer sees the rally that won the point. It is not a crash and no
test catches it, but it is the difference between watching a match and watching
a replay of one you already know the result of.

This mattered enough to fix here, and it would have mattered far more had the
HLS plan survived — a 10-second picture behind an instant scoreboard is not
usable at all.

### What shipped

The public viewer holds each score update back by roughly how far behind the
picture is. The delay is **measured, not guessed**: WebRTC reports
`jitterBufferDelay / jitterBufferEmittedCount` (how long a frame waits before it
is played — the largest and most variable part of the lag) and the candidate
pair's `currentRoundTripTime`. It is re-measured every 3 seconds, because the
jitter buffer grows and shrinks over the course of a match.

Two details that are easy to get wrong:

- **Only while video is actually on screen.** A viewer watching the scoreboard
  alone — video never started, or the court is not transmitting — has nothing to
  stay in step with, and delaying their score would be pure loss. When the video
  stops, everything held back is flushed immediately, so the scoreboard never
  looks frozen.
- **The Cloudflare path measures short.** Round-trip time there is this browser
  to Cloudflare's edge; the phone's own upload into Cloudflare is invisible from
  the viewer. A fixed `CLOUDFLARE_INGEST_ESTIMATE_MS` allowance is added on that
  path, and none on the mesh, where the far end _is_ the phone.

Capped at 6 seconds whatever the stats claim, and seeded with a 500 ms default
for the moment between the picture appearing and the first measurement — the
points scored right then are the ones most likely to be spoiled, because the
viewer has only just started watching.

## 7. Configuration required

Everything needed to stand this up on a fresh machine or a new Firebase project.

### 7.1 Server environment — `packages/server/.env`

Gitignored and untracked; never commit it. Added for streaming/cloud sync on top
of the existing `PORT` / `ADMIN_PASSWORD` / `DATABASE_URL` (see HANDOFF.md's
configuration reference):

```
HTTPS_PORT=3001                    # optional, defaults to PORT + 1

MDNS_HOSTNAME=courtside.local      # optional — see 7.6; the name advertised over mDNS
MDNS_ENABLED=true                  # optional — set to "false" if the venue blocks multicast
LOCAL_TLS_DIR=~/.courtside-scoreboard/certs  # optional — where the persistent CA/cert live

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

### 7.2c Cloudflare Stream — one-time setup

Needed only to serve more than a handful of internet viewers (see 6e). Without
it the app falls back to the 5-viewer peer mesh; LAN streaming never touches it.

1. Same Cloudflare account as 7.2b. Dashboard → **Stream**. Stream is a paid
   product — there is no free tier — so a subscription must be active on the
   account before live inputs can be created.
2. Create an API token with the **Stream** permission set to **Edit**
   (the API reference calls the same grant `Stream Write`).
3. Copy the **Account ID** from any dashboard page's right-hand sidebar.
4. Put both in `packages/server/.env`:

   ```
   CLOUDFLARE_ACCOUNT_ID=<account id>
   CLOUDFLARE_STREAM_API_TOKEN=<token>
   ```

   Both are required together; either one alone leaves the feature off.

5. Restart the desktop app, then confirm:

   ```bash
   curl -s http://localhost:3000/api/stream-input/<courtId>
   ```

   should report `"configured":true` with a `publishUrl` and `playbackUrl` on
   `customer-<code>.cloudflarestream.com`. The first call for a court creates its
   live input, so it is slower than later ones.

**Pricing — two parts, and the first one surprises people:**

1. **A $5/month floor you cannot avoid.** Stream has no pay-per-use-only plan.
   Activating it forces you through a "Configure storage" screen that sells
   storage in $5 blocks of 1,000 minutes, and that purchase is what switches the
   product on.

   **This app never uses a single minute of it.** Cloudflare cannot record
   WebRTC broadcasts, and `recording.mode` is set to `off` explicitly, so the
   block stays permanently empty — treat the $5 as an activation fee, and leave
   the quantity at the minimum of 1. Raising it buys more of something nothing
   will ever write to.

2. **$1 per 1,000 minutes delivered**, on actual usage. Ingest and encoding are
   free. In practice: a one-hour match watched by 30 people is 1,800
   viewer-minutes, about **$1.80**; a full eight-hour tournament day at that
   audience is roughly **$14**.

So a month with no matches still costs $5, and a month with one busy tournament
day costs about $19. Weigh that against the free peer mesh, which serves five
viewers for nothing beyond TURN bandwidth — see 7.2d for switching between them
without touching the venue machine.

⚠️ **Cloudflare began billing WebRTC delivery on 15 October 2026.** Before that
date WHEP delivery was free, so any cost estimate taken from an earlier run of
this feature is not comparable.

The API token can create and delete live inputs across the whole account. It
lives in `.env` (gitignored), never in a client bundle, and is never written to
a log — including when Cloudflare echoes the request back in an error body,
which there is a regression test for.

### 7.2d The remote off-switch

Cloudflare Stream is the only part of this app billed per minute delivered, and
the machine running the server sits on a venue LAN nobody can reach from
outside. So the off-switch lives somewhere reachable from a phone.

In the Firebase console, create:

```
config/streaming  ->  { cloudflareStreamEnabled: false }
```

The next broadcast started on any court uses the free peer mesh instead.
Setting it back to `true`, or deleting the document, restores Cloudflare.

- **Default is on.** A missing document, a missing field, a value that is not a
  boolean, no Firebase configured at all, or a failed or slow read — all mean
  "enabled". The switch exists to turn a working feature off deliberately; a
  Firestore hiccup must never silently downgrade every court to five viewers.
  Only an explicit `false` disables it.
- **Takes effect on the next broadcast**, not mid-transmission. The flag is read
  once when a court starts transmitting — one document read per match.
- **Nothing is spent while it is off.** The flag is checked _before_ the live
  input is fetched, so a disabled feature makes no Cloudflare API call and
  cannot create a new live input on an account you have just decided to stop
  spending on.
- **No security rule is needed.** It is read by the Admin SDK, which bypasses
  rules entirely, so the catch-all `allow read, write: if false` already denies
  every client both. Only the Firebase console can change it — unlike
  `streams/{courtId}`, which has to stay world-writable for signalling.
- **Deliberately not in the admin dashboard.** This is an operator decision
  about billing, not a match-day setting, and putting it on a screen anyone at
  the venue can open invites it being toggled by accident.

Confirm which way it is set:

```bash
curl -s http://localhost:3000/api/stream-input/<courtId>
```

`enabled` is reported separately from `configured` on purpose: "the operator
turned this off" and "this was never set up" both fall back to the mesh, but
only one of them is worth investigating.

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

| Need                                                    | Why                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phone reaches the laptop's **HTTPS** listener (`:3001`) | `getUserMedia` requires a secure context; the cert warning must be accepted once per phone — see 7.6 for what "once" now actually means |
| Laptop has internet                                     | to push scores to Firestore                                                                                                             |
| Phone has internet                                      | to signal to internet viewers via Firestore                                                                                             |
| —                                                       | Internet viewers need **no** access to the venue network at all                                                                         |

If the venue has no uplink, everything still works on the LAN; only the public
page goes stale.

### 7.6 Making "accept the warning once" actually mean once

The self-signed cert originally described above had two problems, both found
by actually going through the warning flow on a phone rather than reading the
code:

1. **It was regenerated on every server start.** A phone that had trusted it
   once saw a brand new "not private" warning the very next time the app
   restarted — nothing was ever durable to trust.
2. **It set `commonName: localhost` and nothing else.** A phone reaches this
   server by LAN IP, not the literal string "localhost", and modern browsers
   validate the hostname against the certificate's Subject Alternative Name
   (SAN), not the CN.

**What shipped:** a small local Certificate Authority
(`packages/server/src/integrations/local-tls.ts`), generated once and
persisted to `~/.courtside-scoreboard/certs/`, which signs a long-lived leaf
certificate listing every name/address the server might be reached by —
`localhost`, `127.0.0.1`, `::1`, `config.mdnsHostname` (`courtside.local` by
default — see below), and every non-loopback IPv4 address the machine had at
first boot. A phone that installs and trusts the CA once (via
`GET /api/local-ca.pem`, served with `Content-Type: application/x-x509-ca-cert`
so iOS/Android offer to install it as a profile, and reachable over **plain
HTTP** — chicken-and-egg: it can't require a trust the phone doesn't have
yet) never sees the warning again for anything this CA has signed, including
across app restarts.

**The remaining gap this doesn't close on its own:** an IP baked into the SAN
list stops being useful the moment the venue's DHCP hands out a different
one — a stable identity needs a stable _name_, not just a persistent
certificate. That's what `packages/server/src/integrations/mdns.ts` adds:
`bonjour-service` advertises the server at `config.mdnsHostname`
(`courtside.local`) over mDNS, so `.local` resolution — not the specific
IP — is what a device relies on. Combined with the persistent cert above,
trusting the CA once means the warning is gone for good, even across a venue
change that gives the laptop a new IP.

**Where this doesn't reach:** `.local` resolution isn't universal —

| Platform               | `.local` resolution                                                         |
| ---------------------- | --------------------------------------------------------------------------- |
| iPhone (Safari/Chrome) | Native, always works                                                        |
| Android                | Only 13+ (the DNS Resolver Mainline module) — older phones don't resolve it |
| Windows                | Not built in at all — needs Apple's Bonjour service installed separately    |

A device that can't resolve `courtside.local` falls back to the LAN-IP link
exactly as before — no worse than the original behaviour, and the persistent
cert still means that IP-based link survives an app restart for as long as
the IP itself doesn't change. `MDNS_ENABLED=false` turns mDNS off entirely
for a venue where multicast is blocked (some corporate/conference APs do
this); `MDNS_HOSTNAME` overrides the advertised name.

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
accurate but easy to misread as a bug. This is still true and unchanged.

**Partly closed, for a different case:** a later pass added
`STREAM_EVENTS.MATCH_STARTED`/`MATCH_FINALIZED` (see HANDOFF.md's "admin
dashboard reorganization" session) so the phone starts and stops itself with
the match, no press needed — but only once camera permission has already
been granted on that phone (a browser won't prompt for a new one without a
user gesture), and only while its browser tab is still open, sitting idle on
the court's broadcast page, listening as a `stream-standby` socket. None of
that survives a server restart or the tab being closed — the gap above is
specifically about those, and remains exactly as described.

**What's no longer true: the viewer used to need a manual reload too.**
A later pass added automatic reconnection to `public-viewer/index.html`
(`connectAttempt`/`scheduleRetry`, with backoff and a visible "↻ Reconnect"
button once automatic retries give up) — see 6d for the diagnostics that
motivated it. A viewer whose connection drops, or who was already on the
page when the court's broadcast restarts, now picks it back up on its own.
The gap above is specifically the **broadcaster** (the court's phone)
needing a human to press Start again — not the viewer needing to reload,
which was the original, now-fixed symptom ("it did not refresh
automatically when the transmission started and the user had to reload").

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
| `client`  | 382   | 98.4%      | 96.4%    |
| `server`  | 193   | 99.7%      | 98.6%    |
| `shared`  | 142   | 100%       | 98.1%    |

Up from 186/112/90 (68.9%/82.5% statements on client/server) before the
skill-driven refactor — see section 5b. Every streaming and signalling file
(`webrtc-stream.ts`, `firestore-signal.ts`, `sockets/stream.ts`,
`cloud-sync.ts`, both Stream screens, `useFullscreen`, `useWakeLock`) is now at
or near 100%, closing the gap **HANDOFF.md** used to call out explicitly. The
later growth in these numbers (335→382 client, 157→193 server, 90→142
shared) is the unrelated player-roster-import feature, not more streaming
work — see HANDOFF.md's "player roster import" section.

### Environment (`packages/server/.env`, gitignored)

`FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` (all three
required by `cert()`), plus optional `FIREBASE_PRIVATE_KEY_ID`,
`FIREBASE_CLIENT_ID`, and `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_API_TOKEN`
(both required together; see 7.2b), and `CLOUDFLARE_ACCOUNT_ID` /
`CLOUDFLARE_STREAM_API_TOKEN` (both required together; see 7.2c). Never commit
these.

### Firestore

`matches/{courtId}` — one document per court, written by the server on every
score change, world-readable, client-writes denied. Payload shape is
`PublicScoreboard` in `cloud-sync.ts`.

`config/streaming` — `{ cloudflareStreamEnabled: boolean }`, the remote
off-switch for Cloudflare Stream (see 7.2d). Server-only: written by hand in the
Firebase console, read by the Admin SDK, denied to every client by the
catch-all rule.

`streams/{courtId}` — presence for the court's broadcast: `live`, `paused`, and
`whepUrl` (the Cloudflare playback URL, or `null` when the court is using the
peer mesh). World-readable _and_ world-writable, which is why the viewer
validates `whepUrl` before using it — see 6e.

### Links

- [MDN: WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [MDN: RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
- [WebRTC Samples](https://github.com/webrtc/samples)
- [Firebase console](https://console.firebase.google.com/project/courtside-scoreboard-86e96/overview)
