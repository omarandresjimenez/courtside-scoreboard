import { Router } from 'express';
import {
  parseCategoryList,
  validateMatchEligibility,
  type MatchSummary,
  type MatchType,
  type ScoringConfig,
  type Side,
} from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { generateJoinCode, generateUmpireToken } from '../match/tokens.js';
import { loadMatchState } from '../match/replay.js';
import { roomForCourt } from '../sockets/index.js';
import type { Server } from 'socket.io';

/** Blank and whitespace-only entries mean "no team", not an empty label. */
function trimmedOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const matchesRouter = Router();
let io: Server | null = null;

export function setMatchesSocketServer(server: Server): void {
  io = server;
}

interface CreateMatchPlayer {
  side: Side;
  /** Selects a roster row from the tournament's imported players — see
   * TournamentPlayer. Preferred over `name`/`lastName` when the tournament
   * has an imported roster; the server looks up and copies its name fields
   * rather than trusting whatever the client also sent for them. */
  tournamentPlayerId?: string;
  name?: string;
  lastName?: string;
  shortName?: string;
}

interface CreateMatchBody {
  matchType: MatchType;
  players: CreateMatchPlayer[];
  /** Competition category as announced, e.g. "BS U19". Free text, optional —
   * unless the tournament has an imported roster, in which case it must be
   * one of the categories that roster actually carries (see the check
   * below the court/umpire lookups). */
  category?: string;
  scoringConfig: ScoringConfig;
  courtId?: string;
  umpireId?: string;
  tournamentId?: string;
  /** Optional per-side team name and country; both fields optional too. */
  teams?: Partial<Record<'A' | 'B', { name?: string; country?: string }>>;
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
    !body.umpireId ||
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

  const umpire = await prisma.umpire.findUnique({ where: { id: body.umpireId } });
  if (!umpire || umpire.tournamentId !== body.tournamentId) {
    res.status(400).json({ error: 'Select an umpire from this tournament.' });
    return;
  }

  const tournament = await prisma.tournament.findUnique({ where: { id: body.tournamentId } });
  if (!tournament) {
    res.status(400).json({ error: 'Selected tournament was not found.' });
    return;
  }

  // Each player is either picked from the tournament's imported roster
  // (tournamentPlayerId) or typed manually — see CreateMatchPlayer. Roster
  // rows are looked up here, once, both to resolve the name to store and to
  // feed validateMatchEligibility below; a manually-typed player simply has
  // no roster data, so every eligibility check involving it is skipped.
  const roster = await prisma.tournamentPlayer.findMany({
    where: { tournamentId: body.tournamentId },
  });
  const rosterById = new Map(roster.map((r) => [r.id, r]));

  interface ResolvedPlayer {
    side: Side;
    name: string;
    lastName: string;
    shortName: string | undefined;
    tournamentPlayerId: string | null;
    gender: string | null;
    birthDate: Date | null;
    categories: string | null;
  }

  const resolvedPlayers: ResolvedPlayer[] = [];
  for (const p of body.players) {
    if (p.tournamentPlayerId) {
      const rosterRow = rosterById.get(p.tournamentPlayerId);
      if (!rosterRow) {
        res.status(400).json({ error: 'A selected player was not found in this roster.' });
        return;
      }
      resolvedPlayers.push({
        side: p.side,
        name: rosterRow.firstName,
        lastName: rosterRow.lastName,
        shortName: p.shortName,
        tournamentPlayerId: rosterRow.id,
        gender: rosterRow.gender,
        birthDate: rosterRow.birthDate,
        categories: rosterRow.categories,
      });
      continue;
    }

    if (!p.name?.trim()) {
      res.status(400).json({ error: 'Every player needs a name.' });
      return;
    }
    resolvedPlayers.push({
      side: p.side,
      name: p.name.trim(),
      lastName: p.lastName?.trim() ?? '',
      shortName: p.shortName,
      tournamentPlayerId: null,
      gender: null,
      birthDate: null,
      categories: null,
    });
  }

  const trimmedCategory = body.category?.trim() || null;

  // Once a roster has been imported, category is no longer free text: it
  // must be one of the codes that roster actually carries, so an admin
  // cannot type a category no player is registered for.
  if (trimmedCategory && roster.length > 0) {
    const knownCategories = new Set(roster.flatMap((r) => parseCategoryList(r.categories)));
    if (!knownCategories.has(trimmedCategory.toUpperCase())) {
      res.status(400).json({
        error: `"${trimmedCategory}" is not one of this tournament's imported categories.`,
      });
      return;
    }
  }

  const eligibilityIssues = validateMatchEligibility(
    body.matchType,
    trimmedCategory,
    resolvedPlayers.map((p) => ({
      side: p.side,
      gender: p.gender,
      birthDate: p.birthDate?.toISOString() ?? null,
      categories: p.categories,
    })),
    tournament.date,
  );
  if (eligibilityIssues.length > 0) {
    res.status(400).json({ error: eligibilityIssues.map((issue) => issue.message).join(' ') });
    return;
  }

  // One match at a time per court. Without this the admin can queue several
  // matches onto the same court, and Court.currentMatchId — which is what the
  // TV subscribes to — silently follows only the newest of them.
  const occupying = await prisma.match.findFirst({
    where: {
      assignedCourtId: body.courtId,
      status: { in: ['CREATED', 'IN_PROGRESS'] },
    },
  });
  if (occupying) {
    res.status(409).json({
      error: `${court.label} is still in use. Finalise the match on it before starting another.`,
    });
    return;
  }

  // Same one-at-a-time rule for the umpire — a person can't officiate two
  // live matches at once.
  const umpireBusy = await prisma.match.findFirst({
    where: {
      assignedUmpireId: body.umpireId,
      status: { in: ['CREATED', 'IN_PROGRESS'] },
    },
  });
  if (umpireBusy) {
    res.status(409).json({
      error: `${umpire.name} is already umpiring another match. Finalise it before assigning another.`,
    });
    return;
  }

  const match = await prisma.match.create({
    data: {
      matchType: body.matchType,
      pointsToWin: body.scoringConfig.pointsToWin,
      capScore: body.scoringConfig.capScore,
      intervalAt: body.scoringConfig.intervalAt,
      teamAName: trimmedOrNull(body.teams?.A?.name),
      teamBName: trimmedOrNull(body.teams?.B?.name),
      teamACountry: trimmedOrNull(body.teams?.A?.country),
      teamBCountry: trimmedOrNull(body.teams?.B?.country),
      umpireToken: generateUmpireToken(),
      umpireCode: generateJoinCode(),
      tournamentId: body.tournamentId,
      category: trimmedCategory,
      assignedCourtId: body.courtId,
      assignedUmpireId: body.umpireId,
      players: {
        create: resolvedPlayers.map((p) => ({
          side: p.side,
          name: p.name,
          lastName: p.lastName,
          // Prefer the family name for the short form: on a TV wall two
          // players sharing a given name are otherwise indistinguishable.
          shortName: p.shortName?.trim() || (p.lastName || p.name).slice(0, 3).toUpperCase(),
          tournamentPlayerId: p.tournamentPlayerId,
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
          assignedUmpireId: state.match.assignedUmpireId,
          umpireName: state.match.umpireName ?? null,
          createdAt: state.match.createdAt,
          startedAt: state.match.startedAt,
          completedAt: state.match.completedAt,
          category: state.match.category ?? null,
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
            retiredSide: state.derived.retiredSide,
          },
        },
      ];
    },
  );
  res.json(summaries);
});
