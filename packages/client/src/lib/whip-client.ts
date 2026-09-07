/**
 * WHIP — WebRTC-HTTP Ingestion Protocol. How the court-side phone hands its
 * camera to Cloudflare.
 *
 * The whole protocol is one HTTP request: POST an SDP offer as
 * `application/sdp`, get an SDP answer back as the response body, and keep the
 * `Location` header so the session can be deleted on the way out. There is no
 * SDK to install and no signalling server involved — which is the point,
 * because this replaces a Firestore round trip per viewer with a single upload
 * that Cloudflare then fans out itself.
 */

/** How long to wait for ICE gathering before publishing anyway. */
const ICE_GATHER_TIMEOUT_MS = 2_000;

export interface WhipSession {
  stop: () => void;
}

export interface WhipOptions {
  /**
   * Called once if the published connection drops after it was established.
   *
   * WHIP has no reconnection of its own — a dropped session simply stops
   * transmitting, and on a phone on venue wifi that is a matter of when, not
   * if. Surfacing it lets the caller re-publish; without this the broadcast
   * dies silently for every viewer at the first blip.
   */
  onConnectionLost?: () => void;
}

/**
 * Wait until the browser has finished collecting ICE candidates, so the offer
 * we POST already contains them.
 *
 * WHIP supports trickle ICE, but only via a follow-up PATCH that not every
 * implementation honours. Sending a complete offer sidesteps the question
 * entirely and costs a fraction of a second. Capped by a timer because
 * gathering can hang on a network where some candidate type never resolves,
 * and a slightly incomplete offer still connects.
 */
function whenIceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * Publish `stream` to a WHIP endpoint.
 *
 * Rejects if Cloudflare refuses the offer, so the caller can fall back to the
 * peer-to-peer mesh rather than leaving the court transmitting into nothing.
 *
 * No `iceServers` are configured, matching Cloudflare's own example: the far
 * end is a public host, so the browser reaches it directly and neither STUN
 * nor a relay has anything to contribute.
 */
export async function publishViaWhip(
  publishUrl: string,
  stream: MediaStream,
  options: WhipOptions = {},
): Promise<WhipSession> {
  const pc = new RTCPeerConnection();

  // `sendonly` is required by Cloudflare — a `sendrecv` transceiver (the
  // default for addTrack) makes it expect a bidirectional session.
  stream.getTracks().forEach((track) => pc.addTransceiver(track, { direction: 'sendonly' }));

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await whenIceGathered(pc);

    // localDescription rather than `offer`, since it now carries the
    // candidates gathered above.
    const sdp = pc.localDescription?.sdp ?? offer.sdp;
    if (!sdp) throw new Error('WHIP publish failed: the browser produced no SDP offer');

    const response = await fetch(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp,
    });

    // Checked with `ok` rather than against 201: the WHIP draft specifies
    // Created, but Cloudflare does not document the status it actually returns.
    if (!response.ok) {
      throw new Error(`WHIP publish rejected (HTTP ${response.status})`);
    }

    const answer = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    // Registered only after the session is established, so a failure during
    // negotiation rejects (and is handled by the caller's fallback) rather
    // than also firing a reconnect.
    let notified = false;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' && pc.connectionState !== 'disconnected') return;
      // `stop()` closes the peer, which fires this handler again — and once
      // reported, the caller has already torn this session down.
      if (notified) return;
      notified = true;
      options.onConnectionLost?.();
    };

    // Relative per the spec, so it has to be resolved against the endpoint.
    const location = response.headers.get('Location');
    const sessionUrl = location ? new URL(location, publishUrl).toString() : null;

    return {
      stop() {
        // Cleared first: close() transitions the peer to 'closed' by way of
        // states this handler reacts to, which would report a loss the caller
        // itself just caused.
        pc.onconnectionstatechange = null;
        pc.close();
        // Tells Cloudflare the broadcast is over instead of leaving it to time
        // out — best effort, since this commonly runs as the tab is closing.
        if (sessionUrl)
          void fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
      },
    };
  } catch (error) {
    // Never leave a half-negotiated peer behind holding the camera tracks.
    pc.close();
    throw error;
  }
}
