import { useEffect, useState } from 'react';
import {
  umpireCall,
  type Side,
  type IntervalKind,
  INTERVAL_LABELS,
  formatSideNames,
  formatPlayerName,
} from '@courtside/shared';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMatchState } from '../lib/useMatchState.js';
import { CourtDiagram } from './CourtDiagram.js';
import { ConfirmDialog } from '../lib/ConfirmDialog.js';
import { formatCountdown, useCountdown } from '../lib/useCountdown.js';

const other = (side: Side): Side => (side === 'A' ? 'B' : 'A');

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt) return null;
  const endTime = completedAt ? Date.parse(completedAt) : Date.now();
  const elapsedSeconds = Math.max(0, Math.round((endTime - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes} min ${seconds} sec`;
}

/**
 * Which side is drawn on the left. Ends alternate every game, and the umpire
 * picks the game-1 arrangement during setup — so it is persisted per match
 * rather than held in state, or a mid-match refresh would silently mirror
 * the court under the umpire.
 */
const endsKey = (matchId: string) => `courtside:ends:${matchId}`;

function storedBaseLeftSide(matchId: string): Side {
  try {
    return localStorage.getItem(endsKey(matchId)) === 'B' ? 'B' : 'A';
  } catch {
    // Private mode / blocked storage — the default arrangement is fine.
    return 'A';
  }
}

function storeBaseLeftSide(matchId: string, side: Side) {
  try {
    localStorage.setItem(endsKey(matchId), side);
  } catch {
    // Non-fatal: ends are presentation only, the match still scores.
  }
}

/**
 * Set 04's umpire screen, rebuilt around a plan view of the court — see
 * docs/umpire-screen-spec.md for the reference behaviour this follows.
 */
/** Per-break wording for the banner and its confirm dialog. */
const BREAK_WORDING: Record<
  IntervalKind,
  { verb: string; action: string; title: string; noun: string }
> = {
  WARM_UP: {
    verb: 'skip',
    action: 'Skip warm-up',
    title: 'Skip the warm-up?',
    noun: 'warm-up',
  },
  MID_GAME: { verb: 'resume', action: 'Resume', title: 'Resume play?', noun: 'interval' },
  BETWEEN_GAMES: {
    verb: 'resume',
    action: 'Resume',
    title: 'Start the next game?',
    noun: 'interval',
  },
};

export function UmpireScreen() {
  const { matchId } = useParams<{ matchId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  // Setup-only state: how the umpire has arranged the court before the
  // opening serve. `rightCourtPlayer` is the player standing in each side's
  // right service court, which at nil-nil is by definition the first server.
  const [baseLeftSide, setBaseLeftSide] = useState<Side>(() => storedBaseLeftSide(matchId ?? ''));
  const [openingSide, setOpeningSide] = useState<Side>('A');
  const [rightCourtPlayer, setRightCourtPlayer] = useState<Record<Side, string>>({ A: '', B: '' });
  const [pendingAction, setPendingAction] = useState<'resume' | 'finish' | null>(null);
  // Re-renders once a second purely so the elapsed clock advances.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const {
    state,
    connected,
    error,
    addPoint,
    undoLastPoint,
    startSet,
    resumeFromInterval,
    retireMatch,
  } = useMatchState({ role: 'umpire', matchId: matchId ?? '', token }, `umpire:${matchId}`);

  // Read off the optional state: this hook has to run on every render,
  // including the ones that bail out at the guards just below.
  const pendingBreak = state?.derived.interval ?? null;
  const remaining = useCountdown(
    pendingBreak ? pendingBreak.seconds : null,
    `${state?.derived.currentSet.setNumber ?? 0}:${pendingBreak?.kind ?? 'none'}`,
  );

  if (!matchId || !token) {
    return <p className="screen-message">This umpire link is missing its match ID or token.</p>;
  }
  if (error) return <p className="screen-message">{error}</p>;
  if (!state) return <p className="screen-message">Connecting…</p>;

  const { match, derived } = state;
  const isDoubles = match.matchType === 'doubles';
  const sidePlayers = (side: Side) => match.players.filter((p) => p.side === side);
  const teamName = (side: Side) => formatSideNames(match.players, side, `Side ${side}`);
  const nameFor = (playerId: string) => {
    const player = match.players.find((p) => p.playerId === playerId);
    return player ? formatPlayerName(player) : '';
  };
  const scoreFor = (side: Side) =>
    side === 'A' ? derived.currentSet.scoreA : derived.currentSet.scoreB;

  // Ends change at every game, from whichever arrangement game 1 started in.
  const leftSide: Side =
    derived.currentSet.setNumber % 2 === 1 ? baseLeftSide : other(baseLeftSide);
  const rightSide = other(leftSide);

  const isReadyToScore = derived.serve.servingSide !== null;
  const breakNow = derived.interval;
  // A warm-up is *skipped*, the other two are *resumed* — the umpire is
  // cutting a break short in every case, but calling the warm-up "resume play"
  // would describe play that has not started yet.
  const breakWording = BREAK_WORDING[breakNow?.kind ?? 'MID_GAME'];
  // Points are locked during either kind of break; the umpire ends it.
  const scoringLocked = !isReadyToScore || breakNow !== null || derived.matchWinner !== null;
  const secondsLeft = remaining ?? 0;
  const elapsed = formatDuration(match.startedAt, match.completedAt);
  // Games actually played, newest state first — `derived.sets` already drops
  // the phantom trailing set once the match is decided.
  const summarySets = derived.sets.filter(
    (set) => set.winner !== null || set.scoreA + set.scoreB > 0,
  );
  const canUndo =
    !derived.onInterval &&
    !derived.matchWinner &&
    derived.currentSet.scoreA + derived.currentSet.scoreB > 0;

  const call = umpireCall({
    scoreA: derived.currentSet.scoreA,
    scoreB: derived.currentSet.scoreB,
    servingSide: derived.serve.servingSide,
    serviceOver: derived.serviceOver,
    onInterval: derived.onInterval,
    matchWinner: derived.matchWinner,
    config: match.scoringConfig,
    teamNames: { A: teamName('A'), B: teamName('B') },
    setsWon: derived.setsWon,
  });

  // ---- setup helpers -------------------------------------------------

  const rightPlayerFor = (side: Side) =>
    rightCourtPlayer[side] || sidePlayers(side)[0]?.playerId || '';
  const leftPlayerFor = (side: Side) =>
    sidePlayers(side).find((p) => p.playerId !== rightPlayerFor(side))?.playerId ?? '';

  function swapPartners(side: Side) {
    // Derived from `current`, not from the render-time closure: two quick
    // taps on a phone would otherwise both compute from the same stale
    // value, toggling twice and looking like the button does nothing.
    setRightCourtPlayer((current) => {
      const players = sidePlayers(side);
      // A half-filled doubles roster has nobody to swap with.
      if (players.length < 2) return current;
      const currentRight = current[side] || players[0]!.playerId;
      return { ...current, [side]: players.find((p) => p.playerId !== currentRight)!.playerId };
    });
  }

  function swapEnds() {
    const next = other(baseLeftSide);
    setBaseLeftSide(next);
    storeBaseLeftSide(matchId!, next);
  }

  // At nil-nil the serve is always from the right court, so whoever the
  // umpire has placed there is the first server — no separate picker needed.
  const setupPositions: Record<Side, { right: string; left: string }> = {
    A: { right: rightPlayerFor('A'), left: leftPlayerFor('A') },
    B: { right: rightPlayerFor('B'), left: leftPlayerFor('B') },
  };

  function startMatch() {
    const firstServerId = isDoubles
      ? setupPositions[openingSide].right
      : sidePlayers(openingSide)[0]?.playerId;
    if (!firstServerId) return;
    startSet(openingSide, firstServerId, isDoubles ? setupPositions : undefined);
  }

  // ---- render --------------------------------------------------------

  const teamLabel = (side: Side) => {
    const team = match.teams?.[side];
    return [team?.name, team?.country].filter(Boolean).join(' · ');
  };

  const teamRow = (side: Side) => (
    <div key={side} className={`umpire-team side-${side.toLowerCase()}`}>
      <span className="umpire-team-name">
        {teamName(side)}
        {teamLabel(side) && <small className="team-identity">{teamLabel(side)}</small>}
      </span>
      <span className="umpire-team-sets">{derived.setsWon[side]}</span>
      <span className="umpire-team-score">{scoreFor(side)}</span>
    </div>
  );

  const diagram = (
    <CourtDiagram
      matchType={match.matchType}
      leftSide={leftSide}
      courtPositions={isReadyToScore ? derived.serve.courtPositions : setupPositions}
      servingSide={isReadyToScore ? derived.serve.servingSide : openingSide}
      serverPlayerId={
        isReadyToScore ? derived.serve.serverPlayerId : setupPositions[openingSide].right
      }
      scoreFor={scoreFor}
      nameFor={nameFor}
      singlesNameFor={(side) => {
        const player = sidePlayers(side)[0];
        return player ? formatPlayerName(player) : '';
      }}
      overlayFor={
        isReadyToScore || !isDoubles
          ? undefined
          : (side) => (
              <button
                type="button"
                className="court-swap"
                onClick={() => swapPartners(side)}
                title={`Swap ${teamName(side)} service courts`}
                aria-label={`Swap ${teamName(side)} service courts`}
              >
                <span className="court-swap-glyph" aria-hidden="true">
                  ⇅
                </span>
                <span className="court-swap-label">Swap</span>
              </button>
            )
      }
    />
  );

  return (
    <main className="umpire-screen umpire-court-view">
      <p className="connection-status" data-connected={connected}>
        {connected ? 'Live' : 'Reconnecting…'}
      </p>

      <div className="umpire-meta">
        <span className="summary-pill">{match.courtLabel ?? 'Court'}</span>
        {/* Category over match type: "MS U19" already says singles. */}
        <span className={`summary-pill${match.category ? ' category-pill' : ''}`}>
          {match.category ?? match.matchType}
        </span>
      </div>

      <header className="umpire-teams">
        {teamRow(leftSide)}
        {teamRow(rightSide)}
      </header>

      {derived.matchWinner ? (
        // The court says nothing once the match is over — what the umpire
        // and players want now is the game-by-game record.
        <section className="match-complete">
          <h1>
            {teamName(derived.matchWinner)} wins the match
            {derived.retiredSide && ` — ${teamName(derived.retiredSide)} retired`}
          </h1>
          <div
            className="tv-scoreboard umpire-scoreboard"
            aria-label="Match summary"
            style={{ '--set-count': summarySets.length } as React.CSSProperties}
          >
            <div className="tv-set-labels" aria-hidden="true">
              <span />
              {summarySets.map((set) => (
                <span key={set.setNumber}>Set {set.setNumber}</span>
              ))}
            </div>
            {(['A', 'B'] as const).map((side) => (
              <div
                className={`tv-player-row side-${side.toLowerCase()}${
                  derived.matchWinner === side ? ' match-winner' : ''
                }`}
                key={side}
              >
                <strong className="tv-player-name">
                  {teamName(side)}
                  {derived.retiredSide === side && <span className="retired-tag">Retired</span>}
                </strong>
                {summarySets.map((set) => (
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
          {elapsed && <p className="match-elapsed">Match time {elapsed}</p>}
          {!derived.finalised && (
            <button type="button" className="primary" onClick={() => setPendingAction('finish')}>
              Finalise match
            </button>
          )}
        </section>
      ) : (
        <>
          <div className="umpire-play">
            <button
              type="button"
              className={`point-button side-${leftSide.toLowerCase()}`}
              onClick={() => addPoint(leftSide)}
              disabled={scoringLocked}
              aria-label={`Point to ${teamName(leftSide)}`}
            >
              +1
            </button>
            {diagram}
            <button
              type="button"
              className={`point-button side-${rightSide.toLowerCase()}`}
              onClick={() => addPoint(rightSide)}
              disabled={scoringLocked}
              aria-label={`Point to ${teamName(rightSide)}`}
            >
              +1
            </button>
          </div>

          {!isReadyToScore && (
            <div className="umpire-setup-bar">
              <div className="side-choice" role="radiogroup" aria-label="Serving end">
                {([leftSide, rightSide] as const).map((side, index) => (
                  <label key={side}>
                    <input
                      type="radio"
                      name="opening-side"
                      checked={openingSide === side}
                      onChange={() => setOpeningSide(side)}
                    />
                    {index === 0 ? 'Left serves' : 'Right serves'}
                  </label>
                ))}
              </div>
              <button type="button" onClick={swapEnds} aria-label="Swap ends">
                ⇄ Swap ends
              </button>
              <button type="button" className="primary" onClick={startMatch}>
                Start match
              </button>
            </div>
          )}
        </>
      )}

      <footer className="umpire-callbar">
        <p className="umpire-call" role="status">
          {call}
        </p>
        <div className="umpire-actions">
          {elapsed && !derived.matchWinner && (
            <span className="match-elapsed" aria-label="Elapsed match time">
              {elapsed}
            </span>
          )}
          {breakNow && (
            <button type="button" className="banner" onClick={() => setPendingAction('resume')}>
              {INTERVAL_LABELS[breakNow.kind]}
              {` ${formatCountdown(secondsLeft)}`} — tap to {breakWording.verb}
            </button>
          )}
          {canUndo && (
            <button type="button" onClick={undoLastPoint}>
              Undo
            </button>
          )}
          {isReadyToScore && !derived.matchWinner && (
            <button
              type="button"
              className="danger-button"
              onClick={() => setPendingAction('finish')}
            >
              End match
            </button>
          )}
        </div>
      </footer>

      {pendingAction === 'resume' && breakNow && (
        <ConfirmDialog
          title={breakWording.title}
          message={
            secondsLeft > 0
              ? `${formatCountdown(secondsLeft)} of the ${breakWording.noun} still to run.`
              : `The ${breakWording.noun} is over.`
          }
          choices={[
            {
              label: breakWording.action,
              onSelect: () => {
                resumeFromInterval();
                setPendingAction(null);
              },
            },
          ]}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {pendingAction === 'finish' && (
        <ConfirmDialog
          title={derived.matchWinner ? 'Finalise this match?' : 'End this match early?'}
          message={
            derived.matchWinner
              ? `${teamName(derived.matchWinner)} wins. This closes the match for good.`
              : 'Pick the side the match is awarded to — use this when a player retires.'
          }
          // Cancel always means "do nothing", so the winning side is chosen
          // from explicit buttons rather than from confirm-vs-cancel.
          choices={
            derived.matchWinner
              ? [
                  {
                    label: 'Finalise',
                    onSelect: () => {
                      retireMatch(derived.matchWinner!);
                      setPendingAction(null);
                    },
                  },
                ]
              : ([leftSide, rightSide] as const).map((side) => ({
                  label: `${teamName(side)} wins`,
                  danger: true,
                  onSelect: () => {
                    retireMatch(side);
                    setPendingAction(null);
                  },
                }))
          }
          onCancel={() => setPendingAction(null)}
        />
      )}
    </main>
  );
}
