import express from 'express';
import request from 'supertest';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

import { config } from '../config.js';
import { courtsRouter } from './courts.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', courtsRouter);
  return app;
}

describe('POST /api/courts', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp()).post('/api/courts').send({ label: 'Court 1' });
    expect(response.status).toBe(401);
  });

  it('rejects a missing or blank label', async () => {
    const response = await request(buildApp())
      .post('/api/courts')
      .set('x-admin-password', config.adminPassword)
      .send({ label: '   ' });
    expect(response.status).toBe(400);
  });

  it('creates a court, idle by default', async () => {
    const response = await request(buildApp())
      .post('/api/courts')
      .set('x-admin-password', config.adminPassword)
      .send({ label: 'Court 1' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ label: 'Court 1', currentMatchId: null });
    expect(response.body.courtId).toBeTruthy();
  });

  it('trims the label', async () => {
    const response = await request(buildApp())
      .post('/api/courts')
      .set('x-admin-password', config.adminPassword)
      .send({ label: '  Court 2  ' });

    expect(response.body.label).toBe('Court 2');
  });
});

describe('GET /api/courts', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp()).get('/api/courts');
    expect(response.status).toBe(401);
  });

  it('lists courts oldest-first, as the shared Court shape', async () => {
    const court = mockPrisma.seedCourt({ label: 'Court 3' });

    const response = await request(buildApp())
      .get('/api/courts')
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([{ courtId: court.id, label: 'Court 3', currentMatchId: null }]),
    );
  });
});
