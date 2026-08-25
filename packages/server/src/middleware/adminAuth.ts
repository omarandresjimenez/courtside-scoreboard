import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * Single shared password for the whole admin app (Set 08). There's
 * typically one organizer device, so per-user accounts would be overkill —
 * this just stops a random person on the LAN from creating/cancelling
 * matches by guessing the admin URL.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-admin-password');
  if (provided !== config.adminPassword) {
    res.status(401).json({ error: 'Invalid admin password.' });
    return;
  }
  next();
}
