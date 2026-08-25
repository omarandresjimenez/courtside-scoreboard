import type { Server, Socket } from 'socket.io';
import {
  SERVER_EVENTS,
  TV_EVENTS,
  UMPIRE_EVENTS,
  type AddPointPayload,
  type SubscribeCourtPayload,
  type UndoLastPointPayload,
} from '@courtside/shared';
import { prisma } from '../db/client.js';
import { loadMatchState } from '../match/replay.js';

function roomForMatch(matchId: string): string {
  return `match:${matchId}`;
}

/**
 * Wires up the real-time side of Set 07 / Set 08: the umpire link is
 * token-checked once at connect time, the socket is then only ever
 * trusted for the single matchId it authenticated against, and every
 * write re-derives the full match state from the event log before
 * broadcasting it — see @courtside/shared's deriveMatchState().
 *
 * ADD_POINT and UNDO_LAST_POINT are wired end-to-end below. START_SET,
 * RESUME_FROM_INTERVAL, RETIRE_MATCH, and the ADMIN_EVENTS (edit details,
 * edit scoring config, cancel, assign to court) are the next pass — see
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
      void withAuthorizedMatch(io, socket, payload.matchId, async () => {
        await prisma.scoreEvent.create({
          data: {
            matchId: payload.matchId,
            eventId: payload.eventId,
            type: 'POINT',
            side: payload.side,
            timestamp: BigInt(Date.now()),
          },
        });
      });
    });

    socket.on(UMPIRE_EVENTS.UNDO_LAST_POINT, (payload: UndoLastPointPayload) => {
      void withAuthorizedMatch(io, socket, payload.matchId, async () => {
        await prisma.scoreEvent.create({
          data: {
            matchId: payload.matchId,
            eventId: payload.eventId,
            type: 'UNDO_LAST_POINT',
            timestamp: BigInt(Date.now()),
          },
        });
      });
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
  if (state) io.to(roomForMatch(matchId)).emit(SERVER_EVENTS.MATCH_STATE, state);
}

async function sendCurrentState(socket: Socket, matchId: string): Promise<void> {
  const state = await loadMatchState(matchId);
  if (state) socket.emit(SERVER_EVENTS.MATCH_STATE, state);
  else socket.emit(SERVER_EVENTS.MATCH_NOT_FOUND, { matchId });
}
