import * as courtside from './index.js';

describe('package entry point', () => {
  it('re-exports the scoring engine, domain types, and event contract', () => {
    expect(typeof courtside.deriveMatchState).toBe('function');
    expect(typeof courtside.checkSetWinner).toBe('function');
    expect(courtside.SCORING_PRESETS.standard).toBeDefined();
    expect(courtside.UMPIRE_EVENTS.ADD_POINT).toBe('umpire:add_point');
  });
});
