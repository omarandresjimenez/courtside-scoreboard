import {
  DEFAULT_LOCALE,
  browserLanguages,
  detectLocale,
  translate,
  type Dictionary,
  type Locale,
} from './locale.js';

describe('detectLocale', () => {
  it('picks a supported locale from the browser list', () => {
    expect(detectLocale(['es-MX', 'en-US'])).toBe('es');
  });

  it('matches on the primary subtag, not the full region-specific tag', () => {
    expect(detectLocale(['en-GB'])).toBe('en');
    expect(detectLocale(['es-AR'])).toBe('es');
  });

  it('is case-insensitive', () => {
    expect(detectLocale(['ES-mx'])).toBe('es');
  });

  it('skips an unsupported language to find a supported one further down the list', () => {
    expect(detectLocale(['fr-FR', 'de-DE', 'es-ES'])).toBe('es');
  });

  it('falls back to the default locale when nothing supported is found', () => {
    expect(detectLocale(['fr-FR', 'de-DE'])).toBe(DEFAULT_LOCALE);
  });

  it('falls back to the default locale for an empty list', () => {
    expect(detectLocale([])).toBe(DEFAULT_LOCALE);
  });

  it('tolerates undefined entries in the list', () => {
    expect(detectLocale([undefined, 'es-ES'])).toBe('es');
  });
});

describe('browserLanguages', () => {
  const original = { languages: navigator.languages, language: navigator.language };

  afterEach(() => {
    Object.defineProperty(navigator, 'languages', {
      value: original.languages,
      configurable: true,
    });
    Object.defineProperty(navigator, 'language', { value: original.language, configurable: true });
  });

  it("prefers the browser's full ranked list when present", () => {
    Object.defineProperty(navigator, 'languages', {
      value: ['es-MX', 'en-US'],
      configurable: true,
    });

    expect(browserLanguages()).toEqual(['es-MX', 'en-US']);
  });

  it('falls back to the single navigator.language when the list is empty', () => {
    Object.defineProperty(navigator, 'languages', { value: [], configurable: true });
    Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });

    expect(browserLanguages()).toEqual(['fr-FR']);
  });
});

describe('translate', () => {
  const dictionaries: Record<Locale, Dictionary> = {
    en: { greeting: 'Hello, {{name}}!', nested: { label: 'Nested label' } },
    es: { greeting: 'Hola, {{name}}!' },
  };

  it('resolves a top-level key for the active locale', () => {
    expect(translate(dictionaries, 'es', 'greeting', { name: 'Ana' })).toBe('Hola, Ana!');
  });

  it('resolves a nested (dot-path) key', () => {
    expect(translate(dictionaries, 'en', 'nested.label')).toBe('Nested label');
  });

  it("falls back to the default locale's copy when the active locale is missing the key", () => {
    expect(translate(dictionaries, 'es', 'nested.label')).toBe('Nested label');
  });

  it('falls back to the key itself when neither locale has it', () => {
    expect(translate(dictionaries, 'es', 'nothing.here')).toBe('nothing.here');
  });

  it('leaves an unmatched placeholder untouched rather than dropping it', () => {
    expect(translate(dictionaries, 'en', 'greeting', {})).toBe('Hello, {{name}}!');
  });

  it('does not attempt interpolation when no vars are given', () => {
    expect(translate(dictionaries, 'en', 'greeting')).toBe('Hello, {{name}}!');
  });
});
