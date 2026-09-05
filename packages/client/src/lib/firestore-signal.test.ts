/**
 * Focused on resource release rather than the signalling happy path: the
 * per-viewer Firestore listeners were previously created and discarded, so a
 * broadcast accumulated two live `onSnapshot` subscriptions for every viewer
 * that had ever connected. These tests pin that down — the WebRTC handshake
 * itself is exercised against real browsers, not jsdom.
 */

interface FakeSnapshotRegistration {
  path: string;
  callback: (snap: unknown) => void;
  unsubscribe: jest.Mock;
}

const registrations: FakeSnapshotRegistration[] = [];

const pathOf = (ref: unknown): string => (ref as { path: string })?.path ?? '';

const mockOnSnapshot = jest.fn((ref: unknown, callback: (snap: unknown) => void) => {
  const unsubscribe = jest.fn();
  registrations.push({ path: pathOf(ref), callback, unsubscribe });
  return unsubscribe;
});

const mockDeleteDoc = jest.fn(async () => undefined);
const mockAddDoc = jest.fn(async () => undefined);
const mockSetDoc = jest.fn(async () => undefined);

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({ name: 'test-app' })),
  getApps: jest.fn(() => []),
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({ type: 'firestore' })),
  doc: jest.fn((parent: unknown, ...segments: string[]) => ({
    path: [pathOf(parent), ...segments].filter(Boolean).join('/'),
  })),
  collection: jest.fn((parent: unknown, ...segments: string[]) => ({
    path: [pathOf(parent), ...segments].filter(Boolean).join('/'),
  })),
  onSnapshot: (...args: unknown[]) => mockOnSnapshot(args[0], args[1] as (snap: unknown) => void),
  setDoc: (...args: unknown[]) => mockSetDoc(...(args as [])),
  addDoc: (...args: unknown[]) => mockAddDoc(...(args as [])),
  deleteDoc: (...args: unknown[]) => mockDeleteDoc(...(args as [])),
  getDocs: jest.fn(async () => ({ docs: [] })),
  serverTimestamp: jest.fn(() => 'ts'),
}));

import { broadcastToInternet, MAX_INTERNET_VIEWERS } from './firestore-signal.js';

class FakePeerConnection {
  connectionState = 'new';
  currentRemoteDescription: unknown = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  close = jest.fn(() => {
    this.connectionState = 'closed';
  });
  addTrack = jest.fn();
  createOffer = jest.fn(async () => ({ type: 'offer', sdp: 'sdp' }));
  setLocalDescription = jest.fn(async () => undefined);
  setRemoteDescription = jest.fn(async () => undefined);
  addIceCandidate = jest.fn(async () => undefined);
  // logSelectedCandidatePair() calls this on 'connected'; an empty stats map
  // is the realistic shape for a peer with no nominated pair yet.
  getStats = jest.fn(async () => new Map());
}

let createdPeers: FakePeerConnection[] = [];

/** Let the purge promise and connectViewer's awaits settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream;
}

/** Drive the viewers-collection listener the way Firestore would. */
function emitViewerChange(type: 'added' | 'removed', id: string, data: unknown = {}) {
  const viewersListener = registrations.find((r) => r.path.endsWith('/viewers'));
  viewersListener?.callback({
    docChanges: () => [{ type, doc: { id, data: () => data } }],
  });
}

const config = { apiKey: 'k', authDomain: 'd', projectId: 'p', appId: 'a' };

beforeEach(() => {
  registrations.length = 0;
  createdPeers = [];
  mockOnSnapshot.mockClear();
  mockDeleteDoc.mockClear();
  mockAddDoc.mockClear();
  mockSetDoc.mockClear();
  (globalThis as Record<string, unknown>).RTCPeerConnection = function () {
    const pc = new FakePeerConnection();
    createdPeers.push(pc);
    return pc;
  };
  (globalThis as Record<string, unknown>).RTCSessionDescription = function (v: unknown) {
    return v;
  };
  (globalThis as Record<string, unknown>).RTCIceCandidate = function (v: unknown) {
    return v;
  };
});

