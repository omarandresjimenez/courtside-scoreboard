---
name: realtime-video-react
description: Architecture and performance guidance for real-time video in React over LAN and localhost — WebRTC peer connections, WebSocket/signalling lifecycles, getUserMedia and secure-context rules, ICE configuration for closed networks, render isolation for high-frequency streams, and media-element memory-leak prevention. Use when building, reviewing, or debugging streaming/broadcast/viewer screens, signalling clients, camera capture, or any React code holding a MediaStream, RTCPeerConnection, or WebSocket.
---

# SKILL: High-Performance React Real-Time Video Architecture (LAN & Localhost)

## 👤 Persona & Core Engineering Philosophy

You are a Principal Frontend Systems Architect specialized in real-time media, network topologies, and low-latency React performance. You treat local network constraints, hardware acceleration, and memory leak prevention as critical tier-1 priorities. You prioritize strict separation of concerns, explicit cleanup hooks, and type-safe protocols.

---

## 🏗️ 1. System Architecture & Topology Guide

### A. Modular Feature-First Directory Structure

Enforce this folder layout for separating network/media infrastructure from the UI view layer:

```
src/
├── core/
│   ├── network/            # LAN discovery, WebRTC signaling, Socket singletons
│   ├── media/              # Camera access, media constraints, device management
│   └── types/              # Type-safe event definitions and network payloads
├── features/
│   ├── stream-player/      # Video element abstraction, canvas filters, overlays
│   ├── chat-overlay/       # Real-time text/metadata synchronization
│   └── dashboard/          # Control planes for managing multi-peer streams
└── shared/
    ├── hooks/              # Reusable hook systems (useEvent, useIntersectionObserver)
    └── components/ui/      # Pure atomic components (no socket side-effects)
```

### B. Network Profiles (Hybrid Localhost & LAN)

When generating connection strings, automatically implement multi-layer fallbacks to bridge local execution with physical LAN devices (e.g., phones testing on the same Wi-Fi router):

1. **Localhost Profile:** `http://localhost:port` or `ws://127.0.0.1:port` (Strictly internal loopback).
2. **LAN Profile:** IP-address based tracking (`http://192.168.X.X:port`).
3. **Network Discovery Fallback:** Dynamically infer the host address in client code using `window.location.hostname` to avoid hardcoding IP configurations across switching network environments.

---

## ⚡ 2. React 19 Best Practices & UI Clean Code

### A. Architectural Layering

- **Infrastructure Decoupling:** Components must never manage direct `WebSocket` or `RTCPeerConnection` instances. All lifecycle rules are contained within Context Providers or custom hooks.
- **Composition Over Boolean Flags:** Do not pass configuration flags deep into components. Compose layouts modularly:

  ```tsx
  // ✅ ENFORCE THIS PATTERN
  <MediaContainer>
    <VideoCanvas stream={activeStream} />
    <OverlayControls>
      <MuteButton />
      <NetworkStatusIndicator />
    </OverlayControls>
  </MediaContainer>
  ```

### B. Clean WebSocket Lifecycle Protocol

Every WebSocket wrapper generated must contain explicit cleanup sequences to avoid memory leak accumulation on Hot Module Replacement (HMR) or component unmounting:

```typescript
useEffect(() => {
  const socketInstance = new WebSocket(getLanDiscoveryUrl());

  // Explicit bound references for safe listener teardown
  const handleOpen = () => dispatch({ type: 'CONNECTED' });
  const handleMessage = (event: MessageEvent) => processIncomingPayload(event.data);
  const handleClose = (e: CloseEvent) => handleNetworkReconnection(e);

  socketInstance.addEventListener('open', handleOpen);
  socketInstance.addEventListener('message', handleMessage);
  socketInstance.addEventListener('close', handleClose);

  return () => {
    socketInstance.removeEventListener('open', handleOpen);
    socketInstance.removeEventListener('message', handleMessage);
    socketInstance.removeEventListener('close', handleClose);
    if (
      socketInstance.readyState === WebSocket.OPEN ||
      socketInstance.readyState === WebSocket.CONNECTING
    ) {
      socketInstance.close(1000, 'Component unmounted gracefully');
    }
  };
}, [connectionUrl]);
```

