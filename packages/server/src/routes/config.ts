import { Router } from 'express';
import { config } from '../config.js';

export const configRouter = Router();

// Public, unauthenticated: this is the same non-sensitive information the
// server already advertises to anyone on the LAN over mDNS (see
// integrations/mdns.ts) — the point of asking here is just to let the admin
// dashboard build a link that matches whatever this server actually
// advertises, rather than guessing or hard-coding "courtside.local" and
// silently drifting if MDNS_HOSTNAME is ever customised for a venue.
configRouter.get('/config', (_req, res) => {
  res.json({ mdnsHostname: config.mdnsHostname, mdnsEnabled: config.mdnsEnabled });
});
