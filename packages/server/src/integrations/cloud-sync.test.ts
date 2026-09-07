const mockCert = jest.fn((sa: unknown) => ({ credential: sa }));
const mockInitializeApp = jest.fn();
const mockGetApps = jest.fn(() => [] as unknown[]);
const mockSet = jest.fn(async () => undefined);
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));
const mockGetFirestore = jest.fn(() => ({ collection: mockCollection }));

jest.mock('firebase-admin/app', () => ({
  cert: (sa: unknown) => mockCert(sa),
  getApps: () => mockGetApps(),
  initializeApp: (opts: unknown) => mockInitializeApp(opts),
}));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockGetFirestore(),
}));

type CloudSync = typeof import('./cloud-sync.js');

/** Fresh module each time: initialization is one-shot module-level state. */
async function loadModule(): Promise<CloudSync> {
  jest.resetModules();
  return (await import('./cloud-sync.js')) as CloudSync;
}

const CREDS = {
  FIREBASE_PROJECT_ID: 'proj',
  FIREBASE_PRIVATE_KEY: '-----BEGIN-----\\nline2\\n-----END-----',
  FIREBASE_CLIENT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
};

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
let errorLog: jest.SpyInstance;
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetApps.mockReturnValue([]);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  for (const key of Object.keys(CREDS)) delete process.env[key];
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe('initializeCloudServices', () => {
  it.each(Object.keys(CREDS))('stays disabled when %s is missing', async (missing) => {
    Object.assign(process.env, CREDS);
    delete process.env[missing];

    (await loadModule()).initializeCloudServices();

    // cert() requires all three; a partial config must be caught here rather
    // than failing later inside the SDK with a worse message.
    expect(mockInitializeApp).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[Cloud] Firebase credentials not found - cloud sync disabled',
    );
  });

  it('initializes with all three credentials', async () => {
    Object.assign(process.env, CREDS);

    (await loadModule()).initializeCloudServices();

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[Cloud] Firebase initialized');
  });

  it('unescapes the newlines a PEM key loses when stored in a .env line', async () => {
    Object.assign(process.env, CREDS);

    (await loadModule()).initializeCloudServices();

    expect(mockCert).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: '-----BEGIN-----\nline2\n-----END-----' }),
    );
  });

  it('does not create a duplicate app when one already exists', async () => {
    Object.assign(process.env, CREDS);
    mockGetApps.mockReturnValue([{ name: '[DEFAULT]' }]);

    const mod = await loadModule();
    mod.initializeCloudServices();

    expect(mockInitializeApp).not.toHaveBeenCalled();
    // Still usable — it reuses the existing app rather than giving up.
    expect(mockGetFirestore).toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    Object.assign(process.env, CREDS);
    const mod = await loadModule();

    mod.initializeCloudServices();
    mod.initializeCloudServices();

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
  });

  it('survives an SDK failure without taking the server down', async () => {
    Object.assign(process.env, CREDS);
    mockInitializeApp.mockImplementationOnce(() => {
      throw new Error('bad key');
    });

    const mod = await loadModule();
    expect(() => mod.initializeCloudServices()).not.toThrow();
    expect(errorLog).toHaveBeenCalledWith(
      '[Cloud] Firebase initialization failed:',
      expect.any(Error),
    );
  });
});

describe('toPublicScoreboard', () => {
  const rawMatch = {
    matchId: 'm1',
    matchType: 'singles',
    status: 'IN_PROGRESS',
    courtLabel: 'Court 1',
    players: [
      {
        playerId: 'a1',
        side: 'A',
        name: 'Alice',
        lastName: 'Adams',
        shortName: 'ALI',
        email: 'a@b.c',
      },
    ],
    teams: { A: { name: null } },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    // The secrets that authorise scoring this match.
    umpireToken: 'SECRET-TOKEN',
    umpireCode: 'SECRET-CODE',
  };

  it('never lets umpire credentials reach a world-readable document', async () => {
    const result = (await loadModule()).toPublicScoreboard({ match: rawMatch, derived: {} });
    const serialised = JSON.stringify(result);

    // matches/{courtId} is public by design; publishing these would let any
    // reader score the match.
    expect(serialised).not.toContain('SECRET-TOKEN');
    expect(serialised).not.toContain('SECRET-CODE');
    expect(result).not.toHaveProperty('umpireToken');
    expect(result).not.toHaveProperty('umpireCode');
  });

  it('projects players down to the four public fields', async () => {
    const result = (await loadModule()).toPublicScoreboard({ match: rawMatch, derived: {} });

    expect(result.players).toEqual([
      { playerId: 'a1', side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
    ]);
    expect(JSON.stringify(result)).not.toContain('a@b.c');
  });

  it('carries the fields the public scoreboard needs', async () => {
    const derived = { setsWon: { A: 1, B: 0 } };
    const result = (await loadModule()).toPublicScoreboard({ match: rawMatch, derived });

    expect(result).toMatchObject({
      matchId: 'm1',
      matchType: 'singles',
      status: 'IN_PROGRESS',
      courtLabel: 'Court 1',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      derived,
    });
  });

  it('falls back safely on an empty match', async () => {
    const result = (await loadModule()).toPublicScoreboard({ match: {}, derived: undefined });

    expect(result).toEqual({
      matchId: '',
      matchType: '',
      status: '',
      courtLabel: null,
      category: null,
      players: [],
      teams: null,
      startedAt: null,
      completedAt: null,
      derived: null,
    });
  });
});

describe('syncScoreToCloud', () => {
  const payload = {
    matchId: 'm1',
    matchType: 'singles',
    status: 'IN_PROGRESS',
    courtLabel: 'Court 1',
    category: null,
    players: [],
    teams: null,
    startedAt: null,
    completedAt: null,
    derived: null,
  };

  it('skips silently when Firebase was never configured', async () => {
    const mod = await loadModule();
    await expect(mod.syncScoreToCloud('court1', payload)).resolves.toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('writes the score to the court document', async () => {
    Object.assign(process.env, CREDS);
    const mod = await loadModule();
    mod.initializeCloudServices();

    await expect(mod.syncScoreToCloud('court1', payload)).resolves.toBe(true);

    expect(mockCollection).toHaveBeenCalledWith('matches');
    expect(mockDoc).toHaveBeenCalledWith('court1');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'm1', syncStatus: 'synced' }),
      { merge: true },
    );
  });

  it('reports a write failure without throwing at the caller', async () => {
    Object.assign(process.env, CREDS);
    const mod = await loadModule();
    mod.initializeCloudServices();
    mockSet.mockRejectedValueOnce(new Error('offline'));

    await expect(mod.syncScoreToCloud('court1', payload)).resolves.toBe(false);
    expect(errorLog).toHaveBeenCalled();
  });
});

describe('getCloudDb', () => {
  it('hands out the Firestore handle once initialization has succeeded', async () => {
    Object.assign(process.env, CREDS);
    const mod = await loadModule();
    mod.initializeCloudServices();

    // Other integrations read their own remote configuration through this
    // rather than each re-initialising the Admin SDK.
    expect(mod.getCloudDb()).toBeDefined();
  });

  it('is undefined when cloud sync was never configured', async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    const mod = await loadModule();
    mod.initializeCloudServices();

    // The normal state for a venue running purely on the LAN — callers must
    // treat it as "no cloud" and carry on, never as an error.
    expect(mod.getCloudDb()).toBeUndefined();
  });

  it('is undefined before initialization has been attempted at all', async () => {
    const mod = await loadModule();

    expect(mod.getCloudDb()).toBeUndefined();
  });
});
