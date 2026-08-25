import { Router } from 'express';
import type { MatchSummary, MatchType, ScoringConfig } from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { generateUmpireToken } from '../match/tokens.js';
import { loadMatchState } from '../match/replay.js';

export const matchesRouter = Router();

interface CreateMatchBody {
  matchType: MatchType;
  players: Array<{ side: 'A' | 'B'; name: string; shortName?: string }>;
  scoringConfig: ScoringConfig;
  courtId?: string;
}

function isValidScoringConfig(config: ScoringConfig): boolean {
  return (
    Number.isInteger(config.pointsToWin) &&
    Number.isInteger(config.capScore) &&
    Number.isInteger(config.intervalAt) &&
    config.capScore > config.pointsToWin &&
    config.intervalAt > 0 &&
    config.intervalAt < config.pointsToWin
  );
}

// Admin-only: everything that creates or mutates a match goes through the
// shared admin password (Set 08). Umpire actions (scoring) are authorized
// per-match by umpireToken instead, over the socket connection.
matchesRouter.post('/matches', adminAuth, async (req, res) => {
  const body = req.body as Partial<CreateMatchBody>;

  const expectedPlayerCount = body.matchType === 'doubles' ? 4 : 2;
  if (
    (body.matchType !== 'singles' && body.matchType !== 'doubles') ||
    !Array.isArray(body.players) ||
    body.players.length !== expectedPlayerCount ||
    !body.scoringConfig ||
    !isValidScoringConfig(body.scoringConfig)
  ) {
    res.status(400).json({ error: 'Invalid match payload.' });
    return;
  }

  const match = await prisma.match.create({
    data: {
      matchType: body.matchType,
      pointsToWin: body.scoringConfig.pointsToWin,
      capScore: body.scoringConfig.capScore,
      intervalAt: body.scoringConfig.intervalAt,
      umpireToken: generateUmpireToken(),
      assignedCourtId: body.courtId ?? null,
      players: {
        create: body.players.map((p) => ({
          side: p.side,
          name: p.name,
          shortName: p.shortName?.trim() || p.name.slice(0, 3).toUpperCase(),
        })),
      },
    },
  });

  if (body.courtId) {
    await prisma.court.update({
      where: { id: body.courtId },
      data: { currentMatchId: match.id },
    });
  }

  const state = await loadMatchState(match.id);
  res.status(201).json(state);
});

matchesRouter.get('/matches/:matchId', async (req, res) => {
  const state = await loadMatchState(req.params.matchId);
  if (!state) {
    res.status(404).json({ error: 'Match not found.' });
    return;
  }
  res.json(state);
});

// Admin-only: the raw rows carry umpireToken, which must never reach an
// unauthenticated client — see "Set 08 — QR, links & security".
matchesRouter.get('/matches', adminAuth, async (_req, res) => {
  const matches = await prisma.match.findMany({ orderBy: { createdAt: 'desc' } });
  const summaries: MatchSummary[] = matches.map((m) => ({
    matchId: m.id,
    matchType: m.matchType as MatchSummary['matchType'],
    status: m.status as MatchSummary['status'],
    assignedCourtId: m.assignedCourtId,
    createdAt: m.createdAt.toISOString(),
  }));
  res.json(summaries);
});
