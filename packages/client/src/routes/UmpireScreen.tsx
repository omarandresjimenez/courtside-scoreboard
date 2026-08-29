import { useState } from 'react';
import type { CourtPositions, Side } from '@courtside/shared';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMatchState } from '../lib/useMatchState.js';

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt) return null;
  const endTime = completedAt ? Date.parse(completedAt) : Date.now();
  const elapsedSeconds = Math.max(0, Math.round((endTime - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes} min ${seconds} sec`;
}

/** Set 04's umpire "live scoring" screen. */
export function UmpireScreen() {
  const { matchId } = useParams<{ matchId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [openingSide, setOpeningSide] = useState<Side>('A');
  const [firstServerPlayerId, setFirstServerPlayerId] = useState('');
  const [rightPlayerIds, setRightPlayerIds] = useState<Record<Side, string>>({ A: '', B: '' });

  const { state, connected, error, addPoint, undoLastPoint, startSet, resumeFromInterval } =
    useMatchState({ role: 'umpire', matchId: matchId ?? '', token }, `umpire:${matchId}`);

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
  const sidePlayers = (side: 'A' | 'B') => match.players.filter((p) => p.side === side);
  const serverPlayer =
    derived.serve.serverPlayerId &&
    match.players.find((player) => player.playerId === derived.serve.serverPlayerId);

  const servingText = (() => {
    if (!derived.serve.servingSide) return 'Serving: To be decided';

    const serveSideText = `Serving: Side ${derived.serve.servingSide}`;
    if (!serverPlayer) {
      return serveSideText;
    }

    if (match.matchType === 'doubles') {
      const courtPositions = derived.serve.courtPositions[derived.serve.servingSide];
      const positionText = courtPositions
        ? `${courtPositions.left === serverPlayer.playerId ? 'left' : 'right'} court`
        : 'service court';
      return `${serveSideText} · ${serverPlayer.name} (${positionText})`;
    }

    return `${serveSideText} · ${serverPlayer.name}`;
  })();

  const isReadyToScore = derived.serve.servingSide !== null;
  const canUndo =
    !derived.onInterval &&
    !derived.matchWinner &&
    derived.currentSet.scoreA + derived.currentSet.scoreB > 0;
  const scoreSets = derived.matchWinner
    ? derived.sets
    : [
        ...derived.sets.filter((set) => set.setNumber !== derived.currentSet.setNumber),
        derived.currentSet,
      ];
  const playerForSide = (side: Side) =>
    match.players.find((player) => player.playerId === firstServerPlayerId && player.side === side);
  const currentServer =
    serverPlayer ||
    (derived.serve.servingSide ? sidePlayers(derived.serve.servingSide)[0] : undefined);
  const serviceCourt = derived.serve.servingSide
    ? (derived.serve.servingSide === 'A' ? derived.currentSet.scoreA : derived.currentSet.scoreB) %
        2 ===
      0
      ? 'Right court'
      : 'Left court'
    : null;

  function startMatch(event: React.FormEvent) {
    event.preventDefault();
    const firstServer = playerForSide(openingSide);
    if (!firstServer) return;
    let courtPositions: CourtPositions | undefined;
    if (match.matchType === 'doubles') {
      const positions = (['A', 'B'] as const).reduce<CourtPositions>((layouts, side) => {
        const players = sidePlayers(side);
        const right = rightPlayerIds[side];
        const left = players.find((player) => player.playerId !== right)?.playerId;
        if (right && left) layouts[side] = { right, left };
        return layouts;
      }, {});
      if (!positions.A || !positions.B || positions[openingSide]?.right !== firstServer.playerId)
        return;
      courtPositions = positions;
    }
    startSet(openingSide, firstServer.playerId, courtPositions);
  }

  return (
    <main className="umpire-screen">
      <p className="connection-status" data-connected={connected}>
        {connected ? 'Live' : 'Reconnecting…'}
      </p>

      <div className="match-summary-card">
        <span className="summary-pill">{match.matchType}</span>
        <span className="summary-pill">
          {match.courtLabel ?? `Court ${match.assignedCourtId ?? 'Unassigned'}`}
        </span>
        <time className="summary-pill">
          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        {!derived.matchWinner && (
          <span className="summary-pill">Set {derived.currentSet.setNumber}</span>
        )}
        {!derived.matchWinner && <span className="summary-pill">{servingText}</span>}
      </div>

      {derived.matchWinner ? (
        <>
          <div
            className="tv-scoreboard umpire-scoreboard"
            aria-label="Match score"
            style={{
              gridTemplateColumns: `minmax(10rem, 1.5fr) repeat(${scoreSets.length}, minmax(4rem, 1fr))`,
            }}
          >
            <div className="tv-set-labels" aria-hidden="true">
              <span />
              {scoreSets.map((set) => (
                <span key={set.setNumber}>Set {set.setNumber}</span>
              ))}
            </div>
            {(['A', 'B'] as const).map((side) => (
              <div
                className={`tv-player-row side-${side.toLowerCase()}${derived.matchWinner === side ? ' match-winner' : ''}`}
                key={side}
              >
                <strong className="tv-player-name">{playerName(side)}</strong>
                {scoreSets.map((set) => (
                  <strong
                    key={set.setNumber}
                    className={set.winner === side ? 'set-score-winner' : ''}
                  >
                    {side === 'A' ? set.scoreA : set.scoreB}
                  </strong>
                ))}
              </div>
            ))}
          </div>
          <section className="match-complete">
            <h1>{playerName(derived.matchWinner)} wins the match</h1>
            {formatDuration(match.startedAt, match.completedAt) && (
              <p>Match time {formatDuration(match.startedAt, match.completedAt)}</p>
            )}
          </section>
        </>
      ) : (
        <>
          {!isReadyToScore ? (
            <form className="service-setup" onSubmit={startMatch}>
              <h1>Set opening service</h1>
              <fieldset>
                <legend>Who serves first?</legend>
                <div className="side-choice" role="radiogroup" aria-label="First serving side">
                  {(['A', 'B'] as const).map((side) => (
                    <label key={side}>
                      <input
                        type="radio"
                        name="opening-side"
                        value={side}
                        checked={openingSide === side}
                        onChange={() => {
                          setOpeningSide(side);
                          setFirstServerPlayerId('');
                        }}
                      />
                      Side {side}
                    </label>
                  ))}
                </div>
                {match.matchType === 'doubles' &&
                  (['A', 'B'] as const).map((side) => (
                    <label key={side}>
                      Side {side}, right service court
                      <select
                        value={rightPlayerIds[side]}
                        onChange={(event) =>
                          setRightPlayerIds({ ...rightPlayerIds, [side]: event.target.value })
                        }
                        required
                      >
                        <option value="">Choose player</option>
                        {sidePlayers(side).map((player) => (
                          <option key={player.playerId} value={player.playerId}>
                            {player.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                <label>
                  First server (right court)
                  <select
                    value={firstServerPlayerId}
                    onChange={(event) => setFirstServerPlayerId(event.target.value)}
                    required
                  >
                    <option value="">Choose player</option>
                    {sidePlayers(openingSide)
                      .filter(
                        (player) =>
                          match.matchType === 'singles' ||
                          player.playerId === rightPlayerIds[openingSide],
                      )
                      .map((player) => (
                        <option key={player.playerId} value={player.playerId}>
                          {player.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button type="submit">Start scoring</button>
              </fieldset>
            </form>
          ) : (
            <>
              <h1>Set {derived.currentSet.setNumber}</h1>
              <p className="service-callout">
                <strong>{currentServer?.name ?? `Side ${derived.serve.servingSide}`}</strong> to
                serve from <strong>{serviceCourt?.toLowerCase()}</strong>
              </p>
              <div className="score-row">
                <button type="button" onClick={() => addPoint('A')} disabled={derived.onInterval}>
                  {playerName('A')}: {derived.currentSet.scoreA}
                </button>
                <button type="button" onClick={() => addPoint('B')} disabled={derived.onInterval}>
                  {playerName('B')}: {derived.currentSet.scoreB}
                </button>
              </div>

              <div className="serve-breakdown">
                <div
                  className={`serve-box side-a${derived.serve.servingSide === 'A' ? ' serving-player' : ''}`}
                >
                  <span className="label">Side A</span>
                  <strong>
                    {sidePlayers('A')
                      .map((p) => p.name)
                      .join(' / ') || 'Unassigned'}
                  </strong>
                  {derived.serve.servingSide === 'A' && (
                    <span className="serve-marker">Serving now</span>
                  )}
                </div>
                <div
                  className={`serve-box side-b${derived.serve.servingSide === 'B' ? ' serving-player' : ''}`}
                >
                  <span className="label">Side B</span>
                  <strong>
                    {sidePlayers('B')
                      .map((p) => p.name)
                      .join(' / ') || 'Unassigned'}
                  </strong>
                  {derived.serve.servingSide === 'B' && (
                    <span className="serve-marker">Serving now</span>
                  )}
                </div>
              </div>

              <div className="umpire-actions">
                {derived.onInterval && (
                  <button type="button" className="banner" onClick={resumeFromInterval}>
                    Interval — tap to resume play
                  </button>
                )}
                {canUndo && (
                  <button type="button" onClick={undoLastPoint}>
                    Undo last point
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      <p className="sets-summary">
        Sets — {playerName('A')} {derived.setsWon.A} : {derived.setsWon.B} {playerName('B')}
      </p>
    </main>
  );
}
