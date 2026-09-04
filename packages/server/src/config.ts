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
  // Where the built client (packages/client/dist) lives, so this one server
  // can host the whole app on one LAN address — see app.ts and the
  // "Running for a real match" section of the README. Overridable because
  // it's a sibling-package path guess based on the workspace layout, not
  // something derivable at runtime without assumptions.
  clientDistPath: process.env.CLIENT_DIST_PATH ?? path.resolve(process.cwd(), '../client/dist'),
};
