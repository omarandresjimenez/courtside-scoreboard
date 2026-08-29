import { randomBytes, randomUUID } from 'node:crypto';

/** A long, unguessable secret for the umpire link/QR — see Set 08. */
export function generateUmpireToken(): string {
  return randomBytes(24).toString('base64url');
}

export function generateEventId(): string {
  return randomUUID();
}

// 32 characters, no 0/O/1/I/L — nothing that looks like another character
// when read off a screen or a printout. 256 % 32 === 0, so mapping a random
// byte onto this alphabet via modulo carries no bias.
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH = 6;

/**
 * A short, human-typeable code for the /tv and /umpire join screens — the
 * alternative to copying a full URL between the admin machine and a
 * separate TV or umpire device. 32^6 (~1.07 billion) combinations is far
 * more than any LAN-only, single-event brute-force is going to work through.
 */
export function generateJoinCode(): string {
  const bytes = randomBytes(JOIN_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) {
    code += JOIN_CODE_ALPHABET[bytes[i]! % JOIN_CODE_ALPHABET.length];
  }
  return code;
}
