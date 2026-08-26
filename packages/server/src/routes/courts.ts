import { Router } from 'express';
import type { Court } from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';

export const courtsRouter = Router();

interface CreateCourtBody {
  label: string;
}

function toCourt(row: { id: string; label: string; currentMatchId: string | null }): Court {
  return { courtId: row.id, label: row.label, currentMatchId: row.currentMatchId };
}

// Admin-only, same shared password as match management (Set 08). Courts are
// created once ahead of an event and then targeted by TV links — see the
// match-day setup guide for the create-court → get-TV-link flow.
courtsRouter.post('/courts', adminAuth, async (req, res) => {
  const body = req.body as Partial<CreateCourtBody>;
  if (typeof body.label !== 'string' || !body.label.trim()) {
    res.status(400).json({ error: 'A court label is required.' });
    return;
  }

  const court = await prisma.court.create({ data: { label: body.label.trim() } });
  res.status(201).json(toCourt(court));
});

courtsRouter.get('/courts', adminAuth, async (_req, res) => {
  const courts = await prisma.court.findMany({ orderBy: { createdAt: 'asc' } });
  res.json(courts.map(toCourt));
});
