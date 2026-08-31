import express from 'express';
import request from 'supertest';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

import { config } from '../config.js';
import { umpiresRouter } from './umpires.js';

const tournamentId = 'tournament-1';

beforeEach(() => {
  mockPrisma.reset();
  mockPrisma.seedTournament({ id: tournamentId });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', umpiresRouter);
  return app;
}

describe('POST /api/umpires', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp()).post('/api/umpires').send({ name: 'Uma Umpire' });
    expect(response.status).toBe(401);
  });

  it('rejects a missing or blank name', async () => {
    const response = await request(buildApp())
      .post('/api/umpires')
      .set('x-admin-password', config.adminPassword)
      .send({ name: '   ', tournamentId });
    expect(response.status).toBe(400);
  });

  it('rejects a missing tournamentId', async () => {
    const response = await request(buildApp())
      .post('/api/umpires')
      .set('x-admin-password', config.adminPassword)
      .send({ name: 'Uma Umpire' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/tournament/i);
  });

  it('rejects a tournamentId that does not exist', async () => {
    const response = await request(buildApp())
      .post('/api/umpires')
      .set('x-admin-password', config.adminPassword)
      .send({ name: 'Uma Umpire', tournamentId: 'does-not-exist' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/not found/i);
  });

  it('creates an umpire', async () => {
    const response = await request(buildApp())
      .post('/api/umpires')
      .set('x-admin-password', config.adminPassword)
      .send({ name: 'Uma Umpire', tournamentId });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: 'Uma Umpire', tournamentId });
    expect(response.body.umpireId).toBeTruthy();
  });

  it('trims the name', async () => {
    const response = await request(buildApp())
      .post('/api/umpires')
      .set('x-admin-password', config.adminPassword)
      .send({ name: '  Uma Umpire  ', tournamentId });

    expect(response.body.name).toBe('Uma Umpire');
  });
});

describe('GET /api/umpires', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp()).get('/api/umpires');
    expect(response.status).toBe(401);
  });

  it('rejects a request missing tournamentId', async () => {
    const response = await request(buildApp())
      .get('/api/umpires')
      .set('x-admin-password', config.adminPassword);
    expect(response.status).toBe(400);
  });

  it('lists umpires oldest-first, as the shared Umpire shape', async () => {
    const umpire = mockPrisma.seedUmpire({ name: 'Uma Umpire', tournamentId });

    const response = await request(buildApp())
      .get(`/api/umpires?tournamentId=${tournamentId}`)
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ umpireId: umpire.id, tournamentId, name: 'Uma Umpire' }]);
  });
});

describe('DELETE /api/umpires/:umpireId', () => {
  it('returns 404 for an unknown umpire', async () => {
    const response = await request(buildApp())
      .delete('/api/umpires/does-not-exist')
      .set('x-admin-password', config.adminPassword);
    expect(response.status).toBe(404);
  });

  it('deletes an umpire when the admin password is valid', async () => {
    const umpire = mockPrisma.seedUmpire({ name: 'Uma Umpire', tournamentId });

    const response = await request(buildApp())
      .delete(`/api/umpires/${umpire.id}`)
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ umpireId: umpire.id, name: 'Uma Umpire' });

    const remaining = await request(buildApp())
      .get(`/api/umpires?tournamentId=${tournamentId}`)
      .set('x-admin-password', config.adminPassword);
    expect(remaining.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ umpireId: umpire.id })]),
    );
  });
});
