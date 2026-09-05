import { Router } from 'express';
import { getTurnIceServers, isTurnConfigured } from '../integrations/turn-credentials.js';

export const turnRouter = Router();

/**
 * Short-lived ICE servers for the court-side broadcaster.
 *
 * Unauthenticated on purpose: the broadcaster page is opened from a QR code by
 * whoever is running the court, with no login to hang auth off. That is
 * acceptable because this server is LAN-only (see the warning in
 * STREAMING_UPGRADE.md against tunnelling port 3000 to the internet), the
 * credentials it hands out expire, and the underlying TURN key never leaves
 * the server.
 *
 * Always 200, even unconfigured — an empty list means "no relay available",
 * which the client handles by falling back to STUN. An error status here would
 * make a missing optional feature look like a broken endpoint.
 */
turnRouter.get('/turn-credentials', async (_req, res) => {
  const iceServers = await getTurnIceServers();
  res.json({ iceServers, configured: isTurnConfigured() });
});
