import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

type LocalCaRouterModule = typeof import('./local-ca.js');

/** local-ca.ts -> local-tls.ts -> config.ts all read LOCAL_TLS_DIR from
 * process.env at import time, so a fresh module graph is needed per test
 * to point at a throwaway directory instead of this machine's real
 * ~/.courtside-scoreboard/certs. */
async function loadRouter(): Promise<LocalCaRouterModule> {
  jest.resetModules();
  return (await import('./local-ca.js')) as LocalCaRouterModule;
}

describe('GET /api/local-ca.pem', () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'courtside-local-ca-'));
    process.env = { ...originalEnv, LOCAL_TLS_DIR: dir };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the CA certificate as a PEM download, unauthenticated', async () => {
    const { localCaRouter } = await loadRouter();
    const app = express();
    app.use('/api', localCaRouter);

    const response = await request(app).get('/api/local-ca.pem');

    expect(response.status).toBe(200);
    expect(response.text).toContain('-----BEGIN CERTIFICATE-----');
    expect(response.headers['content-type']).toContain('application/x-x509-ca-cert');
    expect(response.headers['content-disposition']).toContain('courtside-scoreboard-ca.pem');
  });

  it('never serves the CA private key', async () => {
    const { localCaRouter } = await loadRouter();
    const app = express();
    app.use('/api', localCaRouter);

    const response = await request(app).get('/api/local-ca.pem');

    expect(response.text).not.toContain('PRIVATE KEY');
  });

  it('serves the same CA on repeated requests rather than a new one each time', async () => {
    const { localCaRouter } = await loadRouter();
    const app = express();
    app.use('/api', localCaRouter);

    const first = await request(app).get('/api/local-ca.pem');
    const second = await request(app).get('/api/local-ca.pem');

    expect(second.text).toBe(first.text);
  });
});
