import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMatchState } from '../lib/useMatchState.js';
import { startViewing } from '../lib/webrtc-stream.js';

/** The internet/audience-facing screen: live video from the court-side
 * phone plus the score overlay. Generated alongside the broadcast link
 * whenever a match is created — see AdminDashboard's "streamViewLinkFor". */
export function StreamViewer() {
  const { courtId } = useParams<{ courtId: string }>();
  const { state, isFromCache, error } = useMatchState(
    { role: 'tv', courtId: courtId ?? '' },
    `stream-view:${courtId}`,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!courtId) return;
    const handle = startViewing(courtId, setStream, setIsPaused);
    return () => handle.stop();
  }, [courtId]);

  // Attached here rather than straight from startViewing's callback: the
  // WebRTC track routinely arrives before the score state this screen also
  // waits on, and back then the <video> wasn't mounted yet — so `srcObject`
  // was assigned to a null ref and the stream was silently dropped for good
  // (nothing re-attached it once the element did appear). Driving it from an
  // effect means the assignment simply re-runs whenever either the stream or
  // the element changes, so neither ordering can lose the race.
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = stream;
    // Belt and braces alongside the `muted` attribute below: some older
    // browsers (smart TVs especially) don't act on the `autoPlay` attribute
    // when the source is a MediaStream assigned after mount, and simply sit
    // at a black first frame. Muted playback is always permitted, so this
    // can only fail for reasons worth seeing in the console.
    if (stream) {
      void element.play().catch((err) => {
        console.warn('Stream autoplay was blocked:', err);
      });
    }
  }, [stream]);

  if (!courtId) return <p className="screen-message">Missing court ID.</p>;

  const { match, derived } = state ?? {};

  const playerName = (side: 'A' | 'B') =>
    (match?.players ?? [])
      .filter((p) => p.side === side)
      .map((p) => p.name.split(/\s+/)[0] || p.shortName)
      .join(' / ') || side;

  const scoreSets = !derived
    ? []
    : derived.matchWinner
      ? derived.sets
      : [
          ...derived.sets.filter((set) => set.setNumber !== derived.currentSet.setNumber),
          derived.currentSet,
        ];

  const showPlaceholder = !stream;

  return (
    <main className="stream-screen">
      {isFromCache && <p className="banner">Reconnecting…</p>}

      <div className="stream-video-container">
        {showPlaceholder && (
          <div className="stream-placeholder">
            <p>Waiting for the court to start streaming…</p>
          </div>
        )}
        {!showPlaceholder && isPaused && (
          <div className="stream-paused-overlay">
            <p>Paused by the court</p>
          </div>
        )}
        {/* `muted` is load-bearing, not cosmetic: browsers refuse to autoplay
            audible media without a user gesture, and a viewer arriving by QR
            code has made no gesture — so `autoPlay` alone left the element
            stuck at paused/black while a perfectly healthy 30 FPS stream
            arrived behind it. The broadcast is video-only (see
            camera-stream.ts, `audio: false`), so muting costs nothing. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="stream-image"
          style={{ display: showPlaceholder ? 'none' : 'block' }}
        />
      </div>

      {/* The video above deliberately doesn't wait on this: a court can be
          transmitting before its match has been created (players warming up),
          and blanking the whole screen until a score exists would hide a feed
          that is already live. The overlay just isn't drawn until there's a
          match to draw. */}
      {!state ? (
        <p className="stream-score-pending">
          {error ? 'Waiting for a match on this court…' : 'Connecting…'}
        </p>
      ) : (
        <div className="stream-score-overlay">
          <div className="stream-score-header">
            <span className="summary-pill">{match?.courtLabel ?? 'Court'}</span>
            <time className="summary-pill">
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </div>

          <div
            className="stream-scoreboard"
            style={{ '--set-count': Math.min(scoreSets.length, 3) } as React.CSSProperties}
          >
            <div className="stream-set-labels" aria-hidden="true">
              <span />
              {scoreSets.slice(0, 3).map((set) => (
                <span key={set.setNumber} className={set.winner ? '' : 'current-set'}>
                  S{set.setNumber}
                </span>
              ))}
            </div>
            {(['A', 'B'] as const).map((side) => (
              <div key={side} className={`stream-player-row side-${side.toLowerCase()}`}>
                <span className="stream-player-name">{playerName(side)}</span>
                {scoreSets.slice(0, 3).map((set) => (
                  <strong key={set.setNumber} className={set.winner === side ? 'set-winner' : ''}>
                    {side === 'A' ? set.scoreA : set.scoreB}
                  </strong>
                ))}
              </div>
            ))}
          </div>

          {derived?.matchWinner && (
            <p className="stream-winner">
              <strong>{playerName(derived.matchWinner)} wins</strong>
            </p>
          )}
        </div>
      )}
    </main>
  );
}
