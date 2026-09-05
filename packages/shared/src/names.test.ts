import { formatPlayerName, formatSideNames } from './names.js';

const player = (over: Partial<Parameters<typeof formatPlayerName>[0]> = {}) => ({
  name: 'Juan',
  lastName: 'Pérez',
  shortName: 'JPE',
  ...over,
});

describe('formatPlayerName', () => {
  it('renders an initial and the family name', () => {
    expect(formatPlayerName(player())).toBe('J. Pérez');
  });

  it('uppercases the initial regardless of how it was typed', () => {
    expect(formatPlayerName(player({ name: 'juan' }))).toBe('J. Pérez');
  });

  it('keeps accents and multi-word family names intact', () => {
    expect(formatPlayerName(player({ name: 'ángela', lastName: 'de la Cruz' }))).toBe(
      'Á. de la Cruz',
    );
  });

  it('trims stray whitespace from either field', () => {
    expect(formatPlayerName(player({ name: '  Juan  ', lastName: ' Pérez ' }))).toBe('J. Pérez');
  });

  it('splits a legacy full name held in `name`', () => {
    // Rows created before first/last name were captured separately must not
    // render differently from the rows beside them.
    expect(formatPlayerName(player({ name: 'Alice Adams', lastName: '' }))).toBe('A. Adams');
  });

  it('uses the last word as the family name in a legacy three-part name', () => {
    expect(formatPlayerName(player({ name: 'Maria del Bosque', lastName: '' }))).toBe('M. Bosque');
  });

  it('returns a single legacy name unchanged rather than inventing an initial', () => {
    expect(formatPlayerName(player({ name: 'Prakash', lastName: '' }))).toBe('Prakash');
  });

  it('falls back to the family name alone when there is no given name', () => {
    expect(formatPlayerName(player({ name: '', lastName: 'Pérez' }))).toBe('Pérez');
  });

  it('falls back to the short name when nothing else is usable', () => {
    expect(formatPlayerName(player({ name: '', lastName: '', shortName: 'JPE' }))).toBe('JPE');
  });

  it('returns an empty string when there is genuinely nothing', () => {
    expect(formatPlayerName({ name: '', lastName: '', shortName: '' })).toBe('');
  });
});

describe('formatSideNames', () => {
  const roster = [
    { side: 'A' as const, name: 'Juan', lastName: 'Pérez', shortName: 'JPE' },
    { side: 'A' as const, name: 'Ana', lastName: 'Gómez', shortName: 'AGO' },
    { side: 'B' as const, name: 'Bilal', lastName: 'Bruno', shortName: 'BBR' },
  ];

  it('joins a doubles pair', () => {
    expect(formatSideNames(roster, 'A')).toBe('J. Pérez / A. Gómez');
  });

  it('renders a singles side alone', () => {
    expect(formatSideNames(roster, 'B')).toBe('B. Bruno');
  });

  it('falls back to the side letter when a side has no players', () => {
    expect(formatSideNames([], 'A')).toBe('A');
  });

  it('accepts a caller-supplied fallback for roomier layouts', () => {
    expect(formatSideNames([], 'A', 'Side A')).toBe('Side A');
  });

  it('skips players that render to nothing rather than leaving a stray slash', () => {
    const withBlank = [
      { side: 'A' as const, name: 'Juan', lastName: 'Pérez', shortName: 'JPE' },
      { side: 'A' as const, name: '', lastName: '', shortName: '' },
    ];
    expect(formatSideNames(withBlank, 'A')).toBe('J. Pérez');
  });
});
