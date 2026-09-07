// Modular entry points, not the `import admin from 'firebase-admin'`
// namespace: under ESM, firebase-admin v14's default export carries no
// `.credential`, so the old `admin.credential.cert(...)` form threw
// "Cannot read properties of undefined (reading 'cert')" and left cloud sync
// silently disabled even with every credential correctly set.
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let db: Firestore | undefined;
let isInitialized = false;

/**
 * Initialize Firebase Admin SDK
 */
export function initializeCloudServices() {
  if (isInitialized) return;

  try {
    // Only initialize if credentials are available. All three are checked
    // because cert() requires all three — omitting clientEmail here used to
    // let a half-configured install reach cert() and fail there instead.
    if (
      !process.env.FIREBASE_PROJECT_ID ||
      !process.env.FIREBASE_PRIVATE_KEY ||
      !process.env.FIREBASE_CLIENT_EMAIL
    ) {
      console.warn('[Cloud] Firebase credentials not found - cloud sync disabled');
      isInitialized = false;
      return;
    }

    // cert() wants exactly these three; the other service-account JSON fields
    // (private_key_id, client_id, the OAuth URLs) are not part of its input.
    // The \n unescaping matters because a PEM key spanning multiple lines has
    // to survive being stored as a single-line .env value.
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };

    // Guarded so a re-entry (tests, a server restart in-process) doesn't throw
    // on a duplicate default app.
    if (getApps().length === 0) {
      initializeApp({ credential: cert(serviceAccount) });
    }

    db = getFirestore();
    isInitialized = true;
    console.log('[Cloud] Firebase initialized');
  } catch (error) {
    console.error('[Cloud] Firebase initialization failed:', error);
    isInitialized = false;
  }
}

/**
 * The Firestore handle, or undefined when cloud sync is not configured.
 *
 * Exposed so other integrations can read their own remote configuration
 * without each one re-initialising the Admin SDK. Callers must treat
 * `undefined` as "no cloud" and carry on — it is the normal state for a venue
 * running purely on the LAN.
 */
export function getCloudDb(): Firestore | undefined {
  return isInitialized ? db : undefined;
}

/**
 * The public projection of a match — what a Firestore document keyed by court
 * is allowed to contain.
 *
 * SECURITY: `Match` carries `umpireToken` (the secret that authorises scoring
 * a match) and `umpireCode`. The Firestore `matches/{courtId}` documents are
 * world-readable by design — that is the whole point of the public scoreboard
 * — so spreading a raw match object into one would publish the umpire's
 * credentials to the internet and let any reader score the match. This is an
 * explicit allow-list rather than a delete-list: a field added to `Match`
 * later must be opted *in* here, and cannot leak by being forgotten.
 */
export interface PublicScoreboard {
  matchId: string;
  matchType: string;
  status: string;
  courtLabel: string | null;
  players: Array<{
    playerId: string;
    side: string;
    name: string;
    lastName: string;
    shortName: string;
  }>;
  category: string | null;
  teams: unknown;
  startedAt: string | null;
  completedAt: string | null;
  derived: unknown;
}

/** Build the allow-listed public view. Takes the same `{ match, derived }`
 *  shape the socket layer already broadcasts. */
export function toPublicScoreboard(state: {
  match: Record<string, unknown>;
  derived: unknown;
}): PublicScoreboard {
  const m = state.match;
  return {
    matchId: String(m.matchId ?? ''),
    matchType: String(m.matchType ?? ''),
    status: String(m.status ?? ''),
    courtLabel: (m.courtLabel as string | null) ?? null,
    category: (m.category as string | null) ?? null,
    players: ((m.players as PublicScoreboard['players']) ?? []).map((p) => ({
      playerId: p.playerId,
      side: p.side,
      name: p.name,
      lastName: p.lastName,
      shortName: p.shortName,
    })),
    teams: m.teams ?? null,
    startedAt: (m.startedAt as string | null) ?? null,
    completedAt: (m.completedAt as string | null) ?? null,
    derived: state.derived ?? null,
  };
}

/**
 * Sync score updates to Firestore.
 *
 * Typed to `PublicScoreboard` rather than a loose object on purpose: these
 * documents are world-readable, and a raw `Match` carries `umpireToken`. The
 * signature makes the allow-list (toPublicScoreboard) the only way in, so the
 * credential leak is now a compile error rather than a code-review question.
 */
export async function syncScoreToCloud(
  courtId: string,
  matchData: PublicScoreboard,
): Promise<boolean> {
  if (!isInitialized || !db) {
    console.debug('[Cloud] Cloud sync not initialized, skipping');
    return false;
  }

  try {
    await db
      .collection('matches')
      .doc(courtId)
      .set(
        {
          ...matchData,
          updatedAt: new Date(),
          syncStatus: 'synced',
        },
        { merge: true },
      );

    console.log(`[Cloud] Score synced for court ${courtId}`);
    return true;
  } catch (error) {
    console.error(`[Cloud] Sync failed for court ${courtId}:`, error);
    return false;
  }
}
