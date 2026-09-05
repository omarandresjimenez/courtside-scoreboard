/**
 * ICE server configuration, kept in one place because the right answer
 * differs by topology — and getting that wrong is silent.
 *
 * Mirrored for the static public viewer in `public-viewer/ice-config.js`.
 * The two must stay in sync.
 */

/** Public STUN. Free, no signup, and enough on its own for two peers that are
 *  not both behind a restrictive NAT. */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * TURN relay credentials — **not configured yet**.
 *
 * STUN only tells a peer its own public address; it cannot forward traffic.
 * When either side sits behind symmetric NAT or carrier CGNAT — the normal
 * case on mobile data, and common on corporate wifi — no direct path exists
 * and the connection fails with `connectionState === 'failed'` *after*
 * signalling has apparently succeeded. A TURN server relays the media
 * instead, and is the only fix for that failure.
 *
 * This is empty on purpose. The obvious candidate, OpenRelay's shared
 * `openrelayproject` credentials, is **dead**: the host still resolves and
 * accepts TCP, but the allocation is refused —
 *
 *     turn:openrelay.metered.ca:80?transport=udp  -> code=400 TURN allocate error
 *     turn:openrelay.metered.ca:443?transport=udp -> code=400 TURN allocate error
 *     relay candidates gathered: 0
 *
 * — so listing it would look like a fix while changing nothing. There is no
 * remaining zero-signup public TURN worth depending on; a relay costs
 * bandwidth, so every provider gates it behind an account.
 *
 * To enable, fill this array with credentials from one provider and mirror
 * the change in `public-viewer/ice-config.js`:
 *
 * ```ts
 * const TURN_SERVERS: RTCIceServer[] = [
 *   { urls: 'turn:<host>:3478',               username: '<user>', credential: '<pass>' },
 *   { urls: 'turn:<host>:443?transport=tcp',  username: '<user>', credential: '<pass>' },
 * ];
 * ```
 *
 * Include a TCP/443 entry alongside UDP: networks that block UDP outright
 * (hotel, some corporate wifi) can still relay over TCP 443, which is
 * indistinguishable from HTTPS to a firewall.
 *
 * Until this is populated the app behaves exactly as before — STUN only,
 * which works whenever at least one side has a cone NAT.
 */
const TURN_SERVERS: RTCIceServer[] = [];

/** Whether a relay is configured at all. Surfaced so a screen can tell a
 *  viewer *why* a connection failed instead of blaming their network. */
export const HAS_TURN = TURN_SERVERS.length > 0;

/**
 * LAN path (Socket.io signalling, viewers inside the venue).
 *
 * Deliberately STUN-only. Both peers are on the same subnet, so host
 * candidates connect directly and a relay would never be selected anyway.
 * More importantly this path has to survive a venue with **no internet
 * uplink at all**, and listing unreachable TURN servers there only adds
 * gathering latency for a candidate that cannot help.
 */
export const LAN_ICE_SERVERS: RTCIceServer[] = STUN_SERVERS;

/**
 * Internet path (Firestore signalling, viewers outside the venue).
 *
 * Needs TURN: by definition the two peers are on unrelated networks, and at
 * least one of them is usually behind a NAT that STUN cannot punch through.
 */
export const INTERNET_ICE_SERVERS: RTCIceServer[] = [...STUN_SERVERS, ...TURN_SERVERS];

/**
 * Log how a connected peer actually reached the other side.
 *
 * `relay` means TURN carried it, `srflx` means STUN sufficed, `host` means a
 * direct local path. Without this there is no way to tell whether a TURN
 * server is doing anything, or whether a working connection is one network
 * change away from breaking.
 */
export function logSelectedCandidatePair(pc: RTCPeerConnection, label: string): void {
  void pc
    .getStats()
    .then((stats) => {
      stats.forEach((report) => {
        if (report.type !== 'candidate-pair') return;
        if (report.state !== 'succeeded' || !report.nominated) return;
        const local = stats.get(report.localCandidateId as string) as
          { candidateType?: string; protocol?: string } | undefined;
        const remote = stats.get(report.remoteCandidateId as string) as
          { candidateType?: string } | undefined;
        console.info(
          `[ice] ${label} connected: local=${local?.candidateType ?? '?'}` +
            `/${local?.protocol ?? '?'} remote=${remote?.candidateType ?? '?'}` +
            `${local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? ' (via TURN relay)' : ''}`,
        );
      });
    })
    .catch(() => {
      // Diagnostics must never affect the call.
    });
}
