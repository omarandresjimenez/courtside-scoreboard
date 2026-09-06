import express from 'express';
import request from 'supertest';

type ConfigRouterModule = typeof import('./config.js');

/** config.ts reads MDNS_HOSTNAME/MDNS_ENABLED from process.env at import
 * time, so a fresh module graph is needed to exercise a different value. */
async function loadRouter(): Promise<ConfigRouterModule> {
  jest.resetModules();
  return (await import('./config.js')) as ConfigRouterModule;
}

describe('GET /api/config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports the default mDNS hostname and enabled state, unauthenticated', async () => {
    delete process.env.MDNS_HOSTNAME;
    delete process.env.MDNS_ENABLED;
    const { configRouter } = await loadRouter();
    const app = express();
    app.use('/api', configRouter);

    const response = await request(app).get('/api/config');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mdnsHostname: 'courtside.local', mdnsEnabled: true });
  });

  it('reflects a customised MDNS_HOSTNAME and a disabled MDNS_ENABLED', async () => {
    process.env.MDNS_HOSTNAME = 'my-venue.local';
    process.env.MDNS_ENABLED = 'false';
    const { configRouter } = await loadRouter();
    const app = express();
    app.use('/api', configRouter);

    const response = await request(app).get('/api/config');

    expect(response.body).toEqual({ mdnsHostname: 'my-venue.local', mdnsEnabled: false });
  });
});
