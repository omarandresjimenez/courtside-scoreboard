import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';

let errorLog: jest.SpyInstance;

beforeEach(() => {
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('errorHandler', () => {
  it('answers 500 rather than letting the request hang', async () => {
    const a = express();
    a.get('/boom', () => {
      throw new Error('kaboom');
    });
    a.use(errorHandler);

    const response = await request(a).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Something went wrong handling that request.' });
  });

  it('never leaks the internal error to the client', async () => {
    const a = express();
    a.get('/boom', () => {
      throw new Error('SELECT * FROM umpire WHERE token = "s3cret-token"');
    });
    a.use(errorHandler);

    const response = await request(a).get('/boom');

    // Reachable by anyone on the venue LAN, and an internal message can carry a
    // query, a path, or part of a credential.
    expect(JSON.stringify(response.body)).not.toContain('s3cret-token');
  });

  it('logs the detail that the response withholds', async () => {
    const a = express();
    a.get('/boom', () => {
      throw new Error('kaboom');
    });
    a.use(errorHandler);

    await request(a).get('/boom');

    expect(errorLog).toHaveBeenCalledWith(
      '[server] unhandled error while serving a request:',
      expect.any(Error),
    );
  });

  it('does not try to answer twice when the response already started', () => {
    // Called directly rather than through a request: a half-written response
    // is never closed, so driving this over HTTP would simply hang.
    const res = {
      headersSent: true,
      status: jest.fn(),
      json: jest.fn(),
    } as unknown as import('express').Response;

    errorHandler(new Error('failed mid-stream'), {} as never, res, jest.fn());

    // Only Express can tidy up a partial response; a second set of headers
    // would throw inside the error handler itself.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
  });
});
