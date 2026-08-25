import { openDB, type IDBPDatabase } from 'idb';
import type { MatchStatePayload } from '@courtside/shared';

/**
 * Per-client IndexedDB cache (Set 02) — keeps the last known match state on
 * this device so the screen doesn't go blank on a brief Wi-Fi drop. The
 * server is always the final authority; this is read on load / while
 * reconnecting, never written back as if it were authoritative.
 */
const DB_NAME = 'courtside-cache';
const STORE = 'match-state';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE);
    },
  });
  return dbPromise;
}

export async function cacheMatchState(key: string, state: MatchStatePayload): Promise<void> {
  try {
    const db = await getDb();
    await db.put(STORE, state, key);
  } catch {
    // Best-effort only — IndexedDB can be unavailable (e.g. private
    // browsing). Losing the cache never blocks live scoring.
  }
}

export async function readCachedMatchState(key: string): Promise<MatchStatePayload | undefined> {
  try {
    const db = await getDb();
    return await db.get(STORE, key);
  } catch {
    return undefined;
  }
}
