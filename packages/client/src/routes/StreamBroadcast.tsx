import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { requestCameraStream } from '../lib/camera-stream.js';
import { startBroadcasting, type BroadcasterHandle } from '../lib/webrtc-stream.js';

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
  const [status, setStatus] = useState<BroadcastStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      broadcasterRef.current?.stop();
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
        Status: {status === 'live' ? 'Transmitting' : status === 'paused' ? 'Paused' : status === 'starting' ? 'Starting…' : status === 'error' ? 'Error' : 'Idle'}
      </p>
    </main>
  );
}
