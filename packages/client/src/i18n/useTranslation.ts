import { useMemo, useSyncExternalStore } from 'react';
import {
  browserLanguages,
  detectLocale,
  isSupportedLocale,
  translate,
  type Locale,
} from './locale.js';
import en from './en.js';
import es from './es.js';

const dictionaries = { en, es };

/** An admin's explicit choice (the language dropdown) overrides browser
 * detection on every load after the first — see setLocale below. */
const LOCALE_STORAGE_KEY = 'courtside:locale';

export interface Translation {
  locale: Locale;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => void;
}

/** The "current locale" as a pure function of persisted state — a stored
 * preference if one was ever set, otherwise the browser's own preference.
 * No separate in-memory copy to keep in sync: this *is* the single source
 * of truth, which is also what makes it safe to call from any number of
 * independent useTranslation() call sites without a Context provider. */
function currentLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && isSupportedLocale(stored)) return stored;
  return detectLocale(browserLanguages());
}

// Every useTranslation() call site subscribes here, so setLocale from any
// one of them (the language dropdown, wherever it's rendered) is reflected
// everywhere else on the page immediately — e.g. PlayerAutocomplete's own
// useTranslation() call picks up an AdminDashboard-driven language change
// without either component needing to know about the other.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  listeners.forEach((listener) => listener());
}

/**
 * Returns a `t()` bound to the current locale (a stored preference, or the
 * browser's own if none was ever chosen — see currentLocale above), plus
 * `setLocale` to change and persist it. Deliberately not a Context
 * provider: `currentLocale`/`setLocale` already are the shared state, kept
 * in sync across every call site via `useSyncExternalStore`, so there's
 * nothing a provider would add here beyond an unnecessary wrapper element.
 */
export function useTranslation(): Translation {
  const locale = useSyncExternalStore(subscribe, currentLocale);
  const t = useMemo(
    () => (key: string, vars?: Record<string, string | number>) =>
      translate(dictionaries, locale, key, vars),
    [locale],
  );
  return { locale, t, setLocale };
}
