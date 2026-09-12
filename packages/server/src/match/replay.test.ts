import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

// This import must come after jest.mock() above so that when replay.ts's
// own `import { prisma } from '../db/client.js'` resolves, it resolves to
// the mock, not the real (here, ungenerated) Prisma client.
import { loadMatchState } from './replay.js';

describe('loadMatchState', () => {
  it('returns null when the match does not exist', async () => {
    expect(await loadMatchState('missing-match')).toBeNull();
  });

  it('assembles the Match and replays its events through the shared scoring engine', async () => {
    const match = mockPrisma.seedMatch({ pointsToWin: 21, capScore: 30, intervalAt: 11 });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    ]);
    mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(1) });
    mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(2) });

    const state = await loadMatchState(match.id);

    expect(state?.match.matchId).toBe(match.id);
    expect(state?.match.players).toHaveLength(2);
    expect(state?.match.players[0]).toMatchObject({
      side: 'A',
      name: 'Alice',
      lastName: 'Adams',
      shortName: 'ALI',
    });
    expect(state?.derived.currentSet).toMatchObject({ scoreA: 2, scoreB: 0 });
  });

  it('parses a JSON event payload (doubles START_SET court positions)', async () => {
    const match = mockPrisma.seedMatch({ matchType: 'doubles' });
    mockPrisma.seedEvent(match.id, {
      type: 'START_SET',
      timestamp: BigInt(1),
      payload: JSON.stringify({
        firstServerPlayerId: 'p-right',
        courtPositions: { A: { right: 'p-right', left: 'p-left' } },
      }),
    });

    const state = await loadMatchState(match.id);

    expect(state?.derived.serve.servingSide).toBe('A');
    expect(state?.derived.serve.serverPlayerId).toBe('p-right');
  });

  it('treats a missing payload as no extra fields, not an error', async () => {
    const match = mockPrisma.seedMatch();
    mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'B', payload: null });

    const state = await loadMatchState(match.id);

    expect(state?.derived.currentSet).toMatchObject({ scoreA: 0, scoreB: 1 });
  });

  it('derives legacy match timestamps from scoring events when database timestamps are absent', async () => {
    const match = mockPrisma.seedMatch({ pointsToWin: 1, capScore: 2 });
    mockPrisma.seedEvent(match.id, {
      type: 'START_SET',
      timestamp: BigInt(Date.parse('2026-08-29T10:00:00.000Z')),
      payload: JSON.stringify({ firstServerSide: 'A' }),
    });
    for (const timestamp of [30_000, 60_000, 90_000, 150_000]) {
      mockPrisma.seedEvent(match.id, {
        type: 'POINT',
        side: 'A',
        timestamp: BigInt(Date.parse('2026-08-29T10:00:00.000Z') + timestamp),
      });
    }

    const state = await loadMatchState(match.id);

    expect(state?.derived.matchWinner).toBe('A');
    expect(state?.match.startedAt).toBe('2026-08-29T10:00:00.000Z');
    expect(state?.match.completedAt).toBe('2026-08-29T10:02:30.000Z');
  });

  it('derives completedAt from a RETIRE event when the match ends by retirement, not a point', async () => {
    const match = mockPrisma.seedMatch();
    mockPrisma.seedEvent(match.id, {
      type: 'POINT',
      side: 'A',
      timestamp: BigInt(Date.parse('2026-08-29T10:00:00.000Z')),
    });
    mockPrisma.seedEvent(match.id, {
      type: 'RETIRE',
      side: 'A',
      timestamp: BigInt(Date.parse('2026-08-29T10:05:00.000Z')),
    });

    const state = await loadMatchState(match.id);

    expect(state?.derived.matchWinner).toBe('A');
    expect(state?.match.completedAt).toBe('2026-08-29T10:05:00.000Z');
  });

  it('decodes a walkover reason from a RETIRE event payload', async () => {
    const match = mockPrisma.seedMatch();
    mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(1) });
    mockPrisma.seedEvent(match.id, {
      type: 'RETIRE',
      side: 'A',
      timestamp: BigInt(2),
      payload: JSON.stringify({ reason: 'WALKOVER' }),
    });

    const state = await loadMatchState(match.id);

    expect(state?.derived.retireReason).toBe('WALKOVER');
  });
});
