import { generateEventId, generateJoinCode, generateUmpireToken } from './tokens.js';

describe('generateUmpireToken', () => {
  it('produces a non-trivial, base64url-safe string', () => {
    const token = generateUmpireToken();
    expect(token.length).toBeGreaterThan(20);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a different token on every call', () => {
    expect(generateUmpireToken()).not.toBe(generateUmpireToken());
  });
});

describe('generateEventId', () => {
  it('produces a valid UUID', () => {
    expect(generateEventId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('produces a different id on every call', () => {
    expect(generateEventId()).not.toBe(generateEventId());
  });
});

describe('generateJoinCode', () => {
  it('produces a 6-character code from the unambiguous alphabet', () => {
    expect(generateJoinCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('excludes visually ambiguous characters', () => {
    const codes = Array.from({ length: 200 }, () => generateJoinCode()).join('');
    expect(codes).not.toMatch(/[0O1IL]/);
  });

  it('produces a different code on every call', () => {
    expect(generateJoinCode()).not.toBe(generateJoinCode());
  });
});
