import { act, render, screen } from '@testing-library/react';
import { Clock } from './Clock.js';

describe('Clock', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the current time as hours and minutes', () => {
    jest.setSystemTime(new Date('2026-01-01T14:35:00'));
    render(<Clock className="summary-pill" />);

    expect(screen.getByText(/14:35|02:35/)).toBeInTheDocument();
  });

  it('applies the className to the time element', () => {
    const { container } = render(<Clock className="summary-pill" />);
    expect(container.querySelector('time')).toHaveClass('summary-pill');
  });

  it('updates as the minute advances', () => {
    jest.setSystemTime(new Date('2026-01-01T14:35:00'));
    const { container } = render(<Clock />);
    const before = container.querySelector('time')?.textContent;

    act(() => {
      jest.setSystemTime(new Date('2026-01-01T14:36:00'));
      jest.advanceTimersByTime(1000);
    });

    expect(container.querySelector('time')?.textContent).not.toBe(before);
  });

  it('clears its interval on unmount so no timer outlives the screen', () => {
    const clearSpy = jest.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<Clock />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
