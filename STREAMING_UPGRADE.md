# Video Streaming Performance Upgrade

**Date Started:** 2026-09-03  
**Status:** In Progress

---

## Goal

Replace the slow MJPEG frame-upload streaming with a real-time video streaming solution that delivers **smooth, low-latency video** from the court-side phone to internet viewers, while maintaining the live score overlay.

**Current Performance:** ~2 FPS (one image every 500ms) — too slow for a watchable match broadcast.

---

## Architecture

### Pages Involved
- **`/stream/court/:courtId`** — Court-side broadcaster (phone with camera)
  - Simple camera controls: Start / Pause / Resume / Stop
  - No score display (just raw video)
  
- **`/stream/live/court/:courtId`** — Internet viewer (desktop/mobile/tablet)
  - Live video stream from the broadcaster
  - Real-time score overlay (from Socket.IO match state)
  - Status placeholder ("waiting for broadcast", "paused", etc.)

### Current Stack (MJPEG)
- **Broadcaster:** Captures camera frames via `canvas.toBlob()` every 500ms
- **Server:** Stores latest JPEG in memory, relays to viewers via MJPEG multipart stream
- **Viewer:** Polling for status + `<img>` tag displaying MJPEG stream
- **Latency:** ~500ms per frame + network + browser decode
- **Problem:** Only 2 FPS, visibly jerky

---

## Options Considered

### 1. **MJPEG (Current)**
- ✅ Simple, no dependencies
- ✅ Immediate browser support (just `<img>` tag)
- ❌ **Only ~2 FPS** — limited by frame capture interval
- ❌ No adaptive quality
- ❌ High bandwidth at full quality

### 2. **WebRTC (Recommended)**
- ✅ **Low-latency real-time video** (30-60+ FPS typical)
- ✅ Built-in codec adaptation (VP8, VP9, H.264, etc.)
- ✅ Automatic bandwidth adaptation
- ✅ Hardware acceleration in browsers
- ✅ No dependencies (native browser API)
- ⚠️ Requires signaling server to exchange SDP offers/answers
- ⚠️ NAT traversal may need STUN/TURN (simple case: local LAN, no TURN needed)

### 3. **HLS (HTTP Live Streaming)**
- ✅ Good browser support
- ❌ Higher latency (typically 6-10+ seconds, 2-10 second segments)
- ❌ More complex encoder setup (FFmpeg or similar)
- ❌ Overkill for LAN-only broadcast

### 4. **DASH (Dynamic Adaptive Streaming)**
- ❌ Similar issues to HLS (higher latency)
- ❌ Overkill for LAN tool

---

## Decision: WebRTC

**WebRTC is chosen** because:
1. **Low latency** — target <500ms end-to-end, typically 50-200ms on LAN
2. **60 FPS native** — the browser's video codec naturally delivers smooth motion
3. **No external dependencies** — uses native `RTCPeerConnection` API
4. **Zero infrastructure** — signaling runs over existing Socket.IO server
5. **Adaptive quality** — browser automatically adjusts bitrate for network conditions

---

## Implementation Plan

### Phase 1: Signaling Server (Socket.IO Events)
- **`broadcast:offer`** — Broadcaster sends SDP offer to server
- **`broadcast:answer`** — Server relays SDP answer from viewer(s) back to broadcaster
- **`broadcast:ice-candidate`** — ICE candidates exchanged in both directions
- Server stores active broadcaster per court, relays answers/ICE to all viewers

### Phase 2: Broadcaster Side (`StreamBroadcast.tsx`)
1. Get camera stream via `getUserMedia()`
2. Create `RTCPeerConnection` with video track from camera
3. Send SDP offer to server via Socket.IO
4. Receive SDP answer and ICE candidates from server
5. Add ICE candidates to local peer connection
6. Stream begins flowing once connection established

### Phase 3: Viewer Side (`StreamViewer.tsx`)
1. Listen for broadcast start signal via Socket.IO
2. Create `RTCPeerConnection` as answerer
3. Wait for SDP offer from broadcaster
4. Send SDP answer back to server
5. Exchange ICE candidates
6. Render incoming `<video>` stream once established

### Phase 4: Clean Up MJPEG Code
- Delete `packages/server/src/routes/video-stream.ts`
- Remove `/api/video/*` endpoints (frame upload, MJPEG stream, status poll)
- Remove `packages/client/src/lib/camera-stream.ts` (replace with simpler getUserMedia wrapper)
- Update `AdminDashboard.tsx` tests for new stream link structure

---

## Current Status

