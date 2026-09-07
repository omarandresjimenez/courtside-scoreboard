/**
 * Cloudflare Stream Live inputs — the scalable path for internet viewers.
 *
 * Why this exists: the Firestore path (see the client's firestore-signal.ts)
 * is a WebRTC *mesh*. Every internet viewer costs the court-side phone a
 * separate encoded upload, so it is capped at MAX_INTERNET_VIEWERS and a
 * handful of viewers already saturates a phone uplink. Cloudflare inverts
 * that: the phone uploads **once** to a live input, and Cloudflare fans that
 * one stream out to every viewer from its own edge.
 *
 * Why WHIP/WHEP and not HLS: Cloudflare treats them as mutually exclusive —
 * "we do not yet support ... inputs using WHIP to be recorded and played
 * using HLS/DASH". HLS playback would require RTMP or SRT ingest, which a
 * browser cannot speak without a native encoder, and that would destroy the
 * whole point of this app's broadcaster (open a link on a phone, press
 * Start). So the phone publishes over WHIP and viewers subscribe over WHEP,
 * which is WebRTC end to end and lands under ~500ms of latency.
 *
 * Consequences of that choice, all deliberate:
 *   * No recording, and therefore no storage billed (Cloudflare does not
 *     record WebRTC broadcasts at all).
 *   * No server-reported viewer count — the broadcast screen shows one for
 *     the mesh path and cannot for this one.
 *
 * Like the TURN integration next door, nothing here ever throws: an
 * unconfigured or unreachable Cloudflare degrades to the existing Firestore
 * mesh, which is exactly today's behaviour.
 */

import { getCloudDb } from './cloud-sync.js';

/** Identifies which court a live input belongs to, so a restart re-adopts the
 *  input it made last time instead of creating a new one every boot. */
const META_KEY = 'courtsideCourtId';

/**
 * Remote off-switch: `config/streaming` in Firestore, field
 * `cloudflareStreamEnabled`.
 *
 * Cloudflare Stream is the one part of this app that costs money per minute
 * delivered, and the machine running the server sits on a venue LAN that
 * nobody can reach from outside. So the switch lives somewhere reachable from
 * a phone — edit the field in the Firebase console and the next broadcast uses
 * the free peer mesh instead.
 *
 * Deliberately *not* in the admin dashboard: this is an operator decision about
 * billing, not a match-day setting, and putting it on a screen that anyone at
 * the venue can open invites it being toggled by accident.
 *
 * Read by the Admin SDK, which bypasses security rules, so the document needs
 * no rule of its own — the catch-all denies every client both read and write,
 * and only the Firebase console can change it.
 */
const FLAG_COLLECTION = 'config';
const FLAG_DOC = 'streaming';
const FLAG_FIELD = 'cloudflareStreamEnabled';

/** Never let a slow Firestore read hold up a broadcast that is about to start. */
const FLAG_TIMEOUT_MS = 3_000;

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** How long to wait on Cloudflare before giving up and falling back. The
 *  broadcaster is holding a live camera while this runs. */
const REQUEST_TIMEOUT_MS = 8_000;

export interface LiveInput {
  uid: string;
  /**
   * WHIP ingest URL. **This is a credential** — Cloudflare's own words: "the
   * broadcast secret is part of this URL, so treat it like a stream key".
   * It goes to the court-side broadcaster and must never be published to
   * viewers or written to Firestore.
   */
  publishUrl: string;
  /** WHEP playback URL. Safe to hand to viewers; that is its purpose. */
  playbackUrl: string;
}

/**
 * One live input per court, reused for every match played on it.
 *
 * Per-court rather than per-match because the broadcast link is already one
 * stable address per court (see the court rows on the admin dashboard), and
 * because creating an input per match would pile up abandoned inputs in the
 * Cloudflare account for no benefit.
 */
const cache = new Map<string, LiveInput>();

/** Test seam — a module-level cache would otherwise leak between cases. */
export function resetLiveInputCache(): void {
  cache.clear();
}

export function isStreamConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_STREAM_API_TOKEN);
}

/**
 * Whether the remote off-switch permits using Cloudflare right now.
 *
 * Defaults to **true** in every uncertain case — the document does not exist,
 * the field is absent, cloud sync is not configured, the read fails or times
 * out. The switch exists to turn a working feature off on purpose; a Firestore
 * hiccup must not silently downgrade every court to the 5-viewer mesh.
 *
 * Read once per broadcast start, so it costs one document read per match and
 * takes effect on the next broadcast rather than mid-transmission.
 */
