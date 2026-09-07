const mockGetCloudDb = jest.fn();
jest.mock('./cloud-sync.js', () => ({
  getCloudDb: () => mockGetCloudDb(),
}));

import {
  getLiveInputForCourt,
  isStreamConfigured,
  isStreamEnabledRemotely,
  resetLiveInputCache,
} from './cloudflare-stream.js';

/** A Firestore stub whose `config/streaming` document holds `data`. */
function cloudDbWith(data: unknown, exists = true) {
  const get = jest.fn(async () => ({ exists, data: () => data }));
  return {
    db: { collection: jest.fn(() => ({ doc: jest.fn(() => ({ get })) })) },
    get,
  };
}

const FULL_INPUT = {
  uid: 'input-1',
  meta: { courtsideCourtId: 'court-a' },
  webRTC: { url: 'https://customer-x.cloudflarestream.com/secret/webRTC/publish' },
  webRTCPlayback: { url: 'https://customer-x.cloudflarestream.com/secret/webRTC/play' },
};

const originalEnv = { ...process.env };
let fetchMock: jest.Mock;
let warn: jest.SpyInstance;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** The URL of the nth fetch this test made, for asserting call order. */
function urlOf(call: number): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

beforeEach(() => {
  resetLiveInputCache();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_STREAM_API_TOKEN;
  fetchMock = jest.fn();
  (globalThis as Record<string, unknown>).fetch = fetchMock;
  // No cloud sync unless a test says otherwise — a LAN-only venue is the
  // normal case, and the switch must not require Firebase to be configured.
  mockGetCloudDb.mockReturnValue(undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

function configure() {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-123';
  process.env.CLOUDFLARE_STREAM_API_TOKEN = 'token-abc';
}

describe('isStreamConfigured', () => {
  it('is false until both the account and the token are present', () => {
    expect(isStreamConfigured()).toBe(false);

    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-123';
    expect(isStreamConfigured()).toBe(false);

    process.env.CLOUDFLARE_STREAM_API_TOKEN = 'token-abc';
    expect(isStreamConfigured()).toBe(true);
  });
});

describe('getLiveInputForCourt', () => {
  it('returns null without calling Cloudflare when unconfigured', async () => {
    expect(await getLiveInputForCourt('court-a')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates an input when the account has none for this court', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(ok({ result: [] })) // list
      .mockResolvedValueOnce(ok({ result: FULL_INPUT })); // create

    expect(await getLiveInputForCourt('court-a')).toEqual({
      uid: 'input-1',
      publishUrl: FULL_INPUT.webRTC.url,
      playbackUrl: FULL_INPUT.webRTCPlayback.url,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('tags a created input with its court so a later run can find it again', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(ok({ result: [] }))
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));

    await getLiveInputForCourt('court-a');

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.meta.courtsideCourtId).toBe('court-a');
  });

  it('records nothing, so no Cloudflare storage is ever billed', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(ok({ result: [] }))
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));

    await getLiveInputForCourt('court-a');

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.recording).toEqual({ mode: 'off' });
  });

  it('adopts the input a previous run created rather than making another', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(
        ok({ result: [{ uid: 'input-1', meta: { courtsideCourtId: 'court-a' } }] }),
      )
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));

    const input = await getLiveInputForCourt('court-a');

    expect(input?.uid).toBe('input-1');
    // List, then fetch that one in full. Never a POST — an input per restart
    // would pile up abandoned inputs in the account.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(1)).toContain('/stream/live_inputs/input-1');
    fetchMock.mock.calls.forEach(([, init]) => expect(init?.method).not.toBe('POST'));
  });

  it('ignores an existing input belonging to a different court', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(
        ok({ result: [{ uid: 'other', meta: { courtsideCourtId: 'court-b' } }] }),
      )
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));

    await getLiveInputForCourt('court-a');

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('re-fetches the matched input in full, since the list omits the WebRTC URLs', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(
        ok({ result: [{ uid: 'input-1', meta: { courtsideCourtId: 'court-a' } }] }),
      )
      // The list entry alone has no webRTC block, so adopting it without this
      // second call would yield an input that cannot be published to.
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));

    const input = await getLiveInputForCourt('court-a');

    expect(input?.publishUrl).toBe(FULL_INPUT.webRTC.url);
  });

  it('caches, so a second broadcast on the same court costs no API calls', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(ok({ result: [] }))
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));

    await getLiveInputForCourt('court-a');
    const again = await getLiveInputForCourt('court-a');

    expect(again?.uid).toBe('input-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the API token as a bearer credential', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(ok({ result: [] }))
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));

    await getLiveInputForCourt('court-a');

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer token-abc',
    });
  });

  it('returns null when Cloudflare refuses, so the caller falls back to the mesh', async () => {
    configure();
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    expect(await getLiveInputForCourt('court-a')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('never logs the response body, which can echo the token back', async () => {
    configure();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ errors: ['token token-abc is invalid'] }),
    });

    await getLiveInputForCourt('court-a');

    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('token-abc');
  });

  it('returns null rather than throwing when Cloudflare is unreachable', async () => {
    configure();
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(getLiveInputForCourt('court-a')).resolves.toBeNull();
  });

  it('rejects an input that carries no WebRTC URLs', async () => {
    configure();
    fetchMock
      .mockResolvedValueOnce(ok({ result: [] }))
      // An input made for RTMP ingest has no webRTC block, and is useless here.
      .mockResolvedValueOnce(ok({ result: { uid: 'input-1' } }));

    expect(await getLiveInputForCourt('court-a')).toBeNull();
  });

  it('does not cache a failure, so a transient outage recovers on the next try', async () => {
    configure();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect(await getLiveInputForCourt('court-a')).toBeNull();

    fetchMock
      .mockResolvedValueOnce(ok({ result: [] }))
      .mockResolvedValueOnce(ok({ result: FULL_INPUT }));
    expect(await getLiveInputForCourt('court-a')).not.toBeNull();
  });
});

