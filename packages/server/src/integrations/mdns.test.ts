const mockStop = jest.fn();
const mockPublish = jest.fn(() => ({ stop: mockStop }));
const mockDestroy = jest.fn();
const mockBonjourCtor = jest.fn();

jest.mock('bonjour-service', () => ({
  Bonjour: jest.fn().mockImplementation((...args: unknown[]) => {
    mockBonjourCtor(...args);
    return { publish: mockPublish, destroy: mockDestroy };
  }),
}));

type Mdns = typeof import('./mdns.js');

/** Fresh module each time: config (and so config.mdnsEnabled/mdnsHostname)
 * is read once at import time, so a different env needs a fresh import —
 * same pattern as cloud-sync.test.ts. */
async function loadModule(): Promise<Mdns> {
  jest.resetModules();
  return (await import('./mdns.js')) as Mdns;
}

const ORIGINAL_ENV = process.env;
let warn: jest.SpyInstance;
let log: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('publishMdns', () => {
  it('publishes a service at config.mdnsHostname on config.httpsPort', async () => {
    process.env.MDNS_HOSTNAME = 'courtside.local';
    process.env.HTTPS_PORT = '3001';
    const { publishMdns } = await loadModule();

    publishMdns();

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'courtside.local', port: 3001, type: 'https' }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('courtside.local:3001'));
  });

  it('does nothing when MDNS_ENABLED=false, without touching bonjour-service at all', async () => {
    process.env.MDNS_ENABLED = 'false';
    const { publishMdns } = await loadModule();

    const handle = publishMdns();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockBonjourCtor).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  it('stop() tears down the published service and destroys the instance', async () => {
    const { publishMdns } = await loadModule();
    const handle = publishMdns();

    handle.stop();

    expect(mockStop).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('logs a warning through the Bonjour error callback rather than letting it crash the process', async () => {
    const { publishMdns } = await loadModule();
    publishMdns();

    const errorCallback = mockBonjourCtor.mock.calls[0]?.[1] as (error: Error) => void;
    errorCallback(new Error('no multicast interface'));

    expect(warn).toHaveBeenCalledWith('[mDNS] error:', 'no multicast interface');
  });

  it('does not throw if bonjour-service itself throws during setup', async () => {
    mockPublish.mockImplementationOnce(() => {
      throw new Error('EADDRINUSE');
    });
    const { publishMdns } = await loadModule();

    expect(() => publishMdns()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[mDNS] could not start advertising:', expect.any(Error));
  });

  it('stop() does not throw even if tearing down the service itself throws', async () => {
    mockStop.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    const { publishMdns } = await loadModule();
    const handle = publishMdns();

    expect(() => handle.stop()).not.toThrow();
  });
});
