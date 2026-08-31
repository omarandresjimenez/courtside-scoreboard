import { umpireCall, type UmpireCallInput } from './calls.js';
import { SCORING_PRESETS } from './types.js';

function input(overrides: Partial<UmpireCallInput> = {}): UmpireCallInput {
  return {
    scoreA: 0,
    scoreB: 0,
    servingSide: 'A',
    serviceOver: false,
    onInterval: false,
    matchWinner: null,
    config: SCORING_PRESETS.standard,
    teamNames: { A: 'Alice / Ana', B: 'Bilal / Bruno' },
    setsWon: { A: 0, B: 0 },
    ...overrides,
  };
}

const call = (overrides: Partial<UmpireCallInput> = {}) => umpireCall(input(overrides));

describe('umpireCall', () => {
  it('opens the match with "Love all, play" while no server is set', () => {
    expect(call({ servingSide: null })).toBe('Love all, play');
  });

  it("speaks the server's score first, whichever side is serving", () => {
    // Identical scoreline, opposite servers — the spoken order flips.
    expect(call({ scoreA: 5, scoreB: 4, servingSide: 'A' })).toBe('5, 4');
    expect(call({ scoreA: 5, scoreB: 4, servingSide: 'B' })).toBe('4, 5');
  });

  it('says "love" rather than a zero', () => {
    expect(call({ scoreA: 1, scoreB: 0, servingSide: 'A' })).toBe('1, love');
    expect(call({ scoreA: 0, scoreB: 1, servingSide: 'A' })).toBe('love, 1');
  });

  it('collapses a level score to "<n> all"', () => {
    expect(call({ scoreA: 2, scoreB: 2 })).toBe('2 all');
  });

  it('opens every game with "Love all, play", once a server is set too', () => {
    // Nil-nil only happens at the start of a game, so it always takes the
    // opening call rather than a bare "Love all".
    expect(call({ scoreA: 0, scoreB: 0 })).toBe('Love all, play');
    expect(call({ scoreA: 0, scoreB: 0, servingSide: 'B' })).toBe('Love all, play');
  });

  it('prefixes "Service over" when the rally moved the serve across', () => {
    expect(call({ scoreA: 0, scoreB: 1, servingSide: 'B', serviceOver: true })).toBe(
      'Service over, 1, love',
    );
  });

  it('keeps a "love" tail lower case behind the service-over prefix', () => {
    expect(call({ scoreA: 11, scoreB: 0, servingSide: 'B', serviceOver: true })).toBe(
      'Service over, love, 11',
    );
  });

  it('falls back to the opening call if a score somehow arrives with no server', () => {
    // Defensive only: every scored rally sets a server. Covered because the
    // function is exported and callers are not all in this repo.
    expect(call({ scoreA: 3, scoreB: 1, servingSide: null })).toBe('Love all, play');
  });

  it('appends the interval after the score', () => {
    expect(call({ scoreA: 11, scoreB: 0, servingSide: 'A', onInterval: true })).toBe(
      '11, love. Interval',
    );
  });

  it('announces game point between the two numbers, still server-first', () => {
    // Side A serving on 20 of 21 — one rally from the game.
    expect(call({ scoreA: 20, scoreB: 15, servingSide: 'A' })).toBe('20 game point 15');
  });

  it('announces game point when the receiver is the one on the brink', () => {
    expect(call({ scoreA: 20, scoreB: 15, servingSide: 'B' })).toBe('15 game point 20');
  });

  it('upgrades game point to match point when that game would win the match', () => {
    expect(call({ scoreA: 20, scoreB: 15, servingSide: 'A', setsWon: { A: 1, B: 0 } })).toBe(
      '20 match point 15',
    );
  });

  it('does not call game point at 20-20, where a further point only leads', () => {
    expect(call({ scoreA: 20, scoreB: 20, servingSide: 'A' })).toBe('20 all');
  });

  it('calls game point at 20-all once a side edges ahead to 21', () => {
    expect(call({ scoreA: 21, scoreB: 20, servingSide: 'A' })).toBe('21 game point 20');
  });

  it('calls game point at the cap score, where one point wins regardless of margin', () => {
    expect(call({ scoreA: 29, scoreB: 28, servingSide: 'A' })).toBe('29 game point 28');
  });

  it('respects a shorter configured format', () => {
    // The "short" preset wins at 15, so 14 is game point rather than 20.
    expect(call({ scoreA: 14, scoreB: 4, servingSide: 'A', config: SCORING_PRESETS.short })).toBe(
      '14 game point 4',
    );
  });

  it('announces the winning team once the match is decided', () => {
    expect(call({ matchWinner: 'B' })).toBe('Match won by Bilal / Bruno');
  });

  it('lets the match result outrank every other state', () => {
    expect(call({ matchWinner: 'A', onInterval: true, serviceOver: true, servingSide: null })).toBe(
      'Match won by Alice / Ana',
    );
  });

  it('combines service over with the interval call', () => {
    expect(
      call({ scoreA: 5, scoreB: 11, servingSide: 'B', serviceOver: true, onInterval: true }),
    ).toBe('Service over, 11, 5. Interval');
  });
});
