/**
 * A tiny in-memory stand-in for the Prisma client, shaped to cover exactly
 * the calls this codebase makes (see replay.ts, routes/matches.ts, and
 * sockets/index.ts). Used instead of a real SQLite database in tests so
 * they're fast, deterministic, and don't depend on `prisma generate`
 * having run — every method is a jest.fn() so call assertions still work.
 */

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
  matchType: string;
  status: string;
  pointsToWin: number;
  capScore: number;
  intervalAt: number;
  scoringLocked: boolean;
  umpireToken: string;
  assignedCourtId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface FakeCourtRow {
  id: string;
  label: string;
  currentMatchId: string | null;
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

  function seedMatch(overrides: Partial<FakeMatchRow> = {}): FakeMatchRow {
    const id = overrides.id ?? generateId('match');
    const row: FakeMatchRow = {
      id,
      matchType: 'singles',
      status: 'CREATED',
      pointsToWin: 21,
      capScore: 30,
      intervalAt: 11,
      scoringLocked: false,
      umpireToken: 'test-token',
      assignedCourtId: null,
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
      label: 'Court 1',
      currentMatchId: null,
      createdAt: new Date(),
      ...overrides,
    };
    courts.set(id, row);
    return row;
  }

  const prisma = {
    match: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = generateId('match');
        const row: FakeMatchRow = {
          id,
          matchType: data.matchType as string,
          status: 'CREATED',
          pointsToWin: data.pointsToWin as number,
          capScore: data.capScore as number,
          intervalAt: data.intervalAt as number,
          scoringLocked: false,
          umpireToken: data.umpireToken as string,
          assignedCourtId: (data.assignedCourtId as string | null) ?? null,
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
          where: { id: string };
          include?: { players?: boolean; events?: unknown };
        }) => {
          const row = matches.get(where.id);
          if (!row) return null;
          if (!include) return row;
          return {
            ...row,
            ...(include.players ? { players: players.get(where.id) ?? [] } : {}),
            ...(include.events ? { events: events.get(where.id) ?? [] } : {}),
          };
        },
      ),

      findMany: jest.fn(async () => {
        return [...matches.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }),
    },

    court: {
      create: jest.fn(async ({ data }: { data: { label: string } }) => {
        const row: FakeCourtRow = {
          id: generateId('court'),
          label: data.label,
          currentMatchId: null,
          createdAt: new Date(),
        };
        courts.set(row.id, row);
        return row;
      }),

      findMany: jest.fn(async () => {
        return [...courts.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }),

      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => courts.get(where.id) ?? null,
      ),

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
            timestamp: bigint;
          };
        }) => {
          const row: FakeEventRow = {
            id: generateId('event'),
            matchId: data.matchId,
            eventId: data.eventId,
            type: data.type,
            side: data.side ?? null,
            payload: null,
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

  return { prisma, seedMatch, seedPlayers, seedEvent, seedCourt };
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;
