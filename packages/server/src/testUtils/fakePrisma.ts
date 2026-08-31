/**
 * A tiny in-memory stand-in for the Prisma client, shaped to cover exactly
 * the calls this codebase makes (see replay.ts, routes/matches.ts, and
 * sockets/index.ts). Used instead of a real SQLite database in tests so
 * they're fast, deterministic, and don't depend on `prisma generate`
 * having run — every method is a jest.fn() so call assertions still work.
 */

import { Prisma } from '../../generated/prisma/index.js';

interface FakePlayerRow {
  id: string;
  matchId: string;
  side: string;
  name: string;
  shortName: string;
}

interface FakeEventRow {
  id: string;
  matchId: string;
  eventId: string;
  type: string;
  side: string | null;
  payload: string | null;
  timestamp: bigint;
  createdAt: Date;
}

interface FakeMatchRow {
  id: string;
  tournamentId: string | null;
  matchType: string;
  status: string;
  pointsToWin: number;
  capScore: number;
  intervalAt: number;
  scoringLocked: boolean;
  umpireToken: string;
  umpireCode: string;
  assignedCourtId: string | null;
  assignedUmpireId: string | null;
  teamAName: string | null;
  teamBName: string | null;
  teamACountry: string | null;
  teamBCountry: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface FakeCourtRow {
  id: string;
  tournamentId: string | null;
  label: string;
  currentMatchId: string | null;
  tvCode: string;
  createdAt: Date;
}

interface FakeTournamentRow {
  id: string;
  name: string;
  date: Date;
  createdAt: Date;
}

interface FakeUmpireRow {
  id: string;
  tournamentId: string | null;
  name: string;
  createdAt: Date;
}

let nextId = 1;
function generateId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

export function createFakePrisma() {
  const matches = new Map<string, FakeMatchRow>();
  const players = new Map<string, FakePlayerRow[]>();
  const events = new Map<string, FakeEventRow[]>();
  const courts = new Map<string, FakeCourtRow>();
  const tournaments = new Map<string, FakeTournamentRow>();
  const umpires = new Map<string, FakeUmpireRow>();

  function seedTournament(overrides: Partial<FakeTournamentRow> = {}): FakeTournamentRow {
    const id = overrides.id ?? generateId('tournament');
    const row: FakeTournamentRow = {
      id,
      name: 'Test Tournament',
      date: new Date(),
      createdAt: new Date(),
      ...overrides,
    };
    tournaments.set(id, row);
    return row;
  }

  function seedMatch(overrides: Partial<FakeMatchRow> = {}): FakeMatchRow {
    const id = overrides.id ?? generateId('match');
    const row: FakeMatchRow = {
      id,
      tournamentId: null,
      matchType: 'singles',
      status: 'CREATED',
      pointsToWin: 21,
      capScore: 30,
      intervalAt: 11,
      teamAName: null,
      teamBName: null,
      teamACountry: null,
      teamBCountry: null,
      scoringLocked: false,
      umpireToken: 'test-token',
      umpireCode: 'TESTCODE',
      assignedCourtId: null,
      assignedUmpireId: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      ...overrides,
    };
    matches.set(id, row);
    if (!players.has(id)) players.set(id, []);
    if (!events.has(id)) events.set(id, []);
    return row;
  }

  function seedPlayers(matchId: string, rows: Array<Omit<FakePlayerRow, 'id' | 'matchId'>>): void {
    players.set(
      matchId,
      rows.map((row) => ({ id: generateId('player'), matchId, ...row })),
    );
  }

  function seedEvent(
    matchId: string,
    overrides: Partial<Omit<FakeEventRow, 'id' | 'matchId'>>,
  ): FakeEventRow {
    const row: FakeEventRow = {
      id: generateId('event'),
      matchId,
      eventId: overrides.eventId ?? generateId('client-event'),
      type: overrides.type ?? 'POINT',
      side: overrides.side ?? null,
      payload: overrides.payload ?? null,
      timestamp: overrides.timestamp ?? BigInt(Date.now()),
      createdAt: new Date(),
    };
    const list = events.get(matchId) ?? [];
    list.push(row);
    events.set(matchId, list);
    return row;
  }

  function seedCourt(overrides: Partial<FakeCourtRow> = {}): FakeCourtRow {
    const id = overrides.id ?? generateId('court');
    const row: FakeCourtRow = {
      id,
      tournamentId: null,
      label: 'Court 1',
      currentMatchId: null,
      tvCode: 'TVCODE',
      createdAt: new Date(),
      ...overrides,
    };
    courts.set(id, row);
    return row;
  }

  function seedUmpire(overrides: Partial<FakeUmpireRow> = {}): FakeUmpireRow {
    const id = overrides.id ?? generateId('umpire');
    const row: FakeUmpireRow = {
      id,
      tournamentId: null,
      name: 'Uma Umpire',
      createdAt: new Date(),
      ...overrides,
    };
    umpires.set(id, row);
    return row;
  }

  const prisma = {
    match: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = generateId('match');
        const row: FakeMatchRow = {
          id,
          tournamentId: (data.tournamentId as string | null) ?? null,
          matchType: data.matchType as string,
          status: 'CREATED',
          pointsToWin: data.pointsToWin as number,
          capScore: data.capScore as number,
          intervalAt: data.intervalAt as number,
          scoringLocked: false,
          umpireToken: data.umpireToken as string,
          umpireCode: data.umpireCode as string,
          assignedCourtId: (data.assignedCourtId as string | null) ?? null,
          assignedUmpireId: (data.assignedUmpireId as string | null) ?? null,
          teamAName: (data.teamAName as string | null) ?? null,
          teamBName: (data.teamBName as string | null) ?? null,
          teamACountry: (data.teamACountry as string | null) ?? null,
          teamBCountry: (data.teamBCountry as string | null) ?? null,
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        };
        matches.set(id, row);
        const playersInput =
          (data.players as { create: Array<Record<string, string>> })?.create ?? [];
        players.set(
          id,
          playersInput.map(
            (p) => ({ id: generateId('player'), matchId: id, ...p }) as FakePlayerRow,
          ),
        );
        events.set(id, []);
        return row;
      }),

