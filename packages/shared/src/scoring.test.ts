import { checkSetWinner, deriveMatchState, otherSide } from './scoring.js';
import type { CourtPositions, ScoreEvent, ScoringConfig, Side } from './types.js';
import { SCORING_PRESETS } from './types.js';

const standard: ScoringConfig = SCORING_PRESETS.standard;
const short: ScoringConfig = SCORING_PRESETS.short;

let seq = 0;
function point(side: 'A' | 'B', matchId = 'm1'): ScoreEvent {
  seq += 1;
  return { eventId: `e${seq}`, matchId, type: 'POINT', side, timestamp: seq };
}
function undo(matchId = 'm1'): ScoreEvent {
  seq += 1;
  return { eventId: `e${seq}`, matchId, type: 'UNDO_LAST_POINT', timestamp: seq };
}
function startSet(
  courtPositions?: CourtPositions,
  firstServerPlayerId?: string,
  firstServerSide?: Side,
  matchId = 'm1',
): ScoreEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    matchId,
    type: 'START_SET',
    timestamp: seq,
    ...(courtPositions ? { courtPositions } : {}),
    ...(firstServerPlayerId ? { firstServerPlayerId } : {}),
    ...(firstServerSide ? { firstServerSide } : {}),
  };
}
function retire(side: Side, matchId = 'm1'): ScoreEvent {
  seq += 1;
  return { eventId: `e${seq}`, matchId, type: 'RETIRE', side, timestamp: seq };
}
function resumeInterval(matchId = 'm1'): ScoreEvent {
  seq += 1;
  return { eventId: `e${seq}`, matchId, type: 'RESUME_INTERVAL', timestamp: seq };
}

describe('checkSetWinner', () => {
  it('has no winner before pointsToWin is reached', () => {
    expect(checkSetWinner(19, 18, standard)).toBeNull();
  });

  it('wins at pointsToWin with a 2-point margin', () => {
    expect(checkSetWinner(21, 19, standard)).toBe('A');
  });

  it('keeps playing through deuce without a 2-point margin', () => {
    expect(checkSetWinner(21, 20, standard)).toBeNull();
    expect(checkSetWinner(20, 20, standard)).toBeNull();
  });

  it('caps the set at capScore regardless of margin', () => {
    expect(checkSetWinner(30, 29, standard)).toBe('A');
    expect(checkSetWinner(29, 29, standard)).toBeNull();
  });

  it('applies the short-format numbers independently of standard', () => {
    expect(checkSetWinner(15, 13, short)).toBe('A');
    expect(checkSetWinner(21, 20, short)).toBe('A'); // cap at 21
  });

  it('declares B the winner just as readily as A, on margin', () => {
    expect(checkSetWinner(19, 21, standard)).toBe('B');
  });

  it('declares B the winner just as readily as A, at the cap', () => {
    expect(checkSetWinner(29, 30, standard)).toBe('B');
  });
});

