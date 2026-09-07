import { Router } from 'express';
import {
  getLiveInputForCourt,
  isStreamConfigured,
  isStreamEnabledRemotely,
} from '../integrations/cloudflare-stream.js';

export const streamInputRouter = Router();

/**
 * The Cloudflare live input for a court: where the phone publishes, and where
 * viewers subscribe.
 *
 * Unauthenticated on the same basis as /turn-credentials: the broadcaster page
 * is opened from a QR code by whoever is running the court, with no login to
 * hang auth off, and this server is LAN-only (see the warning in
 * docs/STREAMING_UPGRADE.md against tunnelling port 3000 to the internet).
 *
 * That LAN-only property is doing more work here than it does for TURN, because
 * `publishUrl` embeds Cloudflare's broadcast secret. Anyone who can reach this
 * endpoint can transmit to the court's input. Two mitigations: it is reachable
 * only from inside the venue's network, and a leaked URL is revoked by rotating
 * the input's keys in the Cloudflare dashboard rather than by rebuilding
 * anything here.
 *
 * Always 200, even unconfigured — `configured: false` means "no Cloudflare
 * available", which the client handles by falling back to the Firestore peer
 * mesh. An error status would make a missing optional feature look like a
 * broken endpoint.
 *
 * `enabled` reports the remote off-switch (see isStreamEnabledRemotely). It is
 * separate from `configured` on purpose: "the operator turned this off" and
 * "this was never set up" both fall back to the mesh, but only one of them is
 * worth investigating, and a single flag would make them indistinguishable
 * from the client's logs.
 *
 * Checked before the live input is fetched, so a disabled feature costs no
 * Cloudflare API call and — more to the point — cannot create a new live input
 * on an account the operator has just decided to stop spending on.
 */
streamInputRouter.get('/stream-input/:courtId', async (req, res) => {
  const configured = isStreamConfigured();
  const enabled = await isStreamEnabledRemotely();

  const input = configured && enabled ? await getLiveInputForCourt(req.params.courtId) : null;

  res.json({
    configured,
    enabled,
    publishUrl: input?.publishUrl ?? null,
    playbackUrl: input?.playbackUrl ?? null,
  });
});
