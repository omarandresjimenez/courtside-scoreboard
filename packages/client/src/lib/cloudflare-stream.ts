/**
 * Ask the local server whether this court has a Cloudflare live input.
 *
 * Mirrors turn-credentials.ts, and for the same reason: the Cloudflare API
 * token can create and delete inputs on the whole account, so it stays on the
 * server and the browser only ever receives the two URLs for its own court.
 *
 * Never rejects. No Cloudflare — unconfigured, unreachable, or an error
 * response — resolves to null, and the caller falls back to the Firestore peer
 * mesh, which is exactly today's behaviour. Throwing would stop the broadcast
 * from starting, which is far worse than a broadcast that reaches fewer
 * viewers.
 */

export interface CourtLiveInput {
  /** WHIP ingest URL. A credential — see the server route's comment. Never
   *  write this to Firestore or show it on a viewer page. */
  publishUrl: string;
  /** WHEP playback URL, published to viewers via the stream document. */
  playbackUrl: string;
}

export async function fetchCourtLiveInput(courtId: string): Promise<CourtLiveInput | null> {
  try {
    const response = await fetch(`/api/stream-input/${encodeURIComponent(courtId)}`);
    if (!response.ok) {
      console.warn(`[stream] server returned HTTP ${response.status}; using the peer mesh`);
      return null;
    }

    const body = (await response.json()) as {
      configured?: boolean;
      enabled?: boolean;
      publishUrl?: string | null;
      playbackUrl?: string | null;
    };

    if (!body.configured) {
      console.info('[stream] Cloudflare Stream not configured; using the peer mesh');
      return null;
    }
    // Deliberately turned off by the operator (see the server's remote
    // off-switch), not a fault — logged as information, and distinctly from
    // "never configured", so the two are told apart in a browser console.
    if (body.enabled === false) {
      console.info('[stream] Cloudflare Stream disabled remotely; using the peer mesh');
      return null;
    }
    if (!body.publishUrl || !body.playbackUrl) {
      console.warn('[stream] Cloudflare is configured but returned no live input for this court');
      return null;
    }

    console.info('[stream] Cloudflare live input available for this court');
    return { publishUrl: body.publishUrl, playbackUrl: body.playbackUrl };
  } catch (error) {
    console.warn('[stream] could not reach the live-input endpoint; using the peer mesh:', error);
    return null;
  }
}