describe('deriveMatchState', () => {
  it('tracks a live, unfinished set', () => {
    const events = [point('A'), point('A'), point('B')];
    const state = deriveMatchState(events, standard);
    expect(state.currentSet).toMatchObject({ scoreA: 2, scoreB: 1, winner: null });
    expect(state.matchWinner).toBeNull();
  });

  it('flags the mid-set interval once a side reaches intervalAt', () => {
    const events = Array.from({ length: 11 }, () => point('A'));
    const state = deriveMatchState(events, standard);
    expect(state.onInterval).toBe(true);
  });

  it('clears the interval flag once the umpire resumes play', () => {
    const events = [...Array.from({ length: 11 }, () => point('A')), resumeInterval()];
    const state = deriveMatchState(events, standard);
    expect(state.onInterval).toBe(false);
  });

  it('keeps the interval resumed as further points come in', () => {
    const events = [...Array.from({ length: 11 }, () => point('A')), resumeInterval(), point('B')];
    const state = deriveMatchState(events, standard);
    expect(state.onInterval).toBe(false);
  });

  it("a resume event before intervalAt is reached has no effect (can't happen via the UI)", () => {
    const events = [resumeInterval(), point('A')];
    const state = deriveMatchState(events, standard);
    expect(state.onInterval).toBe(false);
    expect(state.currentSet.scoreA).toBe(1);
  });

  it('re-arms the interval flag in a fresh set after resuming the previous one', () => {
    const events = [
      ...Array.from({ length: 20 }, () => point('A')),
      resumeInterval(),
      ...Array.from({ length: 15 }, () => point('B')),
      point('A'), // closes set 1 at 21-15
      ...Array.from({ length: 11 }, () => point('B')), // set 2 hits its own interval
    ];
    const state = deriveMatchState(events, standard);
    expect(state.currentSet.setNumber).toBe(2);
    expect(state.onInterval).toBe(true);
  });

  it('still fires the mid-game interval in set 2 after the between-games break was resumed', () => {
    // Every real match resumes the between-games break before scoring can
    // resume (the UI locks points until it does) — so a resume at 0-0
    // followed by more points reaching this set's own interval score must
    // still show the mid-game interval. A single shared "resumed" flag for
    // both kinds of break would wrongly stay set from the earlier resume
    // and swallow this one.
    const events = [
      ...Array.from({ length: 20 }, () => point('A')),
      resumeInterval(), // dismisses set 1's mid-game interval
      ...Array.from({ length: 15 }, () => point('B')),
      point('A'), // closes set 1 at 21-15
      resumeInterval(), // dismisses the between-games break opening set 2
      ...Array.from({ length: 11 }, () => point('B')), // set 2 hits its own interval
    ];
    const state = deriveMatchState(events, standard);
    expect(state.currentSet.setNumber).toBe(2);
    expect(state.onInterval).toBe(true);
  });

  it('closes a set and starts the next when someone wins it', () => {
    // B must reach 15 before A's 21st point, or the set would have already
    // closed at 21-0 — a real rally sequence can't score 21-15 any other way.
    const events = [
      ...Array.from({ length: 20 }, () => point('A')),
      ...Array.from({ length: 15 }, () => point('B')),
      point('A'),
    ];
    const state = deriveMatchState(events, standard);
    expect(state.sets[0]).toMatchObject({ winner: 'A', scoreA: 21, scoreB: 15 });
    expect(state.setsWon).toEqual({ A: 1, B: 0 });
    expect(state.currentSet.setNumber).toBe(2);
    expect(state.matchWinner).toBeNull();
  });

  it('declares a match winner after 2 sets', () => {
    const setWin = (winner: 'A' | 'B') =>
      winner === 'A'
        ? Array.from({ length: 21 }, () => point('A'))
        : Array.from({ length: 21 }, () => point('B'));
    const events = [...setWin('A'), ...setWin('A')];
    const state = deriveMatchState(events, standard);
    expect(state.matchWinner).toBe('A');
    expect(state.setsWon).toEqual({ A: 2, B: 0 });
  });

  it('undoes the last point', () => {
    const events = [point('A'), point('A'), point('B'), undo()];
    const state = deriveMatchState(events, standard);
    expect(state.currentSet).toMatchObject({ scoreA: 2, scoreB: 0 });
  });

  it("undoes A's point just as readily as B's", () => {
    const events = [point('B'), point('A'), undo()];
    const state = deriveMatchState(events, standard);
    expect(state.currentSet).toMatchObject({ scoreA: 0, scoreB: 1 });
  });

  it('clears the serving side when undoing the very first point of a set', () => {
    const state = deriveMatchState([point('A'), undo()], standard);
    expect(state.serve.servingSide).toBeNull();
  });

  it('reopens the previous set when B was the one who closed it', () => {
    const events = [
      ...Array.from({ length: 20 }, () => point('B')),
      ...Array.from({ length: 15 }, () => point('A')),
      point('B'),
      undo(),
    ];
    const state = deriveMatchState(events, standard);
    expect(state.currentSet).toMatchObject({ setNumber: 1, scoreA: 15, scoreB: 20, winner: null });
  });

  it('clears the serving side when a reopened set had exactly one point', () => {
    // A degenerate config (capScore <= pointsToWin is invalid per the
    // server's own validation — see Set 08 — and never produced by real
    // gameplay) used purely to exercise the case where the set being
    // reopened had nothing left in it once the closing point is removed.
    const degenerate: ScoringConfig = { pointsToWin: 5, capScore: 1, intervalAt: 1 };
    const state = deriveMatchState([point('A'), undo()], degenerate);
    expect(state.serve.servingSide).toBeNull();
    expect(state.matchWinner).toBeNull();
  });

  it('reopens the previous set when the undone point was the one that closed it', () => {
    const events = [
      ...Array.from({ length: 20 }, () => point('A')),
      ...Array.from({ length: 15 }, () => point('B')),
      point('A'),
      undo(), // reverses A's 21st point
    ];
    const state = deriveMatchState(events, standard);
    expect(state.sets).toHaveLength(1);
    expect(state.currentSet).toMatchObject({ setNumber: 1, scoreA: 20, scoreB: 15, winner: null });
    expect(state.setsWon).toEqual({ A: 0, B: 0 });
  });

  it('reverses a match-winning point via undo', () => {
    const setWin = () => Array.from({ length: 21 }, () => point('A'));
    const events = [...setWin(), ...setWin(), undo()];
    const state = deriveMatchState(events, standard);
    expect(state.matchWinner).toBeNull();
    expect(state.setsWon).toEqual({ A: 1, B: 0 });
    expect(state.currentSet).toMatchObject({ setNumber: 2, scoreA: 20, scoreB: 0 });
  });

  it('does nothing when undo is called with no points scored yet', () => {
    const state = deriveMatchState([undo()], standard);
    expect(state.currentSet).toMatchObject({ scoreA: 0, scoreB: 0 });
    expect(state.matchWinner).toBeNull();
  });

  it('declares a winner via manual retirement', () => {
    const events = [point('A'), point('B'), retire('B')];
    const state = deriveMatchState(events, standard);
    expect(state.matchWinner).toBe('B');
  });

  it('ignores a malformed RETIRE event with no side', () => {
    const malformed: ScoreEvent = { eventId: 'x1', matchId: 'm1', type: 'RETIRE', timestamp: 1 };
    const state = deriveMatchState([malformed], standard);
    expect(state.matchWinner).toBeNull();
  });

  it('ignores a malformed POINT event with no side', () => {
    const malformed: ScoreEvent = { eventId: 'x2', matchId: 'm1', type: 'POINT', timestamp: 1 };
    const state = deriveMatchState([malformed], standard);
    expect(state.currentSet).toMatchObject({ scoreA: 0, scoreB: 0 });
  });

  it('ignores events after the match has already ended, except undo', () => {
    const setWin = () => Array.from({ length: 21 }, () => point('A'));
    const events = [...setWin(), ...setWin(), point('B'), point('B')];
    const state = deriveMatchState(events, standard);
    expect(state.matchWinner).toBe('A');
    expect(state.setsWon).toEqual({ A: 2, B: 0 });
  });

  it('has no serving player before any point is scored', () => {
    const state = deriveMatchState([], standard);
    expect(state.serve).toEqual({ servingSide: null, serverPlayerId: null, courtPositions: {} });
  });

  it('tracks singles serve side without a doubles court assignment', () => {
    const state = deriveMatchState([point('A')], standard);
    expect(state.serve.servingSide).toBe('A');
    expect(state.serve.serverPlayerId).toBeNull();
  });

  it('names the opening server in singles before any point is scored', () => {
    // Singles has no courtPositions, so serverFor() alone can't identify
    // the server — this is the one case that needs the firstServerSide/
    // firstServerPlayerId fallback recorded by START_SET.
    const state = deriveMatchState([startSet(undefined, 'alice', 'A')], standard);
    expect(state.serve).toMatchObject({ servingSide: 'A', serverPlayerId: 'alice' });
  });

  it('clears the singles server name once the other side takes the serve', () => {
    const state = deriveMatchState([startSet(undefined, 'alice', 'A'), point('B')], standard);
    expect(state.serve.servingSide).toBe('B');
    expect(state.serve.serverPlayerId).toBeNull();
  });

  describe('doubles serve rotation', () => {
    const positions: CourtPositions = {
      A: { right: 'a-right', left: 'a-left' },
      B: { right: 'b-right', left: 'b-left' },
    };

    it('leaves serve state unresolved when only the court layout is set, not the first server', () => {
      const state = deriveMatchState([startSet(positions)], standard);
      expect(state.serve.servingSide).toBeNull();
    });

    it('finds the first server when they are the left-court occupant, not right', () => {
      const state = deriveMatchState([startSet(positions, 'b-left')], standard);
      expect(state.serve.servingSide).toBe('B');
    });

    it('leaves serve unresolved if the named first server matches no one', () => {
      const state = deriveMatchState([startSet(positions, 'nobody')], standard);
      expect(state.serve.servingSide).toBeNull();
    });

    it('resolves the first server even when only one side has a known layout yet', () => {
      const partial: CourtPositions = { A: { right: 'a-right', left: 'a-left' } };
      const state = deriveMatchState([startSet(partial, 'a-right')], standard);
      expect(state.serve.servingSide).toBe('A');
    });

    it('knows the first server before any point is played (right court, by law)', () => {
      const state = deriveMatchState([startSet(positions, 'a-right')], standard);
      expect(state.serve.servingSide).toBe('A');
      expect(state.serve.serverPlayerId).toBe('a-right');
    });

    it('keeps the same physical server serving as their side keeps winning', () => {
      // a-right serves first (score 0, even -> right). Winning retains
      // serve, so a-right serves again — but the score is now 1 (odd), and
      // the swap-on-retained-serve rule means a-right is now standing in
      // the *left* court, not that a different partner takes over.
      const state = deriveMatchState([startSet(positions, 'a-right'), point('A')], standard);
      expect(state.serve.servingSide).toBe('A');
      expect(state.serve.serverPlayerId).toBe('a-right');
    });

    it('does not swap the receiving side when it wins the rally (side-out)', () => {
      const state = deriveMatchState([startSet(positions, 'a-right'), point('B')], standard);
      // B was receiving, not serving, when they won the rally — Set 03's
      // rule is "swap only when winning while already serving" — so B's
      // court assignment is unchanged, and B's score is 1 (odd) -> left.
      expect(state.serve.servingSide).toBe('B');
      expect(state.serve.serverPlayerId).toBe('b-left');
    });

    it('keeps rotating correctly across several consecutive points for one side', () => {
      const state = deriveMatchState(
        [startSet(positions, 'a-right'), point('A'), point('A'), point('A')],
        standard,
      );
      // a-right never loses serve across this streak, so it must still be
      // a-right serving no matter how many points have been played.
      expect(state.serve.serverPlayerId).toBe('a-right');
    });
  });
});

