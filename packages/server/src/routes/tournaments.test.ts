import express from 'express';
import request from 'supertest';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

import { config } from '../config.js';
import { tournamentsRouter } from './tournaments.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', tournamentsRouter);
  return app;
}

describe('tournament management', () => {
  it('rejects a missing or blank name', async () => {
    const response = await request(buildApp())
      .post('/api/tournaments')
      .set('x-admin-password', config.adminPassword)
      .send({ name: '   ' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/name/i);
  });

  it('rejects an unparseable date', async () => {
    const response = await request(buildApp())
      .post('/api/tournaments')
      .set('x-admin-password', config.adminPassword)
      .send({ name: 'Winter Open', date: 'not-a-real-date' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/date/i);
  });

  it('creates a named tournament with a default Main Court', async () => {
    const response = await request(buildApp())
      .post('/api/tournaments')
      .set('x-admin-password', config.adminPassword)
      .send({ name: 'Summer Open' });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Summer Open');
    const courts = await mockPrisma.prisma.court.findMany({
      where: { tournamentId: response.body.tournamentId },
    });
    expect(courts).toEqual([expect.objectContaining({ label: 'Main Court' })]);
  });

  it('lists saved tournaments for the launcher', async () => {
    mockPrisma.seedTournament({ name: 'Club Finals' });
    const response = await request(buildApp())
      .get('/api/tournaments')
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Club Finals' })]),
    );
  });
});
