/**
 * The Socket.io event contract — Set 07 and Set 08 of the design spec.
 * Naming these as constants (rather than raw strings scattered across the
 * server and client) keeps both sides of the wire in sync at compile time.
 */

import type { CourtPositions, Match, RetireReason, Side } from './types.js';
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

export interface ResumeFromIntervalPayload {
  matchId: string;
  eventId: string;
}

export interface StartSetPayload {
  matchId: string;
  eventId: string;
  firstServerSide: Side;
  firstServerPlayerId?: string;
  courtPositions?: CourtPositions;
}

export interface RetireMatchPayload {
  matchId: string;
  eventId: string;
  winnerSide: Side;
  /** Omitted when finalising an already-decided match — nobody retired. */
  reason?: RetireReason;
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

/**
 * WebRTC signaling relay for the court-side broadcast — see
 * StreamBroadcast/StreamViewer and registerStreamSocketHandlers. The server
 * never inspects `data`, only relays it, so it's typed loosely here rather
 * than importing DOM-only types (RTCSessionDescriptionInit,
 * RTCIceCandidateInit) into this Node-safe shared package.
 */
export const STREAM_EVENTS = {
  VIEWER_JOINED: 'stream:viewer_joined',
  VIEWER_LEFT: 'stream:viewer_left',
  BROADCASTER_LEFT: 'stream:broadcaster_left',
  OFFER: 'stream:offer',
  ANSWER: 'stream:answer',
  ICE_CANDIDATE: 'stream:ice_candidate',
  /** Pausing only flips `track.enabled` on the broadcaster, which keeps the
   * peer connection up and simply sends black frames — indistinguishable to
   * a viewer from a dark court. The paused state therefore has to travel as
   * its own signal, or the viewer shows black video with no explanation. */
  PAUSED: 'stream:paused',
  /** Told to everyone in the court's stream room the moment the umpire
   * finalises the match on it — the broadcaster acts on this by stopping
   * transmission itself, since a court camera has nothing left worth
   * sending once its match is over. */
  MATCH_FINALIZED: 'stream:match_finalized',
  /** Told to everyone in the court's stream room the moment the umpire
   * starts the match on it — a phone sitting idle on that court's broadcast
   * page, already holding camera permission from an earlier transmission,
   * acts on this by starting itself with no tap needed. A phone that has
   * never granted permission simply does nothing, same as today. */
  MATCH_STARTED: 'stream:match_started',
} as const;

/** Sent by a peer: "deliver `data` to the peer identified by `targetId`". */
export interface StreamSignalOutgoing {
  targetId: string;
  data: unknown;
}

/** Received by a peer: "here's `data` from the peer identified by `fromId`". */
export interface StreamSignalIncoming {
  fromId: string;
  data: unknown;
}

export interface StreamPeerEventPayload {
  peerId: string;
}

export interface StreamPausedPayload {
  paused: boolean;
}