describe('otherSide', () => {
  it('flips A to B and back', () => {
    expect(otherSide('A')).toBe('B');
    expect(otherSide('B')).toBe('A');
  });
});

describe('serviceOver', () => {
  it('is false before any point has been played', () => {
    expect(
      deriveMatchState([startSet(undefined, 'a1', 'A')], SCORING_PRESETS.standard).serviceOver,
    ).toBe(false);
  });

  it('is false when the side that opened the serve wins the first rally', () => {
    const events = [startSet(undefined, 'a1', 'A'), point('A')];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).serviceOver).toBe(false);
  });

  it('is true when the receiver wins the first rally', () => {
    const events = [startSet(undefined, 'a1', 'A'), point('B')];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).serviceOver).toBe(true);
  });

  it('is false while the server keeps winning rallies', () => {
    const events = [startSet(undefined, 'a1', 'A'), point('A'), point('A')];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).serviceOver).toBe(false);
  });

  it('is true on the rally that takes the serve back across', () => {
    const events = [startSet(undefined, 'a1', 'A'), point('A'), point('B')];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).serviceOver).toBe(true);
  });

  it('is recomputed after an undo rather than left stale', () => {
    // Undoing the rally that changed hands must clear the "service over"
    // state too, or the umpire would keep being told to say it.
    const events = [startSet(undefined, 'a1', 'A'), point('A'), point('B'), undo()];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).serviceOver).toBe(false);
  });

  it('stays false for points replayed without a recorded opening serve', () => {
    // Older matches (and the stubbed admin flows) can produce POINT events
    // with no START_SET, so there is no opening side to compare against.
    expect(deriveMatchState([point('B')], SCORING_PRESETS.standard).serviceOver).toBe(false);
  });
});

