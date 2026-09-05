import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { useFullscreen } from './useFullscreen.js';

type Mutable = Record<string, unknown>;

const originalDoc: Mutable = {};
const DOC_KEYS = [
  'fullscreenEnabled',
  'webkitFullscreenEnabled',
  'fullscreenElement',
  'webkitFullscreenElement',
  'exitFullscreen',
  'webkitExitFullscreen',
];

function setDoc(props: Mutable) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(document, key, { value, configurable: true, writable: true });
  }
}

function containerRef(el: Partial<HTMLElement> | null) {
  const ref = createRef<HTMLElement>();
  (ref as { current: unknown }).current = el;
  return ref as React.RefObject<HTMLElement | null>;
}

function videoRef(el: Partial<HTMLVideoElement> | null) {
  const ref = createRef<HTMLVideoElement>();
  (ref as { current: unknown }).current = el;
  return ref as React.RefObject<HTMLVideoElement | null>;
}

beforeEach(() => {
  for (const key of DOC_KEYS) originalDoc[key] = (document as unknown as Mutable)[key];
  setDoc({
    fullscreenEnabled: true,
    webkitFullscreenEnabled: undefined,
    fullscreenElement: null,
    webkitFullscreenElement: null,
    exitFullscreen: jest.fn(async () => undefined),
    webkitExitFullscreen: undefined,
  });
  // jsdom has no video fullscreen; tests opt in explicitly.
  delete (HTMLVideoElement.prototype as unknown as Mutable).webkitEnterFullscreen;
});

afterEach(() => {
  setDoc(originalDoc);
  jest.restoreAllMocks();
});

describe('useFullscreen', () => {
  it('reports support when the document allows fullscreen', () => {
    const { result } = renderHook(() => useFullscreen(containerRef(null)));
    expect(result.current.isSupported).toBe(true);
  });

  it('reports support on iPhone, where only video fullscreen exists', () => {
    setDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: undefined });
    (HTMLVideoElement.prototype as unknown as Mutable).webkitEnterFullscreen = jest.fn();

    const { result } = renderHook(() => useFullscreen(containerRef(null)));
    expect(result.current.isSupported).toBe(true);
  });

  it('reports no support when the browser offers no route at all', () => {
    setDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: undefined });
    const { result } = renderHook(() => useFullscreen(containerRef(null)));
    expect(result.current.isSupported).toBe(false);
  });

  it('requests fullscreen on the container', () => {
    const requestFullscreen = jest.fn(async () => undefined);
    const { result } = renderHook(() => useFullscreen(containerRef({ requestFullscreen })));

    act(() => result.current.toggle());

    expect(requestFullscreen).toHaveBeenCalled();
  });

  it('falls back to the prefixed request in older Safari', () => {
    const webkitRequestFullscreen = jest.fn();
    const { result } = renderHook(() =>
      useFullscreen(containerRef({ webkitRequestFullscreen } as Partial<HTMLElement>)),
    );

    act(() => result.current.toggle());

    expect(webkitRequestFullscreen).toHaveBeenCalled();
  });

  it('falls back to native video fullscreen on iPhone', () => {
    const webkitEnterFullscreen = jest.fn();
    // No requestFullscreen on the container at all — the iPhone case.
    const { result } = renderHook(() =>
      useFullscreen(containerRef({}), videoRef({ webkitEnterFullscreen } as never)),
    );

    act(() => result.current.toggle());

    expect(webkitEnterFullscreen).toHaveBeenCalled();
  });

  it('does not attempt video fullscreen when the video says it cannot', () => {
    const webkitEnterFullscreen = jest.fn();
    const { result } = renderHook(() =>
      useFullscreen(
        containerRef({}),
        videoRef({ webkitEnterFullscreen, webkitSupportsFullscreen: false } as never),
      ),
    );

    act(() => result.current.toggle());

    expect(webkitEnterFullscreen).not.toHaveBeenCalled();
  });

  it('exits when already fullscreen', () => {
    const exitFullscreen = jest.fn(async () => undefined);
    setDoc({ fullscreenElement: {}, exitFullscreen });
    const requestFullscreen = jest.fn(async () => undefined);

    const { result } = renderHook(() => useFullscreen(containerRef({ requestFullscreen })));
    act(() => result.current.toggle());

    expect(exitFullscreen).toHaveBeenCalled();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('uses the prefixed exit when that is all there is', () => {
    const webkitExitFullscreen = jest.fn();
    setDoc({ webkitFullscreenElement: {}, exitFullscreen: undefined, webkitExitFullscreen });

    const { result } = renderHook(() => useFullscreen(containerRef({})));
    act(() => result.current.toggle());

    expect(webkitExitFullscreen).toHaveBeenCalled();
  });

  it('tracks fullscreen state from the browser event, not the click', () => {
    const { result } = renderHook(() => useFullscreen(containerRef({})));
    expect(result.current.isFullscreen).toBe(false);

    // The user can also leave fullscreen with Escape or a system gesture.
    setDoc({ fullscreenElement: {} });
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(result.current.isFullscreen).toBe(true);

    setDoc({ fullscreenElement: null });
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(result.current.isFullscreen).toBe(false);
  });

  it('survives a request the browser refuses', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const requestFullscreen = jest.fn(() => Promise.reject(new Error('gesture required')));

    const { result } = renderHook(() => useFullscreen(containerRef({ requestFullscreen })));
    act(() => result.current.toggle());
    await act(async () => {
      await Promise.resolve();
    });

    expect(warn).toHaveBeenCalledWith('Fullscreen request was refused:', expect.any(Error));
  });

  it('does nothing when there is no container and no video', () => {
    const { result } = renderHook(() => useFullscreen(containerRef(null)));
    expect(() => act(() => result.current.toggle())).not.toThrow();
  });

  it('removes its listeners on unmount', () => {
    const remove = jest.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useFullscreen(containerRef({})));
    unmount();
    expect(remove).toHaveBeenCalledWith('fullscreenchange', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function));
  });
});
