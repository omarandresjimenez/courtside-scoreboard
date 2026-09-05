import { renderHook, waitFor } from '@testing-library/react';
import { useCourtLabel } from './useCourtLabel.js';

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as Record<string, unknown>).fetch = fetchMock;
});
afterEach(() => jest.restoreAllMocks());

describe('useCourtLabel', () => {
  it('asks the public label endpoint for the court', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ label: 'Center Court' }) });

    const { result } = renderHook(() => useCourtLabel('court-1'));

    await waitFor(() => expect(result.current).toBe('Center Court'));
    expect(fetchMock).toHaveBeenCalledWith('/api/courts/court-1/label');
  });

  it('encodes the court id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ label: 'X' }) });
    renderHook(() => useCourtLabel('a/b?c'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/courts/a%2Fb%3Fc/label'));
  });

  it('does not fetch without a court id', () => {
    renderHook(() => useCourtLabel(undefined));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays null when the court is unknown, so the caller can fall back', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    const { result } = renderHook(() => useCourtLabel('missing'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('stays null when the request fails outright', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useCourtLabel('court-1'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('ignores a blank label rather than rendering an empty heading', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ label: '   ' }) });

    const { result } = renderHook(() => useCourtLabel('court-1'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('refetches when the court changes', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ label: 'A' }) });
    const { rerender } = renderHook(({ id }) => useCourtLabel(id), {
      initialProps: { id: 'court-1' as string | undefined },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ id: 'court-2' });

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/courts/court-2/label'));
  });
});
