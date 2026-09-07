import { Router } from 'express';
import type { TournamentPlayer } from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

export const tournamentPlayersRouter = Router();

interface ImportRow {
  memberId?: string | null;
  firstName: string;
  lastName: string;
  gender?: string | null;
  country?: string | null;
  club?: string | null;
  /** ISO date (yyyy-mm-dd), or null. */
  birthDate?: string | null;
  categories?: string | null;
  status?: string | null;
}

interface ImportBody {
  tournamentId: string;
  players: ImportRow[];
}

function toTournamentPlayer(row: {
  id: string;
  tournamentId: string;
  memberId: string | null;
  firstName: string;
  lastName: string;
  gender: string | null;
  country: string | null;
  club: string | null;
  birthDate: Date | null;
  categories: string;
  status: string;
}): TournamentPlayer {
  return {
    tournamentPlayerId: row.id,
    tournamentId: row.tournamentId,
    memberId: row.memberId,
    firstName: row.firstName,
    lastName: row.lastName,
    gender: row.gender,
    country: row.country,
    club: row.club,
    birthDate: row.birthDate ? row.birthDate.toISOString().slice(0, 10) : null,
    categories: row.categories,
    status: row.status,
  };
}

function isValidRow(row: unknown): row is ImportRow {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as Partial<ImportRow>;
  return typeof candidate.firstName === 'string' && typeof candidate.lastName === 'string';
}

/**
 * Bulk import (upsert) a tournament's player roster — normally the parsed
 * rows of a CSV export from tournament-management software (see
 * parseTournamentPlayersCsv in @courtside/shared, run client-side so this
 * endpoint stays a plain JSON API). Rows carrying a `memberId` update the
 * existing row for that id on re-import (fixing a bad export doesn't create
 * duplicates); rows without one are always inserted as new.
 */
tournamentPlayersRouter.post(
  '/tournament-players/import',
  adminAuth,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<ImportBody>;
    if (typeof body.tournamentId !== 'string' || !body.tournamentId) {
      res.status(400).json({ error: 'A tournament is required.' });
      return;
    }
    if (!Array.isArray(body.players) || body.players.length === 0) {
      res.status(400).json({ error: 'No players to import.' });
      return;
    }

    const tournament = await prisma.tournament.findUnique({ where: { id: body.tournamentId } });
    if (!tournament) {
      res.status(400).json({ error: 'Selected tournament was not found.' });
      return;
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of body.players) {
      if (!isValidRow(row) || !row.firstName.trim() || !row.lastName.trim()) {
        skipped += 1;
        continue;
      }

      const data = {
        firstName: row.firstName.trim(),
        lastName: row.lastName.trim(),
        gender: row.gender?.trim() || null,
        country: row.country?.trim() || null,
        club: row.club?.trim() || null,
        birthDate: row.birthDate ? new Date(row.birthDate) : null,
        categories: row.categories?.trim() || '',
        status: row.status?.trim() || 'Accepted',
      };
      const memberId = row.memberId?.trim() || null;

      if (memberId) {
        const existing = await prisma.tournamentPlayer.findUnique({
          where: { tournamentId_memberId: { tournamentId: body.tournamentId, memberId } },
        });
        await prisma.tournamentPlayer.upsert({
          where: { tournamentId_memberId: { tournamentId: body.tournamentId, memberId } },
          create: { tournamentId: body.tournamentId, memberId, ...data },
          update: data,
        });
        if (existing) updated += 1;
        else imported += 1;
      } else {
        await prisma.tournamentPlayer.create({
          data: { tournamentId: body.tournamentId, memberId: null, ...data },
        });
        imported += 1;
      }
    }

    res.status(201).json({ imported, updated, skipped });
  }),
);

tournamentPlayersRouter.get(
  '/tournament-players',
  adminAuth,
  asyncRoute(async (req, res) => {
    const tournamentId = req.query.tournamentId;
    if (typeof tournamentId !== 'string' || !tournamentId) {
      res.status(400).json({ error: 'A tournament is required.' });
      return;
    }
    const players = await prisma.tournamentPlayer.findMany({
      where: { tournamentId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    res.json(players.map(toTournamentPlayer));
  }),
);

// Lets an admin drop a bad row (a typo'd import, a scratched player) without
// re-importing the whole roster — matches don't reference this table
// directly (see Player.tournamentPlayerId's comment in schema.prisma), so
// removing one never touches match history.
tournamentPlayersRouter.delete(
  '/tournament-players/:playerId',
  adminAuth,
  asyncRoute<{ playerId: string }>(async (req, res) => {
    const playerId = req.params.playerId!;

    const player = await prisma.tournamentPlayer.findUnique({ where: { id: playerId } });
    if (!player) {
      res.status(404).json({ error: 'Player not found.' });
      return;
    }

    const deleted = await prisma.tournamentPlayer.delete({ where: { id: playerId } });
    res.json(toTournamentPlayer(deleted));
  }),
);
