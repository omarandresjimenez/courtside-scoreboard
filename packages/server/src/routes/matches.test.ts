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
  umpireId: 'umpire-required',
  tournamentId: 'tournament-required',
};

beforeEach(() => {
  // One live match per court is now enforced, so each test needs a clean
  // slate rather than inheriting the previous test's match on this court.
  mockPrisma.reset();
  mockPrisma.seedTournament({ id: 'tournament-required' });
  mockPrisma.seedCourt({ id: 'court-required', tournamentId: 'tournament-required' });
  mockPrisma.seedUmpire({ id: 'umpire-required', tournamentId: 'tournament-required' });
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

  it('rejects players that do not say which side they play for', async () => {
    // Regression. `players` was checked for length but never for contents, so
    // this passed validation, reached Prisma, and rejected inside an async
    // handler — which Express 4 does not catch, so the whole server exited and
    // the client got no response at all. Every court's scoring stopped because
    // of one malformed request.
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, players: [{ name: 'X' }, { name: 'Y' }] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid match payload.' });
  });

  it('rejects a side that is neither A nor B', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        players: [
          { side: 'Z', name: 'X' },
          { side: 'B', name: 'Y' },
        ],
      });

    expect(response.status).toBe(400);
  });

  it('rejects players stacked on one side', async () => {
    // Two players, both valid individually, but the match is unplayable in a
    // way the scoring engine has no way to represent.
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        players: [
          { side: 'A', name: 'X' },
          { side: 'A', name: 'Y' },
        ],
      });

    expect(response.status).toBe(400);
  });

  it('rejects doubles that are not two a side', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        matchType: 'doubles',
        players: [
          { side: 'A', name: 'P1' },
          { side: 'A', name: 'P2' },
          { side: 'A', name: 'P3' },
          { side: 'B', name: 'P4' },
        ],
      });

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
          { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'AA' },
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
        umpireId: 'umpire-required',
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

  it('refuses a second match on a court that still has a live one', async () => {
    const first = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);
    expect(first.status).toBe(201);

    const second = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/still in use/);
  });

  it('frees the court once the match on it is completed', async () => {
    // Finalising is what releases a court, so a finished match must not
    // block the next one.
    mockPrisma.seedMatch({
      id: 'done',
      tournamentId: 'tournament-required',
      assignedCourtId: 'court-required',
      status: 'COMPLETED',
    });
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);
    expect(response.status).toBe(201);
  });

  it('accepts optional team names and countries, trimming blanks to null', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        teams: {
          A: { name: '  Riverside  ', country: 'COL' },
          B: { name: '   ', country: '' },
        },
      });
    expect(response.status).toBe(201);
    expect(response.body.match.teams).toEqual({
      A: { name: 'Riverside', country: 'COL' },
      B: { name: null, country: null },
    });
  });

  it('defaults teams to null when the form omits them entirely', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);
    expect(response.body.match.teams).toEqual({
      A: { name: null, country: null },
      B: { name: null, country: null },
    });
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

  it('rejects a match with no umpire assignment', async () => {
    const { umpireId: _umpireId, ...bodyWithoutUmpire } = validSinglesBody;
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(bodyWithoutUmpire);

    expect(response.status).toBe(400);
  });

  it('rejects a match assigned to an unknown umpire', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, umpireId: 'not-an-umpire' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/umpire from this tournament/);
  });

  it('refuses to double-book an umpire already on a live match', async () => {
    const first = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);
    expect(first.status).toBe(201);

    const otherCourt = mockPrisma.seedCourt({ tournamentId: 'tournament-required' });
    const second = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, courtId: otherCourt.id });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already umpiring/);
  });

  it('frees the umpire once their match is completed', async () => {
    mockPrisma.seedMatch({
      id: 'done',
      tournamentId: 'tournament-required',
      assignedUmpireId: 'umpire-required',
      status: 'COMPLETED',
    });
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);
    expect(response.status).toBe(201);
  });

  it('resolves the assigned umpire name onto the created match', async () => {
    mockPrisma.seedUmpire({
      id: 'umpire-required',
      tournamentId: 'tournament-required',
      name: 'Uma',
    });
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);

    expect(response.status).toBe(201);
    expect(response.body.match.assignedUmpireId).toBe('umpire-required');
    expect(response.body.match.umpireName).toBe('Uma');
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
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Solo', lastName: 'Olos', shortName: 'SOL' },
    ]);

    const response = await request(buildApp()).get(`/api/matches/${match.id}`);

    expect(response.status).toBe(200);
    expect(response.body.match.matchId).toBe(match.id);
  });
});

