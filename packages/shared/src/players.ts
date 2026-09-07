import { parseCsv } from './csv.js';
import type { MatchType, Side } from './types.js';

/**
 * A tournament's imported player roster — the source an admin picks from
 * when creating a match, instead of retyping names that already exist in a
 * tournament-management export. See TournamentPlayer in types.ts for the
 * stored shape and AdminDashboard's "Import players" card for where this
 * gets used.
 */
export interface TournamentPlayerImportRow {
  memberId: string | null;
  firstName: string;
  lastName: string;
  gender: string | null;
  country: string | null;
  club: string | null;
  /** ISO date (yyyy-mm-dd), or null if the source left it blank. */
  birthDate: string | null;
  /** Raw slash-separated codes as imported, e.g. "MS/MD/XD". Kept raw —
   * see parseCategoryList for the parsed form. */
  categories: string | null;
  status: string | null;
}

const HEADER_ALIASES: Record<string, keyof TournamentPlayerImportRow> = {
  memberid: 'memberId',
  firstname: 'firstName',
  lastname: 'lastName',
  gender: 'gender',
  country: 'country',
  club: 'club',
  birthdate: 'birthDate',
  category: 'categories',
  categories: 'categories',
  status: 'status',
};

export interface ParsedRosterImport {
  rows: TournamentPlayerImportRow[];
  /** Rows dropped for missing a first or last name — the only two fields
   * this app cannot function without; everything else may be blank. */
  skipped: number;
}

/**
 * Parses a tournament-software CSV export into rows ready to send to
 * `POST /api/tournament-players/import`. Column order doesn't matter and
 * unknown columns are ignored — only the header names in HEADER_ALIASES
 * (matched case-insensitively) are read.
 */
export function parseTournamentPlayersCsv(text: string): ParsedRosterImport {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], skipped: 0 };

  // Safe: the length check above guarantees a first row exists.
  const headerRow = table[0]!;
  const columns = headerRow.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);

  const rows: TournamentPlayerImportRow[] = [];
  let skipped = 0;

  for (const line of table.slice(1)) {
    const record: Partial<Record<keyof TournamentPlayerImportRow, string>> = {};
    columns.forEach((key, index) => {
      if (!key) return;
      const value = line[index]?.trim();
      if (value) record[key] = value;
    });

    const firstName = record.firstName?.trim();
    const lastName = record.lastName?.trim();
    if (!firstName || !lastName) {
      skipped += 1;
      continue;
    }

    rows.push({
      memberId: record.memberId ?? null,
      firstName,
      lastName,
      gender: record.gender?.toUpperCase() ?? null,
      country: record.country ?? null,
      club: record.club ?? null,
      birthDate: normalizeBirthDate(record.birthDate),
      categories: record.categories ?? null,
      status: record.status ?? null,
    });
  }

  return { rows, skipped };
}

/** Accepts yyyy-mm-dd as-is; tolerates dd/mm/yyyy exports by detecting the
 * slash form. Anything else unparseable is dropped rather than guessed at. */