      findUnique: jest.fn(
        async ({
          where,
          include,
        }: {
          where: { id?: string; umpireCode?: string };
          include?: { players?: boolean; events?: unknown };
        }) => {
          const row = where.id
            ? matches.get(where.id)
            : [...matches.values()].find((m) => m.umpireCode === where.umpireCode);
          if (!row) return null;
          if (!include) return row;
          return {
            ...row,
            ...(include.players ? { players: players.get(row.id) ?? [] } : {}),
            ...(include.events ? { events: events.get(row.id) ?? [] } : {}),
          };
        },
      ),

      /** Supports only the court/umpire-occupancy queries the matches route makes. */
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where?: {
            assignedCourtId?: string;
            assignedUmpireId?: string;
            status?: { in?: string[] };
          };
        } = {}) => {
          const wanted = where?.status?.in;
          return (
            [...matches.values()].find(
              (m) =>
                (where?.assignedCourtId === undefined ||
                  m.assignedCourtId === where.assignedCourtId) &&
                (where?.assignedUmpireId === undefined ||
                  m.assignedUmpireId === where.assignedUmpireId) &&
                (wanted === undefined || wanted.includes(m.status)),
            ) ?? null
          );
        },
      ),

      findMany: jest.fn(async ({ where }: { where?: { tournamentId?: string } } = {}) => {
        return [...matches.values()]
          .filter((match) => !where?.tournamentId || match.tournamentId === where.tournamentId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }),

      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<FakeMatchRow> }) => {
          const existing = matches.get(where.id);
          if (!existing) throw new Error(`Fake match ${where.id} not found`);
          const updated = { ...existing, ...data };
          matches.set(where.id, updated);
          return updated;
        },
      ),

      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const existing = matches.get(where.id);
        if (!existing) throw new Error(`Fake match ${where.id} not found`);
        matches.delete(where.id);
        return existing;
      }),
    },

    court: {
      create: jest.fn(
        async ({ data }: { data: { label: string; tvCode: string; tournamentId?: string } }) => {
          const row: FakeCourtRow = {
            id: generateId('court'),
            tournamentId: data.tournamentId ?? null,
            label: data.label,
            currentMatchId: null,
            tvCode: data.tvCode,
            createdAt: new Date(),
          };
          courts.set(row.id, row);
          return row;
        },
      ),

      findMany: jest.fn(async ({ where }: { where?: { tournamentId?: string } } = {}) => {
        return [...courts.values()]
          .filter((court) => !where?.tournamentId || court.tournamentId === where.tournamentId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }),

      findUnique: jest.fn(
        async ({ where }: { where: { id?: string; tvCode?: string } }) =>
          (where.id
            ? courts.get(where.id)
            : [...courts.values()].find((c) => c.tvCode === where.tvCode)) ?? null,
      ),

      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const existing = courts.get(where.id);
        if (!existing) throw new Error(`Fake court ${where.id} not found`);
        courts.delete(where.id);
        return existing;
      }),

      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<FakeCourtRow> }) => {
          const existing = courts.get(where.id);
          if (!existing) throw new Error(`Fake court ${where.id} not found`);
          const updated = { ...existing, ...data };
          courts.set(where.id, updated);
          return updated;
        },
      ),
    },

    umpire: {
      create: jest.fn(async ({ data }: { data: { name: string; tournamentId?: string } }) => {
        const row: FakeUmpireRow = {
          id: generateId('umpire'),
          tournamentId: data.tournamentId ?? null,
          name: data.name,
          createdAt: new Date(),
        };
        umpires.set(row.id, row);
        return row;
      }),

      findMany: jest.fn(async ({ where }: { where?: { tournamentId?: string } } = {}) => {
        return [...umpires.values()]
          .filter((umpire) => !where?.tournamentId || umpire.tournamentId === where.tournamentId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }),

      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => umpires.get(where.id) ?? null,
      ),

      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const existing = umpires.get(where.id);
        if (!existing) throw new Error(`Fake umpire ${where.id} not found`);
        umpires.delete(where.id);
        return existing;
      }),
    },

    tournament: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: {
            name: string;
            date: Date;
            courts?: { create: { label: string; tvCode: string } };
          };
        }) => {
          const tournament = seedTournament({ name: data.name, date: data.date });
          if (data.courts)
            seedCourt({
              label: data.courts.create.label,
              tvCode: data.courts.create.tvCode,
              tournamentId: tournament.id,
            });
          return tournament;
        },
      ),
      findMany: jest.fn(async () =>
        [...tournaments.values()].sort((a, b) => b.date.getTime() - a.date.getTime()),
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => tournaments.get(where.id) ?? null,
      ),
    },

    scoreEvent: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: {
            matchId: string;
            eventId: string;
            type: string;
            side?: string;
            payload?: string;
            timestamp: bigint;
          };
        }) => {
          const alreadyExists = [...events.values()]
            .flat()
            .some((row) => row.eventId === data.eventId);
          if (alreadyExists) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: ['eventId'] },
            });
          }

          const row: FakeEventRow = {
            id: generateId('event'),
            matchId: data.matchId,
            eventId: data.eventId,
            type: data.type,
            side: data.side ?? null,
            payload: data.payload ?? null,
            timestamp: data.timestamp,
            createdAt: new Date(),
          };
          const list = events.get(data.matchId) ?? [];
          list.push(row);
          events.set(data.matchId, list);
          return row;
        },
      ),
    },
  };

  /**
   * Empties every table. The fake is built once per test module, so without
   * this rows accumulate across tests in a file — which is invisible until a
   * rule like "one live match per court" starts reading them.
   */
  function reset(): void {
    matches.clear();
    players.clear();
    events.clear();
    courts.clear();
    tournaments.clear();
    umpires.clear();
  }

  return {
    prisma,
    seedMatch,
    seedPlayers,
    seedEvent,
    seedCourt,
    seedTournament,
    seedUmpire,
    reset,
  };
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;
