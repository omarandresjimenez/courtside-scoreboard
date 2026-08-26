import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createFakePrisma } from './testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('./db/client.js', () => ({ prisma: mockPrisma.prisma }));

// After the mock, so createApp (and everything it wires up) resolves
// './db/client.js' to the fake above.
import { createApp } from './app.js';

// Deliberately outside the repo entirely, so these tests behave the same
// whether or not the client has actually been built on this machine.
const NO_CLIENT_BUILD = path.join(tmpdir(), 'courtside-no-such-client-dist');

describe('createApp', () => {
  it('falls back to config.clientDistPath when no override is given', () => {
    // No clientDistPath option here, unlike every other test in this file —
    // this is the only one exercising the `options.clientDistPath ?? config.clientDistPath`
    // default rather than a test-supplied path.
    const { app } = createApp();
    expect(app).toBeDefined();
  });

  it('wires up an Express app, an HTTP server, and a Socket.io server', () => {
    const { app, httpServer, io } = createApp({ clientDistPath: NO_CLIENT_BUILD });

    expect(app).toBeDefined();
    expect(httpServer).toBeDefined();
    expect(io).toBeDefined();
  });

  it('mounts the health and matches routers under /api', async () => {
    const { app, httpServer } = createApp({ clientDistPath: NO_CLIENT_BUILD });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'courtside-scoreboard-server' });

    // The httpServer wraps the same app but is never .listen()-ed here —
    // closing it is a no-op cleanup, kept for symmetry with real usage.
    httpServer.close();
  });

  describe('when the client has not been built', () => {
    it('does not serve a UI, but a 404 still falls through Express normally', async () => {
      const { app } = createApp({ clientDistPath: NO_CLIENT_BUILD });

      const response = await request(app).get('/umpire/m1');

      expect(response.status).toBe(404);
    });
  });

  describe('when the client has been built', () => {
    let clientDistPath: string;

    beforeEach(() => {
      clientDistPath = mkdtempSync(path.join(tmpdir(), 'courtside-client-dist-'));
      writeFileSync(
        path.join(clientDistPath, 'index.html'),
        '<!doctype html><title>courtside</title>',
      );
      writeFileSync(path.join(clientDistPath, 'app.css'), 'body { margin: 0; }');
    });

    afterEach(() => {
      rmSync(clientDistPath, { recursive: true, force: true });
    });

    it('serves the built index.html at the root', async () => {
      const { app } = createApp({ clientDistPath });

      const response = await request(app).get('/');

      expect(response.status).toBe(200);
      expect(response.text).toContain('<title>courtside</title>');
    });

    it('serves static assets (e.g. the built CSS) directly', async () => {
      const { app } = createApp({ clientDistPath });

      const response = await request(app).get('/app.css');

      expect(response.status).toBe(200);
      expect(response.text).toBe('body { margin: 0; }');
    });

    it('falls back to index.html for a client-side route, so deep links survive a refresh', async () => {
      const { app } = createApp({ clientDistPath });

      const response = await request(app).get('/umpire/some-match-id?token=abc');

      expect(response.status).toBe(200);
      expect(response.text).toContain('<title>courtside</title>');
    });

    it('still 404s an unknown /api route rather than serving index.html for it', async () => {
      const { app } = createApp({ clientDistPath });

      const response = await request(app).get('/api/does-not-exist');

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('courtside');
    });
  });
});
