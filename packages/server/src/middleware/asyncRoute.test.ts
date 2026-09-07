import express from 'express';
import request from 'supertest';
import { asyncRoute } from './asyncRoute.js';
import { errorHandler } from './errorHandler.js';

/** An app with the same wiring as the real one: routes, then the boundary. */
function app(handler: express.RequestHandler) {
  const a = express();
  a.get('/thing', handler);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('asyncRoute', () => {
  it('passes a successful response straight through', async () => {
    const response = await request(
      app(asyncRoute(async (_req, res) => void res.json({ ok: true }))),
    ).get('/thing');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('turns a rejected promise into a 500 instead of an unhandled rejection', async () => {
    // This is the whole point. Without the wrapper, Express 4 never sees the
    // rejection, Node calls it unhandled, and the process exits — one bad
    // request stopping every court instead of failing that one request.
    const response = await request(
      app(
        asyncRoute(async () => {
          throw new Error('database exploded');
        }),
      ),
    ).get('/thing');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Something went wrong handling that request.' });
  });

  it('forwards a synchronous throw the same way', async () => {
    const response = await request(
      app(
        asyncRoute(() => {
          throw new Error('thrown before any await');
        }),
      ),
    ).get('/thing');

    expect(response.status).toBe(500);
  });

  it('forwards a rejection that carries no error object', async () => {
    const response = await request(app(asyncRoute(async () => Promise.reject()))).get('/thing');

    expect(response.status).toBe(500);
  });

  it('lets a handler answer with its own error status', async () => {
    // Deliberate failures still belong to the route; only unexpected ones
    // should reach the boundary.
    const response = await request(
      app(asyncRoute(async (_req, res) => void res.status(404).json({ error: 'Not found.' }))),
    ).get('/thing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found.' });
  });

  it('keeps route parameters typed and readable', async () => {
    const a = express();
    a.get(
      '/courts/:courtId',
      asyncRoute<{ courtId: string }>(async (req, res) => {
        res.json({ seen: req.params.courtId });
      }),
    );

    const response = await request(a).get('/courts/court-42');

    expect(response.body).toEqual({ seen: 'court-42' });
  });
});
