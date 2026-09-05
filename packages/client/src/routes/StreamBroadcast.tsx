import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useCameraBroadcast } from '../lib/useCameraBroadcast.js';
import { StreamVideo } from '../lib/StreamVideo.js';
import { useFullscreen } from '../lib/useFullscreen.js';
import { useWakeLock } from '../lib/useWakeLock.js';
import { FullscreenButton } from '../lib/FullscreenButton.js';

const STATUS_LABELS: Record<string, string> = {
  live: 'Transmitting',
  paused: 'Paused',
  starting: 'Starting…',
  error: 'Error',
  idle: 'Idle',
};

/** The court-side broadcaster: a plain camera control panel (no score) that
 * a phone at the court opens to transmit video. Paired with StreamViewer,
 * which is what internet viewers watch.
 *
 * Presentational only — the camera, the LAN mesh and the internet mesh all
 * live in useCameraBroadcast. */
export function StreamBroadcast() {
  const { courtId } = useParams<{ courtId: string }>();
  const { status, errorMessage, internetViewers, stream, start, togglePause, stop } =
    useCameraBroadcast(courtId);
  const screenRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // The whole panel, not just the preview: the operator still needs Pause and
  // Stop while fullscreen.
  const fullscreen = useFullscreen(screenRef, videoRef);
  // A sleeping phone suspends camera capture and kills the broadcast, which
  // looks from outside exactly like a crash.
  useWakeLock(status === 'live' || status === 'paused');

  if (!courtId) return <p className="screen-message">Missing court ID.</p>;

  const isLiveOrPaused = status === 'live' || status === 'paused';

  return (
    <main className="broadcast-screen" ref={screenRef}>
      <h1>Court transmission</h1>
      <p className="broadcast-subtitle">Court {courtId}</p>

      <div className="broadcast-preview-container">
        <StreamVideo stream={stream} className="broadcast-preview" ref={videoRef} />
        {isLiveOrPaused && <FullscreenButton state={fullscreen} />}
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
          <button type="button" onClick={() => void start()} disabled={status === 'starting'}>
            {status === 'starting' ? 'Starting…' : '📹 Start transmission'}
          </button>
        ) : (
          <>
            <button type="button" onClick={togglePause}>
              {status === 'paused' ? '▶️ Resume' : '⏸️ Pause'}
            </button>
            <button type="button" className="danger-button" onClick={stop}>
              ⏹️ Stop
            </button>
          </>
        )}
      </div>

      <p className="broadcast-status" role="status">
        Status: {STATUS_LABELS[status]}
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
