import { fetchCourtLiveInput } from './cloudflare-stream.js';

const INPUT = {
  configured: true,
  publishUrl: 'https://customer-x.cloudflarestream.com/secret/webRTC/publish',
  playbackUrl: 'https://customer-x.cloudflarestream.com/secret/webRTC/play',
};

let fetchMock: jest.Mock;
let warn: jest.SpyInstance;

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as Record<string, unknown>).fetch = fetchMock;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('fetchCourtLiveInput', () => {
  it('asks the local server for this court', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => INPUT });

    await fetchCourtLiveInput('court-42');

    expect(fetchMock).toHaveBeenCalledWith('/api/stream-input/court-42');
  });

  it('escapes a court id rather than building a broken URL', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => INPUT });

    await fetchCourtLiveInput('court a/b');

    expect(fetchMock).toHaveBeenCalledWith('/api/stream-input/court%20a%2Fb');
  });

  it('returns both URLs when Cloudflare is available', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => INPUT });

    expect(await fetchCourtLiveInput('court-a')).toEqual({
      publishUrl: INPUT.publishUrl,
      playbackUrl: INPUT.playbackUrl,
    });
  });

  it('returns null when the server has no Cloudflare configured', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: false, publishUrl: null, playbackUrl: null }),
    });

    // Not an error: the peer mesh is the documented fallback.
    expect(await fetchCourtLiveInput('court-a')).toBeNull();
  });

  it('returns null when Cloudflare is configured but produced no input', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, publishUrl: null, playbackUrl: null }),
    });

    expect(await fetchCourtLiveInput('court-a')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when only one of the two URLs came back', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, publishUrl: INPUT.publishUrl, playbackUrl: null }),
    });

    // Publishing with nowhere to send viewers is worse than not publishing.
    expect(await fetchCourtLiveInput('court-a')).toBeNull();
  });

  it('returns null on an HTTP error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    expect(await fetchCourtLiveInput('court-a')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('never rejects when the endpoint is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    // Throwing here would stop the broadcast starting at all, which is far
    // worse than a broadcast that reaches fewer viewers.
    await expect(fetchCourtLiveInput('court-a')).resolves.toBeNull();
  });
});
