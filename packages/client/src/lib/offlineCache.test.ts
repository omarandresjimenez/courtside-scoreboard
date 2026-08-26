import type { MatchStatePayload } from '@courtside/shared';

const mockDb = { put: jest.fn(), get: jest.fn() };
type UpgradeCallback = (db: { createObjectStore: (name: string) => void }) => void;
const mockOpenDB = jest.fn(
  async (_name: string, _version: number, _opts: { upgrade: UpgradeCallback }) => mockDb,
);
jest.mock('idb', () => ({ openDB: mockOpenDB }));

// After the mock, so offlineCache's `import { openDB } from 'idb'` resolves
// to the mock above rather than trying to touch a real IndexedDB.
import { cacheMatchState, readCachedMatchState } from './offlineCache.js';

const samplePayload = { match: { matchId: 'm1' } } as unknown as MatchStatePayload;

describe('cacheMatchState', () => {
  // This test must run first: offlineCache.ts caches its db connection in a
  // module-level singleton, so openDB() is only ever actually invoked once
  // across this whole file — this is where we can observe that call.
  it('opens the db once, wiring the upgrade callback, and writes the state under the given key', async () => {
    await cacheMatchState('umpire:m1', samplePayload);

    expect(mockOpenDB).toHaveBeenCalledWith(
      'courtside-cache',
      1,
      expect.objectContaining({ upgrade: expect.any(Function) }),
    );
    expect(mockDb.put).toHaveBeenCalledWith('match-state', samplePayload, 'umpire:m1');

    const call = mockOpenDB.mock.calls[0];
    if (!call) throw new Error('openDB was not called');
    const createObjectStore = jest.fn();
    call[2].upgrade({ createObjectStore });
    expect(createObjectStore).toHaveBeenCalledWith('match-state');
  });

  it('swallows errors — a cache write must never block live scoring', async () => {
    mockDb.put.mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    await expect(cacheMatchState('umpire:m1', samplePayload)).resolves.toBeUndefined();
  });
});

describe('readCachedMatchState', () => {
  it('returns whatever the db has stored under the key', async () => {
    mockDb.get.mockResolvedValueOnce(samplePayload);

    const result = await readCachedMatchState('umpire:m1');

    expect(mockDb.get).toHaveBeenCalledWith('match-state', 'umpire:m1');
    expect(result).toBe(samplePayload);
  });

  it('returns undefined (not a throw) when the db read fails', async () => {
    mockDb.get.mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    await expect(readCachedMatchState('umpire:m1')).resolves.toBeUndefined();
  });
});
