import type { FullscreenState } from './useFullscreen.js';

/**
 * Fullscreen toggle for a media surface. Renders nothing where the browser
 * has no fullscreen route at all, rather than offering a control that does
 * nothing when pressed.
 */
export function FullscreenButton({ state }: { state: FullscreenState }) {
  if (!state.isSupported) return null;

  const label = state.isFullscreen ? 'Exit full screen' : 'Full screen';
  return (
    <button
      type="button"
      className="fullscreen-button"
      onClick={state.toggle}
      aria-label={label}
      title={label}
    >
      {state.isFullscreen ? '⤡' : '⤢'}
    </button>
  );
}