describe('broadcastToInternet listener lifecycle', () => {
  it('unsubscribes both per-viewer listeners when the viewer disappears', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    emitViewerChange('added', 'viewer1');
    await flush();

    // The answer document and the answerCandidates collection.
    const perViewer = registrations.filter((r) => r.path.includes('viewer1'));
    expect(perViewer).toHaveLength(2);
    expect(perViewer.every((r) => r.unsubscribe.mock.calls.length === 0)).toBe(true);

    emitViewerChange('removed', 'viewer1');

    // The leak this guards: closing the peer does not detach a Firestore
    // listener, so these must be unsubscribed explicitly.
    expect(perViewer.every((r) => r.unsubscribe.mock.calls.length === 1)).toBe(true);
    expect(createdPeers[0]?.close).toHaveBeenCalled();

    handle.stop();
  });

  it('unsubscribes every viewer listener on stop()', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    emitViewerChange('added', 'viewerA');
    await flush();
    emitViewerChange('added', 'viewerB');
    await flush();

    const perViewer = registrations.filter((r) => /viewer[AB]/.test(r.path));
    expect(perViewer).toHaveLength(4);

    handle.stop();

    expect(perViewer.every((r) => r.unsubscribe.mock.calls.length === 1)).toBe(true);
    expect(handle.viewerCount()).toBe(0);
  });

  it('reports the viewer count as peers connect and leave', async () => {
    const counts: number[] = [];
    const handle = broadcastToInternet(config, 'court1', fakeStream(), (n) => counts.push(n));
    await flush();

    emitViewerChange('added', 'viewer1');
    await flush();
    expect(handle.viewerCount()).toBe(1);

    emitViewerChange('removed', 'viewer1');
    expect(handle.viewerCount()).toBe(0);
    expect(counts).toContain(1);
    expect(counts[counts.length - 1]).toBe(0);

    handle.stop();
  });

  it('refuses an abandoned request older than the TTL without spending a slot', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    emitViewerChange('added', 'stale', { requestedAt: Date.now() - 10 * 60_000 });
    await flush();

    expect(handle.viewerCount()).toBe(0);
    expect(createdPeers).toHaveLength(0);
    // The corpse is cleared rather than left to block a slot forever.
    expect(mockDeleteDoc).toHaveBeenCalled();

    handle.stop();
  });

  it('caps concurrent viewers at MAX_INTERNET_VIEWERS', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    for (let i = 0; i < MAX_INTERNET_VIEWERS + 3; i += 1) {
      emitViewerChange('added', `viewer${i}`);
      await flush();
    }

    expect(handle.viewerCount()).toBe(MAX_INTERNET_VIEWERS);

    handle.stop();
  });

  it('does not register listeners for a viewer whose handshake finishes after stop()', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    emitViewerChange('added', 'late');
    // Deliberately no flush: stop() lands mid-handshake.
    handle.stop();
    await flush();

    const perViewer = registrations.filter((r) => r.path.includes('late'));
    expect(perViewer).toHaveLength(0);
    expect(handle.viewerCount()).toBe(0);
  });
});

