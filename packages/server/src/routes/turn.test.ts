import express from 'express';
import request from 'supertest';
import { turnRouter } from './turn.js';
import { resetTurnCredentialCache } from '../integrations/turn-credentials.js';

const RELAY = [
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
    username: 'minted-user',
    credential: 'minted-secret',
  },
];

const originalEnv = { ...process.env };

function app() {
  const a = express();
  a.use('/api', turnRouter);
  return a;
}

beforeEach(() => {
  resetTurnCredentialCache();
  delete process.env.CLOUDFLARE_TURN_KEY_ID;
  delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

describe('GET /api/turn-credentials', () => {
  it('reports no relay when unconfigured, without failing the request', async () => {
    const response = await request(app()).get('/api/turn-credentials');

    // A missing optional feature must not look like a broken endpoint.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ iceServers: [], configured: false });
  });

  it('serves minted credentials when configured', async () => {
    process.env.CLOUDFLARE_TURN_KEY_ID = 'key-123';
    process.env.CLOUDFLARE_TURN_API_TOKEN = 'token-abc';
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ iceServers: RELAY }),
    }));

    const response = await request(app()).get('/api/turn-credentials');

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(response.body.iceServers).toEqual(RELAY);
  });

  it('never exposes the long-term TURN key to a client', async () => {
    process.env.CLOUDFLARE_TURN_KEY_ID = 'key-123';
    process.env.CLOUDFLARE_TURN_API_TOKEN = 'token-abc';
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ iceServers: RELAY }),
    }));

    const response = await request(app()).get('/api/turn-credentials');

    // The whole reason minting happens server-side: the key mints unlimited
    // credentials, so it must never cross the wire.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('token-abc');
    expect(body).not.toContain('key-123');
  });
});
