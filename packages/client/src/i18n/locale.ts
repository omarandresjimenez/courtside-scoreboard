/**
 * Locale detection and lookup — deliberately hand-rolled rather than a
 * library: this app supports exactly two locales on exactly one screen (the
 * admin dashboard), which doesn't justify i18next's plural rules, ICU
 * message parsing, or lazy-loaded namespaces. `{{var}}` interpolation and a
 * two-key (singular/plural) convention cover every string this app actually
 * has.
 */

export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Each language's own name for itself (not translated) — the standard way
 * a language picker labels its own options, so a Spanish speaker recognises
 * "Español" regardless of whatever language the UI currently renders in. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
};

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Picks the first of the browser's preferred languages (most-preferred
 * first) that this app supports, matching on the primary subtag only — so
 * "es-MX" and "es-ES" both resolve to "es", same as "en-GB" resolves to
 * "en". Falls back to DEFAULT_LOCALE when nothing in the list matches, or
 * when the browser reports nothing at all.
 *
 * Takes the language list as a parameter (rather than reading
 * `navigator.languages` itself) so callers — and tests — can pass an
 * explicit list instead of stubbing global `navigator` state.
 */
export function detectLocale(languages: readonly (string | undefined)[]): Locale {
  for (const language of languages) {
    if (!language) continue;
    const primary = language.split('-')[0]?.toLowerCase();
    if (primary && isSupportedLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/** The browser's own preference order — `navigator.languages` when
 * available (more accurate: it's the user's full ranked list, not just the
 * top pick), falling back to the single `navigator.language`. */
export function browserLanguages(): readonly string[] {
  return navigator.languages && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
}

/** A translation dictionary: string leaves, nested for organisation by
 * section — see en.ts. Every locale must carry the same shape as `en`. */
export type Dictionary = { [key: string]: string | Dictionary };

function lookup(dictionary: Dictionary, path: string): string | undefined {
  const value = path
    .split('.')
    .reduce<Dictionary | string | undefined>(
      (acc, segment) => (acc && typeof acc === 'object' ? acc[segment] : undefined),
      dictionary,
    );
  return typeof value === 'string' ? value : undefined;
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Resolves `key` (dot-path, e.g. "courts.heading") against `dictionaries`
 * for `locale`, falling back to DEFAULT_LOCALE's copy of the same key if
 * the active locale is missing it (a partial translation shows the correct
 * fallback text instead of a blank), and finally to the key itself — a
 * visibly-wrong string is a much easier bug to spot than empty UI text.
 */
export function translate(
  dictionaries: Record<Locale, Dictionary>,
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const template =
    lookup(dictionaries[locale], key) ?? lookup(dictionaries[DEFAULT_LOCALE], key) ?? key;
  return vars ? interpolate(template, vars) : template;
}
