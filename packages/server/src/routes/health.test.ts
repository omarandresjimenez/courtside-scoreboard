import express from 'express';
import request from 'supertest';
import { healthRouter } from './health.js';

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const app = express();
    app.use('/api', healthRouter);

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'courtside-scoreboard-server' });
  });
});
