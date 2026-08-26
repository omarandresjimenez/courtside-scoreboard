import { SCORING_PRESETS } from './types.js';

describe('SCORING_PRESETS', () => {
  it('matches the standard format from the design spec (21 / 30 / 11)', () => {
    expect(SCORING_PRESETS.standard).toEqual({ pointsToWin: 21, capScore: 30, intervalAt: 11 });
  });

  it('matches the short format from the design spec (15 / 21 / 8)', () => {
    expect(SCORING_PRESETS.short).toEqual({ pointsToWin: 15, capScore: 21, intervalAt: 8 });
  });

  it('keeps capScore strictly greater than pointsToWin for every preset', () => {
    Object.values(SCORING_PRESETS).forEach((preset) => {
      expect(preset.capScore).toBeGreaterThan(preset.pointsToWin);
    });
  });

  it('keeps intervalAt strictly between 0 and pointsToWin for every preset', () => {
    Object.values(SCORING_PRESETS).forEach((preset) => {
      expect(preset.intervalAt).toBeGreaterThan(0);
      expect(preset.intervalAt).toBeLessThan(preset.pointsToWin);
    });
  });
});
