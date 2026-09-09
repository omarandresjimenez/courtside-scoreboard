import { useCallback, useEffect, useState, type RefObject } from 'react';

/** Safari (desktop and iPad) still ships only the prefixed names. */
interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface WebkitDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
}
/** iPhone exposes fullscreen *only* here — not on arbitrary elements. */
interface WebkitVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
}

function currentFullscreenElement(): Element | null {
  const doc = document as WebkitDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * True if this browser can go fullscreen at all, by any route available to
 * *this* call — `hasVideoFallback` is false for a caller that passed no
 * `videoRef`, since the iPhone route below has nothing to enter fullscreen
 * without one.
 *
 * Probed on the prototypes rather than a live element so the answer is stable
 * from the first render, before any ref has been attached.
 */
function detectSupport(hasVideoFallback: boolean): boolean {
  if (typeof document === 'undefined') return false;
  const doc = document as WebkitDocument;
  if (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) return true;
  if (!hasVideoFallback) return false;
  // iPhone Safari: no element fullscreen, but video has its own native path.
  return (
    typeof HTMLVideoElement !== 'undefined' &&
    typeof (HTMLVideoElement.prototype as WebkitVideo).webkitEnterFullscreen === 'function'
  );
}

export interface FullscreenState {
  isFullscreen: boolean;
  isSupported: boolean;
  toggle: () => void;
}

/**
 * Fullscreen for a container, with the iPhone caveat handled.
 *
 * `Element.requestFullscreen()` does not exist on iPhone Safari — only
 * `HTMLVideoElement.webkitEnterFullscreen()` does. So when the container
 * cannot go fullscreen itself, this falls back to putting just the video
 * fullscreen, which is the best that platform allows. Pass `videoRef` to
 * enable that fallback; without it, iPhone reports unsupported.
 */
export function useFullscreen(
  containerRef: RefObject<HTMLElement | null>,
  videoRef?: RefObject<HTMLVideoElement | null>,
): FullscreenState {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSupported] = useState(() => detectSupport(videoRef !== undefined));

  useEffect(() => {
    const sync = () => setIsFullscreen(currentFullscreenElement() !== null);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const toggle = useCallback(() => {
    const doc = document as WebkitDocument;

    if (currentFullscreenElement()) {
      void (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return;
    }

    const container = containerRef.current as WebkitElement | null;
    if (container?.requestFullscreen) {
      // Rejects when the gesture isn't trusted; never a reason to crash.
      void container.requestFullscreen().catch((err: unknown) => {
        console.warn('Fullscreen request was refused:', err);
      });
      return;
    }
    if (container?.webkitRequestFullscreen) {
      void container.webkitRequestFullscreen();
      return;
    }

    // iPhone. Native video fullscreen has its own chrome and its own exit
    // gesture, and fires no fullscreenchange event — so `isFullscreen` stays
    // false here, which is correct: the page never entered fullscreen.
    const video = videoRef?.current as WebkitVideo | null;
    if (video?.webkitEnterFullscreen && video.webkitSupportsFullscreen !== false) {
      video.webkitEnterFullscreen();
    }
  }, [containerRef, videoRef]);

  return { isFullscreen, isSupported, toggle };
}
