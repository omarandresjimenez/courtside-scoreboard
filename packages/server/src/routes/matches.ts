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
import { asyncRoute } from '../middleware/asyncRoute.js';

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

/**
 * Every player must declare which side it plays for.
 *
 * `players` was previously checked only for being an array of the right
 * *length*, never for its contents. A player object without `side` therefore
 * passed validation, reached Prisma, and was rejected there — as a rejection
 * inside an async handler, which Express 4 does not catch, so the whole server
 * exited and the client got no response at all. Both ends of that are fixed now
 * (see asyncRoute and errorHandler), but a malformed request still deserves a
 * 400 rather than a generic 500.
 */
function hasValidPlayers(players: CreateMatchPlayer[], matchType: MatchType): boolean {
  const expected = matchType === 'doubles' ? 4 : 2;
  if (players.length !== expected) return false;
  if (!players.every((player) => player?.side === 'A' || player?.side === 'B')) return false;

  // Evenly split, or the match is unplayable in a way the scoring engine has
  // no way to represent — four players all on side A would be accepted by a
  // per-player check alone.
  return players.filter((player) => player.side === 'A').length === expected / 2;
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
matchesRouter.post(
  '/matches',
  adminAuth,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<CreateMatchBody>;

    if (
      (body.matchType !== 'singles' && body.matchType !== 'doubles') ||
      !Array.isArray(body.players) ||
      !hasValidPlayers(body.players, body.matchType) ||
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
      // Both shapes on purpose. `error` keeps the endpoint readable to any
      // caller (and to a log), while `issues` carries the codes the admin
      // dashboard translates — this server has no idea what language the
      // browser is in, so it cannot produce the text the admin should see.
      res.status(400).json({
        error: eligibilityIssues.map((issue) => issue.message).join(' '),
        issues: eligibilityIssues,
      });
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
  }),
);

// Public, unauthenticated, and registered ahead of the /matches/:matchId
// route below so "resolve" isn't swallowed as a matchId. Knowing the code
// grants the same scoring authority as the umpire link/token it resolves
// to, so — same as that link — hand it out only to the actual umpire.
matchesRouter.get(
  '/matches/resolve/:code',
  asyncRoute<{ code: string }>(async (req, res) => {
    const match = await prisma.match.findUnique({
      where: { umpireCode: req.params.code.toUpperCase() },
    });
    if (!match) {
      res.status(404).json({ error: 'Match code not found.' });
      return;
    }
    res.json({ matchId: match.id, token: match.umpireToken });
  }),
);

matchesRouter.get(
  '/matches/:matchId',
  asyncRoute<{ matchId: string }>(async (req, res) => {
    const state = await loadMatchState(req.params.matchId);
    if (!state) {
      res.status(404).json({ error: 'Match not found.' });
      return;
    }
    res.json(state);
  }),
);

// Admin-only: the raw rows carry umpireToken, which must never reach an
// unauthenticated client — see "Set 08 — QR, links & security".
matchesRouter.get(
  '/matches',
  adminAuth,
  asyncRoute(async (_req, res) => {
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
  }),
);
