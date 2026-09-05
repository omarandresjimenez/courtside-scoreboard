import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { requestCameraStream } from '../lib/camera-stream.js';
import { startBroadcasting, type BroadcasterHandle } from '../lib/webrtc-stream.js';
import { broadcastToInternet, type InternetBroadcastHandle } from '../lib/firestore-signal.js';
import { firebaseConfig } from '../lib/firebase-config.js';

type BroadcastStatus = 'idle' | 'starting' | 'live' | 'paused' | 'error';

function cameraErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError') {
      return 'Camera permission was denied. Allow camera access in your browser settings and try again.';
    }
    if (err.name === 'NotFoundError') {
      return 'No camera was found on this device.';
    }
    return err.message;
  }
  return 'Failed to access the camera.';
}

/** The court-side broadcaster: a plain camera control panel (no score) that
 * a phone at the court opens to transmit video. Paired with StreamViewer,
 * which is what internet viewers watch. */
export function StreamBroadcast() {
  const { courtId } = useParams<{ courtId: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const broadcasterRef = useRef<BroadcasterHandle | null>(null);
  const internetRef = useRef<InternetBroadcastHandle | null>(null);
  const [status, setStatus] = useState<BroadcastStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [internetViewers, setInternetViewers] = useState(0);

  useEffect(() => {
    return () => {
      broadcasterRef.current?.stop();
      internetRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function handleStart() {
    if (!courtId) return;
    setErrorMessage(null);
    setStatus('starting');
    try {
      const stream = await requestCameraStream();
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      broadcasterRef.current = startBroadcasting(courtId, stream);
      // Second, independent signalling path for viewers watching from outside
      // the venue (see firestore-signal.ts). Run alongside the LAN one rather
      // than instead of it: the Socket.io path is the only one that still works
      // when the venue has no internet uplink, which is the situation this app
      // is built to survive. Failure here must not take the LAN broadcast down
      // with it, hence the try/catch.
      try {
        internetRef.current = broadcastToInternet(
          firebaseConfig,
          courtId,
          stream,
          setInternetViewers,
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
  }

  function handlePauseResume() {
    if (!broadcasterRef.current) return;
    const nextPaused = status !== 'paused';
    broadcasterRef.current.setVideoEnabled(!nextPaused);
    setStatus(nextPaused ? 'paused' : 'live');
  }

  function handleStop() {
    broadcasterRef.current?.stop();
    broadcasterRef.current = null;
    internetRef.current?.stop();
    internetRef.current = null;
    setInternetViewers(0);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStatus('idle');
  }

  if (!courtId) return <p className="screen-message">Missing court ID.</p>;

  const isLiveOrPaused = status === 'live' || status === 'paused';

  return (
    <main className="broadcast-screen">
      <h1>Court transmission</h1>
      <p className="broadcast-subtitle">Court {courtId}</p>

      <div className="broadcast-preview-container">
        <video ref={videoRef} autoPlay playsInline muted className="broadcast-preview" />
        {!isLiveOrPaused && (
          <div className="broadcast-preview-placeholder">
            <p>Camera preview appears here once transmission starts.</p>
          </div>
        )}
        {status === 'paused' && (
          <div className="broadcast-preview-overlay">
            <p>Paused</p>
          </div>
        )}
      </div>

      {errorMessage && <p className="field-error">{errorMessage}</p>}

      <div className="broadcast-controls">
        {!isLiveOrPaused ? (
          <button type="button" onClick={() => void handleStart()} disabled={status === 'starting'}>
            {status === 'starting' ? 'Starting…' : '📹 Start transmission'}
          </button>
        ) : (
          <>
            <button type="button" onClick={handlePauseResume}>
              {status === 'paused' ? '▶️ Resume' : '⏸️ Pause'}
            </button>
            <button type="button" className="danger-button" onClick={handleStop}>
              ⏹️ Stop
            </button>
          </>
        )}
      </div>

      <p className="broadcast-status" role="status">
        Status:{' '}
        {status === 'live'
          ? 'Transmitting'
          : status === 'paused'
            ? 'Paused'
            : status === 'starting'
              ? 'Starting…'
              : status === 'error'
                ? 'Error'
                : 'Idle'}
        {isLiveOrPaused && (
          <>
            {' · '}
            {/* Each internet viewer is a separate encoded upload from this
                phone, so this number is the thing to watch if the picture
                starts degrading — not a vanity counter. */}
            🌐 {internetViewers} internet viewer{internetViewers === 1 ? '' : 's'}
          </>
        )}
      </p>
    </main>
  );
}
