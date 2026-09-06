import { act, renderHook, waitFor } from '@testing-library/react';

const track = { stop: jest.fn(), kind: 'video' };
const stream = { getTracks: () => [track] } as unknown as MediaStream;

const mockRequestCameraStream = jest.fn(async () => stream);
jest.mock('./camera-stream.js', () => ({
  requestCameraStream: () => mockRequestCameraStream(),
  cameraErrorMessage: (err: unknown) => (err as Error).message,
}));

const lanHandle = { setVideoEnabled: jest.fn(), stop: jest.fn() };
const mockStartBroadcasting = jest.fn((..._args: unknown[]) => lanHandle);
const standbyHandle = { stop: jest.fn() };
const mockWatchForMatchStart = jest.fn((..._args: unknown[]) => standbyHandle);
jest.mock('./webrtc-stream.js', () => ({
  startBroadcasting: (...args: unknown[]) => mockStartBroadcasting(...args),
  watchForMatchStart: (...args: unknown[]) => mockWatchForMatchStart(...args),
}));

const internetHandle = { stop: jest.fn(), viewerCount: () => 0, setPaused: jest.fn() };
const RELAY_SERVERS = [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' }];
const mockFetchIce = jest.fn(async () => RELAY_SERVERS);
const mockBroadcastToInternet = jest.fn(
  (
    _config: unknown,
    _courtId: string,
    _stream: MediaStream,
    _onCount?: (n: number) => void,
    _iceServers?: unknown,
  ) => internetHandle,
);
jest.mock('./firestore-signal.js', () => ({
  broadcastToInternet: (...args: unknown[]) =>
    mockBroadcastToInternet(
      args[0],
      args[1] as string,
      args[2] as MediaStream,
      args[3] as ((n: number) => void) | undefined,
      args[4],
    ),
}));

jest.mock('./turn-credentials.js', () => ({
  fetchInternetIceServers: () => mockFetchIce(),
}));

import { useCameraBroadcast } from './useCameraBroadcast.js';

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestCameraStream.mockResolvedValue(stream);
  mockFetchIce.mockResolvedValue(RELAY_SERVERS);
});

async function started(courtId = 'court1') {
  const view = renderHook(() => useCameraBroadcast(courtId));
  await act(async () => {
    await view.result.current.start();
  });
  return view;
}

