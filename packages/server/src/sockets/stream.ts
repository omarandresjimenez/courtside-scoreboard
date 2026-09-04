import type { Server, Socket } from 'socket.io';
import {
  STREAM_EVENTS,
  type StreamPeerEventPayload,
  type StreamSignalOutgoing,
} from '@courtside/shared';

function roomForStream(courtId: string): string {
  return `stream:${courtId}`;
}

/** courtId -> the current broadcaster's socket id. Mesh WebRTC: the
 * broadcaster holds one RTCPeerConnection per viewer, this server only
 * relays signaling messages between them — see StreamBroadcast/StreamViewer
 * and packages/client/src/lib/webrtc-stream.ts. */
const broadcasterByCourtId = new Map<string, string>();

/** Registered alongside registerSocketHandlers — Socket.io supports multiple
 * 'connection' listeners, so this stays independent of the scoring wiring. */
export function registerStreamSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    const { role, courtId } = socket.handshake.query as Record<string, string | undefined>;
    if (!courtId) return;
    if (role !== 'stream-broadcaster' && role !== 'stream-viewer') return;

    const room = roomForStream(courtId);
    void socket.join(room);

    if (role === 'stream-broadcaster') {
      broadcasterByCourtId.set(courtId, socket.id);

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
        if (broadcasterByCourtId.get(courtId) === socket.id) broadcasterByCourtId.delete(courtId);
        socket.to(room).emit(STREAM_EVENTS.BROADCASTER_LEFT);
      });
    } else {
      const broadcasterId = broadcasterByCourtId.get(courtId);
      if (broadcasterId) {
        const payload: StreamPeerEventPayload = { peerId: socket.id };
        io.to(broadcasterId).emit(STREAM_EVENTS.VIEWER_JOINED, payload);
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
