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

/**
 * Last-resort net for async code Express never sees — the Socket.io handlers,
 * the cloud-sync writes, anything scheduled.
 *
 * Routes are covered properly by asyncRoute + errorHandler, which fail one
 * request and answer it. These two only catch what those cannot reach, and they
 * deliberately do **not** exit.
 *
 * That is the opposite of the usual advice for `uncaughtException`, and it is a
 * considered trade for this particular program: it is an appliance running a
 * live tournament on a laptop nobody is watching, with no supervisor to restart
 * it. Staying up in a possibly-degraded state beats every court going dark
 * mid-match — and the alternative is not a clean restart, it is a blank TV and
 * an umpire who cannot score.
 *
 * Installed only once the server is actually listening, and that is the whole
 * point of `armResilience()`. Applied from the start, they swallow *start-up*
 * failures too — a second copy launched over a running one hit EADDRINUSE,
 * logged it, and carried on as a process that serves nothing while the old one
 * keeps the port. Every request then goes to whichever copy bound first, which
 * looks exactly like code changes not taking effect. Before the bind succeeds,
 * Node's own behaviour — crash, loudly — is the correct one.
 */
function armResilience(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled promise rejection (server kept running):', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[server] uncaught exception (server kept running):', error);
  });
}

const { app, httpServer, io } = createApp();

// A server that cannot bind its port is not degraded, it is useless, and
// pretending otherwise hides the problem behind a stale process still serving
// the previous build.
httpServer.on('error', (error) => {
  console.error(`[server] could not listen on port ${config.port}:`, error);
  process.exit(1);
});

httpServer.listen(config.port, () => {
  console.log(`Courtside Scoreboard server listening on port ${config.port}`);
  armResilience();
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
// The camera listener failing is not fatal the way the main one is: scoring,
// the TV screens and the admin dashboard all still work without it. Only
// broadcasting is lost, so this says so and carries on.
httpsServer.on('error', (error) => {
  console.error(
    `[server] could not listen on HTTPS port ${config.httpsPort} — ` +
      'camera broadcasting will be unavailable, everything else still works:',
    error,
  );
});

httpsServer.listen(config.httpsPort, () => {
  console.log(`Courtside Scoreboard HTTPS (camera) listener on port ${config.httpsPort}`);
});

// Lets a phone reach that HTTPS listener at config.mdnsHostname instead of
// the LAN IP — see mdns.ts for why (a name survives DHCP reassigning the
// IP between matches; an IP baked into a trusted cert does not).
publishMdns();
