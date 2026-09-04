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
  const [hasStream, setHasStream] = useState(false);
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!courtId) return;
    const handle = startViewing(courtId, (stream) => {
      if (videoRef.current) videoRef.current.srcObject = stream;
      setHasStream(stream !== null);
    });
    return () => handle.stop();
  }, [courtId]);

  if (!courtId) return <p className="screen-message">Missing court ID.</p>;
  if (error && !state) return <p className="screen-message">Waiting for match…</p>;
  if (!state) return <p className="screen-message">Connecting…</p>;

  const { match, derived } = state;

  const playerName = (side: 'A' | 'B') =>
    match.players
      .filter((p) => p.side === side)
      .map((p) => p.name.split(/\s+/)[0] || p.shortName)
      .join(' / ') || side;

  const scoreSets = derived.matchWinner
    ? derived.sets
    : [
        ...derived.sets.filter((set) => set.setNumber !== derived.currentSet.setNumber),
        derived.currentSet,
      ];

  const showPlaceholder = !hasStream;

  return (
    <main className="stream-screen">
      {isFromCache && <p className="banner">Reconnecting…</p>}

      <div className="stream-video-container">
        {showPlaceholder && (
          <div className="stream-placeholder">
            <p>Waiting for the court to start streaming…</p>
          </div>
        )}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="stream-image"
          style={{ display: showPlaceholder ? 'none' : 'block' }}
        />
      </div>

      <div className="stream-score-overlay">
        <div className="stream-score-header">
          <span className="summary-pill">{match.courtLabel ?? 'Court'}</span>
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

        {derived.matchWinner && (
          <p className="stream-winner">
            <strong>{playerName(derived.matchWinner)} wins</strong>
          </p>
        )}
      </div>
    </main>
  );
}
