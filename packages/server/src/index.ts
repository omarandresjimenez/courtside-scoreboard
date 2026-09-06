import https from 'node:https';
import { createApp } from './app.js';
import { config } from './config.js';
import { ensureSchemaColumns } from './db/ensure-columns.js';
import { getOrCreateLocalTlsIdentity } from './integrations/local-tls.js';
import { publishMdns } from './integrations/mdns.js';

// Before anything serves a request: an existing database file may predate
// columns this build queries, and Prisma fails the whole query rather than
// degrading. Additive only — see ensure-columns.ts for why this exists at all.
await ensureSchemaColumns();

const { app, httpServer, io } = createApp();

httpServer.listen(config.port, () => {
  console.log(`Courtside Scoreboard server listening on port ${config.port}`);
});

// Phones need a secure context to use the camera (see StreamBroadcast),
// which a plain http:// LAN address never satisfies — this second HTTPS
// listener serves the exact same app so the broadcast link works without a
// separate reverse proxy. The cert is a persistent, CA-signed identity (see
// local-tls.ts) rather than a fresh self-signed one each boot, so the
// browser's one-time "not private" warning stays a one-time thing across
// restarts once a device installs the CA (routes/local-ca.ts) — instead of
// reappearing every launch.
const identity = await getOrCreateLocalTlsIdentity();
const httpsServer = https.createServer({ key: identity.key, cert: identity.cert }, app);
io.attach(httpsServer);
httpsServer.listen(config.httpsPort, () => {
  console.log(`Courtside Scoreboard HTTPS (camera) listener on port ${config.httpsPort}`);
});

// Lets a phone reach that HTTPS listener at config.mdnsHostname instead of
// the LAN IP — see mdns.ts for why (a name survives DHCP reassigning the
// IP between matches; an IP baked into a trusted cert does not).
publishMdns();
