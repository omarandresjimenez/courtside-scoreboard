import { act, renderHook, waitFor } from '@testing-library/react';
import { useWakeLock } from './useWakeLock.js';

const release = jest.fn(async () => undefined);
const request = jest.fn(async () => ({ release }));

function installWakeLock() {
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
    writable: true,
  });
}

function removeWakeLock() {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'wakeLock');
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  installWakeLock();
  setVisibility('visible');
});

afterEach(() => {
  removeWakeLock();
  jest.restoreAllMocks();
});

describe('useWakeLock', () => {
  it('takes the lock when active', async () => {
    renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
  });

  it('does nothing while inactive', () => {
    renderHook(() => useWakeLock(false));
    expect(request).not.toHaveBeenCalled();
  });

  it('takes the lock when it becomes active', async () => {
    const { rerender } = renderHook(({ on }) => useWakeLock(on), {
      initialProps: { on: false },
    });
    expect(request).not.toHaveBeenCalled();

    rerender({ on: true });
    await waitFor(() => expect(request).toHaveBeenCalled());
  });

  it('releases the lock when it stops being active', async () => {
    const { rerender } = renderHook(({ on }) => useWakeLock(on), {
      initialProps: { on: true },
    });
    await waitFor(() => expect(request).toHaveBeenCalled());

    rerender({ on: false });
    await waitFor(() => expect(release).toHaveBeenCalled());
  });

  it('releases the lock on unmount', async () => {
    const { unmount } = renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(release).toHaveBeenCalled());
  });

  it('retakes the lock after the tab comes back, since the browser drops it', async () => {
    renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('does not retake the lock while the tab is still hidden', async () => {
    renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops listening once released, so a late event cannot retake it', async () => {
    const { unmount } = renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    unmount();
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a browser without the API', () => {
    removeWakeLock();
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
  });

  it('survives a refused request, which is common outside a secure context', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    request.mockRejectedValueOnce(new Error('NotAllowedError'));

    renderHook(() => useWakeLock(true));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Screen wake lock unavailable:', expect.any(Error)),
    );
  });
});
