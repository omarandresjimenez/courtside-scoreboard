import express from 'express';
import request from 'supertest';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

import { config } from '../config.js';
import { tournamentPlayersRouter } from './tournament-players.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', tournamentPlayersRouter);
  return app;
}

beforeEach(() => {
  mockPrisma.reset();
  mockPrisma.seedTournament({ id: 'tournament-required' });
});

const importRow = (over: Record<string, unknown> = {}) => ({
  memberId: '19940812',
  firstName: 'John',
  lastName: 'Doe',
  gender: 'M',
  country: 'USA',
  club: 'Bay Badminton Club',
  birthDate: '1994-08-12',
  categories: 'MS/MD',
  status: 'Accepted',
  ...over,
});

describe('POST /api/tournament-players/import', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .send({ tournamentId: 'tournament-required', players: [importRow()] });
    expect(response.status).toBe(401);
  });

  it('rejects a missing tournamentId', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({ players: [importRow()] });
    expect(response.status).toBe(400);
  });

  it('rejects an empty player list', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({ tournamentId: 'tournament-required', players: [] });
    expect(response.status).toBe(400);
  });

  it('rejects a tournament that does not exist', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({ tournamentId: 'ghost-tournament', players: [importRow()] });
    expect(response.status).toBe(400);
  });

  it('imports new rows and reports the count', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({
        tournamentId: 'tournament-required',
        players: [
          importRow(),
          importRow({ memberId: '19961123', firstName: 'Jane', lastName: 'Smith' }),
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ imported: 2, updated: 0, skipped: 0 });
  });

  it('updates an existing row on re-import by memberId, without duplicating it', async () => {
    await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({ tournamentId: 'tournament-required', players: [importRow({ club: 'Old Club' })] });

    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({ tournamentId: 'tournament-required', players: [importRow({ club: 'New Club' })] });

    expect(response.body).toEqual({ imported: 0, updated: 1, skipped: 0 });

    const list = await request(buildApp())
      .get('/api/tournament-players?tournamentId=tournament-required')
      .set('x-admin-password', config.adminPassword);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].club).toBe('New Club');
  });

  it('always inserts rows with no memberId, never upserting them together', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({
        tournamentId: 'tournament-required',
        players: [
          importRow({ memberId: null, firstName: 'A' }),
          importRow({ memberId: null, firstName: 'B' }),
        ],
      });
    expect(response.body).toEqual({ imported: 2, updated: 0, skipped: 0 });
  });

  it('skips a row missing a first or last name and keeps processing the rest', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({
        tournamentId: 'tournament-required',
        players: [importRow({ firstName: '' }), importRow({ memberId: '2', firstName: 'Ok' })],
      });
    expect(response.body).toEqual({ imported: 1, updated: 0, skipped: 1 });
  });

  it('skips a row that is not an object at all', async () => {
    const response = await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({ tournamentId: 'tournament-required', players: [null, importRow({ memberId: '2' })] });
    expect(response.body).toEqual({ imported: 1, updated: 0, skipped: 1 });
  });

  it('leaves optional fields null when the row omits them entirely', async () => {
    await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({
        tournamentId: 'tournament-required',
        players: [{ firstName: 'Minimal', lastName: 'Player' }],
      });

    const list = await request(buildApp())
      .get('/api/tournament-players?tournamentId=tournament-required')
      .set('x-admin-password', config.adminPassword);
    expect(list.body[0]).toMatchObject({
      gender: null,
      country: null,
      club: null,
      birthDate: null,
      categories: '',
      memberId: null,
    });
  });

  it('defaults status to Accepted when the row leaves it blank', async () => {
    await request(buildApp())
      .post('/api/tournament-players/import')
      .set('x-admin-password', config.adminPassword)
      .send({ tournamentId: 'tournament-required', players: [importRow({ status: null })] });

    const list = await request(buildApp())
      .get('/api/tournament-players?tournamentId=tournament-required')
      .set('x-admin-password', config.adminPassword);
    expect(list.body[0].status).toBe('Accepted');
  });
});

describe('GET /api/tournament-players', () => {
  it('rejects a request with no tournamentId', async () => {
    const response = await request(buildApp())
      .get('/api/tournament-players')
      .set('x-admin-password', config.adminPassword);
    expect(response.status).toBe(400);
  });

  it("lists only the requested tournament's roster", async () => {
    mockPrisma.seedTournamentPlayer({ tournamentId: 'tournament-required', firstName: 'A' });
    mockPrisma.seedTournamentPlayer({ tournamentId: 'other-tournament', firstName: 'B' });

    const response = await request(buildApp())
      .get('/api/tournament-players?tournamentId=tournament-required')
      .set('x-admin-password', config.adminPassword);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].firstName).toBe('A');
  });

  it('formats a stored birth date as an ISO yyyy-mm-dd string', async () => {
    mockPrisma.seedTournamentPlayer({
      tournamentId: 'tournament-required',
      birthDate: new Date('1994-08-12T00:00:00.000Z'),
    });
    const response = await request(buildApp())
      .get('/api/tournament-players?tournamentId=tournament-required')
      .set('x-admin-password', config.adminPassword);
    expect(response.body[0].birthDate).toBe('1994-08-12');
  });
});

describe('DELETE /api/tournament-players/:playerId', () => {
  it('removes an existing roster row', async () => {
    const seeded = mockPrisma.seedTournamentPlayer({ tournamentId: 'tournament-required' });

    const response = await request(buildApp())
      .delete(`/api/tournament-players/${seeded.id}`)
      .set('x-admin-password', config.adminPassword);
    expect(response.status).toBe(200);

    const list = await request(buildApp())
      .get('/api/tournament-players?tournamentId=tournament-required')
      .set('x-admin-password', config.adminPassword);
    expect(list.body).toHaveLength(0);
  });

  it('404s for a player that does not exist', async () => {
    const response = await request(buildApp())
      .delete('/api/tournament-players/ghost')
      .set('x-admin-password', config.adminPassword);
    expect(response.status).toBe(404);
  });
});
