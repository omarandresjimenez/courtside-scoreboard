import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { getOrCreateLocalTlsIdentity } from './local-tls.js';

describe('getOrCreateLocalTlsIdentity', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'courtside-local-tls-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a CA and a leaf certificate signed by it', async () => {
    const identity = await getOrCreateLocalTlsIdentity(dir, 'courtside.local');

    const leaf = new X509Certificate(identity.cert);
    const ca = new X509Certificate(identity.caCert);

    expect(ca.checkIssued(ca)).toBe(true); // the CA is self-signed
    expect(leaf.checkIssued(ca)).toBe(true); // the leaf is signed by the CA, not self-signed
    expect(leaf.ca).toBe(false);
    expect(ca.ca).toBe(true);
  });

  it("lists localhost, 127.0.0.1, ::1 and the given hostname in the leaf's SAN", async () => {
    const identity = await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    const leaf = new X509Certificate(identity.cert);

    expect(leaf.subjectAltName).toContain('DNS:localhost');
    expect(leaf.subjectAltName).toContain('DNS:courtside.local');
    expect(leaf.subjectAltName).toContain('IP Address:127.0.0.1');
    // Node's X509Certificate renders ::1 in its fully expanded form.
    expect(leaf.subjectAltName).toContain('IP Address:0:0:0:0:0:0:0:1');
  });

  it('uses the given hostname as the leaf certificate CN', async () => {
    const identity = await getOrCreateLocalTlsIdentity(dir, 'my-venue.local');
    const leaf = new X509Certificate(identity.cert);
    expect(leaf.subject).toContain('CN=my-venue.local');
  });

  it('persists the CA key, CA cert, server key and server cert to disk', async () => {
    await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    expect(readdirSync(dir).sort()).toEqual([
      'ca-cert.pem',
      'ca-key.pem',
      'server-cert.pem',
      'server-key.pem',
    ]);
  });

  it('reuses the persisted identity on a second call instead of regenerating it', async () => {
    const first = await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    const second = await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    expect(second).toEqual(first);
  });

  it('regenerates the identity if a file is missing (a previous run never completed)', async () => {
    const first = await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    rmSync(path.join(dir, 'server-cert.pem'));

    const second = await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    expect(second.cert).not.toBe(first.cert);
    expect(readdirSync(dir)).toContain('server-cert.pem');
  });

  it('tolerates an interface entry Node reports as undefined', async () => {
    // os.networkInterfaces()'s type allows an undefined value per key
    // (TypeScript's index-signature typing), even though Node never
    // actually produces one in practice — covers that defensive branch.
    const spy = jest.spyOn(os, 'networkInterfaces').mockReturnValue({ eth0: undefined });
    await expect(getOrCreateLocalTlsIdentity(dir, 'courtside.local')).resolves.toBeDefined();
    spy.mockRestore();
  });

  it('regenerates the identity if an existing file is unreadable garbage', async () => {
    await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    writeFileSync(path.join(dir, 'server-cert.pem'), 'not a real cert');

    const identity = await getOrCreateLocalTlsIdentity(dir, 'courtside.local');
    // A real regeneration produces a real PEM again, not the garbage string.
    expect(identity.cert).toContain('-----BEGIN CERTIFICATE-----');
  });
});
