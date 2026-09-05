import { useCallback, useEffect, useRef, useState } from 'react';
import { cameraErrorMessage, requestCameraStream } from './camera-stream.js';
import { startBroadcasting, type BroadcasterHandle } from './webrtc-stream.js';
import { broadcastToInternet, type InternetBroadcastHandle } from './firestore-signal.js';
import { firebaseConfig } from './firebase-config.js';
import { fetchInternetIceServers } from './turn-credentials.js';

export type BroadcastStatus = 'idle' | 'starting' | 'live' | 'paused' | 'error';

export interface CameraBroadcast {
  status: BroadcastStatus;
  errorMessage: string | null;
  internetViewers: number;
  stream: MediaStream | null;
  start: () => Promise<void>;
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
  const [internetViewers, setInternetViewers] = useState(0);

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

  const start = useCallback(async () => {
    if (!courtId) return;
    setErrorMessage(null);
    setStatus('starting');
    try {
      const cameraStream = await requestCameraStream();
      streamRef.current = cameraStream;
      setStream(cameraStream);
      broadcasterRef.current = startBroadcasting(courtId, cameraStream);

      // Second, independent signalling path for viewers outside the venue (see
      // firestore-signal.ts). Run alongside the LAN one rather than instead of
      // it: the Socket.io path is the only one that still works when the venue
      // has no internet uplink, which is the situation this app is built to
      // survive. A failure here must not take the LAN broadcast down with it.
      try {
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
      } catch (err) {
        console.warn('Internet broadcast unavailable (LAN streaming unaffected):', err);
      }
      setStatus('live');
    } catch (err) {
      console.error('Camera start failed:', err);
      setErrorMessage(cameraErrorMessage(err));
      setStatus('error');
    }
  }, [courtId]);

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
    setStatus('idle');
  }, [releaseAll]);

  return { status, errorMessage, internetViewers, stream, start, togglePause, stop };
}