describe('isStreamEnabledRemotely', () => {
  it('is enabled when there is no cloud sync to read a flag from', async () => {
    mockGetCloudDb.mockReturnValue(undefined);

    expect(await isStreamEnabledRemotely()).toBe(true);
  });

  it('is enabled when the flag document has never been created', async () => {
    mockGetCloudDb.mockReturnValue(cloudDbWith(undefined, false).db);

    expect(await isStreamEnabledRemotely()).toBe(true);
  });

  it('is enabled when the document exists but carries no flag', async () => {
    mockGetCloudDb.mockReturnValue(cloudDbWith({ somethingElse: 1 }).db);

    expect(await isStreamEnabledRemotely()).toBe(true);
  });

  it('is disabled only by an explicit false', async () => {
    mockGetCloudDb.mockReturnValue(cloudDbWith({ cloudflareStreamEnabled: false }).db);

    expect(await isStreamEnabledRemotely()).toBe(false);
  });

  it('is enabled when the flag is explicitly true', async () => {
    mockGetCloudDb.mockReturnValue(cloudDbWith({ cloudflareStreamEnabled: true }).db);

    expect(await isStreamEnabledRemotely()).toBe(true);
  });

  it('ignores a flag of the wrong type rather than guessing at it', async () => {
    // 'false' the string, or 0, is somebody editing the console field wrong.
    // Treating that as "off" would be a confusing way to lose the feature.
    mockGetCloudDb.mockReturnValue(cloudDbWith({ cloudflareStreamEnabled: 'false' }).db);

    expect(await isStreamEnabledRemotely()).toBe(true);
  });

  it('reads config/streaming', async () => {
    const stub = cloudDbWith({ cloudflareStreamEnabled: false });
    mockGetCloudDb.mockReturnValue(stub.db);

    await isStreamEnabledRemotely();

    expect(stub.db.collection).toHaveBeenCalledWith('config');
  });

  it('assumes enabled when the read fails', async () => {
    mockGetCloudDb.mockReturnValue({
      collection: () => ({ doc: () => ({ get: async () => Promise.reject(new Error('nope')) }) }),
    });

    // The switch exists to turn a working feature off on purpose; a Firestore
    // hiccup must not silently downgrade every court to the 5-viewer mesh.
    expect(await isStreamEnabledRemotely()).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('assumes enabled when the read hangs, without holding up the broadcast', async () => {
    jest.useFakeTimers();
    mockGetCloudDb.mockReturnValue({
      collection: () => ({ doc: () => ({ get: () => new Promise(() => {}) }) }),
    });

    const pending = isStreamEnabledRemotely();
    jest.advanceTimersByTime(3000);

    expect(await pending).toBe(true);
    jest.useRealTimers();
  });
});