describe('POST /api/matches — category and family names', () => {
  const withPlayers = (players: unknown, category?: string) => ({
    ...validSinglesBody,
    ...(category === undefined ? {} : { category }),
    players,
  });

  it('stores the category and the family name', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(
        withPlayers(
          [
            { side: 'A', name: 'Juan', lastName: 'Pérez' },
            { side: 'B', name: 'Carlos', lastName: 'Ramos' },
          ],
          'BS U19',
        ),
      );

    expect(response.status).toBe(201);
    expect(response.body.match.category).toBe('BS U19');
    const players = response.body.match.players as Array<{ lastName: string }>;
    expect(players.map((p) => p.lastName).sort()).toEqual(['Pérez', 'Ramos']);
  });

  it('treats a blank category as none rather than an empty string', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(
        withPlayers(
          [
            { side: 'A', name: 'Juan', lastName: 'Pérez' },
            { side: 'B', name: 'Carlos', lastName: 'Ramos' },
          ],
          '   ',
        ),
      );

    expect(response.status).toBe(201);
    expect(response.body.match.category).toBeNull();
  });

  it('derives the short name from the family name, which disambiguates on a TV wall', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(
        withPlayers([
          { side: 'A', name: 'Juan', lastName: 'Pérez' },
          { side: 'B', name: 'Juan', lastName: 'Ramos' },
        ]),
      );

    const players = response.body.match.players as Array<{ shortName: string }>;
    // Two players called Juan must not both render as "JUA".
    expect(new Set(players.map((p) => p.shortName)).size).toBe(2);
  });

  it('still accepts a player with no family name, as older clients send', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(
        withPlayers([
          { side: 'A', name: 'Alice Adams' },
          { side: 'B', name: 'Bilal Bruno' },
        ]),
      );

    expect(response.status).toBe(201);
    const players = response.body.match.players as Array<{ lastName: string }>;
    expect(players.every((p) => p.lastName === '')).toBe(true);
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

describe('POST /api/matches — eligibility failures carry translatable codes', () => {
  /**
   * A roster pair registered for both WS and WD.
   *
   * Both codes matter: the tournament must actually carry "WD" or the request
   * is refused by the earlier "not one of this tournament's categories" check
   * and never reaches the eligibility stage these tests are about.
   */
  const wsPair = () => [
    {
      side: 'A',
      tournamentPlayerId: mockPrisma.seedTournamentPlayer({
        tournamentId: 'tournament-required',
        firstName: 'Jane',
        lastName: 'Roe',
        gender: 'F',
        categories: 'WS/WD',
      }).id,
    },
    {
      side: 'B',
      tournamentPlayerId: mockPrisma.seedTournamentPlayer({
        tournamentId: 'tournament-required',
        firstName: 'Amy',
        lastName: 'Ng',
        gender: 'F',
        categories: 'WS/WD',
      }).id,
    },
  ];

  it('answers with issue codes, not only an English sentence', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, category: 'WD', players: wsPair() });

    expect(response.status).toBe(400);
    // The dashboard is translated and this server has no idea what language
    // the browser is in, so it cannot write the text the admin should see —
    // it sends the code and lets the client phrase it.
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'categoryNeedsDoubles' })]),
    );
  });

  it('includes the parameters the translated sentence interpolates', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, category: 'WD', players: wsPair() });

    const issue = (response.body.issues as Array<{ code: string; params: unknown }>).find(
      (i) => i.code === 'categoryNeedsDoubles',
    );
    // A missing param renders as a literal "{{category}}" in the dashboard.
    expect(issue?.params).toEqual({ category: 'WD' });
  });

  it('still sends a readable English error for non-browser callers', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, category: 'WD', players: wsPair() });

    expect(typeof response.body.error).toBe('string');
    expect(response.body.error.length).toBeGreaterThan(0);
  });
});