export async function isStreamEnabledRemotely(): Promise<boolean> {
  const db = getCloudDb();
  if (!db) return true;

  // Held so the loser of the race can be cancelled. Without this every call
  // leaves a live 3-second timer behind, which keeps the process awake — it
  // showed up as Jest refusing to exit after the suite finished.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      db.collection(FLAG_COLLECTION).doc(FLAG_DOC).get(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FLAG_TIMEOUT_MS);
      }),
    ]);
    if (!snapshot) {
      console.warn('[stream] timed out reading the remote off-switch - assuming enabled');
      return true;
    }

    const value = snapshot.exists ? (snapshot.data()?.[FLAG_FIELD] as unknown) : undefined;
    // Only an explicit `false` disables it. A missing document, a missing
    // field, or a value of some other type all mean "nobody has set this".
    if (value === false) {
      console.log('[stream] Cloudflare Stream disabled by the remote off-switch');
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[stream] could not read the remote off-switch - assuming enabled:', error);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

interface CloudflareLiveInputBody {
  uid?: string;
  meta?: Record<string, unknown>;
  webRTC?: { url?: string };
  webRTCPlayback?: { url?: string };
}

/** Pull the two URLs we need out of a Cloudflare live-input object, or null if
 *  it is not usable for WebRTC (an input created for RTMP has no webRTC URLs). */
function toLiveInput(body: CloudflareLiveInputBody | undefined): LiveInput | null {
  const uid = body?.uid;
  const publishUrl = body?.webRTC?.url;
  const playbackUrl = body?.webRTCPlayback?.url;
  if (!uid || !publishUrl || !playbackUrl) return null;
  return { uid, publishUrl, playbackUrl };
}

async function cloudflareFetch(
  path: string,
  init: RequestInit & { accountId: string; apiToken: string },
): Promise<unknown | null> {
  const { accountId, apiToken, ...rest } = init;
  try {
    const response = await fetch(`${API_BASE}/accounts/${encodeURIComponent(accountId)}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...rest.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Deliberately does not log the body, for the same reason as the TURN
      // integration: an error response can echo request details back, and this
      // token must never reach a log file.
      console.warn(`[stream] Cloudflare refused ${path} (HTTP ${response.status})`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn(`[stream] Could not reach Cloudflare for ${path}:`, error);
    return null;
  }
}

/** Find an input this server (or a previous run of it) already made for the court. */
async function findExistingInput(
  courtId: string,
  accountId: string,
  apiToken: string,
): Promise<LiveInput | null> {
  const listed = (await cloudflareFetch('/stream/live_inputs', {
    method: 'GET',
    accountId,
    apiToken,
  })) as { result?: CloudflareLiveInputBody[] } | null;

  const match = listed?.result?.find((input) => input.meta?.[META_KEY] === courtId);
  if (!match?.uid) return null;

  // The list response carries a reduced object — no webRTC URLs — so the
  // matching input has to be fetched in full before it is of any use.
  const full = (await cloudflareFetch(`/stream/live_inputs/${encodeURIComponent(match.uid)}`, {
    method: 'GET',
    accountId,
    apiToken,
  })) as { result?: CloudflareLiveInputBody } | null;

  return toLiveInput(full?.result);
}

async function createInput(
  courtId: string,
  accountId: string,
  apiToken: string,
): Promise<LiveInput | null> {
  const created = (await cloudflareFetch('/stream/live_inputs', {
    method: 'POST',
    accountId,
    apiToken,
    body: JSON.stringify({
      meta: { [META_KEY]: courtId, name: `Courtside court ${courtId}` },
      // Explicit even though it is the default: WebRTC broadcasts cannot be
      // recorded anyway, and stating it documents that this integration
      // consumes no Cloudflare storage and therefore incurs no storage bill.
      recording: { mode: 'off' },
    }),
  })) as { result?: CloudflareLiveInputBody } | null;

  const input = toLiveInput(created?.result);
  if (input) console.log(`[stream] Cloudflare live input created for court ${courtId}`);
  return input;
}

/**
 * The live input for a court, creating one on first use.
 *
 * Returns null when unconfigured or when Cloudflare cannot be reached — the
 * caller falls back to the Firestore mesh. Never throws.
 */
export async function getLiveInputForCourt(courtId: string): Promise<LiveInput | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
  if (!accountId || !apiToken) return null;

  const cached = cache.get(courtId);
  if (cached) return cached;

  // Adopt before creating. Without this, every server restart would leave
  // another orphaned input behind in the Cloudflare account.
  const input =
    (await findExistingInput(courtId, accountId, apiToken)) ??
    (await createInput(courtId, accountId, apiToken));

  if (input) cache.set(courtId, input);
  return input;
}
