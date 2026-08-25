/**
 * The Socket.io event contract — Set 07 and Set 08 of the design spec.
 * Naming these as constants (rather than raw strings scattered across the
 * server and client) keeps both sides of the wire in sync at compile time.
 */

import type { CourtPositions, Match, Side } from './types.js';
import type { DerivedMatchState } from './scoring.js';

export const UMPIRE_EVENTS = {
  ADD_POINT: 'umpire:add_point',
  UNDO_LAST_POINT: 'umpire:undo_last_point',
  START_SET: 'umpire:start_set',
  RESUME_FROM_INTERVAL: 'umpire:resume_from_interval',
  RETIRE_MATCH: 'umpire:retire_match',
} as const;

export const ADMIN_EVENTS = {
  EDIT_MATCH_DETAILS: 'admin:edit_match_details',
  EDIT_SCORING_CONFIG: 'admin:edit_scoring_config',
  CANCEL_MATCH: 'admin:cancel_match',
  ASSIGN_MATCH_TO_COURT: 'admin:assign_match_to_court',
} as const;

export const TV_EVENTS = {
  SUBSCRIBE_COURT: 'tv:subscribe_court',
} as const;

export const SERVER_EVENTS = {
  /** Full derived state, sent on connect and after every change — see Set 07. */
  MATCH_STATE: 'server:match_state',
  MATCH_NOT_FOUND: 'server:match_not_found',
  ERROR: 'server:error',
} as const;

export interface AddPointPayload {
  matchId: string;
  eventId: string;
  side: Side;
}

export interface UndoLastPointPayload {
  matchId: string;
  eventId: string;
}

export interface StartSetPayload {
  matchId: string;
  eventId: string;
  firstServerPlayerId?: string;
  courtPositions?: CourtPositions;
}

export interface RetireMatchPayload {
  matchId: string;
  eventId: string;
  winnerSide: Side;
}

export interface AssignMatchToCourtPayload {
  courtId: string;
  matchId: string | null;
}

export interface SubscribeCourtPayload {
  courtId: string;
}

/** What SERVER_EVENTS.MATCH_STATE carries — the full picture for one match. */
export interface MatchStatePayload {
  match: Match;
  derived: DerivedMatchState;
}
