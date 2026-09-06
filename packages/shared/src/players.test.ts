import {
  parseCategoryCode,
  parseCategoryList,
  parseTournamentPlayersCsv,
  validateMatchEligibility,
  type EligibilityPlayer,
} from './players.js';

const SAMPLE_CSV = `MemberID,FirstName,LastName,Gender,Country,Club,BirthDate,Category,Status
19940812,John,Doe,M,USA,Bay Badminton Club,1994-08-12,MS/MD,Accepted
19961123,Jane,Smith,F,CAN,Vancouver BC,1996-11-23,WS/WD,Accepted
20010405,Lee,Zhii,M,MAS,KL Academy,2001-04-05,MS,Accepted
19980719,Anna,Müller,F,GER,Munich BC,1998-07-19,WS/XD,Reserve
20001201,Carlos,Gomez,M,ESP,Madrid Badminton,2000-12-01,MS/MD/XD,Accepted`;

describe('parseTournamentPlayersCsv', () => {
  it('parses every column of a well-formed row', () => {
    const { rows } = parseTournamentPlayersCsv(SAMPLE_CSV);
    expect(rows[0]).toEqual({
      memberId: '19940812',
      firstName: 'John',
      lastName: 'Doe',
      gender: 'M',
      country: 'USA',
      club: 'Bay Badminton Club',
      birthDate: '1994-08-12',
      categories: 'MS/MD',
      status: 'Accepted',
    });
  });

  it('parses all five sample rows', () => {
    const { rows, skipped } = parseTournamentPlayersCsv(SAMPLE_CSV);
    expect(rows).toHaveLength(5);
    expect(skipped).toBe(0);
  });

  it('matches headers case-insensitively and in any order', () => {
    const csv = 'lastname,firstname\nDoe,John';
    const { rows } = parseTournamentPlayersCsv(csv);
    expect(rows).toEqual([
      {
        memberId: null,
        firstName: 'John',
        lastName: 'Doe',
        gender: null,
        country: null,
        club: null,
        birthDate: null,
        categories: null,
        status: null,
      },
    ]);
  });

  it('ignores unrecognized columns', () => {
    const csv = 'FirstName,Ranking,LastName\nJohn,42,Doe';
    const { rows } = parseTournamentPlayersCsv(csv);
    expect(rows[0]?.firstName).toBe('John');
    expect(rows[0]?.lastName).toBe('Doe');
  });

  it('skips rows missing a first or last name', () => {
    const csv = 'FirstName,LastName\nJohn,\n,Doe\nJane,Smith';
    const { rows, skipped } = parseTournamentPlayersCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.firstName).toBe('Jane');
    expect(skipped).toBe(2);
  });

  it('normalizes a dd/mm/yyyy birth date to ISO', () => {
    const csv = 'FirstName,LastName,BirthDate\nJohn,Doe,05/04/2001';
    const { rows } = parseTournamentPlayersCsv(csv);
    expect(rows[0]?.birthDate).toBe('2001-04-05');
  });

  it('drops a birth date it cannot parse', () => {
    const csv = 'FirstName,LastName,BirthDate\nJohn,Doe,not-a-date';
    const { rows } = parseTournamentPlayersCsv(csv);
    expect(rows[0]?.birthDate).toBeNull();
  });

  it('returns nothing for an empty file', () => {
    expect(parseTournamentPlayersCsv('')).toEqual({ rows: [], skipped: 0 });
  });
});

describe('parseCategoryList', () => {
  it('splits a slash-separated cell', () => {
    expect(parseCategoryList('MS/MD/XD')).toEqual(['MS', 'MD', 'XD']);
  });

  it('tolerates commas and semicolons', () => {
    expect(parseCategoryList('MS, MD; XD')).toEqual(['MS', 'MD', 'XD']);
  });

  it('returns an empty array for nothing', () => {
    expect(parseCategoryList(null)).toEqual([]);
    expect(parseCategoryList('')).toEqual([]);
  });
});

