---
name: react-firebase-architecture
description: Production-grade architecture for React + Firebase — modular v9+ SDK initialization, tree-shaking-friendly service separation, multi-environment config validation, type-safe Firestore collections, decoupled data hooks, and security-rule discipline. Use when initializing or refactoring Firebase in a client app, wiring Firestore/Auth into React, writing firestore.rules, configuring firebase-admin on a server, or debugging bundle bloat, resource leaks, or silent config failures.
---

# SKILL: Production-Grade React & Firebase Architecture

## 👤 Persona & Core Engineering Philosophy

You are a Principal Cloud Engineer specialized in Serverless Architectures, Firebase Ecosystems, and Reactive State Syncing. You treat Firebase resource leaks, bloated client bundles, unhandled offline states, and loose security rules as critical production blockers. You write modular, type-safe SDK initializers, enforce strict decouple layers between components and Firestore, and write clean, declarative hooks.

---

## 🏗️ 1. Architecture & SDK Initialization Guide

### A. Modular Initialization (Tree-Shaking Friendly)

Enforce the use of the Firebase Web SDK v9+ (Modular). Never bundle or initialize unnecessary services. Separate the core initialization from feature consumption.

```
src/
├── core/
│   └── firebase/
│       ├── config.ts          # Environment variable checking & app initialization
│       ├── auth.ts            # Auth instance export & common helpers
│       └── firestore.ts       # Firestore instance export & global converters
├── features/
│   └── shared/
│       └── hooks/             # useFirestoreQuery.ts, useAuthUser.ts
└── types/
    └── database.d.ts          # Strict TypeScript interfaces for Collections
```

### B. Safe Multi-Environment Configuration

Every configuration script must validate the presence of required environment variables (`import.meta.env` or `process.env`) at build time to prevent silent runtime crashes.

---

## 📌 Notes for this repository

This project uses Firebase for the public scoreboard and for WebRTC signalling.
Most of the above already holds; the exceptions below are deliberate, and each
was learned the expensive way. Full record in
[STREAMING_UPGRADE.md](../../../STREAMING_UPGRADE.md).

### The client Firebase config is intentionally NOT in environment variables

§1B is about secrets. The Firebase **web** config (`apiKey`, `authDomain`,
`projectId`, `appId`) is not one — it identifies the project and authorises
nothing, it is served to every visitor in the client bundle, and Firebase's own
docs treat it as public. It is therefore committed, in two places that must stay
in sync:

- `packages/client/src/lib/firebase-config.ts` (React app)
- `public-viewer/firebase-config.js` (static page)

Access is governed entirely by `firestore.rules`. Putting these behind env vars
would add ceremony without adding security. **The values that genuinely are
secret** — the service-account key — live in `packages/server/.env`, gitignored,
and are validated at startup.

### `firebase-admin` v14 breaks the namespace import under ESM

The server-side analogue of §1A's modular rule, and non-obvious because it fails
_silently_:

```typescript
// ❌ Throws "Cannot read properties of undefined (reading 'cert')" under ESM.
//    admin.credential does not exist on the default export in v14.
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ✅ Modular entry points
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
if (getApps().length === 0) initializeApp({ credential: cert(serviceAccount) });
```

Every credential can be correct and cloud sync still ends up disabled, with the
only symptom a caught-and-logged init error. Guard `getApps().length === 0` so a
re-entry (tests, in-process restart) doesn't throw on a duplicate app.

### Validate exactly what the SDK requires, not a subset

`cert()` needs `projectId`, `privateKey` **and** `clientEmail`. An earlier guard
here checked only the first two, so a half-configured install sailed past the
check and failed later inside `cert()` with a worse message. Validate the whole
set at the boundary.

Also: `dotenv` resolves `.env` from `process.cwd()`, not from the file's own
location. The Electron app passes `cwd` when spawning the server for exactly this
reason — without it, `.env` is silently ignored and Firebase appears unconfigured.

### Not every Firebase client needs a bundler

§1A's tree-shaking rationale assumes a build step. `public-viewer/` deliberately
has none — it is plain HTML importing the SDK from `gstatic.com` as ES modules,
deployed straight to Hosting. Modularity still applies (import only
`firebase-app` and `firebase-firestore`), but do not "fix" it by adding a build
pipeline.

### Security rules: read-only by default, and mind what the Admin SDK bypasses

The working pattern here:

- `matches/{courtId}` — public read, **all client writes denied**. The server
  writes via the Admin SDK, which bypasses rules entirely, so denying client
  writes costs nothing and stops a reader editing a live score.
- Anything world-readable needs an **allow-list projection**, not a delete-list.
  `toPublicScoreboard()` exists because the raw match object carries
  `umpireToken` — the secret authorising scoring — and spreading it into a public
  document would have published credentials. A field added to the model later
  must be opted _in_.
- Signalling (`streams/{courtId}`) must accept unauthenticated writes, because a
  viewer has to write its SDP answer somewhere. Scope that openness to the
  subtree that needs it and keep the rest denied.

### Per-client documents need a TTL, not just a cleanup handler

Records written by a client and deleted on `pagehide` **leak**: that event does
not fire on a crash, a force-quit, or a phone evicting a background tab. Observed
here as ten abandoned signalling documents, the oldest over three hours, silently
consuming every available connection slot. Anything a client registers in a
shared store needs a server-side or start-up expiry as well.
