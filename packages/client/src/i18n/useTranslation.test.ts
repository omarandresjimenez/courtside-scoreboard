import { act, renderHook } from '@testing-library/react';
import { useTranslation } from './useTranslation.js';

function stubLanguages(languages: string[]) {
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(navigator, 'language', {
    value: languages[0] ?? 'en-US',
    configurable: true,
  });
}

describe('useTranslation', () => {
  const original = { languages: navigator.languages, language: navigator.language };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'languages', {
      value: original.languages,
      configurable: true,
    });
    Object.defineProperty(navigator, 'language', { value: original.language, configurable: true });
  });

  it('resolves English text when the browser prefers English', () => {
    stubLanguages(['en-US']);
    const { result } = renderHook(() => useTranslation());

    expect(result.current.locale).toBe('en');
    expect(result.current.t('courts.heading')).toBe('Courts');
  });

  it('resolves Spanish text when the browser prefers Spanish', () => {
    stubLanguages(['es-MX']);
    const { result } = renderHook(() => useTranslation());

    expect(result.current.locale).toBe('es');
    expect(result.current.t('courts.heading')).toBe('Canchas');
  });

  it('falls back to English when the browser prefers an unsupported language', () => {
    stubLanguages(['fr-FR']);
    const { result } = renderHook(() => useTranslation());

    expect(result.current.locale).toBe('en');
  });

  it('interpolates vars into the resolved template', () => {
    stubLanguages(['en-US']);
    const { result } = renderHook(() => useTranslation());

    expect(result.current.t('courts.copyTvLink', { label: 'Center Court' })).toBe(
      'Copy TV link for Center Court',
    );
  });

  it('switches locale immediately when setLocale is called', () => {
    stubLanguages(['en-US']);
    const { result } = renderHook(() => useTranslation());

    act(() => result.current.setLocale('es'));

    expect(result.current.locale).toBe('es');
    expect(result.current.t('courts.heading')).toBe('Canchas');
  });

  it('persists an explicit choice, overriding the browser language on the next mount', () => {
    stubLanguages(['en-US']);
    const first = renderHook(() => useTranslation());
    act(() => first.result.current.setLocale('es'));

    // A fresh mount — e.g. a page reload — must honour the saved choice
    // rather than re-detecting from the browser.
    const second = renderHook(() => useTranslation());

    expect(second.result.current.locale).toBe('es');
  });

  it('an explicit choice made through one call site is reflected by every other one already mounted', () => {
    stubLanguages(['en-US']);
    const admin = renderHook(() => useTranslation());
    const playerAutocomplete = renderHook(() => useTranslation());
    expect(playerAutocomplete.result.current.locale).toBe('en');

    act(() => admin.result.current.setLocale('es'));

    expect(playerAutocomplete.result.current.locale).toBe('es');
  });

  it('ignores a corrupted stored value instead of throwing, falling back to the browser language', () => {
    localStorage.setItem('courtside:locale', 'not-a-real-locale');
    stubLanguages(['es-ES']);

    const { result } = renderHook(() => useTranslation());

    expect(result.current.locale).toBe('es');
  });
});