describe('useCameraBroadcast', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useCameraBroadcast('court1'));
    expect(result.current.status).toBe('idle');
    expect(result.current.stream).toBeNull();
  });

  it('goes live and drives both signalling paths', async () => {
    const { result } = await started();

    expect(result.current.status).toBe('live');
    expect(result.current.stream).toBe(stream);
    expect(mockStartBroadcasting).toHaveBeenCalled();
    expect(mockBroadcastToInternet).toHaveBeenCalled();
  });

  it('passes the fetched relay into the internet broadcast', async () => {
    await started();

    // A peer built without a relay cannot gain one later without
    // renegotiating, so the credentials must be in hand before broadcasting.
    expect(mockFetchIce).toHaveBeenCalled();
    expect(mockBroadcastToInternet.mock.calls[0]![4]).toEqual(RELAY_SERVERS);
  });

  it('stays live on LAN when the internet path throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockBroadcastToInternet.mockImplementationOnce(() => {
      throw new Error('firebase down');
    });

    const { result } = await started();

    // The LAN mesh is the path that survives a venue with no uplink; an
    // internet failure must never take it down.
    expect(result.current.status).toBe('live');
    expect(mockStartBroadcasting).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('surfaces a camera failure as an error status and message', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRequestCameraStream.mockRejectedValueOnce(new Error('Camera permission was denied.'));

    const { result } = await started();

    expect(result.current.status).toBe('error');
    expect(result.current.errorMessage).toBe('Camera permission was denied.');
    error.mockRestore();
  });

  it('does nothing without a court id', async () => {
    const { result } = renderHook(() => useCameraBroadcast(undefined));
    await act(async () => {
      await result.current.start();
    });
    expect(mockRequestCameraStream).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('pauses and resumes, telling viewers on both paths each time', async () => {
    const { result } = await started();

    act(() => result.current.togglePause());
    expect(result.current.status).toBe('paused');
    expect(lanHandle.setVideoEnabled).toHaveBeenLastCalledWith(false);
    expect(internetHandle.setPaused).toHaveBeenLastCalledWith(true);

    act(() => result.current.togglePause());
    expect(result.current.status).toBe('live');
    expect(lanHandle.setVideoEnabled).toHaveBeenLastCalledWith(true);
    expect(internetHandle.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('still pauses the LAN viewers when the internet path never came up', async () => {
    mockBroadcastToInternet.mockImplementationOnce(() => {
      throw new Error('firebase down');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await started();
    warn.mockRestore();

    // internetRef stayed null; togglePause must not throw reaching for it.
    expect(() => act(() => result.current.togglePause())).not.toThrow();
    expect(result.current.status).toBe('paused');
    expect(lanHandle.setVideoEnabled).toHaveBeenLastCalledWith(false);
  });

  it('ignores a pause before the broadcast has started', () => {
    const { result } = renderHook(() => useCameraBroadcast('court1'));
    act(() => result.current.togglePause());
    expect(lanHandle.setVideoEnabled).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('releases the camera and both meshes on stop', async () => {
    const { result } = await started();

    act(() => result.current.stop());

    expect(lanHandle.stop).toHaveBeenCalled();
    expect(internetHandle.stop).toHaveBeenCalled();
    // Stopping the tracks is what turns the camera light off.
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.stream).toBeNull();
  });

  it('releases everything on unmount even if Stop was never pressed', async () => {
    const { unmount } = await started();

    unmount();

    expect(lanHandle.stop).toHaveBeenCalled();
    expect(internetHandle.stop).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it('reports the internet viewer count as the broadcaster publishes it', async () => {
    const { result } = await started();
    const onCount = mockBroadcastToInternet.mock.calls[0]![3]!;

    act(() => onCount(3));

    await waitFor(() => expect(result.current.internetViewers).toBe(3));
  });

  it('stops itself and leaves a notice when the server reports the match finalised', async () => {
    const { result } = await started();
    const onMatchFinalized = mockStartBroadcasting.mock.calls[0]![2] as () => void;

    act(() => onMatchFinalized());

    expect(lanHandle.stop).toHaveBeenCalled();
    expect(internetHandle.stop).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.stream).toBeNull();
    expect(result.current.autoStopNotice).toMatch(/match on this court has ended/);
  });

  it('clears a stale finalised notice on the next start', async () => {
    const { result } = await started();
    const onMatchFinalized = mockStartBroadcasting.mock.calls[0]![2] as () => void;
    act(() => onMatchFinalized());
    expect(result.current.autoStopNotice).not.toBeNull();

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.autoStopNotice).toBeNull();
  });

  describe('auto-start on match start', () => {
    it('listens for the umpire starting the match while idle', () => {
      renderHook(() => useCameraBroadcast('court1'));
      expect(mockWatchForMatchStart).toHaveBeenCalledWith('court1', expect.any(Function));
    });

    it('does not listen without a court id', () => {
      renderHook(() => useCameraBroadcast(undefined));
      expect(mockWatchForMatchStart).not.toHaveBeenCalled();
    });

    it('starts itself silently when the umpire starts the match and the phone already has camera permission', async () => {
      const { result } = renderHook(() => useCameraBroadcast('court1'));
      const onMatchStarted = mockWatchForMatchStart.mock.calls[0]![1] as () => Promise<void>;

      await act(async () => {
        await onMatchStarted();
      });

      expect(result.current.status).toBe('live');
      expect(result.current.errorMessage).toBeNull();
      // Stops standing by the moment it becomes the real broadcaster —
      // otherwise the same signal could fire the whole thing twice.
      expect(standbyHandle.stop).toHaveBeenCalled();
    });

    it('falls back to idle with no visible error when the phone never granted camera permission', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockRequestCameraStream.mockRejectedValueOnce(new Error('Permission denied'));
      const { result } = renderHook(() => useCameraBroadcast('court1'));
      const onMatchStarted = mockWatchForMatchStart.mock.calls[0]![1] as () => Promise<void>;

      await act(async () => {
        await onMatchStarted();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.errorMessage).toBeNull();
      expect(warn).toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      warn.mockRestore();
      error.mockRestore();
    });

    it('stops listening once a real broadcast is live, and listens again after it stops', async () => {
      const { result } = await started();
      expect(standbyHandle.stop).toHaveBeenCalledTimes(1);

      act(() => result.current.stop());

      expect(mockWatchForMatchStart).toHaveBeenCalledTimes(2);
    });
  });
});
