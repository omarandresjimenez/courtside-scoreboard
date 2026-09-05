import { fetchInternetIceServers } from './turn-credentials.js';
import { INTERNET_ICE_SERVERS } from './ice-config.js';

const RELAY = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
  username: 'minted-user',
  credential: 'minted-secret',
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

describe('fetchInternetIceServers', () => {
  it('asks the local server for credentials', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ iceServers: [RELAY] }) });

    await fetchInternetIceServers();

    expect(fetchMock).toHaveBeenCalledWith('/api/turn-credentials');
  });

  it('appends the relay to the static STUN list rather than replacing it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ iceServers: [RELAY] }) });

    const servers = await fetchInternetIceServers();

    expect(servers).toEqual([...INTERNET_ICE_SERVERS, RELAY]);
  });

  it('falls back to STUN when the server has no relay configured', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ iceServers: [] }) });

    await expect(fetchInternetIceServers()).resolves.toEqual(INTERNET_ICE_SERVERS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no relay configured'));
  });

  it('falls back to STUN on an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(fetchInternetIceServers()).resolves.toEqual(INTERNET_ICE_SERVERS);
  });

  it('falls back to STUN when the endpoint is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(fetchInternetIceServers()).resolves.toEqual(INTERNET_ICE_SERVERS);
  });

  it('never rejects, because a missing relay must not stop the broadcast', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    await expect(fetchInternetIceServers()).resolves.toBeDefined();
  });

  it('tolerates a malformed body', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ iceServers: 'nonsense' }) });

    await expect(fetchInternetIceServers()).resolves.toEqual(INTERNET_ICE_SERVERS);
  });
});
