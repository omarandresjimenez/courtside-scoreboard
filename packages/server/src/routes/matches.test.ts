import express from 'express';
import request from 'supertest';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

import { config } from '../config.js';
import { matchesRouter } from './matches.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', matchesRouter);
  return app;
}

const validSinglesBody = {
  matchType: 'singles',
  players: [
    { side: 'A', name: 'Alice' },
    { side: 'B', name: 'Bilal' },
  ],
  scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
  courtId: 'court-required',
  tournamentId: 'tournament-required',
};

beforeEach(() => {
  mockPrisma.seedTournament({ id: 'tournament-required' });
  mockPrisma.seedCourt({ id: 'court-required', tournamentId: 'tournament-required' });
});

describe('POST /api/matches', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp()).post('/api/matches').send(validSinglesBody);
    expect(response.status).toBe(401);
  });

  it('rejects an invalid payload (wrong player count for singles)', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, players: [{ side: 'A', name: 'Solo' }] });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid scoring config (cap not greater than pointsToWin)', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        scoringConfig: { pointsToWin: 21, capScore: 21, intervalAt: 11 },
      });
    expect(response.status).toBe(400);
  });

  it('creates a singles match and returns its full derived state', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);

    expect(response.status).toBe(201);
    expect(response.body.match.matchType).toBe('singles');
    expect(response.body.match.players).toHaveLength(2);
    expect(response.body.derived.currentSet).toMatchObject({ scoreA: 0, scoreB: 0 });
  });

  it('derives a shortName from the given name when none is provided', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);

    const alice = response.body.match.players.find((p: { name: string }) => p.name === 'Alice');
    expect(alice.shortName).toBe('ALI');
  });

  it('keeps a given shortName rather than deriving one', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        players: [
          { side: 'A', name: 'Alice', shortName: 'AA' },
          { side: 'B', name: 'Bilal' },
        ],
      });

    const alice = response.body.match.players.find((p: { name: string }) => p.name === 'Alice');
    expect(alice.shortName).toBe('AA');
  });

  it('creates a doubles match requiring exactly 4 players', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        matchType: 'doubles',
        players: [
          { side: 'A', name: 'A1' },
          { side: 'A', name: 'A2' },
          { side: 'B', name: 'B1' },
          { side: 'B', name: 'B2' },
        ],
        scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
        courtId: 'court-required',
        tournamentId: 'tournament-required',
      });

    expect(response.status).toBe(201);
    expect(response.body.match.players).toHaveLength(4);
  });

  it('rejects a doubles match with only 2 players', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, matchType: 'doubles' });
    expect(response.status).toBe(400);
  });

  it('assigns the new match to a court when courtId is given', async () => {
    const court = mockPrisma.seedCourt({ tournamentId: 'tournament-required' });

    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, courtId: court.id });

    expect(response.status).toBe(201);
    const updatedCourt = await mockPrisma.prisma.court.findUnique({ where: { id: court.id } });
    expect(updatedCourt?.currentMatchId).toBe(response.body.match.matchId);
  });

  it('rejects a match with no court assignment', async () => {
    const { courtId: _courtId, ...bodyWithoutCourt } = validSinglesBody;
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(bodyWithoutCourt);

    expect(response.status).toBe(400);
  });

  it('rejects a match assigned to an unknown court', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, courtId: 'not-a-court' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/court from this tournament/);
  });
});

describe('GET /api/matches/resolve/:code', () => {
  it('returns 404 for an unknown code', async () => {
    const response = await request(buildApp()).get('/api/matches/resolve/NOPE00');
    expect(response.status).toBe(404);
  });

  it('resolves a known umpireCode to its matchId + token, without auth', async () => {
    const match = mockPrisma.seedMatch({ umpireCode: 'XYZ789', umpireToken: 'the-real-token' });

    const response = await request(buildApp()).get('/api/matches/resolve/XYZ789');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ matchId: match.id, token: 'the-real-token' });
  });

  it('is case-insensitive, since codes are meant to be typed', async () => {
    const match = mockPrisma.seedMatch({ umpireCode: 'LOWCASE' });

    const response = await request(buildApp()).get('/api/matches/resolve/lowcase');

    expect(response.status).toBe(200);
    expect(response.body.matchId).toBe(match.id);
  });
});

describe('GET /api/matches/:matchId', () => {
  it('returns 404 for an unknown match', async () => {
    const response = await request(buildApp()).get('/api/matches/does-not-exist');
    expect(response.status).toBe(404);
  });

  it('returns the match state for a known match, without auth', async () => {
    const match = mockPrisma.seedMatch();
    mockPrisma.seedPlayers(match.id, [{ side: 'A', name: 'Solo', shortName: 'SOL' }]);

    const response = await request(buildApp()).get(`/api/matches/${match.id}`);

    expect(response.status).toBe(200);
    expect(response.body.match.matchId).toBe(match.id);
  });
});

describe('GET /api/matches', () => {
  it('rejects a request with no admin password', async () => {
    const response = await request(buildApp()).get('/api/matches');
    expect(response.status).toBe(401);
  });

  it('rejects a request missing tournamentId', async () => {
    const response = await request(buildApp())
      .get('/api/matches')
      .set('x-admin-password', config.adminPassword);
    expect(response.status).toBe(400);
  });

  it('silently omits a match that vanished between the list query and its detail load', async () => {
    // Simulates a match being deleted concurrently with this request —
    // findMany() already has its id, but loadMatchState() then finds
    // nothing. Should degrade gracefully, not 500.
    const survivor = mockPrisma.seedMatch({ tournamentId: 'tournament-vanishing-test' });
    const vanished = mockPrisma.seedMatch({ tournamentId: 'tournament-vanishing-test' });
    await mockPrisma.prisma.match.delete({ where: { id: vanished.id } });

    const response = await request(buildApp())
      .get('/api/matches?tournamentId=tournament-vanishing-test')
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ matchId: survivor.id })]);
  });

  it('lists matches as safe summaries, never leaking umpireToken', async () => {
    mockPrisma.seedMatch({
      umpireToken: 'super-secret-token',
      tournamentId: 'tournament-required',
    });

    const response = await request(buildApp())
      .get('/api/matches?tournamentId=tournament-required')
      .set('x-admin-password', config.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('umpireToken');
  });
});
