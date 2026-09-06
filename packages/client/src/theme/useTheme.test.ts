import { act, renderHook } from '@testing-library/react';
import { useTheme } from './useTheme.js';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to dark when nothing has been chosen yet', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
  });

  it('switches immediately when setTheme is called', () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme('light'));

    expect(result.current.theme).toBe('light');
  });

  it('persists an explicit choice, overriding the default on the next mount', () => {
    const first = renderHook(() => useTheme());
    act(() => first.result.current.setTheme('light'));

    // A fresh mount — e.g. a page reload — must honour the saved choice.
    const second = renderHook(() => useTheme());

    expect(second.result.current.theme).toBe('light');
  });

  it('a choice made through one call site is reflected by every other one already mounted', () => {
    const header = renderHook(() => useTheme());
    const otherComponent = renderHook(() => useTheme());
    expect(otherComponent.result.current.theme).toBe('dark');

    act(() => header.result.current.setTheme('light'));

    expect(otherComponent.result.current.theme).toBe('light');
  });

  it('ignores a corrupted stored value instead of throwing, falling back to dark', () => {
    localStorage.setItem('courtside:theme', 'not-a-real-theme');

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
  });

  it('switching back to dark is remembered too, not just the first explicit choice', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('light'));
    act(() => result.current.setTheme('dark'));

    const fresh = renderHook(() => useTheme());

    expect(fresh.result.current.theme).toBe('dark');
  });
});
