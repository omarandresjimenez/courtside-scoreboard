import type { Server, Socket } from 'socket.io';
import {
  STREAM_EVENTS,
  type StreamPausedPayload,
  type StreamPeerEventPayload,
  type StreamSignalOutgoing,
} from '@courtside/shared';

function roomForStream(courtId: string): string {
  return `stream:${courtId}`;
}

/** Called from the scoring socket (sockets/index.ts) the moment a match is
 * finalised, so the court's broadcaster (and any viewer) can react without
 * this module needing to know anything about matches itself. */
export function notifyStreamMatchFinalized(io: Server, courtId: string): void {
  io.to(roomForStream(courtId)).emit(STREAM_EVENTS.MATCH_FINALIZED);
}

/** Called from the scoring socket the moment a match starts, so a court
 * phone sitting in standby (see the 'stream-standby' role below) can start
 * transmitting itself. */
export function notifyStreamMatchStarted(io: Server, courtId: string): void {
  io.to(roomForStream(courtId)).emit(STREAM_EVENTS.MATCH_STARTED);
}

/** courtId -> the current broadcaster's socket id. Mesh WebRTC: the
 * broadcaster holds one RTCPeerConnection per viewer, this server only
 * relays signaling messages between them — see StreamBroadcast/StreamViewer
 * and packages/client/src/lib/webrtc-stream.ts. */
const broadcasterByCourtId = new Map<string, string>();

/** courtId -> whether its broadcaster is currently paused. Held server-side
 * rather than only forwarded live, so a viewer who opens the page *during* a
 * pause is told about it too instead of staring at black video. */
const pausedByCourtId = new Map<string, boolean>();

/** Registered alongside registerSocketHandlers — Socket.io supports multiple
 * 'connection' listeners, so this stays independent of the scoring wiring. */
export function registerStreamSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    const { role, courtId } = socket.handshake.query as Record<string, string | undefined>;
    if (!courtId) return;
    if (role !== 'stream-broadcaster' && role !== 'stream-viewer' && role !== 'stream-standby') {
      return;
    }

    const room = roomForStream(courtId);
    void socket.join(room);

    // A standby phone (idle, waiting for its match to start) only needs to
    // sit in the room to receive MATCH_STARTED/MATCH_FINALIZED — it isn't a
    // broadcaster or a WebRTC viewer, so none of the peer bookkeeping below
    // applies to it.
    if (role === 'stream-standby') return;

    if (role === 'stream-broadcaster') {
      broadcasterByCourtId.set(courtId, socket.id);
      // A fresh broadcaster always starts live; clear any stale paused flag
      // left behind by a previous one on this court.
      pausedByCourtId.delete(courtId);

      socket.on(STREAM_EVENTS.PAUSED, (payload: StreamPausedPayload) => {
        pausedByCourtId.set(courtId, payload.paused);
        socket.to(room).emit(STREAM_EVENTS.PAUSED, payload);
      });

      // Viewers who joined before this broadcaster did are already sitting
      // in the room — each still needs an offer, not just future joiners.
      const existingViewers = io.sockets.adapter.rooms.get(room);
      if (existingViewers) {
        for (const viewerId of existingViewers) {
          if (viewerId === socket.id) continue;
          const payload: StreamPeerEventPayload = { peerId: viewerId };
          socket.emit(STREAM_EVENTS.VIEWER_JOINED, payload);
        }
      }

      socket.on('disconnect', () => {
        // Only the *current* broadcaster's departure ends the stream. A phone
        // that drops wifi and reconnects briefly leaves two broadcaster
        // sockets on the court; when the stale one finally times out, an
        // unconditional notice here told every viewer the broadcast was over
        // and tore down their connections to the live one.
        if (broadcasterByCourtId.get(courtId) !== socket.id) return;
        broadcasterByCourtId.delete(courtId);
        pausedByCourtId.delete(courtId);
        socket.to(room).emit(STREAM_EVENTS.BROADCASTER_LEFT);
      });
    } else {
      const broadcasterId = broadcasterByCourtId.get(courtId);
      if (broadcasterId) {
        const payload: StreamPeerEventPayload = { peerId: socket.id };
        io.to(broadcasterId).emit(STREAM_EVENTS.VIEWER_JOINED, payload);
        if (pausedByCourtId.get(courtId)) {
          const paused: StreamPausedPayload = { paused: true };
          socket.emit(STREAM_EVENTS.PAUSED, paused);
        }
      }

      socket.on('disconnect', () => {
        const currentBroadcasterId = broadcasterByCourtId.get(courtId);
        if (currentBroadcasterId) {
          const payload: StreamPeerEventPayload = { peerId: socket.id };
          io.to(currentBroadcasterId).emit(STREAM_EVENTS.VIEWER_LEFT, payload);
        }
      });
    }

    const relay = (event: (typeof STREAM_EVENTS)[keyof typeof STREAM_EVENTS]) => {
      socket.on(event, (payload: StreamSignalOutgoing) => {
        io.to(payload.targetId).emit(event, { fromId: socket.id, data: payload.data });
      });
    };
    relay(STREAM_EVENTS.OFFER);
    relay(STREAM_EVENTS.ANSWER);
    relay(STREAM_EVENTS.ICE_CANDIDATE);
  });
}
