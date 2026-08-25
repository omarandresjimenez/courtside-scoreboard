import { describe, expect, it } from 'vitest';
import { checkSetWinner, deriveMatchState } from './scoring.js';
import type { ScoreEvent, ScoringConfig } from './types.js';
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
});
