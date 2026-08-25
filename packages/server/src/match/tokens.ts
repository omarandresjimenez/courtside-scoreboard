import { randomBytes, randomUUID } from 'node:crypto';

/** A long, unguessable secret for the umpire link/QR — see Set 08. */
export function generateUmpireToken(): string {
  return randomBytes(24).toString('base64url');
}

export function generateEventId(): string {
  return randomUUID();
}
