import type { Server, Socket } from 'socket.io';
import {
  SERVER_EVENTS,
  TV_EVENTS,
  UMPIRE_EVENTS,
  type AddPointPayload,
  type ResumeFromIntervalPayload,
  type StartSetPayload,
  type SubscribeCourtPayload,
  type UndoLastPointPayload,
} from '@courtside/shared';
import { Prisma } from '../../generated/prisma/index.js';
import { prisma } from '../db/client.js';
import { loadMatchState } from '../match/replay.js';

function roomForMatch(matchId: string): string {
  return `match:${matchId}`;
}

export function roomForCourt(courtId: string): string {
  return `court:${courtId}`;
}

/**
 * ScoreEvent.eventId's doc comment promises that replaying a queued offline
 * umpire action twice is safe — but without this, a retried eventId hits
 * SQLite's unique constraint, throws inside an un-awaited `void`-wrapped
 * handler, and crashes the whole process as an unhandled rejection, taking
 * every court down mid-match. A duplicate means this exact action already
 * landed, so it's a no-op, not an error.
 */
export async function createScoreEventIdempotent(
  data: Parameters<typeof prisma.scoreEvent.create>[0]['data'],
): Promise<void> {
  try {
    await prisma.scoreEvent.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }
}

/**
 * Wires up the real-time side of Set 07 / Set 08: the umpire link is
 * token-checked once at connect time, the socket is then only ever
 * trusted for the single matchId it authenticated against, and every
 * write re-derives the full match state from the event log before
 * broadcasting it — see @courtside/shared's deriveMatchState().
 *
 * ADD_POINT, UNDO_LAST_POINT, and RESUME_FROM_INTERVAL are wired end-to-end
 * below. START_SET, RETIRE_MATCH, and the ADMIN_EVENTS (edit details, edit
 * scoring config, cancel, assign to court) are the next pass — see
 * "Set 09 — Admin & tournament dashboard" in the design doc.
 */
export function registerSocketHandlers(io: Server): void {
  io.on('connection', (socket) => {
    const { role, matchId, token, courtId } = socket.handshake.query as Record<
      string,
      string | undefined
    >;

    if (role === 'umpire') void handleUmpireConnection(socket, matchId, token);
    else if (role === 'tv' && courtId) void joinCourt(socket, courtId);

    socket.on(TV_EVENTS.SUBSCRIBE_COURT, (payload: SubscribeCourtPayload) => {
      void joinCourt(socket, payload.courtId);
    });

    socket.on(UMPIRE_EVENTS.ADD_POINT, (payload: AddPointPayload) => {
      void addPoint(io, socket, payload);
    });

    socket.on(UMPIRE_EVENTS.START_SET, (payload: StartSetPayload) => {
      void startSet(io, socket, payload);
    });

    socket.on(UMPIRE_EVENTS.UNDO_LAST_POINT, (payload: UndoLastPointPayload) => {
      void withAuthorizedMatch(io, socket, payload.matchId, () =>
        createScoreEventIdempotent({
          matchId: payload.matchId,
          eventId: payload.eventId,
          type: 'UNDO_LAST_POINT',
          timestamp: BigInt(Date.now()),
        }),
      );
    });

    socket.on(UMPIRE_EVENTS.RESUME_FROM_INTERVAL, (payload: ResumeFromIntervalPayload) => {
      void withAuthorizedMatch(io, socket, payload.matchId, () =>
        createScoreEventIdempotent({
          matchId: payload.matchId,
          eventId: payload.eventId,
          type: 'RESUME_INTERVAL',
          timestamp: BigInt(Date.now()),
        }),
      );
    });
  });
}

