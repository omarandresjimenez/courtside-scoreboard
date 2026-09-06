import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';

export function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Camera capture (see StreamBroadcast) requires a secure context, which a
  // plain http:// LAN address never is — this second, self-signed HTTPS
  // listener (see index.ts) serves the same app so a phone can open the
  // broadcast page securely without a separate reverse proxy.
  httpsPort: Number(process.env.HTTPS_PORT ?? Number(process.env.PORT ?? 3000) + 1),
  adminPassword: required('ADMIN_PASSWORD', 'change-me'),
  // Advertised over mDNS (see integrations/mdns.ts) so a phone can reach the
  // camera-capture HTTPS listener at a name that survives the LAN IP
  // changing between matches — a plain IP-based cert has to be re-trusted
  // every time DHCP hands out a different address. Not every phone resolves
  // ".local" names (older Android, plain Windows), which is why the IP-based
  // link keeps working unchanged alongside this one.
  mdnsHostname: process.env.MDNS_HOSTNAME ?? 'courtside.local',
  // Escape hatch for a venue where multicast is blocked or unwanted (some
  // corporate/conference APs disable it) — must never be so essential that
  // turning it off breaks anything else.
  mdnsEnabled: process.env.MDNS_ENABLED !== 'false',
  // Where the persistent local CA + signed cert (integrations/local-tls.ts)
  // live. Overridable so tests can point it at a throwaway directory instead
  // of writing real key material under this machine's home directory.
  localTlsDir:
    process.env.LOCAL_TLS_DIR ?? path.join(os.homedir(), '.courtside-scoreboard', 'certs'),
  // Where the built client (packages/client/dist) lives, so this one server
  // can host the whole app on one LAN address — see app.ts and the
  // "Running for a real match" section of the README. Overridable because
  // it's a sibling-package path guess based on the workspace layout, not
  // something derivable at runtime without assumptions.
  clientDistPath: process.env.CLIENT_DIST_PATH ?? path.resolve(process.cwd(), '../client/dist'),
};
