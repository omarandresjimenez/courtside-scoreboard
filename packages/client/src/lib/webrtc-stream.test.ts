import { STREAM_EVENTS } from '@courtside/shared';

type Handler = (payload?: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    on: jest.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    emit: jest.fn(),
    disconnect: jest.fn(),
    fire: async (event: string, payload?: unknown) => {
      await handlers.get(event)?.(payload);
    },
    has: (event: string) => handlers.has(event),
  };
}

let fakeSocket = makeFakeSocket();
const mockIo = jest.fn(() => fakeSocket);
jest.mock('socket.io-client', () => ({ io: mockIo }));

import { startBroadcasting, startViewing, watchForMatchStart } from './webrtc-stream.js';

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = 'new';
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  close = jest.fn();
  addTrack = jest.fn();
  createOffer = jest.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
  createAnswer = jest.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' }));
  setLocalDescription = jest.fn(async () => undefined);
  setRemoteDescription = jest.fn(async () => undefined);
  addIceCandidate = jest.fn(async () => undefined);
  constructor(public config: unknown) {
    FakePeerConnection.instances.push(this);
  }
}

const videoTrack = { kind: 'video', enabled: true };
const stream = {
  getTracks: () => [videoTrack],
  getVideoTracks: () => [videoTrack],
} as unknown as MediaStream;

beforeEach(() => {
  fakeSocket = makeFakeSocket();
  mockIo.mockClear();
  FakePeerConnection.instances = [];
  videoTrack.enabled = true;
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
});

const candidate = { toJSON: () => ({ candidate: 'a' }) };

describe('startBroadcasting', () => {
  it('connects as a stream broadcaster for the court', () => {
    startBroadcasting('court1', stream);
    expect(mockIo).toHaveBeenCalledWith('/', {
      query: { role: 'stream-broadcaster', courtId: 'court1' },
      transports: ['websocket'],
    });
  });

  it('offers to a joining viewer and publishes its tracks', async () => {
    startBroadcasting('court1', stream);
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });

    const pc = FakePeerConnection.instances[0]!;
    expect(pc.addTrack).toHaveBeenCalledWith(videoTrack, stream);
    expect(fakeSocket.emit).toHaveBeenCalledWith(STREAM_EVENTS.OFFER, {
      targetId: 'v1',
      data: { type: 'offer', sdp: 'offer-sdp' },
    });
  });

  it('forwards its ICE candidates to the viewer that prompted them', async () => {
    startBroadcasting('court1', stream);
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });

    FakePeerConnection.instances[0]!.onicecandidate?.({ candidate });

    expect(fakeSocket.emit).toHaveBeenCalledWith(STREAM_EVENTS.ICE_CANDIDATE, {
      targetId: 'v1',
      data: { candidate: 'a' },
    });
  });

  it('ignores the end-of-candidates signal', async () => {
    startBroadcasting('court1', stream);
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });
    fakeSocket.emit.mockClear();

    FakePeerConnection.instances[0]!.onicecandidate?.({ candidate: null });

    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });

  it("applies the viewer's answer to that viewer's connection", async () => {
    startBroadcasting('court1', stream);
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });
    await fakeSocket.fire(STREAM_EVENTS.ANSWER, { fromId: 'v1', data: { type: 'answer' } });

    expect(FakePeerConnection.instances[0]!.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
    });
  });

  it('tolerates an answer from an unknown peer', async () => {
    startBroadcasting('court1', stream);
    await expect(
      fakeSocket.fire(STREAM_EVENTS.ANSWER, { fromId: 'ghost', data: {} }),
    ).resolves.toBeUndefined();
  });

  it('closes the connection when a viewer leaves', async () => {
    startBroadcasting('court1', stream);
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_LEFT, { peerId: 'v1' });

    expect(FakePeerConnection.instances[0]!.close).toHaveBeenCalled();
  });

  it('adds a viewer ICE candidate, swallowing a late arrival', async () => {
    startBroadcasting('court1', stream);
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });
    const pc = FakePeerConnection.instances[0]!;
    pc.addIceCandidate.mockRejectedValueOnce(new Error('closed'));

    await fakeSocket.fire(STREAM_EVENTS.ICE_CANDIDATE, { fromId: 'v1', data: { candidate: 'x' } });

    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'x' });
  });

  it('toggling video tells viewers explicitly, because a disabled track still sends frames', () => {
    const handle = startBroadcasting('court1', stream);

    handle.setVideoEnabled(false);
    expect(videoTrack.enabled).toBe(false);
    expect(fakeSocket.emit).toHaveBeenCalledWith(STREAM_EVENTS.PAUSED, { paused: true });

    handle.setVideoEnabled(true);
    expect(videoTrack.enabled).toBe(true);
    expect(fakeSocket.emit).toHaveBeenCalledWith(STREAM_EVENTS.PAUSED, { paused: false });
  });

  it('tells the caller when the server reports the match finalised', async () => {
    const onMatchFinalized = jest.fn();
    startBroadcasting('court1', stream, onMatchFinalized);

    await fakeSocket.fire(STREAM_EVENTS.MATCH_FINALIZED);

    expect(onMatchFinalized).toHaveBeenCalled();
  });

  it('does not throw when finalised with no callback given', async () => {
    startBroadcasting('court1', stream);

    await expect(fakeSocket.fire(STREAM_EVENTS.MATCH_FINALIZED)).resolves.toBeUndefined();
  });

  it('closes every peer and the socket on stop', async () => {
    const handle = startBroadcasting('court1', stream);
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v1' });
    await fakeSocket.fire(STREAM_EVENTS.VIEWER_JOINED, { peerId: 'v2' });

    handle.stop();

    expect(FakePeerConnection.instances.every((pc) => pc.close.mock.calls.length > 0)).toBe(true);
    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });
});

