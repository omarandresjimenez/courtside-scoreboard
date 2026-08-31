import { act, renderHook } from '@testing-library/react';
import { formatCountdown, useCountdown } from './useCountdown.js';

describe('formatCountdown', () => {
  it('renders minutes and zero-padded seconds', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(125)).toBe('2:05');
  });
});

describe('useCountdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('holds at null while no break is running', () => {
    const { result } = renderHook(() => useCountdown(null, 'none'));
    expect(result.current).toBeNull();
  });

  it('counts down once a break starts', () => {
    const { result } = renderHook(() => useCountdown(60, '1:MID_GAME'));
    expect(result.current).toBe(60);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(57);
  });

  it('stops at zero rather than going negative', () => {
    const { result } = renderHook(() => useCountdown(2, '1:MID_GAME'));
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(0);
  });

  it('restarts for a different break instead of continuing the old count', () => {
    const { result, rerender } = renderHook(({ s, k }) => useCountdown(s, k), {
      initialProps: { s: 60, k: '1:MID_GAME' },
    });
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(55);
    rerender({ s: 120, k: '1:BETWEEN_GAMES' });
    expect(result.current).toBe(120);
  });

  it('clears back to null when the break ends', () => {
    const { result, rerender } = renderHook(({ s, k }) => useCountdown(s, k), {
      initialProps: { s: 60 as number | null, k: '1:MID_GAME' },
    });
    rerender({ s: null, k: '1:none' });
    expect(result.current).toBeNull();
  });
});