describe('interval kinds', () => {
  const toInterval = (events: ScoreEvent[]) =>
    deriveMatchState(events, SCORING_PRESETS.standard).interval;

  it('is null while play is live', () => {
    expect(toInterval([startSet(undefined, 'a1', 'A'), point('A')])).toBeNull();
  });

  it('opens a 2-minute warm-up the moment the umpire starts the match', () => {
    expect(toInterval([startSet(undefined, 'a1', 'A')])).toEqual({
      kind: 'WARM_UP',
      seconds: 120,
    });
  });

  it('shows no warm-up before the match has been started', () => {
    // A created match sits at 0-0 with no completed sets, exactly like a
    // warm-up does. What separates them is whether the umpire has chosen ends
    // and first server yet — without that check, every freshly created match
    // would open on a warm-up nobody asked for.
    expect(toInterval([])).toBeNull();
  });

  it('clears the warm-up once the umpire skips it', () => {
    expect(toInterval([startSet(undefined, 'a1', 'A'), resumeInterval()])).toBeNull();
  });

  it('does not re-open the warm-up after the first point', () => {
    const events = [startSet(undefined, 'a1', 'A'), resumeInterval(), point('A')];
    expect(toInterval(events)).toBeNull();
  });

  it('skipping the warm-up does not pre-dismiss the mid-game interval', () => {
    // The trap `openingBreakResumed` exists to avoid: one flag for both breaks
    // meant dismissing the opening one silently dismissed the mid-game one too.
    const events = [
      startSet(undefined, 'a1', 'A'),
      resumeInterval(),
      ...Array.from({ length: 11 }, () => point('A')),
    ];
    expect(toInterval(events)).toEqual({ kind: 'MID_GAME', seconds: 60 });
  });

  it('calls the break before game 2 a between-games break, not a warm-up', () => {
    // Both are "the break that opens this game"; only the first game's is a
    // warm-up.
    const events = [
      startSet(undefined, 'a1', 'A'),
      resumeInterval(),
      ...Array.from({ length: 21 }, () => point('A')),
    ];
    expect(toInterval(events)).toEqual({ kind: 'BETWEEN_GAMES', seconds: 120 });
  });

  it('reports a 60-second mid-game interval at the interval score', () => {
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 11 }, () => point('A')),
    ];
    expect(toInterval(events)).toEqual({ kind: 'MID_GAME', seconds: 60 });
  });

  it('clears once the umpire resumes the mid-game interval', () => {
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 11 }, () => point('A')),
      resumeInterval(),
    ];
    expect(toInterval(events)).toBeNull();
  });

  it('reports a 120-second break once a game has been won', () => {
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 21 }, () => point('A')),
    ];
    expect(toInterval(events)).toEqual({ kind: 'BETWEEN_GAMES', seconds: 120 });
  });

  it('clears the between-games break once the umpire resumes', () => {
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 21 }, () => point('A')),
      resumeInterval(),
    ];
    expect(toInterval(events)).toBeNull();
  });

  it('offers no break after the final game, because none is owed', () => {
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 21 }, () => point('A')),
      resumeInterval(),
      ...Array.from({ length: 21 }, () => point('A')),
    ];
    const state = deriveMatchState(events, SCORING_PRESETS.standard);
    expect(state.matchWinner).toBe('A');
    expect(state.interval).toBeNull();
  });

  it('keeps onInterval meaning the mid-game break only', () => {
    // The TV banner and the umpire's point lock both key off onInterval, so
    // the longer between-games break must not silently start driving them.
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 21 }, () => point('A')),
    ];
    const state = deriveMatchState(events, SCORING_PRESETS.standard);
    expect(state.interval?.kind).toBe('BETWEEN_GAMES');
    expect(state.onInterval).toBe(false);
  });
});

