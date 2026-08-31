/**
 * The scoring/state-machine engine — Set 03 of the design spec.
 *
 * One pure function, deriveMatchState(), replays a match's full ScoreEvent
 * log and returns everything derived from it: per-set scores, the current
 * set, set/match winners, serve state, and the mid-set interval flag. This
 * is the ONLY place this logic should live — server and client both call
 * the same function rather than keeping their own bookkeeping in sync.
 *
 * Undo is intentionally implemented by replay, not by mutating counters:
 * an UNDO_LAST_POINT event cancels the most recent not-yet-cancelled point,
 * including correctly reopening the previous set if the undone point was
 * the one that closed it.
 */

import type { CourtPositions, ScoreEvent, ScoringConfig, Side } from './types.js';

export interface SetResult {
  setNumber: number;
  scoreA: number;
  scoreB: number;
  /** Null while the set is still in progress. */
  winner: Side | null;
  /** True once either score has reached scoringConfig.intervalAt this set. */
  intervalTriggered: boolean;
  /** True once the umpire has dismissed this set's mid-game interval break. */
  intervalResumed: boolean;
  /**
   * True once the umpire has dismissed the between-games break that opens
   * this set (irrelevant for set 1, which has no break before it). Tracked
   * separately from `intervalResumed` — they are two different breaks, and
   * conflating them into one flag meant dismissing the opening break also
   * silently pre-dismissed this set's own mid-game interval later on.
   * Optional so existing SetResult literals need not specify it.
   */
  openingBreakResumed?: boolean;
}

export interface ServeState {
  servingSide: Side | null;
  /** Meaningful for doubles; null for singles or before the first serve. */
  serverPlayerId: string | null;
  courtPositions: CourtPositions;
}

/**
 * Badminton has two kinds of break, and they are not the same length:
 * a mid-game interval when the leader first reaches the interval score,
 * and a longer break between games. The final game has no break after it —
 * there is no next game to break before.
 */
export type IntervalKind = 'MID_GAME' | 'BETWEEN_GAMES';

export const INTERVAL_SECONDS: Record<IntervalKind, number> = {
  MID_GAME: 60,
  BETWEEN_GAMES: 120,
};

export interface IntervalState {
  kind: IntervalKind;
  /** How long the break runs, in seconds. */
  seconds: number;
}

export interface DerivedMatchState {
  /** Completed sets, plus the in-progress one, in order. */
  sets: SetResult[];
  currentSet: SetResult;
  setsWon: Record<Side, number>;
  /** Null until a side has won 2 sets (or a RETIRE event declares one). */
  matchWinner: Side | null;
  serve: ServeState;
  /**
   * True during a mid-game interval only, so existing consumers (the TV
   * banner, the umpire's point lock) keep their original meaning.
   */
  onInterval: boolean;
  /**
   * The break currently in effect, of either kind, or null when play is
   * live. The umpire may resume early; this only says a break is owed.
   */
  interval: IntervalState | null;
  /**
   * True when the rally just played moved the serve to the other side —
   * what the umpire prefixes with "Service over". Derived from the current
   * set's point stack rather than tracked through the replay, so it stays
   * correct after an undo for free (the stack is already the authority on
   * who serves: the side that won the last point serves the next one).
   */
  serviceOver: boolean;
  /**
   * A RETIRE event has been recorded — the umpire has signed the match off,
   * either finalising a decided match or ending one early. Winning the
   * deciding game sets `matchWinner`, but only this makes the match over:
   * the umpire always has the last word.
   */
  finalised: boolean;
  /**
   * The side that retired, when the match was ended early rather than won.
   * Null when the match ran its course — finalising an already-decided match
   * is also a RETIRE event, but nobody retired, so this stays null.
   */
  retiredSide: Side | null;
}

const otherSide = (side: Side): Side => (side === 'A' ? 'B' : 'A');

function emptySet(setNumber: number): SetResult {
  return {
    setNumber,
    scoreA: 0,
    scoreB: 0,
    winner: null,
    intervalTriggered: false,
    intervalResumed: false,
    openingBreakResumed: false,
  };
}

/**
 * Set 03's win-check, generalized over the match's configured
 * pointsToWin / capScore rather than hardcoded 21/30 — this is what makes
 * the "standard" and "short" (and custom) formats share one code path.
 */
