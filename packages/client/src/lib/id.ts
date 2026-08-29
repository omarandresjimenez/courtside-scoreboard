/**
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS or
 * localhost), but this app is designed to run over a plain
 * `http://<lan-ip>` address on match day (see AdminDashboard's
 * copyToClipboard for the same constraint) — so this falls back to
 * `crypto.getRandomValues`, which insecure contexts still expose.
 */
export function generateEventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