describe('startViewing', () => {
  it('connects as a stream viewer for the court', () => {
    startViewing('court1', jest.fn());
    expect(mockIo).toHaveBeenCalledWith('/', {
      query: { role: 'stream-viewer', courtId: 'court1' },
      transports: ['websocket'],
    });
  });

  it('answers the broadcaster offer', async () => {
    startViewing('court1', jest.fn());
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: { type: 'offer' } });

    const pc = FakePeerConnection.instances[0]!;
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer' });
    expect(fakeSocket.emit).toHaveBeenCalledWith(STREAM_EVENTS.ANSWER, {
      targetId: 'b1',
      data: { type: 'answer', sdp: 'answer-sdp' },
    });
  });

  it('hands the remote stream to the caller', async () => {
    const onStream = jest.fn();
    startViewing('court1', onStream);
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });

    const remote = {} as MediaStream;
    FakePeerConnection.instances[0]!.ontrack?.({ streams: [remote] });

    expect(onStream).toHaveBeenCalledWith(remote);
  });

  it('reports null when a track arrives with no stream attached', async () => {
    const onStream = jest.fn();
    startViewing('court1', onStream);
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });

    FakePeerConnection.instances[0]!.ontrack?.({ streams: [] });

    expect(onStream).toHaveBeenCalledWith(null);
  });

  it('sends its ICE candidates back to the broadcaster', async () => {
    startViewing('court1', jest.fn());
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });

    FakePeerConnection.instances[0]!.onicecandidate?.({ candidate });

    expect(fakeSocket.emit).toHaveBeenCalledWith(STREAM_EVENTS.ICE_CANDIDATE, {
      targetId: 'b1',
      data: { candidate: 'a' },
    });
  });

  it('ignores the end-of-candidates signal', async () => {
    startViewing('court1', jest.fn());
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });
    fakeSocket.emit.mockClear();

    FakePeerConnection.instances[0]!.onicecandidate?.({ candidate: null });

    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });

  it('replaces the previous connection when a fresh offer arrives', async () => {
    startViewing('court1', jest.fn());
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0]!.close).toHaveBeenCalled();
  });

  it('relays the paused flag, since a paused track still delivers black frames', async () => {
    const onPaused = jest.fn();
    startViewing('court1', jest.fn(), onPaused);

    await fakeSocket.fire(STREAM_EVENTS.PAUSED, { paused: true });

    expect(onPaused).toHaveBeenCalledWith(true);
  });

  it('clears the stream and the paused flag when the broadcaster leaves', async () => {
    const onStream = jest.fn();
    const onPaused = jest.fn();
    startViewing('court1', onStream, onPaused);
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });

    await fakeSocket.fire(STREAM_EVENTS.BROADCASTER_LEFT);

    expect(FakePeerConnection.instances[0]!.close).toHaveBeenCalled();
    expect(onStream).toHaveBeenLastCalledWith(null);
    expect(onPaused).toHaveBeenLastCalledWith(false);
  });

  it('adds broadcaster ICE candidates, swallowing a late arrival', async () => {
    startViewing('court1', jest.fn());
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });
    const pc = FakePeerConnection.instances[0]!;
    pc.addIceCandidate.mockRejectedValueOnce(new Error('closed'));

    await fakeSocket.fire(STREAM_EVENTS.ICE_CANDIDATE, { data: { candidate: 'x' } });

    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'x' });
  });

  it('tolerates a candidate arriving before any offer', async () => {
    startViewing('court1', jest.fn());
    await expect(
      fakeSocket.fire(STREAM_EVENTS.ICE_CANDIDATE, { data: {} }),
    ).resolves.toBeUndefined();
  });

  it('closes the connection and the socket on stop', async () => {
    const handle = startViewing('court1', jest.fn());
    await fakeSocket.fire(STREAM_EVENTS.OFFER, { fromId: 'b1', data: {} });

    handle.stop();

    expect(FakePeerConnection.instances[0]!.close).toHaveBeenCalled();
    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });
});

describe('watchForMatchStart', () => {
  it('connects as a standby listener for the court, opening no peer connection', () => {
    watchForMatchStart('court1', jest.fn());
    expect(mockIo).toHaveBeenCalledWith('/', {
      query: { role: 'stream-standby', courtId: 'court1' },
      transports: ['websocket'],
    });
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it('tells the caller when the umpire starts the match', async () => {
    const onMatchStarted = jest.fn();
    watchForMatchStart('court1', onMatchStarted);

    await fakeSocket.fire(STREAM_EVENTS.MATCH_STARTED);

    expect(onMatchStarted).toHaveBeenCalled();
  });

  it('disconnects the socket on stop', () => {
    const handle = watchForMatchStart('court1', jest.fn());

    handle.stop();

    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });
});
