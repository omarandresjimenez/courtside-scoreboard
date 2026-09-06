const ORIGINAL_ENV = process.env;

describe('config', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults port to 3000 and adminPassword to "change-me" when unset', async () => {
    delete process.env.PORT;
    delete process.env.ADMIN_PASSWORD;
    // config.ts's `import 'dotenv/config'` would otherwise silently
    // repopulate PORT/ADMIN_PASSWORD from this machine's real
    // packages/server/.env during the re-import below, defeating the
    // deletes above and hiding the fallback branch from ever running.
    process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env-for-testing-only';
    const { config } = await import('./config.js');
    expect(config.port).toBe(3000);
    expect(config.adminPassword).toBe('change-me');
  });

  it('reads PORT and ADMIN_PASSWORD from the environment when set', async () => {
    process.env.PORT = '4000';
    process.env.ADMIN_PASSWORD = 'a-real-secret';
    const { config } = await import('./config.js');
    expect(config.port).toBe(4000);
    expect(config.adminPassword).toBe('a-real-secret');
  });

  it('defaults mdnsHostname to courtside.local and mdnsEnabled to true', async () => {
    delete process.env.MDNS_HOSTNAME;
    delete process.env.MDNS_ENABLED;
    const { config } = await import('./config.js');
    expect(config.mdnsHostname).toBe('courtside.local');
    expect(config.mdnsEnabled).toBe(true);
  });

  it('reads MDNS_HOSTNAME from the environment when set', async () => {
    process.env.MDNS_HOSTNAME = 'my-venue.local';
    const { config } = await import('./config.js');
    expect(config.mdnsHostname).toBe('my-venue.local');
  });

  it('disables mDNS only when MDNS_ENABLED is exactly "false"', async () => {
    process.env.MDNS_ENABLED = 'false';
    const { config } = await import('./config.js');
    expect(config.mdnsEnabled).toBe(false);
  });
});

describe('required', () => {
  it('returns the environment value when set', async () => {
    process.env.SOME_VAR = 'value';
    const { required } = await import('./config.js');
    expect(required('SOME_VAR')).toBe('value');
  });

  it('falls back when the environment value is unset', async () => {
    delete process.env.SOME_VAR;
    const { required } = await import('./config.js');
    expect(required('SOME_VAR', 'fallback')).toBe('fallback');
  });

  it('throws when neither the environment nor a fallback provides a value', async () => {
    delete process.env.SOME_VAR;
    const { required } = await import('./config.js');
    expect(() => required('SOME_VAR')).toThrow('Missing required environment variable: SOME_VAR');
  });
});
