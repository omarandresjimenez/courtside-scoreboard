import { INTERNET_ICE_SERVERS } from './ice-config.js';

/**
 * Ask the local server for a short-lived TURN relay, and combine it with the
 * static STUN list.
 *
 * The relay credentials are minted server-side (see the server's
 * integrations/turn-credentials.ts) because the Cloudflare TURN *key* is a
 * long-term secret that must never reach a browser. Only the broadcaster
 * fetches these: in ICE, one side offering a relay candidate is enough for the
 * other to connect through it, so the public viewer page needs no credentials
 * at all.
 *
 * Never rejects. A missing or unreachable relay degrades the internet path to
 * STUN-only — today's behaviour — whereas throwing would stop the broadcast
 * from starting, which is a far worse outcome than a viewer who cannot
 * traverse their NAT.
 */
export async function fetchInternetIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch('/api/turn-credentials');
    if (!response.ok) {
      console.warn(`[turn] server returned HTTP ${response.status}; using STUN only`);
      return INTERNET_ICE_SERVERS;
    }

    const body = (await response.json()) as { iceServers?: RTCIceServer[] };
    const relays = Array.isArray(body.iceServers) ? body.iceServers : [];
    if (relays.length === 0) {
      console.warn(
        '[turn] no relay configured on the server; using STUN only. ' +
          'Viewers behind symmetric NAT (mobile data) will not connect.',
      );
      return INTERNET_ICE_SERVERS;
    }

    console.info(`[turn] relay available (${relays.length} entries)`);
    // Static STUN first: ICE tries cheaper candidate types before a relay
    // anyway, and keeping them means a lost relay never leaves the list empty.
    return [...INTERNET_ICE_SERVERS, ...relays];
  } catch (error) {
    console.warn('[turn] could not reach the credential endpoint; using STUN only:', error);
    return INTERNET_ICE_SERVERS;
  }
}
