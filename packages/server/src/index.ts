import https from 'node:https';
import { generate } from 'selfsigned';
import { createApp } from './app.js';
import { config } from './config.js';

const { app, httpServer, io } = createApp();

httpServer.listen(config.port, () => {
  console.log(`Courtside Scoreboard server listening on port ${config.port}`);
});

// Phones need a secure context to use the camera (see StreamBroadcast),
// which a plain http:// LAN address never satisfies — this self-signed
// HTTPS listener serves the exact same app so the broadcast link works
// without a separate reverse proxy. Browsers show a one-time "not private"
// warning for the self-signed cert, which is expected on a LAN-only tool.
const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
  notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
  algorithm: 'sha256',
});
const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
io.attach(httpsServer);
httpsServer.listen(config.httpsPort, () => {
  console.log(`Courtside Scoreboard HTTPS (camera) listener on port ${config.httpsPort}`);
});
