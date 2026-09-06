import { X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { config } from '../config.js';

/**
 * A persistent, CA-signed TLS identity for the camera-capture HTTPS
 * listener (see index.ts), instead of a fresh self-signed cert generated
 * every boot.
 *
 * Two problems with the old approach, both found while actually testing the
 * "accept the browser warning" flow on a phone:
 *
 * 1. The cert was regenerated on every server start, so even a phone that
 *    had trusted it once saw a brand new "not private" warning the very
 *    next time the app restarted — there was never anything durable to
 *    trust.
 * 2. It only set `commonName: localhost`, with no Subject Alternative Name.
 *    Modern browsers validate hostname against SAN, not CN, and a phone
 *    reaches this server by LAN IP or by `config.mdnsHostname`
 *    (courtside.local — see integrations/mdns.ts) — neither of which is
 *    the literal string "localhost".
 *
 * The fix: generate a small local Certificate Authority once, persist it to
 * disk, and sign a long-lived leaf certificate from it that lists every
 * name/address this server might be reached by. A phone that installs and
 * trusts the CA once (see routes/local-ca.ts) never sees the warning again
 * for *any* server this CA has ever signed for — including across app
 * restarts and, for names in the SAN list that don't depend on a specific
 * IP (localhost, courtside.local), across a change in the venue's DHCP
 * lease too.
 */

/** 10 years — this is a private, single-purpose CA with nothing else
 * depending on rotation; matches the validity period the previous ad-hoc
 * cert used. */
const VALIDITY_MS = 3650 * 24 * 60 * 60 * 1000;

export interface LocalTlsIdentity {
  /** Private key (PEM) for the HTTPS listener. */
  key: string;
  /** Leaf certificate (PEM) for the HTTPS listener. */
  cert: string;
  /** The CA's own certificate (PEM) — serve this for a device to install
   * and trust once (see routes/local-ca.ts); never serve the CA's key. */
  caCert: string;
}

function paths(dir: string) {
  return {
    caKey: path.join(dir, 'ca-key.pem'),
    caCert: path.join(dir, 'ca-cert.pem'),
    serverKey: path.join(dir, 'server-key.pem'),
    serverCert: path.join(dir, 'server-cert.pem'),
  };
}

/** Every IPv4 address this machine currently has, other than loopback —
 * baked into the leaf cert's SAN as a bonus: it means a device that already
 * trusted the CA can also reach this exact IP without a hostname mismatch,
 * on top of localhost/courtside.local. Read once at cert-creation time —
 * if the venue's DHCP later hands out a different address, this specific
 * entry simply goes unused; it does not invalidate the others. */
function currentLanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

async function generateCa(): Promise<{ key: string; cert: string }> {
  const pems = await generate([{ name: 'commonName', value: 'Courtside Scoreboard Local CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + VALIDITY_MS),
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true,
        critical: true,
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

async function generateLeaf(
  ca: { key: string; cert: string },
  hostname: string,
): Promise<{ key: string; cert: string }> {
  const altNames: Array<{ type: 2 | 7; value?: string; ip?: string }> = [
    { type: 2, value: 'localhost' },
    { type: 2, value: hostname },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...currentLanIPv4Addresses().map((ip): { type: 2 | 7; ip: string } => ({ type: 7, ip })),
  ];

  const pems = await generate([{ name: 'commonName', value: hostname }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + VALIDITY_MS),
    ca,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

/**
 * Loads the persisted CA + leaf certificate from `dir`, generating and
 * saving both if this is the first run (or a previous run never
 * completed). Safe to call on every boot — an existing, readable set of
 * files is reused as-is rather than regenerated, which is the entire
 * point: a device only has to trust the CA once.
 *
 * `dir`/`hostname` default to `config.localTlsDir`/`config.mdnsHostname`;
 * parameterised so tests can point at a throwaway directory instead of
 * writing real key material under this machine's home directory.
 */
export async function getOrCreateLocalTlsIdentity(
  dir: string = config.localTlsDir,
  hostname: string = config.mdnsHostname,
): Promise<LocalTlsIdentity> {
  const p = paths(dir);

  try {
    const existing = {
      key: readFileSync(p.serverKey, 'utf8'),
      cert: readFileSync(p.serverCert, 'utf8'),
      caCert: readFileSync(p.caCert, 'utf8'),
    };
    // A file existing and being readable isn't proof it's a real
    // certificate — a partial write from a previous crash leaves exactly
    // that. Parsing is the actual check; a garbage string throws here.
    new X509Certificate(existing.cert);
    new X509Certificate(existing.caCert);
    return existing;
  } catch {
    // Missing, unreadable, or unparseable (first run, or a partial write
    // from a previous crash) — fall through and (re)generate everything
    // below.
  }

  const ca = await generateCa();
  const leaf = await generateLeaf(ca, hostname);

  mkdirSync(dir, { recursive: true });
  // 0600: this directory holds two private keys.
  writeFileSync(p.caKey, ca.key, { mode: 0o600 });
  writeFileSync(p.caCert, ca.cert, { mode: 0o644 });
  writeFileSync(p.serverKey, leaf.key, { mode: 0o600 });
  writeFileSync(p.serverCert, leaf.cert, { mode: 0o644 });

  return { key: leaf.key, cert: leaf.cert, caCert: ca.cert };
}
