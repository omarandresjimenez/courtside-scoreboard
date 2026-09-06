import { prisma } from './client.js';

/** The slice of PrismaClient this module needs — narrowed so tests can pass
 * a client pointed at a throwaway SQLite file instead of the shared one. */
export interface RawSqlClient {
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
  $queryRawUnsafe: <T>(sql: string) => Promise<T>;
}

/**
 * Add columns and tables this build needs but an older database file lacks.
 *
 * This project has no Prisma migration history — the schema is applied with
 * `prisma db push`, and the packaged desktop app ships a pre-built
 * `template.db` rather than a migration engine. Its only upgrade path was to
 * rename the user's database and copy a fresh empty template over it, which
 * throws away every match they have ever scored.
 *
 * Both changes below are purely additive with defaults, so they can be
 * applied in place instead. Anything requiring a real data migration still
 * needs a considered plan; this is deliberately limited to `ADD COLUMN` and
 * `CREATE TABLE IF NOT EXISTS`.
 */
const REQUIRED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  // NOT NULL needs a default, or SQLite refuses to add it to a populated table.
  { table: 'Player', column: 'lastName', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'Match', column: 'category', definition: 'TEXT' },
  { table: 'Player', column: 'tournamentPlayerId', definition: 'TEXT' },
];

/**
 * New tables added after a database file may already have been created.
 * `statements` runs in order against a fresh connection each time, so index
 * creation can assume the table above it already exists.
 */
const REQUIRED_TABLES: Array<{ table: string; statements: string[] }> = [
  {
    table: 'TournamentPlayer',
    statements: [
      `CREATE TABLE IF NOT EXISTS "TournamentPlayer" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tournamentId" TEXT NOT NULL,
        "memberId" TEXT,
        "firstName" TEXT NOT NULL,
        "lastName" TEXT NOT NULL,
        "gender" TEXT,
        "country" TEXT,
        "club" TEXT,
        "birthDate" DATETIME,
        "categories" TEXT NOT NULL DEFAULT '',
        "status" TEXT NOT NULL DEFAULT 'Accepted',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "TournamentPlayer_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "TournamentPlayer_tournamentId_memberId_key" ON "TournamentPlayer"("tournamentId", "memberId")`,
      `CREATE INDEX IF NOT EXISTS "TournamentPlayer_tournamentId_idx" ON "TournamentPlayer"("tournamentId")`,
    ],
  },
];

export async function ensureSchemaColumns(client: RawSqlClient = prisma): Promise<void> {
  for (const { table, statements } of REQUIRED_TABLES) {
    try {
      for (const statement of statements) {
        await client.$executeRawUnsafe(statement);
      }
    } catch (error) {
      // Same reasoning as the column loop below: worth logging, must not
      // block the server from starting.
      console.error(`[DB] Could not ensure table ${table}:`, error);
    }
  }

  for (const { table, column, definition } of REQUIRED_COLUMNS) {
    try {
      // PRAGMA cannot be parameterised, and these identifiers are constants
      // in the list above rather than anything user-supplied.
      const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info("${table}")`,
      );
      if (columns.some((c) => c.name === column)) continue;

      await client.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
      console.log(`[DB] Added missing column ${table}.${column}`);
    } catch (error) {
      // A failure here is worth seeing, but must not stop the server booting:
      // a venue mid-tournament is better served by an app that runs than one
      // that refuses to start over a column it may not even need yet.
      console.error(`[DB] Could not ensure ${table}.${column}:`, error);
    }
  }
}
