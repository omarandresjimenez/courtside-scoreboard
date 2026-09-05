import { io, type Socket } from 'socket.io-client';
import {
  STREAM_EVENTS,
  type StreamPausedPayload,
  type StreamPeerEventPayload,
  type StreamSignalIncoming,
  type StreamSignalOutgoing,
} from '@courtside/shared';
import { LAN_ICE_SERVERS } from './ice-config.js';

/** STUN only — see LAN_ICE_SERVERS in ice-config.ts for why this path
 * deliberately does not list TURN. The internet path (firestore-signal.ts)
 * is the one that needs a relay. */
const ICE_SERVERS = LAN_ICE_SERVERS;

export interface BroadcasterHandle {
  setVideoEnabled: (enabled: boolean) => void;
  stop: () => void;
}

/** Real-time video via WebRTC instead of the old ~2 FPS JPEG-over-HTTP
 * relay: one RTCPeerConnection per viewer (a mesh — fine for the handful of
 * viewers a single court draws), signaled over Socket.io. The browser's own
 * encoder streams actual motion video at native frame rate. */
export function startBroadcasting(courtId: string, stream: MediaStream): BroadcasterHandle {
  const socket: Socket = io('/', {
    query: { role: 'stream-broadcaster', courtId },
    transports: ['websocket'],
  });
  const peers = new Map<string, RTCPeerConnection>();

  function createPeerFor(viewerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const payload: StreamSignalOutgoing = { targetId: viewerId, data: event.candidate.toJSON() };
      socket.emit(STREAM_EVENTS.ICE_CANDIDATE, payload);
    };
    peers.set(viewerId, pc);
    return pc;
  }

  socket.on(STREAM_EVENTS.VIEWER_JOINED, async ({ peerId }: StreamPeerEventPayload) => {
    const pc = createPeerFor(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const payload: StreamSignalOutgoing = { targetId: peerId, data: offer };
    socket.emit(STREAM_EVENTS.OFFER, payload);
  });

  socket.on(STREAM_EVENTS.ANSWER, async ({ fromId, data }: StreamSignalIncoming) => {
    await peers.get(fromId)?.setRemoteDescription(data as RTCSessionDescriptionInit);
  });

  socket.on(STREAM_EVENTS.ICE_CANDIDATE, ({ fromId, data }: StreamSignalIncoming) => {
    void peers
      .get(fromId)
      ?.addIceCandidate(data as RTCIceCandidateInit)
      .catch(() => {
        // A candidate can lose the race against the connection closing — safe to ignore.
      });
  });

  socket.on(STREAM_EVENTS.VIEWER_LEFT, ({ peerId }: StreamPeerEventPayload) => {
    peers.get(peerId)?.close();
    peers.delete(peerId);
  });

  return {
    setVideoEnabled(enabled) {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = enabled;
      });
      // Disabling the track keeps the connection up and just sends black
      // frames, so viewers have to be told explicitly (see STREAM_EVENTS.PAUSED).
      const payload: StreamPausedPayload = { paused: !enabled };
      socket.emit(STREAM_EVENTS.PAUSED, payload);
    },
    stop() {
      peers.forEach((pc) => pc.close());
      peers.clear();
      socket.disconnect();
    },
  };
}

export interface ViewerHandle {
  stop: () => void;
}

/** Viewer side of the mesh: waits for the broadcaster's offer, answers it,
 * and hands the resulting remote MediaStream back via onStream. */
export function startViewing(
  courtId: string,
  onStream: (stream: MediaStream | null) => void,
  onPaused?: (paused: boolean) => void,
): ViewerHandle {
  const socket: Socket = io('/', {
    query: { role: 'stream-viewer', courtId },
    transports: ['websocket'],
  });
  let pc: RTCPeerConnection | null = null;
  let broadcasterId: string | null = null;

  socket.on(STREAM_EVENTS.OFFER, async ({ fromId, data }: StreamSignalIncoming) => {
    pc?.close();
    broadcasterId = fromId;

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    connection.ontrack = (event) => onStream(event.streams[0] ?? null);
    connection.onicecandidate = (event) => {
      if (!event.candidate || !broadcasterId) return;
      const payload: StreamSignalOutgoing = {
        targetId: broadcasterId,
        data: event.candidate.toJSON(),
      };
      socket.emit(STREAM_EVENTS.ICE_CANDIDATE, payload);
    };
    pc = connection;

    await connection.setRemoteDescription(data as RTCSessionDescriptionInit);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    const payload: StreamSignalOutgoing = { targetId: fromId, data: answer };
    socket.emit(STREAM_EVENTS.ANSWER, payload);
  });

  socket.on(STREAM_EVENTS.ICE_CANDIDATE, ({ data }: StreamSignalIncoming) => {
    void pc?.addIceCandidate(data as RTCIceCandidateInit).catch(() => {
      // A candidate can lose the race against the connection closing — safe to ignore.
    });
  });

  socket.on(STREAM_EVENTS.PAUSED, ({ paused }: StreamPausedPayload) => {
    onPaused?.(paused);
  });

  socket.on(STREAM_EVENTS.BROADCASTER_LEFT, () => {
    pc?.close();
    pc = null;
    onStream(null);
    onPaused?.(false);
  });

  return {
    stop() {
      pc?.close();
      socket.disconnect();
    },
  };
}
