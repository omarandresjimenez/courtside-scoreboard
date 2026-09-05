import {
  getTurnIceServers,
  isTurnConfigured,
  resetTurnCredentialCache,
} from './turn-credentials.js';

const RELAY = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'minted-user',
      credential: 'minted-secret',
    },
  ],
};

const originalEnv = { ...process.env };
let fetchMock: jest.Mock;
let warn: jest.SpyInstance;

function ok(body: unknown) {
  return { ok: true, status: 201, json: async () => body };
}

beforeEach(() => {
  resetTurnCredentialCache();
  delete process.env.CLOUDFLARE_TURN_KEY_ID;
  delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  fetchMock = jest.fn(async () => ok(RELAY));
  (globalThis as Record<string, unknown>).fetch = fetchMock;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

function configure() {
  process.env.CLOUDFLARE_TURN_KEY_ID = 'key-123';
  process.env.CLOUDFLARE_TURN_API_TOKEN = 'token-abc';
}

describe('isTurnConfigured', () => {
  it('is false with neither credential', () => {
    expect(isTurnConfigured()).toBe(false);
  });

  it('is false with only one of the pair', () => {
    process.env.CLOUDFLARE_TURN_KEY_ID = 'key-123';
    expect(isTurnConfigured()).toBe(false);
  });

  it('is true once both are set', () => {
    configure();
    expect(isTurnConfigured()).toBe(true);
  });
});

describe('getTurnIceServers', () => {
  it('returns nothing and calls no API when unconfigured', async () => {
    await expect(getTurnIceServers()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints credentials from Cloudflare', async () => {
    configure();

    await expect(getTurnIceServers()).resolves.toEqual(RELAY.iceServers);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v1/turn/keys/key-123/credentials/generate-ice-servers');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer token-abc');
    expect(JSON.parse(init.body)).toEqual({ ttl: 86400 });
  });

  it('reuses the cached pair rather than minting per broadcast', async () => {
    configure();

    await getTurnIceServers();
    await getTurnIceServers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('degrades to STUN-only when Cloudflare refuses the key', async () => {
    configure();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    await expect(getTurnIceServers()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
  });

  it('never logs the API token, even on failure', async () => {
    configure();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad token token-abc' }),
    });

    await getTurnIceServers();

    // An error body can echo the request back; this token must not reach logs.
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('token-abc');
  });

  it('degrades to STUN-only when Cloudflare is unreachable', async () => {
    configure();
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'));

    await expect(getTurnIceServers()).resolves.toEqual([]);
  });

  it('does not cache a failure, so the next broadcast retries', async () => {
    configure();
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await getTurnIceServers();
    await getTurnIceServers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tolerates a single object where an array is documented', async () => {
    configure();
    const single = { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' };
    fetchMock.mockResolvedValueOnce(ok({ iceServers: single }));

    await expect(getTurnIceServers()).resolves.toEqual([single]);
  });

  it('treats an empty server list as no relay', async () => {
    configure();
    fetchMock.mockResolvedValueOnce(ok({ iceServers: [] }));

    await expect(getTurnIceServers()).resolves.toEqual([]);
  });
});
