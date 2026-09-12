import { formatSideNames, RETIRE_REASON_HEADLINES } from '@courtside/shared';
import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useMatchState } from '../lib/useMatchState.js';
import { useStreamViewer } from '../lib/useStreamViewer.js';
import { StreamVideo } from '../lib/StreamVideo.js';
import { Clock } from '../lib/Clock.js';
import { useFullscreen } from '../lib/useFullscreen.js';
import { useWakeLock } from '../lib/useWakeLock.js';
import { FullscreenButton } from '../lib/FullscreenButton.js';

/** The internet/audience-facing screen: live video from the court-side
 * phone plus the score overlay. Generated alongside the broadcast link
 * whenever a match is created — see AdminDashboard's "streamViewLinkFor". */
export function StreamViewer() {
  const { courtId } = useParams<{ courtId: string }>();
  const { state, isFromCache, error } = useMatchState(
    { role: 'tv', courtId: courtId ?? '' },
    `stream-view:${courtId}`,
  );
  // Signalling, peer connection and socket lifetime all live in the hook;
  // this screen only renders what it reports.
  const { stream, isPaused } = useStreamViewer(courtId);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fullscreen = useFullscreen(containerRef, videoRef);
  // Only while something is actually playing — an idle viewer page has no
  // business keeping a phone awake.
  useWakeLock(stream !== null);

  if (!courtId) return <p className="screen-message">Missing court ID.</p>;

  const { match, derived } = state ?? {};

  const playerName = (side: 'A' | 'B') => formatSideNames(match?.players ?? [], side);

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

      <div className="stream-video-container" ref={containerRef}>
        {showPlaceholder && (
          <div className="stream-placeholder">
            <p>Waiting for the court to start streaming…</p>
          </div>
        )}
        {!showPlaceholder && isPaused && (
          /* role="status" so a screen reader announces the pause too — the
             visual cue alone leaves a non-sighted viewer with silence and no
             explanation. */
          <div className="stream-paused-overlay" role="status">
            <div className="stream-paused-card">
              <strong>Camera paused</strong>
              <span>
                Nothing is wrong with your connection — the court has paused the camera. Video
                resumes automatically.
              </span>
            </div>
          </div>
        )}
        <StreamVideo stream={stream} className="stream-image" ref={videoRef} />
        {stream && <FullscreenButton state={fullscreen} />}
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
            {(match?.category ?? match?.matchType) && (
              <span className={`summary-pill${match?.category ? ' category-pill' : ''}`}>
                {match?.category ?? match?.matchType}
              </span>
            )}
            {/* Isolated so its per-second tick re-renders two digits, not the
                video container (see Clock.tsx). */}
            <Clock className="summary-pill" />
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
              {derived.retiredSide &&
                ` — ${playerName(derived.retiredSide)} ${RETIRE_REASON_HEADLINES[derived.retireReason ?? 'RETIREMENT']}`}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
