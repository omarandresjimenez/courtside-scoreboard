import { io, type Socket } from 'socket.io-client';

export type SocketConnectionOptions =
  { role: 'umpire'; matchId: string; token: string } | { role: 'tv'; courtId: string };

/** One real-time connection per screen — see "Set 02 — Architecture". */
export function connectSocket(options: SocketConnectionOptions): Socket {
  return io('/', { query: options, transports: ['websocket'] });
}
