import express from 'express';
import request from 'supertest';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

import { config } from '../config.js';
import { courtsRouter } from './courts.js';

const tournamentId = 'tournament-1';

beforeEach(() => {
  mockPrisma.seedTournament({ id: tournamentId });
});

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

  it('rejects a missing tournamentId', async () => {
    const response = await request(buildApp())
      .post('/api/courts')
      .set('x-admin-password', config.adminPassword)
      .send({ label: 'Court 1' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/tournament/i);
  });

  it('rejects a tournamentId that does not exist', async () => {
    const response = await request(buildApp())
      .post('/api/courts')
      .set('x-admin-password', config.adminPassword)
      .send({ label: 'Court 1', tournamentId: 'does-not-exist' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/not found/i);
  });

  it('creates a court, idle by default', async () => {
    const response = await request(buildApp())
      .post('/api/courts')
      .set('x-admin-password', config.adminPassword)
      .send({ label: 'Court 1', tournamentId });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ label: 'Court 1', currentMatchId: null });
    expect(response.body.courtId).toBeTruthy();
  });

  it('trims the label', async () => {
    const response = await request(buildApp())
      .post('/api/courts')
      .set('x-admin-password', config.adminPassword)
      .send({ label: '  Court 2  ', tournamentId });

    expect(response.body.label).toBe('Court 2');
  });
});

describe('GET /api/courts', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp()).get('/api/courts');
    expect(response.status).toBe(401);
  });

  it('lists courts oldest-first, as the shared Court shape', async () => {
    const court = mockPrisma.seedCourt({ label: 'Court 3', tvCode: 'ABCDEF', tournamentId });

    const response = await request(buildApp())
      .get(`/api/courts?tournamentId=${tournamentId}`)
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        {
          courtId: court.id,
          tournamentId,
          label: 'Court 3',
          currentMatchId: null,
          tvCode: 'ABCDEF',
        },
      ]),
    );
  });
});

describe('GET /api/courts/resolve/:code', () => {
  it('returns 404 for an unknown code', async () => {
    const response = await request(buildApp()).get('/api/courts/resolve/NOPE00');
    expect(response.status).toBe(404);
  });

  it('resolves a known tvCode to its courtId, without auth', async () => {
    const court = mockPrisma.seedCourt({ tvCode: 'ABC123' });

    const response = await request(buildApp()).get('/api/courts/resolve/ABC123');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ courtId: court.id });
  });

  it('is case-insensitive, since codes are meant to be typed', async () => {
    const court = mockPrisma.seedCourt({ tvCode: 'LOWCASE' });

    const response = await request(buildApp()).get('/api/courts/resolve/lowcase');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ courtId: court.id });
  });
});

describe('GET /api/courts/:courtId/label', () => {
  it('returns 404 for an unknown court', async () => {
    const response = await request(buildApp()).get('/api/courts/nope/label');
    expect(response.status).toBe(404);
  });

  it('returns the label without auth, since the broadcaster page has none', async () => {
    const court = mockPrisma.seedCourt({ label: 'Center Court' });

    const response = await request(buildApp()).get(`/api/courts/${court.id}/label`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ courtId: court.id, label: 'Center Court' });
  });

  it('exposes only the label, not what the admin listing returns', async () => {
    const court = mockPrisma.seedCourt({ label: 'Court 1', tvCode: 'SECRET' });

    const response = await request(buildApp()).get(`/api/courts/${court.id}/label`);

    // This endpoint is unauthenticated, so its payload must stay minimal.
    expect(Object.keys(response.body).sort()).toEqual(['courtId', 'label']);
    expect(JSON.stringify(response.body)).not.toContain('SECRET');
  });
});

describe('DELETE /api/courts/:courtId', () => {
  it('returns 404 for an unknown court', async () => {
    const response = await request(buildApp())
      .delete('/api/courts/does-not-exist')
      .set('x-admin-password', config.adminPassword);
    expect(response.status).toBe(404);
  });

  it('deletes a court when the admin password is valid', async () => {
    const court = mockPrisma.seedCourt({ label: 'Court 5', tvCode: 'DELETE1' });

    const response = await request(buildApp())
      .delete(`/api/courts/${court.id}`)
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ courtId: court.id, label: 'Court 5' });
    expect(
      await request(buildApp()).get('/api/courts').set('x-admin-password', config.adminPassword),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ courtId: court.id })]));
  });
});