/** Microtask-only flush, for use under fake timers. */
async function flushMicro(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function listenerFor(fragment: string) {
  return registrations.find((r) => r.path.includes(fragment));
}

describe('broadcastToInternet peer callbacks', () => {
  it('publishes its ICE candidates and ignores the end-of-candidates signal', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();

    const pc = createdPeers[0]!;
    mockAddDoc.mockClear();

    (pc.onicecandidate as (e: unknown) => void)({
      candidate: { toJSON: () => ({ candidate: 'cand' }) },
    });
    expect(mockAddDoc).toHaveBeenCalledTimes(1);

    (pc.onicecandidate as (e: unknown) => void)({ candidate: null });
    expect(mockAddDoc).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('frees the slot when the connection fails', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();
    expect(handle.viewerCount()).toBe(1);

    const pc = createdPeers[0]!;
    pc.connectionState = 'failed';
    (pc.onconnectionstatechange as () => void)();

    expect(handle.viewerCount()).toBe(0);
    expect(pc.close).toHaveBeenCalled();

    handle.stop();
  });

  it('keeps the peer while the connection is healthy', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();

    const pc = createdPeers[0]!;
    pc.connectionState = 'connected';
    (pc.onconnectionstatechange as () => void)();

    expect(handle.viewerCount()).toBe(1);

    handle.stop();
  });

  it("applies the viewer's answer once", async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();

    const answerListener = listenerFor('viewers/viewer1')!;
    const pc = createdPeers[0]!;

    answerListener.callback({ data: () => ({ answer: { type: 'answer', sdp: 'x' } }) });
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);

    // Already negotiated — a repeat snapshot must not renegotiate.
    pc.currentRemoteDescription = { type: 'answer' };
    answerListener.callback({ data: () => ({ answer: { type: 'answer', sdp: 'x' } }) });
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('ignores a viewer document with no answer yet', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();

    listenerFor('viewers/viewer1')!.callback({ data: () => ({}) });

    expect(createdPeers[0]!.setRemoteDescription).not.toHaveBeenCalled();
    handle.stop();
  });

  it("adds the viewer's ICE candidates, and only newly added ones", async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();

    const candidates = listenerFor('answerCandidates')!;
    const pc = createdPeers[0]!;

    candidates.callback({
      docChanges: () => [
        { type: 'added', doc: { data: () => ({ candidate: 'a' }) } },
        { type: 'modified', doc: { data: () => ({ candidate: 'b' }) } },
      ],
    });

    expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('swallows a candidate that loses the race against a closing connection', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();

    const pc = createdPeers[0]!;
    pc.addIceCandidate.mockRejectedValueOnce(new Error('closed'));

    expect(() =>
      listenerFor('answerCandidates')!.callback({
        docChanges: () => [{ type: 'added', doc: { data: () => ({ candidate: 'a' }) } }],
      }),
    ).not.toThrow();

    await flush();
    handle.stop();
  });

  it('drops a peer that never reaches connected within the timeout', async () => {
    jest.useFakeTimers();
    try {
      const handle = broadcastToInternet(config, 'court1', fakeStream());
      await flushMicro();
      emitViewerChange('added', 'viewer1');
      await flushMicro();
      expect(handle.viewerCount()).toBe(1);

      jest.advanceTimersByTime(31_000);

      // The slot is freed rather than held against a viewer that never arrived.
      expect(handle.viewerCount()).toBe(0);
      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not drop a peer that connected before the timeout', async () => {
    jest.useFakeTimers();
    try {
      const handle = broadcastToInternet(config, 'court1', fakeStream());
      await flushMicro();
      emitViewerChange('added', 'viewer1');
      await flushMicro();

      createdPeers[0]!.connectionState = 'connected';
      jest.advanceTimersByTime(31_000);

      expect(handle.viewerCount()).toBe(1);
      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('announces the broadcast as live, and as ended on stop', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'streams/court1' }),
      expect.objectContaining({ live: true }),
      { merge: true },
    );

    handle.stop();

    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'streams/court1' }),
      expect.objectContaining({ live: false }),
      { merge: true },
    );
  });

  it('ignores a viewer it is already connected to', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    emitViewerChange('added', 'viewer1');
    await flush();
    emitViewerChange('added', 'viewer1');
    await flush();

    expect(createdPeers).toHaveLength(1);
    handle.stop();
  });
});

describe('broadcastToInternet paused flag', () => {
  it('announces the broadcast as not paused when it starts', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();

    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'streams/court1' }),
      expect.objectContaining({ live: true, paused: false }),
      { merge: true },
    );

    handle.stop();
  });

  it('publishes a pause so a viewer sees why the picture went black', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    mockSetDoc.mockClear();

    handle.setPaused(true);

    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'streams/court1' }),
      expect.objectContaining({ paused: true }),
      { merge: true },
    );

    handle.setPaused(false);
    expect(mockSetDoc).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: 'streams/court1' }),
      expect.objectContaining({ paused: false }),
      { merge: true },
    );

    handle.stop();
  });

  it('does not let a failed write to Firestore break the broadcast', async () => {
    const handle = broadcastToInternet(config, 'court1', fakeStream());
    await flush();
    mockSetDoc.mockRejectedValueOnce(new Error('offline'));

    expect(() => handle.setPaused(true)).not.toThrow();

    handle.stop();
  });
});
