import type { NextFunction, RequestHandler } from 'express';

/**
 * Wrap an async route handler so a rejected promise reaches Express instead of
 * killing the process.
 *
 * Express 4 does not understand async handlers: it calls them, ignores the
 * promise they return, and never sees a rejection. Node then treats that as an
 * unhandled rejection and — since Node 15 — exits. So a single unexpected
 * database error in one request does not fail that request, it takes down the
 * whole server: every court's scoring stops, every socket drops, every TV goes
 * blank, mid-match.
 *
 * Observed for real: POST /api/matches with players missing their `side` got
 * past the route's own checks, Prisma rejected it, and the server exited with
 * the client seeing no response at all.
 *
 * Express 5 forwards rejections on its own and this wrapper becomes redundant —
 * harmless, but removable at that point.
 *
 * A route that reads `req.params` states their shape explicitly:
 *
 *     asyncRoute<{ courtId: string }>(async (req, res) => ...)
 *
 * Express normally infers that from the path literal, and passing a handler
 * through any wrapper loses it. Spelling it out documents what each route
 * takes, and keeps the params typed as present rather than `string | undefined`
 * — which is what an index-signature fallback would give under
 * noUncheckedIndexedAccess, adding guards for a case the router has already
 * ruled out.
 */
/* Generic in every parameter Express is, so the route-parameter types it
 * infers from a path literal ("/courts/code/:code" -> { code: string }) still
 * reach the handler through this wrapper. Pinning it to a bare RequestHandler
 * instead silently widens req.params and req.body back to their defaults. */
export function asyncRoute<
  P = Record<string, never>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = unknown,
  Locals extends Record<string, unknown> = Record<string, unknown>,
>(
  handler: RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> {
  return (req, res, next: NextFunction) => {
    // Promise.resolve rather than an async wrapper: a handler that throws
    // *synchronously* must be forwarded the same way, and this covers both.
    Promise.resolve(handler(req, res, next)).catch((reason: unknown) => {
      // Not `.catch(next)`. Express reads `next(undefined)` as "carry on to the
      // next handler", so a rejection with a falsy reason — `Promise.reject()`
      // with no argument, or a thrown null — would be swallowed and the request
      // would fall through to a 404 instead of erroring. Rare, but it fails
      // silently, which is the worst way for this particular safety net to fail.
      next(reason ?? new Error('Request handler rejected without a reason.'));
    });
  };
}
