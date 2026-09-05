import {
  HAS_TURN,
  INTERNET_ICE_SERVERS,
  LAN_ICE_SERVERS,
  logSelectedCandidatePair,
} from './ice-config.js';

const urlsOf = (servers: RTCIceServer[]) => servers.flatMap((s) => [s.urls].flat() as string[]);

describe('ICE configuration', () => {
  it('gives the LAN path STUN but never TURN', () => {
    const urls = urlsOf(LAN_ICE_SERVERS);
    expect(urls.some((u) => u.startsWith('stun:'))).toBe(true);
    // The LAN path has to survive a venue with no uplink; listing an
    // unreachable relay there only delays ICE gathering.
    expect(urls.some((u) => u.startsWith('turn:'))).toBe(false);
  });

  it('gives the internet path everything the LAN path has', () => {
    expect(urlsOf(INTERNET_ICE_SERVERS)).toEqual(expect.arrayContaining(urlsOf(LAN_ICE_SERVERS)));
  });

  it('reports whether a relay is configured, matching the actual server list', () => {
    const hasTurnUrl = urlsOf(INTERNET_ICE_SERVERS).some((u) => u.startsWith('turn:'));
    // HAS_TURN drives the viewer's "why did this fail" message; if it ever
    // disagreed with the real list the diagnosis would be actively wrong.
    expect(HAS_TURN).toBe(hasTurnUrl);
  });

  it('never ships a TURN entry without credentials', () => {
    INTERNET_ICE_SERVERS.filter((s) =>
      [s.urls].flat().some((u) => String(u).startsWith('turn:')),
    ).forEach((s) => {
      expect(s.username).toBeTruthy();
      expect(s.credential).toBeTruthy();
    });
  });
});

describe('logSelectedCandidatePair', () => {
  function peerWithStats(stats: Map<string, unknown>): RTCPeerConnection {
    return { getStats: async () => stats } as unknown as RTCPeerConnection;
  }

  it('reports the winning pair and flags when a relay carried it', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const stats = new Map<string, unknown>([
      [
        'p1',
        {
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'l1',
          remoteCandidateId: 'r1',
        },
      ],
      ['l1', { candidateType: 'relay', protocol: 'udp' }],
      ['r1', { candidateType: 'srflx' }],
    ]);

    logSelectedCandidatePair(peerWithStats(stats), 'test');
    await new Promise((r) => setTimeout(r, 0));

    expect(info).toHaveBeenCalledWith(expect.stringContaining('via TURN relay'));
    info.mockRestore();
  });

  it('does not claim a relay when the pair was direct', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const stats = new Map<string, unknown>([
      [
        'p1',
        {
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'l1',
          remoteCandidateId: 'r1',
        },
      ],
      ['l1', { candidateType: 'srflx', protocol: 'udp' }],
      ['r1', { candidateType: 'srflx' }],
    ]);

    logSelectedCandidatePair(peerWithStats(stats), 'test');
    await new Promise((r) => setTimeout(r, 0));

    expect(info).toHaveBeenCalledWith(expect.not.stringContaining('via TURN relay'));
    info.mockRestore();
  });

  it('ignores pairs that did not win', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const stats = new Map<string, unknown>([
      [
        'p1',
        {
          type: 'candidate-pair',
          state: 'failed',
          nominated: false,
          localCandidateId: 'l1',
          remoteCandidateId: 'r1',
        },
      ],
      ['other', { type: 'transport' }],
    ]);

    logSelectedCandidatePair(peerWithStats(stats), 'test');
    await new Promise((r) => setTimeout(r, 0));

    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('never lets a diagnostics failure reach the call', async () => {
    const broken = {
      getStats: async () => {
        throw new Error('unsupported');
      },
    } as unknown as RTCPeerConnection;
    expect(() => logSelectedCandidatePair(broken, 'test')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
