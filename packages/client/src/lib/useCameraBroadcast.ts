import { useCallback, useEffect, useRef, useState } from 'react';
import { cameraErrorMessage, requestCameraStream } from './camera-stream.js';
import { startBroadcasting, watchForMatchStart, type BroadcasterHandle } from './webrtc-stream.js';
import { broadcastToInternet, type InternetBroadcastHandle } from './firestore-signal.js';
import { firebaseConfig } from './firebase-config.js';
import { fetchInternetIceServers } from './turn-credentials.js';
import { fetchCourtLiveInput } from './cloudflare-stream.js';
import { broadcastViaCloudflare } from './cloudflare-broadcast.js';

export type BroadcastStatus = 'idle' | 'starting' | 'live' | 'paused' | 'error';

/**
 * Which internet path carried this broadcast.
 *
 * 'cloud' — published once to Cloudflare, which fans out to any number of
 *           viewers. 'mesh' — a peer connection per viewer straight from this
 *           phone, capped at MAX_INTERNET_VIEWERS. null — no internet path at
 *           all, LAN viewers only.
 */
export type InternetMode = 'cloud' | 'mesh' | null;

export interface CameraBroadcast {
  status: BroadcastStatus;
  errorMessage: string | null;
  /** Set when the umpire finalised the match on this court and the
   * broadcast was stopped automatically rather than by the Stop button —
   * distinct from errorMessage since nothing went wrong. Cleared on the
   * next Start. */
  autoStopNotice: string | null;
  internetViewers: number;
  internetMode: InternetMode;
  /** Cloud path only: false while the upload to Cloudflare is down and being
   *  retried. The mesh path leaves this true, having no single uplink to lose. */
  internetConnected: boolean;
  stream: MediaStream | null;
  /** `{ silent: true }` is for the auto-start-on-match-start path: a camera
   * failure (most commonly, permission was never granted on this phone)
   * falls back to idle with no visible error, since the operator was never
   * expecting anything to happen and can still press Start manually. */
  start: (options?: { silent?: boolean }) => Promise<void>;
  togglePause: () => void;
  stop: () => void;
}

/**
 * Owns the whole court-side broadcast: the camera, the LAN peer mesh, and the
 * internet peer mesh. The screen that uses it holds no MediaStream, socket or
 * RTCPeerConnection of its own — it renders `status` and calls the three
 * actions, which is the only way the teardown rules stay in one place.
 */
