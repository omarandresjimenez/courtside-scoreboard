import { useEffect, useState } from 'react';

/**
 * A self-contained wall clock.
 *
 * Isolated into its own component on purpose: the per-second tick used to live
 * in StreamViewer, where it re-rendered that whole screen — video container,
 * scoreboard and all — once a second just to redraw two digits. Keeping the
 * interval in a leaf confines the re-render to the leaf, which is the point of
 * separating high-frequency ticks from the media viewport.
 */
export function Clock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <time className={className}>
      {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  );
}
