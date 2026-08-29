/**
 * Core domain types for Courtside Scoreboard.
 *
 * These mirror "Set 06 — Data model" of the design spec: Match, Player, Court
 * are stored entities; Set and ServeState are always *derived* from the
 * ScoreEvent log (see scoring.ts) rather than stored directly.
 */

export type Side = 'A' | 'B';

export type MatchType = 'singles' | 'doubles';

export type MatchStatus = 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

/** Per-match scoring rules, set once at creation and locked after the first point. */
export interface ScoringConfig {
  pointsToWin: number;
  capScore: number;
  intervalAt: number;
}

/** Named presets shown in the "create match" form; "custom" enters raw values. */
export const SCORING_PRESETS = {
  standard: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
  short: { pointsToWin: 15, capScore: 21, intervalAt: 8 },
} as const satisfies Record<string, ScoringConfig>;

export type ScoringPresetName = keyof typeof SCORING_PRESETS | 'custom';

export interface Player {
  playerId: string;
  side: Side;
  name: string;
  /** Used on space-constrained TV layouts. */
  shortName: string;
}

export interface Court {
  courtId: string;
  tournamentId?: string | null;
  label: string;
  /** The live pointer a TV screen follows. Null when the court is idle. */
  currentMatchId: string | null;
  /** Short, human-typeable code for the /tv join screen — stable for the court's lifetime. */
  tvCode: string;
}

export interface Tournament {
  tournamentId: string;
  name: string;
  date: string;
}

export interface Match {
  matchId: string;
  tournamentId?: string | null;
  matchType: MatchType;
  status: MatchStatus;
  scoringConfig: ScoringConfig;
  /** Flips true on the first POINT event; locks matchType/scoringConfig edits. */
  scoringLocked: boolean;
  players: Player[];
  /** Long random secret. Required on every umpire write action. */
  umpireToken: string;
  /** Short, human-typeable code that resolves to matchId + umpireToken on the /umpire join screen. */
  umpireCode: string;
  /** Last (or current) court this match was played on, for history display. */
  assignedCourtId: string | null;
  /** Resolved court label for the live umpire and TV displays. */
  courtLabel?: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type ScoreEventType =
  'START_SET' | 'POINT' | 'UNDO_LAST_POINT' | 'RETIRE' | 'RESUME_INTERVAL';

/** Doubles-only: which partner currently occupies which service court, per side. */
export type CourtPositions = Partial<Record<Side, { right: string; left: string }>>;

/**
 * The append-only log entry — the single source of truth for a match.
 * Every other piece of match state (score, set/match winner, serve position,
 * interval flags) is derived by replaying these in order. See deriveMatchState().
 */
/** A safe, list-view projection of Match — deliberately omits umpireToken. */
export interface MatchSummary {
  matchId: string;
  tournamentId?: string | null;
  matchType: MatchType;
  status: MatchStatus;
  assignedCourtId: string | null;
  courtLabel: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  players: Player[];
  derived: DerivedMatchSummary;
}

export interface MatchSetSummary {
  setNumber: number;
  scoreA: number;
  scoreB: number;
  winner: Side | null;
}

export interface DerivedMatchSummary {
  sets: MatchSetSummary[];
  setsWon: Record<Side, number>;
  matchWinner: Side | null;
}

export interface ScoreEvent {
  eventId: string;
  matchId: string;
  type: ScoreEventType;
  /** POINT: who scored. RETIRE: the declared winner. */
  side?: Side;
  /** START_SET only. */
  firstServerPlayerId?: string;
  /** START_SET only; needed for singles, where no doubles court layout exists. */
  firstServerSide?: Side;
  /** START_SET only, doubles matches. */
  courtPositions?: CourtPositions;
  timestamp: number;
}
