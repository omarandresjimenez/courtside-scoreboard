import { act, renderHook } from '@testing-library/react';

const stop = jest.fn();
const mockStartViewing = jest.fn(
  (
    _courtId: string,
    _onStream: (s: MediaStream | null) => void,
    _onPaused?: (p: boolean) => void,
  ) => ({ stop }),
);
jest.mock('./webrtc-stream.js', () => ({ startViewing: mockStartViewing }));

import { useStreamViewer } from './useStreamViewer.js';

const stream = { id: 's1' } as unknown as MediaStream;

beforeEach(() => {
  stop.mockClear();
  mockStartViewing.mockClear();
});

describe('useStreamViewer', () => {
  it('starts viewing the given court', () => {
    renderHook(() => useStreamViewer('court1'));
    expect(mockStartViewing).toHaveBeenCalledWith(
      'court1',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not connect without a court id', () => {
    const { result } = renderHook(() => useStreamViewer(undefined));
    expect(mockStartViewing).not.toHaveBeenCalled();
    expect(result.current.stream).toBeNull();
  });

  it('exposes the stream once the peer connection delivers it', () => {
    const { result } = renderHook(() => useStreamViewer('court1'));
    act(() => mockStartViewing.mock.calls[0]![1](stream));
    expect(result.current.stream).toBe(stream);
  });

  it('exposes the paused flag reported by the broadcaster', () => {
    const { result } = renderHook(() => useStreamViewer('court1'));
    expect(result.current.isPaused).toBe(false);

    act(() => mockStartViewing.mock.calls[0]![2]!(true));
    expect(result.current.isPaused).toBe(true);
  });

  it('tears the connection down on unmount', () => {
    const { unmount } = renderHook(() => useStreamViewer('court1'));
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reconnects and clears the previous frame when the court changes', () => {
    const { result, rerender } = renderHook(({ id }) => useStreamViewer(id), {
      initialProps: { id: 'court1' as string | undefined },
    });
    act(() => mockStartViewing.mock.calls[0]![1](stream));
    expect(result.current.stream).toBe(stream);

    rerender({ id: 'court2' });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(mockStartViewing).toHaveBeenLastCalledWith(
      'court2',
      expect.any(Function),
      expect.any(Function),
    );
    // The old court's last frame must not linger while court2 negotiates.
    expect(result.current.stream).toBeNull();
  });
});
