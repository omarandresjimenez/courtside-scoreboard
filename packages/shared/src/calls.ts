/**
 * The umpire's spoken call.
 *
 * The scoreboard is side-relative — Side A's score always sits in Side A's
 * row. The *call* is serve-relative: BWF convention is that the server's
 * score is always spoken first, whether they are ahead or behind. Keeping
 * that conversion in one pure function (rather than inline in the screen)
 * makes it exhaustively table-testable, which matters because getting a
 * call wrong in front of a crowd is the visible kind of bug.
 *
 * Wording follows the reference recording documented in
 * docs/umpire-screen-spec.md.
 */

import { checkSetWinner } from './scoring.js';
import type { ScoringConfig, Side } from './types.js';

export interface UmpireCallInput {
  scoreA: number;
  scoreB: number;
  /** Null before the opening serve has been set. */
  servingSide: Side | null;
  /** The last rally moved the serve across the net. */
  serviceOver: boolean;
  /** The mid-set interval is in effect and not yet dismissed. */
  onInterval: boolean;
  /** Set once the match as a whole is decided. */
  matchWinner: Side | null;
  config: ScoringConfig;
  /** Display name per side — a player for singles, both partners for doubles. */
  teamNames: Record<Side, string>;
  /** Sets already won, used to tell "game point" from "match point". */
  setsWon: Record<Side, number>;
}

const otherSide = (side: Side): Side => (side === 'A' ? 'B' : 'A');

/** Badminton says "love", never "zero" or "nil". */
const spoken = (score: number): string => (score === 0 ? 'love' : String(score));

/**
 * A side is at game point when winning one more rally would close the set.
 * Asking `checkSetWinner` rather than comparing against pointsToWin keeps
 * deuce and the cap score handled in exactly one place.
 */
function atGamePoint(scoreA: number, scoreB: number, side: Side, config: ScoringConfig): boolean {
  const next: [number, number] = side === 'A' ? [scoreA + 1, scoreB] : [scoreA, scoreB + 1];
  return checkSetWinner(next[0], next[1], config) === side;
}

export function umpireCall(input: UmpireCallInput): string {
  const { scoreA, scoreB, servingSide, serviceOver, onInterval, matchWinner, config } = input;

  if (matchWinner) return `Match won by ${input.teamNames[matchWinner]}`;

  // "Love all, play" is the call that starts a game, and nil-nil only ever
  // occurs at a game's start — so it covers both the pre-serve setup screen
  // and the moment scoring actually opens.
  if (scoreA === 0 && scoreB === 0) return 'Love all, play';
  // Defensive: a score without a server cannot be spoken from either side.
  if (!servingSide) return 'Love all, play';

  const receivingSide = otherSide(servingSide);
  const serverScore = servingSide === 'A' ? scoreA : scoreB;
  const receiverScore = receivingSide === 'A' ? scoreA : scoreB;

  let base: string;
  if (serverScore === receiverScore) {
    // Nil-nil already returned above, so a level score here is never zero.
    base = `${serverScore} all`;
  } else {
    // Whoever is one rally from the game gets it announced, but the score
    // is still spoken server-first, so the words sit between the numbers.
    const decisive = [servingSide, receivingSide].find((side) =>
      atGamePoint(scoreA, scoreB, side, config),
    );
    if (decisive) {
      const isMatchPoint = input.setsWon[decisive] + 1 >= 2;
      const phrase = isMatchPoint ? 'match point' : 'game point';
      base = `${spoken(serverScore)} ${phrase} ${spoken(receiverScore)}`;
    } else {
      base = `${spoken(serverScore)}, ${spoken(receiverScore)}`;
    }
  }

  // The interval is announced after the score, not before it.
  if (onInterval) base = `${base}. Interval`;

  // Every remaining base call already starts lower case or with a digit, so
  // the prefix simply leads.
  return serviceOver ? `Service over, ${base}` : base;
}
