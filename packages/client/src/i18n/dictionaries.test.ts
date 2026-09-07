import en from './en.js';
import es from './es.js';
import type { Dictionary } from './locale.js';
import { ELIGIBILITY_ISSUE_CODES } from '@courtside/shared';

/** Every string leaf's dot-path, e.g. "courts.heading". */
function leafPaths(dict: Dictionary, prefix = ''): string[] {
  return Object.entries(dict).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : leafPaths(value, path);
  });
}

/** `{{var}}` placeholder names referenced by a template string. */
function placeholders(template: string): string[] {
  return Array.from(template.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1]!).sort();
}

describe('en/es dictionaries', () => {
  it('have exactly the same set of keys — a translation cannot silently go missing', () => {
    expect(leafPaths(es).sort()).toEqual(leafPaths(en).sort());
  });

  it('use the same {{placeholders}} in both locales for every key, so interpolation never silently drops a value', () => {
    const enPaths = leafPaths(en);
    for (const path of enPaths) {
      const enValue = path.split('.').reduce<unknown>((acc, k) => (acc as Dictionary)[k], en);
      const esValue = path.split('.').reduce<unknown>((acc, k) => (acc as Dictionary)[k], es);
      expect(placeholders(esValue as string)).toEqual(placeholders(enValue as string));
    }
  });

  it('has no empty string values in either locale', () => {
    for (const dict of [en, es]) {
      for (const path of leafPaths(dict)) {
        const value = path.split('.').reduce<unknown>((acc, k) => (acc as Dictionary)[k], dict);
        expect(value).not.toBe('');
      }
    }
  });
});

describe('eligibility issue codes', () => {
  it('every code the validator can emit has a translation in both locales', () => {
    // Without this, adding a code in shared/players.ts and forgetting the
    // dictionary entry shows the admin the raw key — which is what
    // translate() falls back to, and reads like a bug rather than a message.
    for (const code of ELIGIBILITY_ISSUE_CODES) {
      const path = `createMatch.eligibility.${code}`;
      for (const [name, dict] of [
        ['en', en],
        ['es', es],
      ] as const) {
        const value = path.split('.').reduce<unknown>((acc, k) => (acc as Dictionary)?.[k], dict);
        // The locale name is folded into the assertion so a failure says which
        // dictionary is short, rather than just "expected string".
        expect({ locale: name, path, value }).toEqual({
          locale: name,
          path,
          value: expect.any(String),
        });
      }
    }
  });
});