function normalizeBirthDate(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`;
  }
  return null;
}

/**
 * Splits an imported category cell into its individual codes: "MS/MD/XD"
 * becomes ["MS", "MD", "XD"]. Tolerates commas or semicolons too, since not
 * every tournament export uses the same separator.
 */
export function parseCategoryList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[/,;]/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

export interface CategoryCode {
  /** 'M' (men's), 'W' (women's), 'X' (mixed) — null when the code doesn't
   * carry a discipline+gender prefix (e.g. an age-only category). */
  genderCode: 'M' | 'W' | 'X' | null;
  /** 'S' (singles) or 'D' (doubles) — null alongside genderCode. */
  disciplineCode: 'S' | 'D' | null;
  /** The number after a "U" token (e.g. "U19" -> 19), or null if absent. */
  ageLimit: number | null;
}

/**
 * Reads the two conventions a category string commonly carries — a
 * discipline+gender prefix (MS/WS/MD/WD/XD) and an age cap (U13, U19, …) —
 * wherever they appear in the string, in whatever order. Either or both
 * can be absent; validateMatchEligibility only checks what it finds.
 */
export function parseCategoryCode(category: string | null | undefined): CategoryCode {
  const text = category?.toUpperCase() ?? '';
  const disciplineMatch = /\b([MWX])([SD])\b/.exec(text);
  const ageMatch = /\bU(\d{1,2})\b/.exec(text);

  return {
    genderCode: (disciplineMatch?.[1] as CategoryCode['genderCode']) ?? null,
    disciplineCode: (disciplineMatch?.[2] as CategoryCode['disciplineCode']) ?? null,
    ageLimit: ageMatch?.[1] ? Number(ageMatch[1]) : null,
  };
}

/** What validateMatchEligibility knows about one assigned player — a subset
 * of TournamentPlayer, since a manually-entered player (no roster match)
 * simply omits everything but `side` and skips every check below. */
export interface EligibilityPlayer {
  side: Side;
  gender?: string | null;
  birthDate?: string | null;
  categories?: string | null;
}

/**
 * Why a line-up was rejected, as a code rather than a sentence.
 *
 * These are shown to the admin, whose dashboard is translated — so the text
 * cannot be built here. This package is framework-free and has no dictionary
 * of its own, and the server that calls it has no idea what language the
 * browser is in. The client translates from `code` + `params` instead.
 *
 * Gender and discipline each get their own code rather than being passed as a
 * parameter, because they would otherwise be English words interpolated into a
 * Spanish sentence — and `translate()` does plain `{{var}}` substitution, with
 * no select/plural form to resolve them properly.
 */
export const ELIGIBILITY_ISSUE_CODES = [
  'categoryNeedsSingles',
  'categoryNeedsDoubles',
  'notRegistered',
  'genderNotAcceptedMale',
  'genderNotAcceptedFemale',
  'tooOld',
  'mixedDoublesSide',
] as const;

/** Derived from the array above rather than declared separately, so the two
 *  cannot drift — the list exists at runtime for the dictionary-coverage test
 *  in the client, which a bare union could not provide. */
export type EligibilityIssueCode = (typeof ELIGIBILITY_ISSUE_CODES)[number];

export interface EligibilityIssue {
  side?: Side;
  code: EligibilityIssueCode;
  /** Interpolated into the translated message by the client. */
  params: Record<string, string | number>;
  /**
   * English rendering of the same thing. Kept because the API answers with a
   * plain `error` string that non-browser callers (and the server's own logs)
   * still need to be readable — the dashboard ignores it and uses `code`.
   */
  message: string;
}

/**
 * Checks a proposed match line-up against what the tournament roster
 * (import) knows about each player: does their registered category list
 * include the category being assigned, does their gender fit the
 * category's M/W/X code, and — for an age-capped category like "U13" —
 * are they young enough. Age is judged by calendar year (tournamentDate's
 * year minus birth year), the common junior-badminton convention, not exact
 * birthday-to-birthday age.
 *
 * Only exercises checks it has data for: a player missing gender, birthDate
 * or categories (manual entry, or an import column left blank) silently
 * skips the checks that need it — "use the data available", not a hard
 * requirement that every field be present.
 */
export function validateMatchEligibility(
  matchType: MatchType,
  category: string | null | undefined,
  players: EligibilityPlayer[],
  tournamentDate: Date = new Date(),
): EligibilityIssue[] {
  const issues: EligibilityIssue[] = [];
  if (!category) return issues;

  const code = parseCategoryCode(category);

  if (code.disciplineCode) {
    const expected: MatchType = code.disciplineCode === 'S' ? 'singles' : 'doubles';
    if (expected !== matchType) {
      issues.push({
        code: expected === 'singles' ? 'categoryNeedsSingles' : 'categoryNeedsDoubles',
        params: { category },
        message: `Category "${category}" is ${expected}, but this match is set up as ${matchType}.`,
      });
    }
  }

  for (const player of players) {
    if (player.categories) {
      const registered = parseCategoryList(player.categories);
      if (registered.length > 0 && !registered.includes(category.toUpperCase())) {
        issues.push({
          side: player.side,
          code: 'notRegistered',
          params: { side: player.side, category },
          message: `A player on side ${player.side} is not registered for category "${category}".`,
        });
      }
    }

    if (code.genderCode && code.genderCode !== 'X' && player.gender) {
      const expectedGender = code.genderCode === 'M' ? 'M' : 'F';
      if (player.gender.toUpperCase() !== expectedGender) {
        const isMale = player.gender.toUpperCase() === 'M';
        issues.push({
          side: player.side,
          code: isMale ? 'genderNotAcceptedMale' : 'genderNotAcceptedFemale',
          params: { side: player.side, category },
          message: `Category "${category}" does not accept a ${
            isMale ? 'male' : 'female'
          } player (side ${player.side}).`,
        });
      }
    }

    if (code.ageLimit && player.birthDate) {
      const birthYear = new Date(player.birthDate).getFullYear();
      if (!Number.isNaN(birthYear)) {
        const age = tournamentDate.getFullYear() - birthYear;
        if (age >= code.ageLimit) {
          issues.push({
            side: player.side,
            code: 'tooOld',
            params: { side: player.side, category, ageLimit: code.ageLimit },
            message: `A player on side ${player.side} is too old for category "${category}" (Under ${code.ageLimit}).`,
          });
        }
      }
    }
  }

  // Mixed doubles: each side must actually be mixed, not merely "some of
  // the four players are". Checked per side rather than across the whole
  // match, since a side of two women beside a side of two men would
  // otherwise average out to "looks mixed overall".
  if (code.genderCode === 'X' && code.disciplineCode === 'D') {
    for (const side of ['A', 'B'] as const) {
      const sidePlayers = players.filter((p) => p.side === side && p.gender);
      if (sidePlayers.length < 2) continue;
      const genders = new Set(sidePlayers.map((p) => p.gender?.toUpperCase()));
      if (!genders.has('M') || !genders.has('F')) {
        issues.push({
          side,
          code: 'mixedDoublesSide',
          params: { side },
          message: `Mixed doubles needs one male and one female player on side ${side}.`,
        });
      }
    }
  }

  return issues;
}