describe('parseCategoryCode', () => {
  it('reads gender, discipline and age from "MS U19"', () => {
    expect(parseCategoryCode('MS U19')).toEqual({
      genderCode: 'M',
      disciplineCode: 'S',
      ageLimit: 19,
    });
  });

  it('reads them in the opposite order too', () => {
    expect(parseCategoryCode('U15 WD')).toEqual({
      genderCode: 'W',
      disciplineCode: 'D',
      ageLimit: 15,
    });
  });

  it('leaves gender/discipline null for an age-only category', () => {
    expect(parseCategoryCode('U13')).toEqual({
      genderCode: null,
      disciplineCode: null,
      ageLimit: 13,
    });
  });

  it('leaves everything null for free text with no recognizable code', () => {
    expect(parseCategoryCode('Open division')).toEqual({
      genderCode: null,
      disciplineCode: null,
      ageLimit: null,
    });
  });

  it('handles a bare discipline code with no age', () => {
    expect(parseCategoryCode('XD')).toEqual({ genderCode: 'X', disciplineCode: 'D', ageLimit: null });
  });

  it('handles a missing category', () => {
    expect(parseCategoryCode(null)).toEqual({ genderCode: null, disciplineCode: null, ageLimit: null });
    expect(parseCategoryCode(undefined)).toEqual({
      genderCode: null,
      disciplineCode: null,
      ageLimit: null,
    });
  });
});

describe('validateMatchEligibility', () => {
  const male: EligibilityPlayer = { side: 'A', gender: 'M', categories: 'MS/MD' };
  const female: EligibilityPlayer = { side: 'B', gender: 'F', categories: 'WS/WD' };

  it('passes a men\'s singles match with two male players', () => {
    const opponent: EligibilityPlayer = { side: 'B', gender: 'M', categories: 'MS/MD' };
    expect(validateMatchEligibility('singles', 'MS', [male, opponent])).toEqual([]);
  });

  it('rejects a female player in a men\'s singles category', () => {
    const issues = validateMatchEligibility('singles', 'MS', [male, female]);
    expect(issues).toContainEqual(
      expect.objectContaining({ side: 'B', message: expect.stringContaining('does not accept a female') }),
    );
  });

  it('rejects a male player in a women\'s singles category', () => {
    const issues = validateMatchEligibility('singles', 'WS', [male, female]);
    expect(issues).toContainEqual(
      expect.objectContaining({ side: 'A', message: expect.stringContaining('does not accept a male') }),
    );
  });

  it('rejects a category not on the player\'s registered list', () => {
    const issues = validateMatchEligibility('doubles', 'XD', [
      { side: 'A', gender: 'M', categories: 'MS/MD' },
      { side: 'B', gender: 'F', categories: 'WS/WD' },
    ]);
    expect(issues.some((i) => i.message.includes('not registered for category'))).toBe(true);
  });

  it('rejects a singles category assigned to a doubles match', () => {
    const issues = validateMatchEligibility('doubles', 'MS', [male, male]);
    expect(issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('is singles, but this match') }),
    );
  });

  it('rejects a player too old for a U13 category', () => {
    const issues = validateMatchEligibility(
      'singles',
      'U13',
      [
        { side: 'A', birthDate: '2013-01-01' },
        { side: 'B', birthDate: '1995-01-01' },
      ],
      new Date('2024-06-01'),
    );
    expect(issues.some((i) => i.side === 'B' && i.message.includes('too old'))).toBe(true);
    expect(issues.some((i) => i.side === 'A')).toBe(false);
  });

  it('requires one male and one female per side for mixed doubles', () => {
    const issues = validateMatchEligibility('doubles', 'XD', [
      { side: 'A', gender: 'M' },
      { side: 'A', gender: 'M' },
      { side: 'B', gender: 'M' },
      { side: 'B', gender: 'F' },
    ]);
    expect(issues.some((i) => i.side === 'A' && i.message.includes('Mixed doubles'))).toBe(true);
    expect(issues.some((i) => i.side === 'B' && i.message.includes('Mixed doubles'))).toBe(false);
  });

  it('skips every check for a player with no roster data', () => {
    expect(
      validateMatchEligibility('singles', 'MS', [{ side: 'A' }, { side: 'B' }]),
    ).toEqual([]);
  });

  it('returns no issues when no category is set', () => {
    expect(validateMatchEligibility('singles', null, [male, female])).toEqual([]);
  });

  it('passes a player young enough for a U13 category', () => {
    const issues = validateMatchEligibility(
      'singles',
      'U13',
      [{ side: 'A', birthDate: '2013-01-01' }],
      new Date('2024-06-01'),
    );
    expect(issues).toEqual([]);
  });

  it('does not flag registration when the player has no registered categories at all', () => {
    const issues = validateMatchEligibility('singles', 'MS', [
      { side: 'A', gender: 'M', categories: '' },
      { side: 'B', gender: 'M', categories: '' },
    ]);
    expect(issues).toEqual([]);
  });

  it('ignores a lone player on a side for the mixed-doubles gender-mix check', () => {
    const issues = validateMatchEligibility('doubles', 'XD', [
      { side: 'A', gender: 'M' },
      { side: 'B', gender: 'M' },
      { side: 'B', gender: 'F' },
    ]);
    expect(issues.some((i) => i.side === 'A')).toBe(false);
  });
});
