import { STREAM_EVENTS } from '@courtside/shared';
import { registerStreamSocketHandlers } from './stream.js';

type Handler = (payload?: unknown) => void;

interface FakeSocket {
  id: string;
  handshake: { query: Record<string, string | undefined> };
  join: jest.Mock;
  emit: jest.Mock;
  to: jest.Mock;
  on: jest.Mock;
  roomEmit: jest.Mock;
  fire: (event: string, payload?: unknown) => void;
}

function makeSocket(id: string, query: Record<string, string | undefined>): FakeSocket {
  const handlers = new Map<string, Handler[]>();
  const roomEmit = jest.fn();
  return {
    id,
    handshake: { query },
    join: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: roomEmit })),
    on: jest.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    roomEmit,
    fire: (event, payload) => handlers.get(event)?.forEach((h) => h(payload)),
  };
}

function makeIo() {
  const rooms = new Map<string, Set<string>>();
  const targetEmit = jest.fn();
  let connectionHandler: (socket: FakeSocket) => void = () => {};
  return {
    rooms,
    targetEmit,
    sockets: { adapter: { rooms } },
    to: jest.fn(() => ({ emit: targetEmit })),
    on: jest.fn((_event: string, handler: (socket: FakeSocket) => void) => {
      connectionHandler = handler;
    }),
    connect: (socket: FakeSocket) => connectionHandler(socket),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const register = (io: ReturnType<typeof makeIo>) => registerStreamSocketHandlers(io as any);

const COURT = 'court1';
const ROOM = `stream:${COURT}`;

function connectBroadcaster(io: ReturnType<typeof makeIo>, id = 'b1') {
  const socket = makeSocket(id, { role: 'stream-broadcaster', courtId: COURT });
  io.connect(socket);
  return socket;
}

function connectViewer(io: ReturnType<typeof makeIo>, id = 'v1') {
  const socket = makeSocket(id, { role: 'stream-viewer', courtId: COURT });
  io.connect(socket);
  return socket;
}

let io: ReturnType<typeof makeIo>;

beforeEach(() => {
  io = makeIo();
  register(io);
  // Each test starts from a clean court; module state persists between them.
  const stale = makeSocket('cleanup', { role: 'stream-broadcaster', courtId: COURT });
  io.connect(stale);
  stale.fire('disconnect');
  io.targetEmit.mockClear();
});

describe('registerStreamSocketHandlers', () => {
  it('ignores a connection with no court id', () => {
    const socket = makeSocket('x', { role: 'stream-viewer' });
    io.connect(socket);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('ignores roles that are not part of streaming', () => {
    const socket = makeSocket('x', { role: 'umpire', courtId: COURT });
    io.connect(socket);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('puts both roles in the court room', () => {
    expect(connectBroadcaster(io).join).toHaveBeenCalledWith(ROOM);
    expect(connectViewer(io).join).toHaveBeenCalledWith(ROOM);
  });

  it('tells the broadcaster about a viewer that arrives later', () => {
    connectBroadcaster(io, 'b1');
    connectViewer(io, 'v1');

    expect(io.to).toHaveBeenCalledWith('b1');
    expect(io.targetEmit).toHaveBeenCalledWith(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });
  });

  it('offers to viewers that were already waiting before it connected', () => {
    io.rooms.set(ROOM, new Set(['v1', 'v2', 'b1']));
    const broadcaster = connectBroadcaster(io, 'b1');

    expect(broadcaster.emit).toHaveBeenCalledWith(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });
    expect(broadcaster.emit).toHaveBeenCalledWith(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v2' });
    // Never to itself.
    expect(broadcaster.emit).not.toHaveBeenCalledWith(STREAM_EVENTS.VIEWER_JOINED, {
      peerId: 'b1',
    });
    io.rooms.delete(ROOM);
  });

  it('relays offer, answer and ICE to the addressed peer only', () => {
    const broadcaster = connectBroadcaster(io, 'b1');

    broadcaster.fire(STREAM_EVENTS.OFFER, { targetId: 'v1', data: { type: 'offer' } });
    expect(io.to).toHaveBeenCalledWith('v1');
    expect(io.targetEmit).toHaveBeenCalledWith(STREAM_EVENTS.OFFER, {
      fromId: 'b1',
      data: { type: 'offer' },
    });

    broadcaster.fire(STREAM_EVENTS.ICE_CANDIDATE, { targetId: 'v1', data: { candidate: 'a' } });
    expect(io.targetEmit).toHaveBeenCalledWith(STREAM_EVENTS.ICE_CANDIDATE, {
      fromId: 'b1',
      data: { candidate: 'a' },
    });
  });

  it('broadcasts a pause to the room', () => {
    const broadcaster = connectBroadcaster(io);
    broadcaster.fire(STREAM_EVENTS.PAUSED, { paused: true });

    expect(broadcaster.to).toHaveBeenCalledWith(ROOM);
    expect(broadcaster.roomEmit).toHaveBeenCalledWith(STREAM_EVENTS.PAUSED, { paused: true });
  });

  it('tells a viewer that joins mid-pause, who would otherwise just see black', () => {
    const broadcaster = connectBroadcaster(io);
    broadcaster.fire(STREAM_EVENTS.PAUSED, { paused: true });

    const viewer = connectViewer(io, 'v9');

    expect(viewer.emit).toHaveBeenCalledWith(STREAM_EVENTS.PAUSED, { paused: true });
  });

  it('does not claim a pause once the broadcaster has resumed', () => {
    const broadcaster = connectBroadcaster(io);
    broadcaster.fire(STREAM_EVENTS.PAUSED, { paused: true });
    broadcaster.fire(STREAM_EVENTS.PAUSED, { paused: false });

    const viewer = connectViewer(io, 'v9');

    expect(viewer.emit).not.toHaveBeenCalledWith(STREAM_EVENTS.PAUSED, { paused: true });
  });

  it('starts a replacement broadcaster live, clearing the old paused flag', () => {
    const first = connectBroadcaster(io, 'b1');
    first.fire(STREAM_EVENTS.PAUSED, { paused: true });

    connectBroadcaster(io, 'b2');
    const viewer = connectViewer(io, 'v9');

    expect(viewer.emit).not.toHaveBeenCalledWith(STREAM_EVENTS.PAUSED, { paused: true });
  });

  it('tells viewers when the live broadcaster leaves', () => {
    const broadcaster = connectBroadcaster(io, 'b1');
    broadcaster.fire('disconnect');

    expect(broadcaster.roomEmit).toHaveBeenCalledWith(STREAM_EVENTS.BROADCASTER_LEFT);
  });

  it('does not end the stream when a superseded broadcaster socket times out', () => {
    // A phone that drops wifi and reconnects leaves the old socket lingering.
    const stale = connectBroadcaster(io, 'b1');
    connectBroadcaster(io, 'b2');

    stale.fire('disconnect');

    // Viewers are mid-stream with b2 — they must not be told it ended.
    expect(stale.roomEmit).not.toHaveBeenCalledWith(STREAM_EVENTS.BROADCASTER_LEFT);
  });

  it('keeps serving viewers from the replacement after the stale socket goes', () => {
    const stale = connectBroadcaster(io, 'b1');
    connectBroadcaster(io, 'b2');
    stale.fire('disconnect');

    io.targetEmit.mockClear();
    connectViewer(io, 'v3');

    expect(io.to).toHaveBeenCalledWith('b2');
    expect(io.targetEmit).toHaveBeenCalledWith(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v3' });
  });

  it('tells the broadcaster when a viewer leaves so it can free the peer', () => {
    connectBroadcaster(io, 'b1');
    const viewer = connectViewer(io, 'v1');
    io.targetEmit.mockClear();

    viewer.fire('disconnect');

    expect(io.targetEmit).toHaveBeenCalledWith(STREAM_EVENTS.VIEWER_LEFT, { peerId: 'v1' });
  });

  it('handles a viewer arriving and leaving with no broadcaster present', () => {
    const viewer = connectViewer(io, 'v1');
    io.targetEmit.mockClear();

    expect(() => viewer.fire('disconnect')).not.toThrow();
    expect(io.targetEmit).not.toHaveBeenCalled();
  });
});
