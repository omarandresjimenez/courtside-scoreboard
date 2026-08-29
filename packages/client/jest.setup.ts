import { TextDecoder, TextEncoder } from 'node:util';
import { randomUUID } from 'node:crypto';
import '@testing-library/jest-dom';

// jsdom's test environment doesn't provide these globals the way a real
// browser does; react-router needs TextEncoder/TextDecoder, and
// lib/id.ts's crypto.randomUUID branch needs it defined to exercise the
// secure-context path (its insecure-context fallback is tested separately).
if (typeof globalThis.TextEncoder === 'undefined') {
  // @ts-expect-error -- Node's TextEncoder is a compatible runtime shape for jsdom's tests.
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  // @ts-expect-error -- Node's TextDecoder is a compatible runtime shape for jsdom's tests.
  globalThis.TextDecoder = TextDecoder;
}
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    value: { ...globalThis.crypto, randomUUID },
    configurable: true,
  });
}