### ✅ Completed (Pre-WebRTC)
- [x] Split broadcaster/viewer into two separate pages (`StreamBroadcast.tsx`, `StreamViewer.tsx`)
- [x] Fixed camera permission error (HTTPS dual-listener, HTTPS on port `httpsPort`)
- [x] Admin dashboard generates both broadcast + viewer links + QR codes
- [x] MJPEG streaming working but slow (2 FPS)
- [x] Pause/resume/stop controls on broadcaster
- [x] Status placeholder on viewer ("waiting", "paused", "stopped")

### 🔄 In Progress
- [ ] Implement WebRTC signaling server in `packages/server/src/routes/webrtc-signal.ts`
- [ ] Create `packages/client/src/lib/webrtc-stream.ts` (signaling + peer connection management)
- [ ] Rewrite `StreamBroadcast.tsx` to use WebRTC instead of frame uploads
- [ ] Rewrite `StreamViewer.tsx` to use WebRTC video stream instead of MJPEG polling
- [ ] Remove obsolete MJPEG routes and frame-upload logic
- [ ] Test on LAN (phone broadcaster + desktop/tablet viewer)

### ❌ Not Started
- [ ] TURN server setup (only if local network NAT traversal fails)
- [ ] Recording/playback of matches
- [ ] Bandwidth monitoring / adaptive quality UI

---

## Socket.IO Events (Signaling)

### Broadcaster → Server → Viewer(s)

```typescript
// Broadcaster connects and starts streaming
socket.emit('broadcast:start', { courtId })

// Broadcaster sends SDP offer
socket.emit('broadcast:offer', { courtId, offer: RTCSessionDescription })

// Broadcaster sends ICE candidate
socket.emit('broadcast:ice-candidate', { courtId, candidate: RTCIceCandidate })

// Broadcaster stops streaming
socket.emit('broadcast:stop', { courtId })

// Viewer answers offer
socket.emit('broadcast:answer', { courtId, answer: RTCSessionDescription })

// Viewer sends ICE candidate
socket.emit('broadcast:ice-candidate', { courtId, candidate: RTCIceCandidate })
```

---

## Testing Checklist

- [ ] Start desktop app (server on `3000` HTTP + `3001` HTTPS)
- [ ] Admin dashboard: create match
- [ ] Copy broadcast link QR → scan from phone
- [ ] Accept HTTPS cert warning
- [ ] Grant camera permission
- [ ] Click "Start transmission"
- [ ] Copy viewer link QR → scan from desktop/tablet
- [ ] Video appears with smooth motion (30+ FPS)
- [ ] Pause on broadcaster → viewer shows "paused" placeholder
- [ ] Resume → video continues smoothly
- [ ] Stop → viewer shows "stopped" placeholder
- [ ] Score overlay updates in real-time on viewer
- [ ] Pause/resume doesn't interrupt Socket.IO connection

---

## Files to Modify/Create

### Create
- `packages/server/src/routes/webrtc-signal.ts` — WebRTC signaling route
- `packages/client/src/lib/webrtc-stream.ts` — WebRTC peer connection + signaling client

### Modify
- `packages/server/src/app.ts` — Wire in WebRTC signaling route
- `packages/client/src/routes/StreamBroadcast.tsx` — Use WebRTC instead of frame uploads
- `packages/client/src/routes/StreamViewer.tsx` — Use WebRTC `<video>` element instead of MJPEG polling
- `packages/client/src/lib/camera-stream.ts` — Simplify to just `getUserMedia` wrapper
- `packages/server/package.json` — Remove `selfsigned` (no longer needed for HTTPS), add WebRTC deps if any

### Delete
- `packages/server/src/routes/video-stream.ts` — MJPEG route (obsolete)
- `packages/server/src/routes/video-stream.test.ts` — MJPEG tests (obsolete)

---

## Performance Expectations (WebRTC)

| Metric | MJPEG (Current) | WebRTC (Target) |
|--------|-----------------|-----------------|
| Frame rate | ~2 FPS | 30-60 FPS |
| Latency | ~500ms per frame | 50-200ms |
| Bandwidth | ~2 Mbps @ full quality | 1-5 Mbps (adaptive) |
| Smoothness | Jerky, visibly delayed | Smooth, natural motion |
| CPU (phone) | Moderate (canvas capture loop) | Moderate-High (video codec) |
| CPU (viewer) | Low (image polling) | Moderate (video decode) |

---

## References

- [MDN: WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [MDN: RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
- [WebRTC Samples](https://github.com/webrtc/samples)
- [Socket.IO Events](https://socket.io/docs/v4/emit-cheatsheet/)