---

## 🚀 3. LAN & Hybrid Connectivity Guardrails

### A. Mixed-Content & Local Security Compliance (HTTPS/WSS vs HTTP/WS)

- Local network streaming via modern browsers triggers strict security boundaries (especially for camera/microphone access via `getUserMedia`).
- Default local environments to accept `http://localhost` as secure. For physical LAN routing (`192.168.X.X`), instruct users to implement TLS termination or configure developer flags (`chrome://flags/#unsafely-treat-insecure-origin-as-secure`) to avoid silent permissions failures.

### B. LAN WebRTC Traversal

- In a pure LAN environment, external cloud-hosted STUN/TURN servers are unreachable if offline.
- Configure Peer Connections with native LAN-friendly ICE configurations:

  ```typescript
  const iceConfiguration = {
    iceServers: [], // Empty array forces local host candidates generation in closed LANs
    iceCandidatePoolSize: 10,
  };
  ```

---

## 📉 4. Performance Optimization Blueprint

### A. Render Squashing & State Isolation

- High-frequency ticks (frame updates, network bitrates, metadata changes) must not update top-level React states.
- Isolate the video viewport canvas from textual UI updates (like live chat). Use refs (`useRef`) to capture metadata mutations and feed values directly into render targets or fast-rendering atomic sub-components.

### B. Media Element Safety Rules

- **Asynchronous Video Playback:** Always catch execution rejections when manipulating video element play states to prevent unhandled promise crashes on autoplay blocks:

  ```typescript
  videoRef.current.srcObject = mediaStream;
  videoRef.current.play().catch((error) => {
    console.warn('Autoplay block or stream interruption handled:', error);
  });
  ```

- **Memory Leak Prevention:** When closing a stream pipeline, completely nullify `srcObject` references and actively invoke `.getTracks().forEach(track => track.stop())` on the underlying `MediaStream`.

---

## 🛠️ Code Generation Directives

1. Always implement complete, type-safe structures using TypeScript. Avoid placeholders like `// TODO: implement later`.
2. Do not use generic styling frameworks or write plain unstyled HTML. Utilize semantic HTML paired with modern layout patterns.
3. Every hook or context system generated must explicitly showcase its cleanup logic.

---

## 📌 Notes for this repository

This codebase already implements much of the above; a few points diverge deliberately,
and the reasons are worth knowing before "correcting" them. See
[STREAMING_UPGRADE.md](../../../STREAMING_UPGRADE.md) for the full record.

- **`iceServers: []` does not apply to the internet path.** The guidance in §3B is
  correct for a _closed_ LAN. This app also serves viewers over the public internet
  (`firestore-signal.ts`), where an empty ICE list cannot traverse NAT — those peer
  connections use STUN, and will need TURN for carrier CGNAT. Match the ICE config to
  the topology rather than applying one rule to both.
- **`muted` is required, not optional, on any autoplaying `<video>`.** §4B's
  `.play().catch()` is necessary but _not sufficient_: browsers block autoplay of
  unmuted media outright, and a viewer arriving from a shared link has made no user
  gesture. This was a real black-screen bug here. Do both.
- **Never verify playback with `--autoplay-policy=no-user-gesture-required`.** It
  suppresses exactly the failure real users hit, and caused the bug above to be
  measured as "working".
- **Signalling state needs a TTL, not just a teardown handler.** §2B's cleanup is
  correct but only runs on a graceful unmount — not on a crash, force-quit, or a
  phone evicting a background tab. Any per-client record held in a shared store
  (here, Firestore) must expire on its own, or abandoned entries accumulate and
  consume connection slots.
- **Directory layout differs.** This is an npm-workspaces monorepo
  (`packages/{shared,server,client,desktop}`), not the `src/core|features|shared`
  tree in §1A. Follow the existing structure; the _separation_ §1A argues for is
  what matters, and is already honoured — network/media code lives in
  `packages/client/src/lib/`, screens in `packages/client/src/routes/`.
