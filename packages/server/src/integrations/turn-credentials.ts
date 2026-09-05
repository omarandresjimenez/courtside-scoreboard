/**
 * Cloudflare Realtime TURN credentials.
 *
 * Why this lives on the server: a TURN key is a long-term secret that can mint
 * unlimited credentials, and Cloudflare's own guidance is to keep it server
 * side. The browser gets only a short-lived username/credential pair, never
 * the key — so a viewer who reads the page source cannot spend the quota.
 *
 * Why TURN is needed at all: STUN only tells a peer its own public address; it
 * cannot forward packets. When either peer is behind symmetric NAT or carrier
 * CGNAT — normal on mobile data, common on corporate wifi — no direct path
 * exists and the connection dies with `connectionState === 'failed'` after
 * signalling has apparently succeeded. A relay is the only fix.
 *
 * Only the broadcaster needs these. In ICE, one side allocating a relay
 * candidate is enough: the viewer simply connects to that relayed address.
 * That keeps every credential off the public viewer page entirely.
 */

const CREDENTIAL_TTL_SECONDS = 86_400; // 24h — must outlast any single match.

/**
 * Refresh this long before expiry rather than at it. A broadcast that starts
 * just before the cached pair lapses would otherwise hand the browser
 * credentials that die mid-match.
 */
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // 1h

/** The subset of RTCIceServer that crosses the wire. */
export interface IceServer {
  urls: string[] | string;
  username?: string;
  credential?: string;
}

let cached: { iceServers: IceServer[]; expiresAt: number } | null = null;

/** Test seam — module-level cache would otherwise leak between cases. */
export function resetTurnCredentialCache(): void {
  cached = null;
}

export function isTurnConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN);
}

/**
 * Mint (or reuse) ICE servers including a Cloudflare TURN relay.
 *
 * Returns `[]` when unconfigured or when Cloudflare is unreachable — never
 * throws. Losing a relay degrades the internet path to STUN-only, which is
 * exactly today's behaviour; letting it throw would take down broadcasting
 * altogether, which is far worse.
 */
export async function getTurnIceServers(): Promise<IceServer[]> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!keyId || !apiToken) return [];
  if (cached && Date.now() < cached.expiresAt) return cached.iceServers;

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      },
    );

    if (!response.ok) {
      // Deliberately does not log the body: an error response can echo back
      // request details, and this token must never reach a log file.
      console.warn(
        `[TURN] Cloudflare refused to mint credentials (HTTP ${response.status}) - relay disabled`,
      );
      return [];
    }

    const body = (await response.json()) as { iceServers?: IceServer[] | IceServer };
    // The documented shape is an array, but a single object is accepted too
    // rather than silently dropping a valid relay on a shape change.
    const iceServers = Array.isArray(body.iceServers)
      ? body.iceServers
      : body.iceServers
        ? [body.iceServers]
        : [];

    if (iceServers.length === 0) {
      console.warn('[TURN] Cloudflare returned no ICE servers - relay disabled');
      return [];
    }

    cached = {
      iceServers,
      expiresAt: Date.now() + CREDENTIAL_TTL_SECONDS * 1000 - REFRESH_MARGIN_MS,
    };
    console.log('[TURN] Cloudflare relay credentials minted');
    return iceServers;
  } catch (error) {
    console.warn('[TURN] Could not reach Cloudflare - relay disabled:', error);
    return [];
  }
}
