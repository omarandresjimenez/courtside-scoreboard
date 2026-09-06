import { useSyncExternalStore } from 'react';

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'dark';

const THEME_STORAGE_KEY = 'courtside:theme';

function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

/** The current theme as a pure function of persisted state — same pattern
 * as i18n/useTranslation.ts's currentLocale(), for the same reason: no
 * separate in-memory copy to keep in sync, and it's what lets every
 * useTheme() call site share one value without a Context provider. Unlike
 * language, there's no "browser preference" fallback — the product default
 * is simply dark until an admin picks otherwise. */
function currentTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored && isTheme(stored) ? stored : DEFAULT_THEME;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  listeners.forEach((listener) => listener());
}

export interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/** Admin-dashboard-only theme preference (light/dark), defaulting to dark
 * and persisted across reloads once explicitly changed — see the `<select>`
 * in AdminDashboard's header. Applied by setting `data-theme` on the
 * dashboard's own root element, which the light-theme CSS overrides are
 * scoped under (see styles.css), so it never affects any other screen. */
export function useTheme(): ThemeState {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  return { theme, setTheme };
}
