/**
 * Focused on what the peer-mesh path cannot do for itself: surviving a dropped
 * upload, and never leaving this phone publishing to Cloudflare after the
 * court has stopped. The WHIP handshake itself is covered in whip-client.test.
 */

const mockSetDoc = jest.fn(async (..._args: unknown[]) => undefined);

const pathOf = (ref: unknown): string => (ref as { path: string })?.path ?? '';

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
  onSnapshot: jest.fn(() => jest.fn()),
  setDoc: (...args: unknown[]) => mockSetDoc(...(args as [])),
  addDoc: jest.fn(async () => undefined),
  deleteDoc: jest.fn(async () => undefined),
  getDocs: jest.fn(async () => ({ docs: [] })),
  serverTimestamp: jest.fn(() => 'ts'),
}));

const mockPublishViaWhip = jest.fn();
jest.mock('./whip-client.js', () => ({
  publishViaWhip: (...args: unknown[]) => mockPublishViaWhip(...args),
}));

import { broadcastViaCloudflare } from './cloudflare-broadcast.js';

const CONFIG = { apiKey: 'k', authDomain: 'a', projectId: 'p', appId: 'i' };
const INPUT = {
  publishUrl: 'https://customer-x.cloudflarestream.com/secret/webRTC/publish',
  playbackUrl: 'https://customer-x.cloudflarestream.com/secret/webRTC/play',
};
const stream = { getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream;

/** The most recent onConnectionLost handler publishViaWhip was given. */
function loseConnection(call = 0): void {
  (
    mockPublishViaWhip.mock.calls[call]?.[2] as { onConnectionLost?: () => void }
  )?.onConnectionLost?.();
}

/** The data written by the nth setDoc call. */
function written(call: number): Record<string, unknown> {
  return mockSetDoc.mock.calls[call]?.[1] as unknown as Record<string, unknown>;
}

let sessions: Array<{ stop: jest.Mock }>;

beforeEach(() => {
  jest.clearAllMocks();
  sessions = [];
  mockPublishViaWhip.mockImplementation(async () => {
    const session = { stop: jest.fn() };
    sessions.push(session);
    return session;
  });
});

const start = () => broadcastViaCloudflare(CONFIG, 'court-a', stream, INPUT);

describe('broadcastViaCloudflare', () => {
  it('publishes to the court live input', async () => {
    await start();

    expect(mockPublishViaWhip).toHaveBeenCalledWith(INPUT.publishUrl, stream, expect.any(Object));
  });

  it('announces the playback URL so internet viewers know where to watch', async () => {
    await start();

    expect(written(0)).toMatchObject({ live: true, whepUrl: INPUT.playbackUrl });
    expect(pathOf(mockSetDoc.mock.calls[0]?.[0])).toBe('streams/court-a');
  });

  it('never writes the publish URL, which carries the broadcast secret', async () => {
    await start();

    const everythingWritten = JSON.stringify(mockSetDoc.mock.calls);
    expect(everythingWritten).not.toContain('/webRTC/publish');
  });

  it('rejects when the first publish fails, so the caller falls back to the mesh', async () => {
    mockPublishViaWhip.mockRejectedValueOnce(new Error('WHIP refused'));

    await expect(start()).rejects.toThrow('WHIP refused');
  });

  it('does not announce a stream it failed to publish', async () => {
    mockPublishViaWhip.mockRejectedValueOnce(new Error('WHIP refused'));

    await expect(start()).rejects.toThrow();
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('reports no viewer count, which Cloudflare does not provide for WebRTC', async () => {
    const handle = await start();

    expect(handle.viewerCount()).toBe(0);
  });

  it('clears the playback URL on stop, so viewers stop chasing a dead stream', async () => {
    const handle = await start();
    mockSetDoc.mockClear();

    handle.stop();

    expect(written(0)).toMatchObject({ live: false, whepUrl: null });
  });

  it('ends the WHIP session on stop', async () => {
    const handle = await start();

    handle.stop();

    expect(sessions[0]?.stop).toHaveBeenCalled();
  });

  it('survives Firestore refusing the presence write', async () => {
    // Presence is a convenience for the viewer's placeholder text. A broadcast
    // that dies because a status write failed would be a far worse trade.
    mockSetDoc.mockRejectedValue(new Error('permission denied'));

    await expect(start()).resolves.toBeDefined();
  });

  it('survives Firestore refusing the pause write', async () => {
    const handle = await start();
    mockSetDoc.mockRejectedValue(new Error('permission denied'));

    expect(() => handle.setPaused(true)).not.toThrow();
  });

  it('publishes the pause flag without touching the playback URL', async () => {
    const handle = await start();
    mockSetDoc.mockClear();

    handle.setPaused(true);

    expect(written(0)).toEqual({ paused: true, updatedAt: 'ts' });
  });

  describe('when the upload drops', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('re-publishes after a backoff', async () => {
      await start();
      loseConnection();

      expect(mockPublishViaWhip).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(mockPublishViaWhip).toHaveBeenCalledTimes(2);
    });

    it('tells the caller it is down and then up again', async () => {
      const onConnectedChange = jest.fn();
      await broadcastViaCloudflare(CONFIG, 'court-a', stream, INPUT, { onConnectedChange });

      loseConnection();
      expect(onConnectedChange).toHaveBeenLastCalledWith(false);

      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();

      expect(onConnectedChange).toHaveBeenLastCalledWith(true);
    });

    it('re-announces once it is back, in case the court doc was cleared', async () => {
      await start();
      loseConnection();
      mockSetDoc.mockClear();

      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();

      expect(written(0)).toMatchObject({ live: true, whepUrl: INPUT.playbackUrl });
    });

    it('keeps retrying with a longer gap when the re-publish also fails', async () => {
      await start();
      mockPublishViaWhip.mockRejectedValueOnce(new Error('still down'));
      loseConnection();

      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockPublishViaWhip).toHaveBeenCalledTimes(2);

      // The camera is still running and the court still expects to be on air,
      // so this settles into a slow retry rather than giving up.
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(mockPublishViaWhip).toHaveBeenCalledTimes(3);
    });

    it('ignores a second loss while a reconnect is already scheduled', async () => {
      await start();
      loseConnection();
      loseConnection();

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      // Two timers would race to re-publish and leave one session unheld.
      expect(mockPublishViaWhip).toHaveBeenCalledTimes(2);
    });

    it('settles at the longest backoff rather than running off the end', async () => {
      await start();
      mockPublishViaWhip.mockRejectedValue(new Error('still down'));
      loseConnection();

      // Walk past the end of the backoff table.
      for (const delay of [2000, 5000, 10000, 20000, 20000]) {
        jest.advanceTimersByTime(delay);
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(mockPublishViaWhip).toHaveBeenCalledTimes(6);
    });

    it('stops retrying once the court stops', async () => {
      const handle = await start();
      loseConnection();
      handle.stop();

      jest.advanceTimersByTime(60000);
      await Promise.resolve();

      expect(mockPublishViaWhip).toHaveBeenCalledTimes(1);
    });

    it('ignores a connection loss reported after the court stopped', async () => {
      const handle = await start();
      handle.stop();
      loseConnection();

      jest.advanceTimersByTime(60000);
      await Promise.resolve();

      expect(mockPublishViaWhip).toHaveBeenCalledTimes(1);
    });

    it('stops a re-publish that lands after the court stopped', async () => {
      const handle = await start();
      loseConnection();
      jest.advanceTimersByTime(2000);

      // stop() during the in-flight publish: without the guard, this phone
      // would keep uploading with nothing left holding the handle.
      handle.stop();
      await Promise.resolve();
      await Promise.resolve();

      expect(sessions[1]?.stop).toHaveBeenCalled();
    });
  });
});
