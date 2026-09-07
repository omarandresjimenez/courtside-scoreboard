import { publishViaWhip } from './whip-client.js';

const PUBLISH_URL = 'https://customer-x.cloudflarestream.com/secret/webRTC/publish';

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { sdp: string } | null = { sdp: 'gathered-offer-sdp' };
  onconnectionstatechange: (() => void) | null = null;
  transceivers: Array<{ track: unknown; init: unknown }> = [];
  listeners = new Map<string, Set<() => void>>();

  close = jest.fn();
  createOffer = jest.fn(async () => ({ type: 'offer', sdp: 'raw-offer-sdp' }));
  setLocalDescription = jest.fn(async () => undefined);
  setRemoteDescription = jest.fn(async () => undefined);
  addTransceiver = jest.fn((track: unknown, init: unknown) => {
    this.transceivers.push({ track, init });
  });

  addEventListener = jest.fn((event: string, handler: () => void) => {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(handler);
  });
  removeEventListener = jest.fn((event: string, handler: () => void) => {
    this.listeners.get(event)?.delete(handler);
  });

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  /** Drive a state change the way the browser would. */
  enter(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  fire(event: string) {
    this.listeners.get(event)?.forEach((handler) => handler());
  }
}

const videoTrack = { kind: 'video' };
const stream = { getTracks: () => [videoTrack] } as unknown as MediaStream;

let fetchMock: jest.Mock;

/** A Cloudflare-shaped WHIP response. */
function whipAnswer(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 201,
    text: async () => 'answer-sdp',
    headers: { get: (name: string) => (name === 'Location' ? '/session/abc' : null) },
    ...overrides,
  };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
  fetchMock = jest.fn(async () => whipAnswer());
  (globalThis as Record<string, unknown>).fetch = fetchMock;
});

afterEach(() => jest.restoreAllMocks());

const peer = () => FakePeerConnection.instances[0] as FakePeerConnection;

/**
 * Let publishViaWhip work through createOffer and setLocalDescription. Both
 * are awaited before ICE gathering is waited on, so a single microtask tick
 * lands before the listener and the timer this file drives even exist.
 */
async function flush(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

/** A peer whose ICE gathering is still in progress. */
function stalledGathering(): void {
  FakePeerConnection.instances = [];
  (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
    override iceGatheringState = 'gathering';
  };
}

describe('publishViaWhip', () => {
  it('offers every track as sendonly, which Cloudflare requires', async () => {
    await publishViaWhip(PUBLISH_URL, stream);

    expect(peer().transceivers).toEqual([{ track: videoTrack, init: { direction: 'sendonly' } }]);
  });

  it('POSTs the offer as application/sdp', async () => {
    await publishViaWhip(PUBLISH_URL, stream);

    expect(fetchMock).toHaveBeenCalledWith(PUBLISH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'gathered-offer-sdp',
    });
  });

  it('sends the gathered offer, not the one createOffer returned', async () => {
    await publishViaWhip(PUBLISH_URL, stream);

    // localDescription carries the ICE candidates collected after
    // setLocalDescription; the original offer does not.
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('gathered-offer-sdp');
  });

  it('applies the SDP answer from the response body', async () => {
    await publishViaWhip(PUBLISH_URL, stream);

    expect(peer().setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'answer-sdp',
    });
  });

  it('publishes anyway when ICE gathering never completes', async () => {
    jest.useFakeTimers();
    stalledGathering();

    const publishing = publishViaWhip(PUBLISH_URL, stream);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    await publishing;

    // A stalled gather must not strand a live camera transmitting to nothing.
    expect(fetchMock).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('stops waiting as soon as gathering completes', async () => {
    jest.useFakeTimers();
    stalledGathering();

    const publishing = publishViaWhip(PUBLISH_URL, stream);
    await flush();

    const pc = peer();
    pc.iceGatheringState = 'complete';
    pc.fire('icegatheringstatechange');
    await publishing;

    expect(fetchMock).toHaveBeenCalled();
    // The listener is detached, so a later event cannot resolve a dead promise.
    expect(pc.removeEventListener).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('rejects when Cloudflare refuses the offer', async () => {
    fetchMock.mockResolvedValue(whipAnswer({ ok: false, status: 404 }));

    // The caller falls back to the peer mesh on this, so it must not resolve.
    await expect(publishViaWhip(PUBLISH_URL, stream)).rejects.toThrow('HTTP 404');
  });

  it('closes the peer when publishing fails, rather than leaking the camera', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(publishViaWhip(PUBLISH_URL, stream)).rejects.toThrow('network down');
    expect(peer().close).toHaveBeenCalled();
  });

  it('rejects when the browser produces no SDP at all', async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      override localDescription = null;
      // No sdp at all — the shape a browser produces when offer creation
      // degenerates, which must not be posted as an empty body.
      override createOffer = jest.fn(async () => ({ type: 'offer', sdp: '' }));
    };
    FakePeerConnection.instances = [];

    await expect(publishViaWhip(PUBLISH_URL, stream)).rejects.toThrow('no SDP offer');
  });

  it('deletes the session on stop, resolving Location against the endpoint', async () => {
    const session = await publishViaWhip(PUBLISH_URL, stream);
    fetchMock.mockClear();

    session.stop();

    expect(peer().close).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('https://customer-x.cloudflarestream.com/session/abc', {
      method: 'DELETE',
      keepalive: true,
    });
  });

  it('still closes the peer when Cloudflare returned no Location header', async () => {
    fetchMock.mockResolvedValue(whipAnswer({ headers: { get: () => null } }));
    const session = await publishViaWhip(PUBLISH_URL, stream);
    fetchMock.mockClear();

    session.stop();

    expect(peer().close).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw when the session DELETE fails', async () => {
    const session = await publishViaWhip(PUBLISH_URL, stream);
    fetchMock.mockRejectedValue(new Error('offline'));

    // stop() commonly runs as the tab is closing; the request is best effort.
    expect(() => session.stop()).not.toThrow();
    await Promise.resolve();
  });

  it('reports a dropped upload so the caller can re-publish', async () => {
    const onConnectionLost = jest.fn();
    await publishViaWhip(PUBLISH_URL, stream, { onConnectionLost });

    peer().enter('failed');

    expect(onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it('reports a disconnect as a loss too', async () => {
    const onConnectionLost = jest.fn();
    await publishViaWhip(PUBLISH_URL, stream, { onConnectionLost });

    peer().enter('disconnected');

    expect(onConnectionLost).toHaveBeenCalled();
  });

  it('reports a loss only once, however many times the state changes', async () => {
    const onConnectionLost = jest.fn();
    await publishViaWhip(PUBLISH_URL, stream, { onConnectionLost });

    peer().enter('disconnected');
    peer().enter('failed');

    // The caller tears the session down on the first report; a second would
    // schedule a duplicate reconnect against a session that no longer exists.
    expect(onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it('does not report a loss the caller itself caused by stopping', async () => {
    const onConnectionLost = jest.fn();
    const session = await publishViaWhip(PUBLISH_URL, stream, { onConnectionLost });

    session.stop();
    peer().enter('closed');

    expect(onConnectionLost).not.toHaveBeenCalled();
  });

  it('ignores healthy state changes', async () => {
    const onConnectionLost = jest.fn();
    await publishViaWhip(PUBLISH_URL, stream, { onConnectionLost });

    peer().enter('connected');

    expect(onConnectionLost).not.toHaveBeenCalled();
  });
});
