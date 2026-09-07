const mockGetCloudDb = jest.fn(() => undefined as unknown);
jest.mock('../integrations/cloud-sync.js', () => ({ getCloudDb: () => mockGetCloudDb() }));

import express from 'express';
import request from 'supertest';
import { streamInputRouter } from './stream-input.js';
import { resetLiveInputCache } from '../integrations/cloudflare-stream.js';

const FULL_INPUT = {
  uid: 'input-1',
  meta: { courtsideCourtId: 'court-a' },
  webRTC: { url: 'https://customer-x.cloudflarestream.com/secret/webRTC/publish' },
  webRTCPlayback: { url: 'https://customer-x.cloudflarestream.com/secret/webRTC/play' },
};

const originalEnv = { ...process.env };

function app() {
  const a = express();
  a.use('/api', streamInputRouter);
  return a;
}

function configure() {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-123';
  process.env.CLOUDFLARE_STREAM_API_TOKEN = 'token-abc';
}

/** Cloudflare finding no existing input, then accepting the creation. */
function cloudflareCreates() {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  (globalThis as Record<string, unknown>).fetch = jest
    .fn()
    .mockResolvedValueOnce(ok({ result: [] }))
    .mockResolvedValueOnce(ok({ result: FULL_INPUT }));
}

beforeEach(() => {
  resetLiveInputCache();
  mockGetCloudDb.mockReturnValue(undefined);
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_STREAM_API_TOKEN;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

describe('GET /api/stream-input/:courtId', () => {
  it('reports no live input when unconfigured, without failing the request', async () => {
    const response = await request(app()).get('/api/stream-input/court-a');

    // A missing optional feature must not look like a broken endpoint — the
    // client reads `configured` and falls back to the peer mesh.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      configured: false,
      enabled: true,
      publishUrl: null,
      playbackUrl: null,
    });
  });

  it('serves the court its publish and playback URLs when configured', async () => {
    configure();
    cloudflareCreates();

    const response = await request(app()).get('/api/stream-input/court-a');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      configured: true,
      enabled: true,
      publishUrl: FULL_INPUT.webRTC.url,
      playbackUrl: FULL_INPUT.webRTCPlayback.url,
    });
  });

  it('never exposes the Cloudflare API token to a client', async () => {
    configure();
    cloudflareCreates();

    const response = await request(app()).get('/api/stream-input/court-a');

    // The token can create and delete inputs across the whole account, which
    // is why it stays on the server.
    expect(JSON.stringify(response.body)).not.toContain('token-abc');
  });

  it('still answers 200 when Cloudflare is configured but unreachable', async () => {
    configure();
    (globalThis as Record<string, unknown>).fetch = jest.fn().mockRejectedValue(new Error('down'));

    const response = await request(app()).get('/api/stream-input/court-a');

    // `configured: true` with no URLs says "this should have worked" — the
    // client falls back either way, but the distinction is worth logging.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      configured: true,
      enabled: true,
      publishUrl: null,
      playbackUrl: null,
    });
  });

  it('falls back to the mesh when the operator has switched Cloudflare off', async () => {
    configure();
    cloudflareCreates();
    mockGetCloudDb.mockReturnValue({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ cloudflareStreamEnabled: false }) }),
        }),
      }),
    });

    const response = await request(app()).get('/api/stream-input/court-a');

    expect(response.body).toEqual({
      configured: true,
      enabled: false,
      publishUrl: null,
      playbackUrl: null,
    });
  });

  it('spends nothing at Cloudflare while the switch is off', async () => {
    configure();
    cloudflareCreates();
    mockGetCloudDb.mockReturnValue({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ cloudflareStreamEnabled: false }) }),
        }),
      }),
    });

    await request(app()).get('/api/stream-input/court-a');

    // Not just "returns no URLs": an operator who has switched this off must
    // not have a brand new live input created on the account behind their back.
    expect(globalThis.fetch as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('asks for the court in the URL', async () => {
    configure();
    cloudflareCreates();

    await request(app()).get('/api/stream-input/court-42');

    const fetchMock = globalThis.fetch as unknown as jest.Mock;
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.meta.courtsideCourtId).toBe('court-42');
  });
});