async function startSet(io: Server, socket: Socket, payload: StartSetPayload): Promise<void> {
  await withAuthorizedMatch(io, socket, payload.matchId, async () => {
    const state = await loadMatchState(payload.matchId);
    if (!state) return;
    if (state.derived.serve.servingSide) {
      socket.emit(SERVER_EVENTS.ERROR, { message: 'Match service has already been set.' });
      return;
    }
    const firstServer = state.match.players.find(
      (player) => player.playerId === payload.firstServerPlayerId,
    );
    if (!firstServer || firstServer.side !== payload.firstServerSide) {
      socket.emit(SERVER_EVENTS.ERROR, { message: 'Choose a first server from the serving side.' });
      return;
    }
    if (state.match.matchType === 'doubles') {
      const positions = payload.courtPositions;
      const hasValidPositions = (side: 'A' | 'B') => {
        const players = state.match.players.filter((player) => player.side === side);
        const layout = positions?.[side];
        return (
          players.length === 2 &&
          layout !== undefined &&
          layout.right !== layout.left &&
          players.some((player) => player.playerId === layout.right) &&
          players.some((player) => player.playerId === layout.left)
        );
      };
      if (
        !hasValidPositions('A') ||
        !hasValidPositions('B') ||
        positions?.[payload.firstServerSide]?.right !== payload.firstServerPlayerId
      ) {
        socket.emit(SERVER_EVENTS.ERROR, {
          message:
            'Set both doubles court positions and choose the right-court player to serve first.',
        });
        return;
      }
    }
    await createScoreEventIdempotent({
      matchId: payload.matchId,
      eventId: payload.eventId,
      type: 'START_SET',
      payload: JSON.stringify({
        firstServerSide: payload.firstServerSide,
        firstServerPlayerId: payload.firstServerPlayerId,
        courtPositions: payload.courtPositions,
      }),
      timestamp: BigInt(Date.now()),
    });
  });
}

async function addPoint(io: Server, socket: Socket, payload: AddPointPayload): Promise<void> {
  await withAuthorizedMatch(io, socket, payload.matchId, async () => {
    const state = await loadMatchState(payload.matchId);
    if (!state?.derived.serve.servingSide) {
      socket.emit(SERVER_EVENTS.ERROR, { message: 'Set the opening server before scoring.' });
      return;
    }
    await createScoreEventIdempotent({
      matchId: payload.matchId,
      eventId: payload.eventId,
      type: 'POINT',
      side: payload.side,
      timestamp: BigInt(Date.now()),
    });
  });
}

async function handleUmpireConnection(
  socket: Socket,
  matchId?: string,
  token?: string,
): Promise<void> {
  if (!matchId || !token) {
    socket.emit(SERVER_EVENTS.ERROR, { message: 'Missing matchId or token.' });
    socket.disconnect();
    return;
  }
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match || match.umpireToken !== token) {
    socket.emit(SERVER_EVENTS.ERROR, { message: 'Invalid umpire token.' });
    socket.disconnect();
    return;
  }
  socket.data.authorizedMatchId = matchId;
  await socket.join(roomForMatch(matchId));
  await sendCurrentState(socket, matchId);
}

async function joinCourt(socket: Socket, courtId: string): Promise<void> {
  const court = await prisma.court.findUnique({ where: { id: courtId } });
  if (!court?.currentMatchId) {
    socket.emit(SERVER_EVENTS.MATCH_NOT_FOUND, { courtId });
    return;
  }
  await socket.join(roomForCourt(courtId));
  await socket.join(roomForMatch(court.currentMatchId));
  await sendCurrentState(socket, court.currentMatchId);
}

async function withAuthorizedMatch(
  io: Server,
  socket: Socket,
  matchId: string,
  action: () => Promise<void>,
): Promise<void> {
  if (socket.data.authorizedMatchId !== matchId) {
    socket.emit(SERVER_EVENTS.ERROR, { message: 'Not authorized for this match.' });
    return;
  }
  await action();
  const state = await loadMatchState(matchId);
  if (!state) return;

  if (state.derived.matchWinner && state.match.status !== 'COMPLETED') {
    await prisma.match.update({
      where: { id: matchId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  } else if (state.derived.serve.servingSide && state.match.status === 'CREATED') {
    await prisma.match.update({
      where: { id: matchId },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
  } else if (!state.derived.matchWinner && state.match.status === 'COMPLETED') {
    await prisma.match.update({
      where: { id: matchId },
      data: { status: 'IN_PROGRESS', completedAt: null },
    });
  }

  const refreshedState = await loadMatchState(matchId);
  if (refreshedState) io.to(roomForMatch(matchId)).emit(SERVER_EVENTS.MATCH_STATE, refreshedState);
}

async function sendCurrentState(socket: Socket, matchId: string): Promise<void> {
  const state = await loadMatchState(matchId);
  if (state) socket.emit(SERVER_EVENTS.MATCH_STATE, state);
  else socket.emit(SERVER_EVENTS.MATCH_NOT_FOUND, { matchId });
}