export function useCameraBroadcast(courtId: string | undefined): CameraBroadcast {
  const streamRef = useRef<MediaStream | null>(null);
  const broadcasterRef = useRef<BroadcasterHandle | null>(null);
  const internetRef = useRef<InternetBroadcastHandle | null>(null);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<BroadcastStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autoStopNotice, setAutoStopNotice] = useState<string | null>(null);
  const [internetViewers, setInternetViewers] = useState(0);
  const [internetMode, setInternetMode] = useState<InternetMode>(null);
  const [internetConnected, setInternetConnected] = useState(true);

  /** Release every resource without touching React state, so it is safe to
   *  call from an unmount cleanup as well as from the Stop button. */
  const releaseAll = useCallback(() => {
    broadcasterRef.current?.stop();
    broadcasterRef.current = null;
    internetRef.current?.stop();
    internetRef.current = null;
    // Stopping the tracks is what actually turns the camera light off; closing
    // the peer connections alone leaves the device captured.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => releaseAll, [releaseAll]);

  /** Reacts to the server telling this court's broadcaster the match it was
   * filming just got finalised — releases the camera the same way the Stop
   * button does, but leaves a distinct notice instead of an error. */
  const handleMatchFinalized = useCallback(() => {
    releaseAll();
    setStream(null);
    setInternetViewers(0);
    setInternetMode(null);
    setInternetConnected(true);
    setStatus('idle');
    setAutoStopNotice('Transmission stopped automatically — the match on this court has ended.');
  }, [releaseAll]);

  const start = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!courtId) return;
      if (!options.silent) {
        setErrorMessage(null);
        setAutoStopNotice(null);
        setStatus('starting');
      }
      try {
        const cameraStream = await requestCameraStream();
        streamRef.current = cameraStream;
        setStream(cameraStream);
        broadcasterRef.current = startBroadcasting(courtId, cameraStream, handleMatchFinalized);

        // Second, independent path for viewers outside the venue. Run alongside
        // the LAN one rather than instead of it: the Socket.io path is the only
        // one that still works when the venue has no internet uplink, which is
        // the situation this app is built to survive. A failure here must not
        // take the LAN broadcast down with it.
        //
        // Cloudflare first, peer mesh second. Both end up behind the same
        // handle; the difference is that Cloudflare takes one upload from this
        // phone and fans it out itself, while the mesh costs an upload per
        // viewer and is capped at MAX_INTERNET_VIEWERS because of it. The mesh
        // remains the fallback rather than being retired, since it needs no
        // account, no billing and no configuration.
        try {
          const input = await fetchCourtLiveInput(courtId);
          if (input) {
            try {
              internetRef.current = await broadcastViaCloudflare(
                firebaseConfig,
                courtId,
                cameraStream,
                input,
                { onConnectedChange: setInternetConnected },
              );
              setInternetConnected(true);
              setInternetMode('cloud');
            } catch (err) {
              // Reaching Cloudflare's API but failing to publish to it is the
              // one case worth falling back from — the court is holding a live
              // camera and the mesh will at least serve a few viewers.
              console.warn('Cloudflare publish failed; falling back to the peer mesh:', err);
            }
          }

          if (!internetRef.current) {
            // Awaited before broadcasting so the first viewer already has a relay
            // to work with; a peer created without one cannot gain it later
            // without renegotiating. Resolves to plain STUN if no relay exists,
            // so this never blocks the broadcast.
            const iceServers = await fetchInternetIceServers();
            internetRef.current = broadcastToInternet(
              firebaseConfig,
              courtId,
              cameraStream,
              setInternetViewers,
              iceServers,
            );
            setInternetMode('mesh');
          }
        } catch (err) {
          console.warn('Internet broadcast unavailable (LAN streaming unaffected):', err);
        }

        // Stop or unmount can land during any of the awaits above, and would
        // otherwise leave this phone publishing to Cloudflare with nothing left
        // holding the handle. Checked against the stream this call started, so
        // a *newer* broadcast is not torn down by an older call finishing late.
        if (streamRef.current !== cameraStream) {
          internetRef.current?.stop();
          internetRef.current = null;
          return;
        }

        setStatus('live');
      } catch (err) {
        if (options.silent) {
          // Most commonly: this phone never granted camera permission, so
          // there was never going to be a silent path — the operator still
          // presses Start manually, exactly as before this feature existed.
          console.warn(
            'Auto-start could not access the camera (falling back to manual Start):',
            err,
          );
          return;
        }
        console.error('Camera start failed:', err);
        setErrorMessage(cameraErrorMessage(err));
        setStatus('error');
      }
    },
    [courtId, handleMatchFinalized],
  );

  const togglePause = useCallback(() => {
    if (!broadcasterRef.current) return;
    // Deliberately not computed inside a setStatus updater: updaters must stay
    // pure, and React invokes them twice under StrictMode — which would emit
    // the pause signal to every viewer twice.
    const nextPaused = status !== 'paused';
    broadcasterRef.current.setVideoEnabled(!nextPaused);
    // Both paths carry the pause independently — a LAN viewer and an internet
    // viewer are told over different transports, and neither can learn it from
    // the other.
    internetRef.current?.setPaused(nextPaused);
    setStatus(nextPaused ? 'paused' : 'live');
  }, [status]);

  const stop = useCallback(() => {
    releaseAll();
    setStream(null);
    setInternetViewers(0);
    setInternetMode(null);
    setInternetConnected(true);
    setAutoStopNotice(null);
    setStatus('idle');
  }, [releaseAll]);

  // While idle (never started, or stopped/finalised back to idle), sit in a
  // lightweight standby connection listening for the umpire to start the
  // match — see watchForMatchStart. Torn down the moment a real broadcast
  // begins (status leaves 'idle'), and rebuilt automatically the next time
  // it returns to 'idle'.
  useEffect(() => {
    if (!courtId || status !== 'idle') return;
    const standby = watchForMatchStart(courtId, () => {
      // Stop listening before starting: a silent auto-start becoming the
      // live broadcaster is exactly the same "leave idle" transition as a
      // manual Start, and this guarantees it happens only once. Returning
      // the promise (rather than firing it and forgetting) just lets a
      // caller await it; the event itself has nothing to do with it.
      standby.stop();
      return start({ silent: true });
    });
    return () => standby.stop();
  }, [courtId, status, start]);

  return {
    status,
    errorMessage,
    autoStopNotice,
    internetViewers,
    internetMode,
    internetConnected,
    stream,
    start,
    togglePause,
    stop,
  };
}
