import { act, renderHook, waitFor } from '@testing-library/react';
import { SERVER_EVENTS, UMPIRE_EVENTS } from '@courtside/shared';
import type { MatchStatePayload } from '@courtside/shared';

type Handler = (payload?: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    on: jest.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    emit: jest.fn(),
    disconnect: jest.fn(),
    fire: (event: string, payload?: unknown) => handlers.get(event)?.(payload),
  };
}

let fakeSocket = makeFakeSocket();
// Cast away the specific SocketConnectionOptions param so this stays a
// drop-in for connectSocket regardless of which options shape a test uses.
const mockConnectSocket = jest.fn((_options: unknown) => fakeSocket);
jest.mock('./socket.js', () => ({ connectSocket: mockConnectSocket }));

const mockCacheMatchState = jest.fn(async (_key: string, _state: MatchStatePayload) => undefined);
const mockReadCachedMatchState = jest.fn(
  async (_key: string) => undefined as MatchStatePayload | undefined,
);
jest.mock('./offlineCache.js', () => ({
  cacheMatchState: mockCacheMatchState,
  readCachedMatchState: mockReadCachedMatchState,
}));

import { useMatchState } from './useMatchState.js';

const samplePayload = {
  match: { matchId: 'm1', matchType: 'singles', players: [], scoringConfig: {} },
  derived: {},
} as unknown as MatchStatePayload;

beforeEach(() => {
  fakeSocket = makeFakeSocket();
  mockConnectSocket.mockImplementation(() => fakeSocket);
  mockCacheMatchState.mockClear();
  mockReadCachedMatchState.mockReset().mockResolvedValue(undefined);
});

describe('useMatchState', () => {
  it('starts disconnected with no state, and connects the socket with the given options', () => {
    const { result } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));

    expect(result.current.state).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(mockConnectSocket).toHaveBeenCalledWith({ role: 'tv', courtId: 'c1' });
  });

  it('renders a cached match state immediately, flagged as from-cache', async () => {
    mockReadCachedMatchState.mockResolvedValue(samplePayload);

    const { result } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));

    await waitFor(() => expect(result.current.state).toBe(samplePayload));
    expect(result.current.isFromCache).toBe(true);
  });

  it('does not apply the cached state after the effect has been cleaned up', async () => {
    let resolveCache: (value: MatchStatePayload | undefined) => void = () => {};
    mockReadCachedMatchState.mockReturnValue(
      new Promise((resolve) => {
        resolveCache = resolve;
      }),
    );

    const { result, unmount } = renderHook(() =>
      useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'),
    );
    unmount();
    resolveCache(samplePayload);
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBeNull();
  });

  it('flips connected on the socket connect/disconnect events', () => {
    const { result } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));

    act(() => fakeSocket.fire('connect'));
    expect(result.current.connected).toBe(true);

    act(() => fakeSocket.fire('disconnect'));
    expect(result.current.connected).toBe(false);
  });

  it('applies MATCH_STATE pushes, clears any error, and caches the new state', () => {
    const { result } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));

    act(() => fakeSocket.fire(SERVER_EVENTS.MATCH_NOT_FOUND));
    expect(result.current.error).not.toBeNull();

    act(() => fakeSocket.fire(SERVER_EVENTS.MATCH_STATE, samplePayload));

    expect(result.current.state).toBe(samplePayload);
    expect(result.current.isFromCache).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockCacheMatchState).toHaveBeenCalledWith('tv:c1', samplePayload);
  });

  it('surfaces MATCH_NOT_FOUND as a friendly error', () => {
    const { result } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));

    act(() => fakeSocket.fire(SERVER_EVENTS.MATCH_NOT_FOUND));

    expect(result.current.error).toBe('No match found for this link yet.');
  });

  it('surfaces a server ERROR message verbatim', () => {
    const { result } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));

    act(() => fakeSocket.fire(SERVER_EVENTS.ERROR, { message: 'Invalid umpire token.' }));

    expect(result.current.error).toBe('Invalid umpire token.');
  });

  it('disconnects the socket on unmount', () => {
    const { unmount } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));
    unmount();
    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });

  describe('addPoint / undoLastPoint', () => {
    it('emit ADD_POINT / UNDO_LAST_POINT with the matchId for an umpire connection', () => {
      const { result } = renderHook(() =>
        useMatchState({ role: 'umpire', matchId: 'm1', token: 'tok' }, 'umpire:m1'),
      );

      act(() => result.current.addPoint('A'));
      expect(fakeSocket.emit).toHaveBeenCalledWith(
        UMPIRE_EVENTS.ADD_POINT,
        expect.objectContaining({ matchId: 'm1', side: 'A' }),
      );

      act(() => result.current.undoLastPoint());
      expect(fakeSocket.emit).toHaveBeenCalledWith(
        UMPIRE_EVENTS.UNDO_LAST_POINT,
        expect.objectContaining({ matchId: 'm1' }),
      );

      act(() => result.current.startSet('A', 'a1'));
      expect(fakeSocket.emit).toHaveBeenCalledWith(
        UMPIRE_EVENTS.START_SET,
        expect.objectContaining({ matchId: 'm1', firstServerSide: 'A', firstServerPlayerId: 'a1' }),
      );

      act(() => result.current.resumeFromInterval());
      expect(fakeSocket.emit).toHaveBeenCalledWith(
        UMPIRE_EVENTS.RESUME_FROM_INTERVAL,
        expect.objectContaining({ matchId: 'm1' }),
      );

      act(() => result.current.retireMatch('B'));
      expect(fakeSocket.emit).toHaveBeenCalledWith(
        UMPIRE_EVENTS.RETIRE_MATCH,
        expect.objectContaining({ matchId: 'm1', winnerSide: 'B' }),
      );
    });

    it('includes courtPositions in START_SET for a doubles match', () => {
      const { result } = renderHook(() =>
        useMatchState({ role: 'umpire', matchId: 'm1', token: 'tok' }, 'umpire:m1'),
      );

      act(() => result.current.startSet('A', 'a1', { A: { right: 'a1', left: 'a2' } }));
      expect(fakeSocket.emit).toHaveBeenCalledWith(
        UMPIRE_EVENTS.START_SET,
        expect.objectContaining({
          matchId: 'm1',
          firstServerSide: 'A',
          firstServerPlayerId: 'a1',
          courtPositions: { A: { right: 'a1', left: 'a2' } },
        }),
      );
    });

    it('are no-ops for a tv (non-umpire) connection', () => {
      const { result } = renderHook(() => useMatchState({ role: 'tv', courtId: 'c1' }, 'tv:c1'));

      act(() => result.current.addPoint('A'));
      act(() => result.current.undoLastPoint());
      act(() => result.current.startSet('A', 'a1'));
      act(() => result.current.resumeFromInterval());
      act(() => result.current.retireMatch('A'));

      expect(fakeSocket.emit).not.toHaveBeenCalled();
    });
  });
});
