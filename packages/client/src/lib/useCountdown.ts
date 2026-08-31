import { useEffect, useRef, useState } from 'react';

/**
 * Counts a break down to zero for display.
 *
 * The clock is deliberately client-local: nothing in the event log records
 * when an interval began, and the umpire may resume early regardless, so
 * this drives a label rather than a rule. Reloading mid-interval restarts
 * the count — acceptable, because the umpire is the authority on when play
 * resumes, not the timer.
 *
 * Pass `seconds: null` when no break is running; the hook then holds at
 * null and starts fresh the next time a break begins.
 */
export function useCountdown(seconds: number | null, key: string): number | null {
  const [remaining, setRemaining] = useState<number | null>(seconds);
  // Restarting is keyed on which break this is, so a mid-game interval and
  // the following between-games break each get their own full count.
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    if (seconds === null) {
      startedFor.current = null;
      setRemaining(null);
      return;
    }
    if (startedFor.current !== key) {
      startedFor.current = key;
      setRemaining(seconds);
    }
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      // Recomputed from a deadline rather than decremented, so a throttled
      // background tab does not leave the clock permanently behind.
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setRemaining(left);
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [seconds, key]);

  return remaining;
}

/** `95` -> `"1:35"`. */
export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
