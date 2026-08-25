import { useParams } from 'react-router-dom';
import { useMatchState } from '../lib/useMatchState.js';

/** Set 04's view-only broadcast-style scoreboard, tied to a court (Set 08). */
export function TvScreen() {
  const { courtId } = useParams<{ courtId: string }>();
  const { state, isFromCache, error } = useMatchState(
    { role: 'tv', courtId: courtId ?? '' },
    `tv:${courtId}`,
  );

  if (!courtId) return <p className="screen-message">This TV link is missing a court ID.</p>;
  if (error && !state) return <p className="screen-message">Waiting for a match on this court…</p>;
  if (!state) return <p className="screen-message">Connecting…</p>;

  const { match, derived } = state;
  const playerName = (side: 'A' | 'B') =>
    match.players
      .filter((p) => p.side === side)
      .map((p) => p.shortName)
      .join(' / ') || side;

  return (
    <main className="tv-screen">
      {isFromCache && <p className="banner">Reconnecting — showing last known score</p>}

      {derived.matchWinner ? (
        <h1>{playerName(derived.matchWinner)} wins the match</h1>
      ) : (
        <>
          <div className="tv-score">
            <span>{playerName('A')}</span>
            <span className="tv-score-number">{derived.currentSet.scoreA}</span>
            <span className="tv-score-number">{derived.currentSet.scoreB}</span>
            <span>{playerName('B')}</span>
          </div>
          {derived.onInterval && <p className="banner">Interval</p>}
        </>
      )}

      <ol className="set-history">
        {derived.sets
          .filter((set) => set.winner)
          .map((set) => (
            <li key={set.setNumber}>
              Set {set.setNumber}: {set.scoreA}–{set.scoreB}
            </li>
          ))}
      </ol>
    </main>
  );
}
