import { useParams, useSearchParams } from 'react-router-dom';
import { useMatchState } from '../lib/useMatchState.js';

/** Set 04's umpire "live scoring" screen. */
export function UmpireScreen() {
  const { matchId } = useParams<{ matchId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const { state, connected, error, addPoint, undoLastPoint } = useMatchState(
    { role: 'umpire', matchId: matchId ?? '', token },
    `umpire:${matchId}`,
  );

  if (!matchId || !token) {
    return <p className="screen-message">This umpire link is missing its match ID or token.</p>;
  }
  if (error) return <p className="screen-message">{error}</p>;
  if (!state) return <p className="screen-message">Connecting…</p>;

  const { match, derived } = state;
  const playerName = (side: 'A' | 'B') =>
    match.players
      .filter((p) => p.side === side)
      .map((p) => p.name)
      .join(' / ') || side;

  return (
    <main className="umpire-screen">
      <p className="connection-status">{connected ? 'Live' : 'Reconnecting…'}</p>

      {derived.matchWinner ? (
        <h1>{playerName(derived.matchWinner)} wins the match</h1>
      ) : (
        <>
          <h1>Set {derived.currentSet.setNumber}</h1>
          <div className="score-row">
            <button type="button" onClick={() => addPoint('A')}>
              {playerName('A')}: {derived.currentSet.scoreA}
            </button>
            <button type="button" onClick={() => addPoint('B')}>
              {playerName('B')}: {derived.currentSet.scoreB}
            </button>
          </div>
          {derived.onInterval && <p className="banner">Interval</p>}
          <button type="button" onClick={undoLastPoint}>
            Undo last point
          </button>
        </>
      )}

      <p className="sets-summary">
        Sets — {playerName('A')} {derived.setsWon.A} : {derived.setsWon.B} {playerName('B')}
      </p>
    </main>
  );
}
