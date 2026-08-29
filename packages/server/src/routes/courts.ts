import { Router } from 'express';
import type { Court } from '@courtside/shared';
import { prisma } from '../db/client.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { generateJoinCode } from '../match/tokens.js';

export const courtsRouter = Router();

interface CreateCourtBody {
  label: string;
  tournamentId: string;
}

function toCourt(row: {
  id: string;
  tournamentId: string | null;
  label: string;
  currentMatchId: string | null;
  tvCode: string;
}): Court {
  return {
    courtId: row.id,
    tournamentId: row.tournamentId,
    label: row.label,
    currentMatchId: row.currentMatchId,
    tvCode: row.tvCode,
  };
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
  if (typeof body.tournamentId !== 'string' || !body.tournamentId) {
    res.status(400).json({ error: 'Select a tournament before adding a court.' });
    return;
  }
  const tournament = await prisma.tournament.findUnique({ where: { id: body.tournamentId } });
  if (!tournament) {
    res.status(400).json({ error: 'Selected tournament was not found.' });
    return;
  }

  const court = await prisma.court.create({
    data: { label: body.label.trim(), tournamentId: body.tournamentId, tvCode: generateJoinCode() },
  });
  res.status(201).json(toCourt(court));
});

courtsRouter.get('/courts', adminAuth, async (req, res) => {
  const tournamentId = req.query.tournamentId;
  if (typeof tournamentId !== 'string' || !tournamentId) {
    res.status(400).json({ error: 'A tournament is required.' });
    return;
  }
  const courts = await prisma.court.findMany({
    where: { tournamentId },
    orderBy: { createdAt: 'asc' },
  });
  res.json(courts.map(toCourt));
});

courtsRouter.delete('/courts/:courtId', adminAuth, async (req, res) => {
  // Express only invokes this handler once ':courtId' matched a non-empty
  // path segment, so it's always present — the assertion is purely to
  // satisfy exactOptionalPropertyTypes on req.params' index signature.
  const courtId = req.params.courtId!;

  const court = await prisma.court.findUnique({ where: { id: courtId } });
  if (!court) {
    res.status(404).json({ error: 'Court not found.' });
    return;
  }

  const deleted = await prisma.court.delete({ where: { id: courtId } });
  res.json(toCourt(deleted));
});

// Public, unauthenticated: this is exactly what the code is for — a TV
// device that doesn't have the admin password types it in at /tv to find
// its court. Read-only and low-stakes, unlike the umpire code below.
courtsRouter.get('/courts/resolve/:code', async (req, res) => {
  const court = await prisma.court.findUnique({
    where: { tvCode: req.params.code.toUpperCase() },
  });
  if (!court) {
    res.status(404).json({ error: 'Court code not found.' });
    return;
  }
  res.json({ courtId: court.id });
});