describe('POST /api/matches — roster-backed players', () => {
  it('copies name/lastName from the roster rather than trusting the client', async () => {
    const rosterPlayer = mockPrisma.seedTournamentPlayer({
      tournamentId: 'tournament-required',
      firstName: 'Jane',
      lastName: 'Roe',
      gender: 'F',
      categories: 'WS',
    });

    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        category: 'WS',
        players: [
          { side: 'A', tournamentPlayerId: rosterPlayer.id, name: 'Someone Else' },
          {
            side: 'B',
            tournamentPlayerId: mockPrisma.seedTournamentPlayer({
              tournamentId: 'tournament-required',
              firstName: 'Amy',
              lastName: 'Ng',
              gender: 'F',
              categories: 'WS',
            }).id,
          },
        ],
      });

    expect(response.status).toBe(201);
    const players = response.body.match.players as Array<{ name: string; lastName: string }>;
    expect(players.map((p) => `${p.name} ${p.lastName}`).sort()).toEqual(['Amy Ng', 'Jane Roe']);
  });

  it("rejects a tournamentPlayerId not found in this tournament's roster", async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        players: [
          { side: 'A', tournamentPlayerId: 'ghost-roster-row' },
          { side: 'B', name: 'Manual Player' },
        ],
      });
    expect(response.status).toBe(400);
  });

  it('rejects a manual player with no name once a roster is imported', async () => {
    mockPrisma.seedTournamentPlayer({ tournamentId: 'tournament-required' });
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        players: [
          { side: 'A', name: '' },
          { side: 'B', name: 'Manual Player' },
        ],
      });
    expect(response.status).toBe(400);
  });

  it("rejects a category not among the tournament's imported categories", async () => {
    mockPrisma.seedTournamentPlayer({ tournamentId: 'tournament-required', categories: 'MS/MD' });
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, category: 'XD' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('not one of');
  });

  it("accepts a category that is among the tournament's imported categories", async () => {
    mockPrisma.seedTournamentPlayer({ tournamentId: 'tournament-required', categories: 'MS/MD' });
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({ ...validSinglesBody, category: 'MS' });
    expect(response.status).toBe(201);
  });

  it("rejects a female player in a men's singles category", async () => {
    const male = mockPrisma.seedTournamentPlayer({
      tournamentId: 'tournament-required',
      firstName: 'John',
      lastName: 'Doe',
      gender: 'M',
      categories: 'MS',
    });
    const female = mockPrisma.seedTournamentPlayer({
      tournamentId: 'tournament-required',
      firstName: 'Jane',
      lastName: 'Roe',
      gender: 'F',
      categories: 'MS',
    });

    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        category: 'MS',
        players: [
          { side: 'A', tournamentPlayerId: male.id },
          { side: 'B', tournamentPlayerId: female.id },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('does not accept a female');
  });

  it('rejects a player too old for a U13 category', async () => {
    const young = mockPrisma.seedTournamentPlayer({
      tournamentId: 'tournament-required',
      firstName: 'Kid',
      lastName: 'One',
      birthDate: new Date('2015-01-01'),
      categories: 'U13',
    });
    const old = mockPrisma.seedTournamentPlayer({
      tournamentId: 'tournament-required',
      firstName: 'Adult',
      lastName: 'Two',
      birthDate: new Date('1990-01-01'),
      categories: 'U13',
    });

    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        category: 'U13',
        players: [
          { side: 'A', tournamentPlayerId: young.id },
          { side: 'B', tournamentPlayerId: old.id },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('too old');
  });

  it('allows manual (non-roster) players when no roster has been imported at all', async () => {
    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send(validSinglesBody);
    expect(response.status).toBe(201);
  });

  it('rejects a court/umpire pair whose tournament no longer exists', async () => {
    mockPrisma.seedCourt({ id: 'court-ghost-tournament', tournamentId: 'ghost-tournament' });
    mockPrisma.seedUmpire({ id: 'umpire-ghost-tournament', tournamentId: 'ghost-tournament' });

    const response = await request(buildApp())
      .post('/api/matches')
      .set('x-admin-password', config.adminPassword)
      .send({
        ...validSinglesBody,
        courtId: 'court-ghost-tournament',
        umpireId: 'umpire-ghost-tournament',
        tournamentId: 'ghost-tournament',
      });
    expect(response.status).toBe(400);
  });
});
