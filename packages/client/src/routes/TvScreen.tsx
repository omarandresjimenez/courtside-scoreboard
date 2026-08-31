import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMatchState } from '../lib/useMatchState.js';

function formatElapsedTime(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt) return null;
  const endTime = completedAt ? Date.parse(completedAt) : Date.now();
  const elapsedSeconds = Math.max(0, Math.round((endTime - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes} min ${seconds} sec`;
}

/** Set 04's view-only broadcast-style scoreboard, tied to a court (Set 08). */
export function TvScreen() {
  const { courtId } = useParams<{ courtId: string }>();
  const { state, isFromCache, error } = useMatchState(
    { role: 'tv', courtId: courtId ?? '' },
    `tv:${courtId}`,
  );

  // Re-renders once a second so the wall clock advances. Runs before the
  // guards below, because hooks cannot be conditional.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!courtId) return <p className="screen-message">This TV link is missing a court ID.</p>;
  if (error && !state) return <p className="screen-message">Waiting for a match on this court…</p>;
  if (!state) return <p className="screen-message">Connecting…</p>;

  const { match, derived } = state;
  const scoreSets = derived.matchWinner
    ? derived.sets
    : [
        ...derived.sets.filter((set) => set.setNumber !== derived.currentSet.setNumber),
        derived.currentSet,
      ];
  const elapsed = formatElapsedTime(match.startedAt, match.completedAt);
  const teamLabel = (side: 'A' | 'B') => {
    const team = match.teams?.[side];
    return [team?.name, team?.country].filter(Boolean).join(' · ');
  };
  const playerName = (side: 'A' | 'B') =>
    match.players
      .filter((p) => p.side === side)
      .map((p) => p.name.split(/\s+/)[0] || p.shortName)
      .join(' / ') || side;
  const serverPlayer =
    derived.serve.serverPlayerId &&
    match.players.find((player) => player.playerId === derived.serve.serverPlayerId);
  const servingPlayerName = (side: 'A' | 'B') => {
    if (derived.serve.servingSide !== side) return null;
    return serverPlayer ? serverPlayer.name.split(/\s+/)[0] : playerName(side);
  };

  return (
    <main className="tv-screen">
      {isFromCache && <p className="banner">Reconnecting — showing last known score</p>}

      <div className="tv-header">
        <span className="summary-pill">{match.matchType}</span>
        <span className="summary-pill">{match.courtLabel ?? 'Court'}</span>
        <time className="summary-pill">
          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </div>

      <div
        className="tv-scoreboard"
        aria-label="Match score"
        style={{ '--set-count': scoreSets.length } as React.CSSProperties}
      >
        <div className="tv-set-labels" aria-hidden="true">
          <span />
          {scoreSets.map((set) => (
            <span key={set.setNumber} className={set.winner ? '' : 'current-set'}>
              Set {set.setNumber}
            </span>
          ))}
        </div>
        {(['A', 'B'] as const).map((side) => (
          <div
            className={`tv-player-row side-${side.toLowerCase()}${derived.matchWinner === side ? ' match-winner' : ''}`}
            key={side}
          >
            <span className="tv-player-name">
              {playerName(side)}
              {teamLabel(side) && <small className="team-identity">{teamLabel(side)}</small>}
              {!derived.matchWinner && servingPlayerName(side) && (
                <strong className="serve-marker">Serving</strong>
              )}
              {derived.retiredSide === side && <span className="retired-tag">Retired</span>}
            </span>
            {scoreSets.map((set) => (
              <strong
                key={set.setNumber}
                className={`${set.winner ? '' : 'current-set'}${set.winner === side ? ' set-score-winner' : ''}`}
              >
                {side === 'A' ? set.scoreA : set.scoreB}
              </strong>
            ))}
          </div>
        ))}
      </div>

      {elapsed && (
        <p className="tv-elapsed" aria-label="Elapsed match time">
          {elapsed}
        </p>
      )}

      {derived.matchWinner ? (
        <section className="match-complete" aria-live="polite">
          <h1>
            {playerName(derived.matchWinner)} wins the match
            {derived.retiredSide && ` — ${playerName(derived.retiredSide)} retired`}
          </h1>
          {elapsed && <p>Match time {elapsed}</p>}
          <button type="button" onClick={() => window.location.reload()}>
            Refresh display
          </button>
        </section>
      ) : (
        derived.interval && (
          <p className="banner">
            {derived.interval.kind === 'MID_GAME' ? 'Interval' : 'Game interval'}
          </p>
        )
      )}
    </main>
  );
}
