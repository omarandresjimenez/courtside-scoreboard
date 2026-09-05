/**
 * ICE servers for the public (internet) viewer.
 *
 * Mirror of the INTERNET_ICE_SERVERS half of
 * `packages/client/src/lib/ice-config.ts` — the two must stay in sync. Kept
 * as a separate file for the same reason firebase-config.js is: this page has
 * no build step, so it cannot import from the TypeScript sources.
 *
 * Why TURN matters here: STUN only reports a peer its own public address, it
 * cannot forward packets. When either side is behind symmetric NAT or carrier
 * CGNAT — normal on mobile data, common on corporate wifi — there is no
 * direct path, and the connection dies with `connectionState === 'failed'`
 * *after* signalling has apparently worked. That is what "Could not reach the
 * camera" means.
 *
 * TURN_SERVERS is empty on purpose — see the TypeScript mirror for the full
 * note. OpenRelay's shared public credentials were verified dead (the server
 * refuses the allocation with error 400 and zero relay candidates are
 * gathered), so listing them would look like a fix while changing nothing.
 * Fill both files with credentials from one provider to enable relaying.
 */
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** @type {RTCIceServer[]} */
const TURN_SERVERS = [];

export const HAS_TURN = TURN_SERVERS.length > 0;
export const ICE_SERVERS = [...STUN_SERVERS, ...TURN_SERVERS];

/**
 * Report how the connection was actually established. `relay` means TURN
 * carried it; `srflx` means STUN was enough; `host` means a direct path.
 * Without this there is no way to confirm a relay is doing anything.
 */
export function logSelectedCandidatePair(pc) {
  pc.getStats()
    .then((stats) => {
      stats.forEach((report) => {
        if (report.type !== 'candidate-pair') return;
        if (report.state !== 'succeeded' || !report.nominated) return;
        const local = stats.get(report.localCandidateId);
        const remote = stats.get(report.remoteCandidateId);
        const viaRelay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        console.info(
          `[ice] connected: local=${local?.candidateType}/${local?.protocol}` +
            ` remote=${remote?.candidateType}${viaRelay ? ' (via TURN relay)' : ''}`,
        );
      });
    })
    .catch(() => {});
}
