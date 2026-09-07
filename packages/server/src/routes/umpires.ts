import { Router } from 'express';
import type { Umpire } from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

export const umpiresRouter = Router();

interface CreateUmpireBody {
  name: string;
  tournamentId: string;
}

function toUmpire(row: { id: string; tournamentId: string | null; name: string }): Umpire {
  return { umpireId: row.id, tournamentId: row.tournamentId, name: row.name };
}

// Admin-only, same shared password as court and match management. Umpires
// are entered once ahead of an event, then picked from a dropdown when a
// match is created — see "Create match" in the admin dashboard.
umpiresRouter.post(
  '/umpires',
  adminAuth,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<CreateUmpireBody>;
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'An umpire name is required.' });
      return;
    }
    if (typeof body.tournamentId !== 'string' || !body.tournamentId) {
      res.status(400).json({ error: 'Select a tournament before adding an umpire.' });
      return;
    }
    const tournament = await prisma.tournament.findUnique({ where: { id: body.tournamentId } });
    if (!tournament) {
      res.status(400).json({ error: 'Selected tournament was not found.' });
      return;
    }

    const umpire = await prisma.umpire.create({
      data: { name: body.name.trim(), tournamentId: body.tournamentId },
    });
    res.status(201).json(toUmpire(umpire));
  }),
);

umpiresRouter.get(
  '/umpires',
  adminAuth,
  asyncRoute(async (req, res) => {
    const tournamentId = req.query.tournamentId;
    if (typeof tournamentId !== 'string' || !tournamentId) {
      res.status(400).json({ error: 'A tournament is required.' });
      return;
    }
    const umpires = await prisma.umpire.findMany({
      where: { tournamentId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(umpires.map(toUmpire));
  }),
);

umpiresRouter.delete(
  '/umpires/:umpireId',
  adminAuth,
  asyncRoute<{ umpireId: string }>(async (req, res) => {
    const umpireId = req.params.umpireId!;

    const umpire = await prisma.umpire.findUnique({ where: { id: umpireId } });
    if (!umpire) {
      res.status(404).json({ error: 'Umpire not found.' });
      return;
    }

    const deleted = await prisma.umpire.delete({ where: { id: umpireId } });
    res.json(toUmpire(deleted));
  }),
);
