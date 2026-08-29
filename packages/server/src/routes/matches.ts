import { Router } from 'express';
import type { MatchSummary, MatchType, ScoringConfig } from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { generateJoinCode, generateUmpireToken } from '../match/tokens.js';
import { loadMatchState } from '../match/replay.js';
import { roomForCourt } from '../sockets/index.js';
import type { Server } from 'socket.io';

export const matchesRouter = Router();
let io: Server | null = null;

export function setMatchesSocketServer(server: Server): void {
  io = server;
}

interface CreateMatchBody {
  matchType: MatchType;
  players: Array<{ side: 'A' | 'B'; name: string; shortName?: string }>;
  scoringConfig: ScoringConfig;
  courtId?: string;
  tournamentId?: string;
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
    !isValidScoringConfig(body.scoringConfig) ||
    !body.courtId ||
    !body.tournamentId
  ) {
    res.status(400).json({ error: 'Invalid match payload.' });
    return;
  }

  const court = await prisma.court.findUnique({ where: { id: body.courtId } });
  if (!court || court.tournamentId !== body.tournamentId) {
    res.status(400).json({ error: 'Select a court from this tournament.' });
    return;
  }

  const match = await prisma.match.create({
    data: {
      matchType: body.matchType,
      pointsToWin: body.scoringConfig.pointsToWin,
      capScore: body.scoringConfig.capScore,
      intervalAt: body.scoringConfig.intervalAt,
      umpireToken: generateUmpireToken(),
      umpireCode: generateJoinCode(),
      tournamentId: body.tournamentId,
      assignedCourtId: body.courtId,
      players: {
        create: body.players.map((p) => ({
          side: p.side,
          name: p.name,
          shortName: p.shortName?.trim() || p.name.slice(0, 3).toUpperCase(),
        })),
      },
    },
  });

  await prisma.court.update({
    where: { id: body.courtId },
    data: { currentMatchId: match.id },
  });

  const state = await loadMatchState(match.id);
  if (state) io?.to(roomForCourt(body.courtId)).emit('server:match_state', state);
  res.status(201).json(state);
});

// Public, unauthenticated, and registered ahead of the /matches/:matchId
// route below so "resolve" isn't swallowed as a matchId. Knowing the code
// grants the same scoring authority as the umpire link/token it resolves
// to, so — same as that link — hand it out only to the actual umpire.
matchesRouter.get('/matches/resolve/:code', async (req, res) => {
  const match = await prisma.match.findUnique({
    where: { umpireCode: req.params.code.toUpperCase() },
  });
  if (!match) {
    res.status(404).json({ error: 'Match code not found.' });
    return;
  }
  res.json({ matchId: match.id, token: match.umpireToken });
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
  const tournamentId = _req.query.tournamentId;
  if (typeof tournamentId !== 'string' || !tournamentId) {
    res.status(400).json({ error: 'A tournament is required.' });
    return;
  }
  const matches = await prisma.match.findMany({
    where: { tournamentId },
    orderBy: { createdAt: 'desc' },
  });
  const summaries = (await Promise.all(matches.map((match) => loadMatchState(match.id)))).flatMap(
    (state): MatchSummary[] => {
      if (!state) return [];
      return [
        {
          matchId: state.match.matchId,
          tournamentId: state.match.tournamentId ?? null,
          matchType: state.match.matchType,
          status: state.match.status,
          assignedCourtId: state.match.assignedCourtId,
          courtLabel: state.match.courtLabel ?? null,
          createdAt: state.match.createdAt,
          startedAt: state.match.startedAt,
          completedAt: state.match.completedAt,
          players: state.match.players,
          derived: {
            sets: state.derived.sets.map(({ setNumber, scoreA, scoreB, winner }) => ({
              setNumber,
              scoreA,
              scoreB,
              winner,
            })),
            setsWon: state.derived.setsWon,
            matchWinner: state.derived.matchWinner,
          },
        },
      ];
    },
  );
  res.json(summaries);
});
