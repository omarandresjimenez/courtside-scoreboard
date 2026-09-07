import type { NextFunction, Request, Response } from 'express';

/**
 * Last stop for anything a route threw.
 *
 * Must be registered after every route (including the SPA fallback), and must
 * keep all four parameters — Express identifies error middleware by arity
 * alone, so dropping the unused `next` silently turns this back into ordinary
 * middleware that never runs.
 *
 * Answers rather than crashes. A failed request should fail; it should not end
 * the tournament. Pairs with asyncRoute(), which is what gets a rejected
 * promise here in the first place under Express 4.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('[server] unhandled error while serving a request:', error);

  // Something already started writing — most likely a streamed response. Only
  // Express can tidy that up, and trying to send a second set of headers here
  // would throw inside the error handler itself.
  if (res.headersSent) return;

  // Deliberately generic: an internal error message can carry a query, a file
  // path, or part of a credential, and this endpoint is reachable by anyone on
  // the venue LAN. The detail goes to the log above instead.
  res.status(500).json({ error: 'Something went wrong handling that request.' });
}
