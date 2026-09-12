import {
  deriveMatchState,
  type CourtPositions,
  type Match,
  type MatchStatePayload,
  type RetireReason,
  type ScoreEvent,
  type ScoringConfig,
  type Side,
} from '@courtside/shared';
import { prisma } from '../db/client.js';

/**
 * Loads one match's full event log from SQLite and replays it through the
 * shared scoring engine. This is the ONLY place match state gets computed —
 * see Set 03 / Set 06 of the design spec for why that matters for undo.
 */
export async function loadMatchState(matchId: string): Promise<MatchStatePayload | null> {
  const record = await prisma.match.findUnique({
    where: { id: matchId },
    include: { players: true, events: { orderBy: { timestamp: 'asc' } } },
  });
  if (!record) return null;
  const court = record.assignedCourtId
    ? await prisma.court.findUnique({ where: { id: record.assignedCourtId } })
    : null;
  const umpire = record.assignedUmpireId
    ? await prisma.umpire.findUnique({ where: { id: record.assignedUmpireId } })
    : null;

  const events: ScoreEvent[] = record.events.map((row) => {
    const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
    return {
      eventId: row.eventId,
      matchId: row.matchId,
      type: row.type as ScoreEvent['type'],
      ...(row.side ? { side: row.side as Side } : {}),
      ...(payload.firstServerPlayerId
        ? { firstServerPlayerId: payload.firstServerPlayerId as string }
        : {}),
      ...(payload.firstServerSide ? { firstServerSide: payload.firstServerSide as Side } : {}),
      ...(payload.courtPositions
        ? { courtPositions: payload.courtPositions as CourtPositions }
        : {}),
      ...(payload.reason ? { retireReason: payload.reason as RetireReason } : {}),
      timestamp: Number(row.timestamp),
    };
  });

  const scoringConfig: ScoringConfig = {
    pointsToWin: record.pointsToWin,
    capScore: record.capScore,
    intervalAt: record.intervalAt,
  };

  const derived = deriveMatchState(events, scoringConfig);
  const startedEvent = events.find((event) => event.type === 'START_SET' || event.type === 'POINT');
  const completedEvent = derived.matchWinner
    ? [...events].reverse().find((event) => event.type === 'POINT' || event.type === 'RETIRE')
    : undefined;
  const timestampToIso = (event: ScoreEvent | undefined): string | null =>
    event ? new Date(event.timestamp).toISOString() : null;

  const match: Match = {
    matchId: record.id,
    tournamentId: record.tournamentId,
    matchType: record.matchType as Match['matchType'],
    status: record.status as Match['status'],
    scoringConfig,
    scoringLocked: record.scoringLocked,
    category: record.category,
    players: record.players.map((p) => ({
      playerId: p.id,
      side: p.side as Side,
      name: p.name,
      lastName: p.lastName,
      shortName: p.shortName,
    })),
    teams: {
      A: { name: record.teamAName, country: record.teamACountry },
      B: { name: record.teamBName, country: record.teamBCountry },
    },
    umpireToken: record.umpireToken,
    umpireCode: record.umpireCode,
    assignedCourtId: record.assignedCourtId,
    courtLabel: court?.label ?? null,
    assignedUmpireId: record.assignedUmpireId,
    umpireName: umpire?.name ?? null,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? timestampToIso(startedEvent),
    completedAt: record.completedAt?.toISOString() ?? timestampToIso(completedEvent),
  };

  return { match, derived };
}
