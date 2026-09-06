import { Bonjour, type Service } from 'bonjour-service';
import { config } from '../config.js';

/**
 * Advertises this server at `config.mdnsHostname` (default
 * "courtside.local") over mDNS, so a phone can reach the camera-capture
 * HTTPS listener at a name instead of a DHCP-assigned LAN IP — see
 * integrations/local-tls.ts for why a stable name matters here (a
 * certificate trusted once should stay trusted, including across a venue
 * handing out a different IP next time).
 *
 * Best-effort only: not every venue network permits multicast (some
 * corporate/conference APs block it outright), and this must never be a
 * reason the rest of the app fails to start — a phone that can't resolve
 * ".local" just falls back to the IP-based link, unchanged.
 */
export function publishMdns(): { stop: () => void } {
  if (!config.mdnsEnabled) return { stop: () => {} };

  let instance: Bonjour | undefined;
  let service: Service | undefined;
  try {
    instance = new Bonjour(undefined, (error: Error) => {
      // bonjour-service's error callback — without one, an mDNS-level
      // failure (e.g. no multicast-capable interface) throws and takes the
      // whole process down with it.
      console.warn('[mDNS] error:', error.message);
    });
    service = instance.publish({
      name: 'Courtside Scoreboard',
      host: config.mdnsHostname,
      type: 'https',
      port: config.httpsPort,
    });
    console.log(`[mDNS] advertising https://${config.mdnsHostname}:${config.httpsPort}`);
  } catch (error) {
    console.warn('[mDNS] could not start advertising:', error);
  }

  return {
    stop: () => {
      try {
        service?.stop();
        instance?.destroy();
      } catch {
        // Best-effort teardown; nothing left listening for this to matter.
      }
    },
  };
}
