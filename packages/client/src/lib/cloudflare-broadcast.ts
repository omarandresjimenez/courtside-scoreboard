import { doc, getFirestore, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';
import {
  appFor,
  type FirestoreSignalConfig,
  type InternetBroadcastHandle,
} from './firestore-signal.js';
import { publishViaWhip, type WhipSession } from './whip-client.js';
import type { CourtLiveInput } from './cloudflare-stream.js';

/**
 * The internet broadcast path that scales: publish once to Cloudflare, let
 * Cloudflare fan out.
 *
 * Interchangeable with broadcastToInternet() — same InternetBroadcastHandle —
 * because the caller picks one or the other and should not care which.
 * The difference that matters is the shape of the load: the mesh path opens a
 * peer connection *per viewer* from the phone and is capped at
 * MAX_INTERNET_VIEWERS for that reason, while this one is a single upload
 * regardless of whether two people or two hundred are watching.
 *
 * Viewers are told where to watch through the same `streams/{courtId}`
 * document the mesh path uses for presence — the court-side phone can reach
 * both the LAN server (for the publish URL) and Firestore, and an internet
 * viewer can reach only Firestore. Publishing the WHEP URL there is what
 * bridges the two without exposing the venue's server.
 */

/** Backoff between re-publish attempts after the upload drops. */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

export interface CloudflareBroadcastOptions {
  /** Notified when the upload is lost and when it comes back, so the
   *  broadcast screen can say so rather than showing a confident "live"
   *  while nothing is reaching Cloudflare. */
  onConnectedChange?: (connected: boolean) => void;
}

/**
 * Publish `stream` to the court's Cloudflare live input.
 *
 * Rejects if the very first publish fails, which is the caller's signal to
 * fall back to the peer mesh. Once established, later drops are handled here
 * by re-publishing rather than by rejecting — the camera is live and the
 * fallback moment has passed.
 */
export async function broadcastViaCloudflare(
  config: FirestoreSignalConfig,
  courtId: string,
  stream: MediaStream,
  input: CourtLiveInput,
  options: CloudflareBroadcastOptions = {},
): Promise<InternetBroadcastHandle> {
  const db: Firestore = getFirestore(appFor(config));
  const streamDoc = doc(db, 'streams', courtId);

  let session: WhipSession | null = null;
  let stopped = false;
  let paused = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Presence for viewers. `whepUrl` is the playback URL only — the publish URL
   * embeds Cloudflare's broadcast secret and must never be written here, where
   * the security rules make it world-readable.
   */
  const announce = (live: boolean) =>
    setDoc(
      streamDoc,
      {
        live,
        paused: live ? paused : false,
        whepUrl: live ? input.playbackUrl : null,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    ).catch(() => {
      // Presence is a convenience for the viewer's placeholder text, not a
      // correctness requirement — a failure here must not stop the broadcast.
    });

  /** One publish, wiring the loss handler that drives reconnection. */
  const publish = () =>
    publishViaWhip(input.publishUrl, stream, {
      onConnectionLost: () => {
        if (stopped) return;
        session?.stop();
        session = null;
        options.onConnectedChange?.(false);
        scheduleReconnect();
      },
    });

  function scheduleReconnect(): void {
    if (stopped || retryTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(() => {
      // No `stopped` check here: stop() cancels this timer, so it cannot fire
      // afterwards. The check that matters is below, once the publish has
      // resolved — that one *can* land after stop().
      retryTimer = null;
      publish()
        .then((next) => {
          // stop() can land while the publish is in flight. Without this the
          // new session would keep uploading with nothing left holding it.
          if (stopped) {
            next.stop();
            return;
          }
          session = next;
          attempt = 0;
          options.onConnectedChange?.(true);
          void announce(true);
        })
        .catch(() => {
          // Keep trying: the camera is still running and the court still
          // expects to be on air. The delay is capped, so this settles into a
          // slow retry rather than a hot loop.
          scheduleReconnect();
        });
    }, delay);
  }

  // Not wrapped in try/catch: a failure here is exactly what tells the caller
  // to use the mesh instead, so it must propagate.
  session = await publish();
  void announce(true);

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      session?.stop();
      session = null;
      void announce(false);
    },

    /**
     * Always 0: Cloudflare reports no viewer count for WebRTC broadcasts, and
     * an invented number would be worse than none. It is also far less
     * interesting here than on the mesh path — where the count is a warning
     * about the phone's uplink — because this upload costs the same whatever
     * the audience.
     */
    viewerCount: () => 0,

    setPaused(next: boolean) {
      paused = next;
      // Only the flag is published. The camera track itself is disabled by the
      // LAN broadcaster handle, and both paths share one MediaStream, so the
      // picture stops for Cloudflare viewers at the same moment.
      void setDoc(streamDoc, { paused: next, updatedAt: serverTimestamp() }, { merge: true }).catch(
        () => {
          // A dropped pause notice is cosmetic; never break the broadcast.
        },
      );
    },
  };
}