export function checkSetWinner(scoreA: number, scoreB: number, config: ScoringConfig): Side | null {
  if (scoreA === config.capScore || scoreB === config.capScore) {
    return scoreA > scoreB ? 'A' : 'B';
  }
  if (Math.max(scoreA, scoreB) >= config.pointsToWin && Math.abs(scoreA - scoreB) >= 2) {
    return scoreA > scoreB ? 'A' : 'B';
  }
  return null;
}

function serverFor(side: Side, sideScore: number, courtPositions: CourtPositions): string | null {
  const positions = courtPositions[side];
  if (!positions) return null; // singles, or doubles positions not yet set for a set
  return sideScore % 2 === 0 ? positions.right : positions.left;
}

export function deriveMatchState(
  events: readonly ScoreEvent[],
  config: ScoringConfig,
): DerivedMatchState {
  const completedSets: SetResult[] = [];
  // One point stack per set index, so an undo that crosses a set boundary
  // can correctly reopen the previous set rather than only ever touching
  // the newest one.
  const pointStacksBySet: Side[][] = [[]];
  let setIndex = 0;
  let current = emptySet(1);
  const setsWon: Record<Side, number> = { A: 0, B: 0 };
  let matchWinner: Side | null = null;
  let courtPositions: CourtPositions = {};
  let servingSide: Side | null = null;
  let finalised = false;
  let retiredSide: Side | null = null;
  let firstServerPlayerId: string | null = null;
  let firstServerSide: Side | null = null;

  for (const event of events) {
    // A stray event after completion is ignored, with two exceptions: the
    // undo that reverses the very point that ended the match, and the RETIRE
    // the umpire signs a decided match off with — which arrives precisely
    // when a winner already exists.
    if (matchWinner && event.type !== 'UNDO_LAST_POINT' && event.type !== 'RETIRE') continue;

    switch (event.type) {
      case 'START_SET': {
        if (event.courtPositions) courtPositions = event.courtPositions;
        firstServerPlayerId = event.firstServerPlayerId ?? null;
        firstServerSide = event.firstServerSide ?? null;
        // The first server's identity is fixed by law before the first
        // rally is even played (BWF: the first serve of a game is from
        // the right court) — so servingSide is knowable immediately,
        // rather than only after a point is won.
        if (event.firstServerPlayerId) {
          const sides = Object.keys(courtPositions) as Side[];
          servingSide =
            sides.find((side) => {
              const sidePositions = courtPositions[side];
              return (
                sidePositions?.right === event.firstServerPlayerId ||
                sidePositions?.left === event.firstServerPlayerId
              );
            }) ?? null;
        }
        servingSide ??= event.firstServerSide ?? null;
        break;
      }

      case 'RETIRE': {
        if (event.side) {
          // Only a retirement that *decides* the match retires anyone; the
          // same event arriving after a winner exists is the umpire signing
          // off a match that was already won on court.
          if (!matchWinner) retiredSide = otherSide(event.side);
          matchWinner = event.side;
        }
        finalised = true;
        break;
      }

      case 'RESUME_INTERVAL': {
        // The same event dismisses either break; which one is currently
        // showing is unambiguous from the score — a set only sits at 0-0
        // with a prior completed set while its own opening break is up,
        // since intervalAt is always greater than zero.
        const isOpeningBreak =
          completedSets.length > 0 && current.scoreA === 0 && current.scoreB === 0;
        if (isOpeningBreak) current.openingBreakResumed = true;
        else current.intervalResumed = true;
        break;
      }

      case 'POINT': {
        if (!event.side) break;
        const scoringSide = event.side;
        const wasAlreadyServing = servingSide === scoringSide;

        if (scoringSide === 'A') current.scoreA += 1;
        else current.scoreB += 1;
        pointStacksBySet[setIndex]!.push(scoringSide);

        // BWF doubles rule: partners swap service courts only when their
        // side wins a point while already serving. This keeps whichever
        // player serves next consistent with the new score's parity.
        if (wasAlreadyServing && courtPositions[scoringSide]) {
          const { right, left } = courtPositions[scoringSide]!;
          courtPositions = { ...courtPositions, [scoringSide]: { right: left, left: right } };
        }
        servingSide = scoringSide;

        const sideScore = scoringSide === 'A' ? current.scoreA : current.scoreB;
        if (!current.intervalTriggered && sideScore >= config.intervalAt) {
          current.intervalTriggered = true;
        }

        const winner = checkSetWinner(current.scoreA, current.scoreB, config);
        if (winner) {
          current.winner = winner;
          completedSets.push(current);
          setsWon[winner] += 1;

          // Always open a fresh set slot, even when the match just ended.
          // Two reasons: `current` must never keep pointing at the object
          // we just pushed into completedSets (or a later undo would mutate
          // a "finished" set in place instead of reopening it properly),
          // and undo-ing the point that won the match needs an empty stack
          // to pop *into* — see the UNDO_LAST_POINT case below. This phantom
          // trailing set is simply never surfaced: the `sets` getter below
          // only appends `current` when the match hasn't ended.
          setIndex += 1;
          current = emptySet(current.setNumber + 1);
          pointStacksBySet[setIndex] = [];

          if (setsWon[winner] >= 2) {
            matchWinner = winner;
          }
        }
        break;
      }

      case 'UNDO_LAST_POINT': {
        const stack = pointStacksBySet[setIndex]!;
        const lastSide = stack.pop();

        if (lastSide) {
          if (lastSide === 'A') current.scoreA -= 1;
          else current.scoreB -= 1;
          current.intervalTriggered = Math.max(current.scoreA, current.scoreB) >= config.intervalAt;
          servingSide = stack.length > 0 ? stack[stack.length - 1]! : null;
        } else if (setIndex > 0) {
          // The set just closed was the only place left to undo from —
          // reopen it, then remove the point that had closed it.
          setIndex -= 1;
          const reopened = completedSets.pop()!;
          // Invariant: a set only ever lands in completedSets after its
          // `winner` field was just set a few lines up in the POINT case,
          // so this is never null in practice.
          setsWon[reopened.winner!] -= 1;
          if (matchWinner === reopened.winner) matchWinner = null;

          const reopenedStack = pointStacksBySet[setIndex]!;
          const undonePoint = reopenedStack.pop();
          current = {
            setNumber: reopened.setNumber,
            scoreA: reopened.scoreA - (undonePoint === 'A' ? 1 : 0),
            scoreB: reopened.scoreB - (undonePoint === 'B' ? 1 : 0),
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          };
          current.intervalTriggered = Math.max(current.scoreA, current.scoreB) >= config.intervalAt;
          servingSide = reopenedStack.length > 0 ? reopenedStack[reopenedStack.length - 1]! : null;
        }
        // else: nothing to undo (start of the match) — no-op.
        break;
      }
    }
  }

  const serverPlayerId = servingSide
    ? (serverFor(
        servingSide,
        servingSide === 'A' ? current.scoreA : current.scoreB,
        courtPositions,
      ) ?? (servingSide === firstServerSide ? firstServerPlayerId : null))
    : null;

  const currentStack = pointStacksBySet[setIndex]!;
  const serviceOver =
    currentStack.length >= 2
      ? currentStack[currentStack.length - 1] !== currentStack[currentStack.length - 2]
      : // The first point of a set changes hands only if the side that won it
        // is not the side that opened the serve.
        currentStack.length === 1 && firstServerSide !== null
        ? currentStack[0] !== firstServerSide
        : false;

  const midGameInterval = current.intervalTriggered && !current.intervalResumed && !matchWinner;
  // Between games: the previous game is decided, the next has not started,
  // and the umpire has not resumed yet. There is no break after the last
  // game, which `matchWinner` already excludes.
  const betweenGames =
    !matchWinner &&
    completedSets.length > 0 &&
    current.scoreA === 0 &&
    current.scoreB === 0 &&
    !current.openingBreakResumed;
  const interval: IntervalState | null = midGameInterval
    ? { kind: 'MID_GAME', seconds: INTERVAL_SECONDS.MID_GAME }
    : betweenGames
      ? { kind: 'BETWEEN_GAMES', seconds: INTERVAL_SECONDS.BETWEEN_GAMES }
      : null;

  return {
    sets: matchWinner ? completedSets : [...completedSets, current],
    currentSet: current,
    setsWon,
    matchWinner,
    serve: { servingSide, serverPlayerId, courtPositions },
    onInterval: midGameInterval,
    interval,
    serviceOver,
    finalised,
    retiredSide,
  };
}

export { otherSide };
