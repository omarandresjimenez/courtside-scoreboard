import { useEffect } from 'react';

/**
 * Hold a screen wake lock while `active`.
 *
 * The court-side phone is the reason this exists: when its screen sleeps the
 * OS suspends camera capture and the broadcast dies, which looks to everyone
 * watching like the app crashed.
 *
 * Best-effort by design. The API needs a secure context and is missing on
 * older iOS, so every failure is swallowed — a phone that dims is a far
 * smaller problem than a broadcast screen that throws.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (!('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch (err) {
        console.warn('Screen wake lock unavailable:', err);
      }
    };
    void acquire();

    // The browser drops the lock whenever the tab is backgrounded — including
    // a glance at another app — and does not restore it on return, so it has
    // to be taken again by hand.
    const reacquire = () => {
      if (!released && document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', reacquire);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', reacquire);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}
