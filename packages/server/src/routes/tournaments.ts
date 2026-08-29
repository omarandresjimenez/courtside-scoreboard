import { Router } from 'express';
import type { Tournament } from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { generateJoinCode } from '../match/tokens.js';

export const tournamentsRouter = Router();

function toTournament(row: { id: string; name: string; date: Date }): Tournament {
  return { tournamentId: row.id, name: row.name, date: row.date.toISOString() };
}

tournamentsRouter.get('/tournaments', adminAuth, async (_req, res) => {
  const tournaments = await prisma.tournament.findMany({ orderBy: { date: 'desc' } });
  res.json(tournaments.map(toTournament));
});

tournamentsRouter.post('/tournaments', adminAuth, async (req, res) => {
  const body = req.body as { name?: unknown; date?: unknown };
  if (typeof body.name !== 'string' || !body.name.trim()) {
    res.status(400).json({ error: 'A tournament name is required.' });
    return;
  }
  const date = typeof body.date === 'string' ? new Date(body.date) : new Date();
  if (Number.isNaN(date.getTime())) {
    res.status(400).json({ error: 'A valid tournament date is required.' });
    return;
  }

  const tournament = await prisma.tournament.create({
    data: {
      name: body.name.trim(),
      date,
      courts: { create: { label: 'Main Court', tvCode: generateJoinCode() } },
    },
  });
  res.status(201).json(toTournament(tournament));
});
