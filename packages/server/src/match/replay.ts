import {
  deriveMatchState,
  type CourtPositions,
  type Match,
  type MatchStatePayload,
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

  const events: ScoreEvent[] = record.events.map((row) => {
    const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
    return {
      eventId: row.eventId,
      matchId: row.matchId,
      type: row.type as ScoreEvent['type'],
      side: (row.side as Side | null) ?? undefined,
      firstServerPlayerId: payload.firstServerPlayerId as string | undefined,
      courtPositions: payload.courtPositions as CourtPositions | undefined,
      timestamp: Number(row.timestamp),
    };
  });

  const scoringConfig: ScoringConfig = {
    pointsToWin: record.pointsToWin,
    capScore: record.capScore,
    intervalAt: record.intervalAt,
  };

  const match: Match = {
    matchId: record.id,
    matchType: record.matchType as Match['matchType'],
    status: record.status as Match['status'],
    scoringConfig,
    scoringLocked: record.scoringLocked,
    players: record.players.map((p) => ({
      playerId: p.id,
      side: p.side as Side,
      name: p.name,
      shortName: p.shortName,
    })),
    umpireToken: record.umpireToken,
    assignedCourtId: record.assignedCourtId,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
  };

  const derived = deriveMatchState(events, scoringConfig);

  return { match, derived };
}