describe('finalised', () => {
  it('is false while a match is merely decided on points', () => {
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 42 }, () => point('A')),
    ];
    const state = deriveMatchState(events, SCORING_PRESETS.standard);
    expect(state.matchWinner).toBe('A');
    expect(state.finalised).toBe(false);
  });

  it('is true once the umpire signs a decided match off', () => {
    // The RETIRE arrives *after* a winner exists, so the replay must not
    // discard it the way it discards other post-completion events.
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 42 }, () => point('A')),
      retire('A'),
    ];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).finalised).toBe(true);
  });

  it('is true when a match is ended early by retirement', () => {
    const events = [startSet(undefined, 'a1', 'A'), point('A'), retire('B')];
    const state = deriveMatchState(events, SCORING_PRESETS.standard);
    expect(state.matchWinner).toBe('B');
    expect(state.finalised).toBe(true);
  });
});

describe('retiredSide', () => {
  it('is null for a match played to its conclusion', () => {
    const events = [
      startSet(undefined, 'a1', 'A'),
      ...Array.from({ length: 42 }, () => point('A')),
      retire('A'),
    ];
    const state = deriveMatchState(events, SCORING_PRESETS.standard);
    expect(state.finalised).toBe(true);
    expect(state.retiredSide).toBeNull();
  });

  it('names the losing side when a match is ended early', () => {
    const events = [startSet(undefined, 'a1', 'A'), point('A'), retire('B')];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).retiredSide).toBe('A');
  });

  it('names side B when B is the one who retires', () => {
    const events = [startSet(undefined, 'a1', 'A'), point('A'), retire('A')];
    expect(deriveMatchState(events, SCORING_PRESETS.standard).retiredSide).toBe('B');
  });
});
