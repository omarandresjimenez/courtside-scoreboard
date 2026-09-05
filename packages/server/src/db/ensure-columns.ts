import { prisma } from './client.js';

/**
 * Add columns this build needs but an older database file lacks.
 *
 * This project has no Prisma migration history — the schema is applied with
 * `prisma db push`, and the packaged desktop app ships a pre-built
 * `template.db` rather than a migration engine. Its only upgrade path was to
 * rename the user's database and copy a fresh empty template over it, which
 * throws away every match they have ever scored.
 *
 * Both columns below are purely additive with defaults, so they can be added
 * in place instead. Anything requiring a real data migration still needs a
 * considered plan; this is deliberately limited to `ADD COLUMN`.
 */
const REQUIRED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  // NOT NULL needs a default, or SQLite refuses to add it to a populated table.
  { table: 'Player', column: 'lastName', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'Match', column: 'category', definition: 'TEXT' },
];

export async function ensureSchemaColumns(): Promise<void> {
  for (const { table, column, definition } of REQUIRED_COLUMNS) {
    try {
      // PRAGMA cannot be parameterised, and these identifiers are constants
      // in the list above rather than anything user-supplied.
      const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info("${table}")`,
      );
      if (columns.some((c) => c.name === column)) continue;

      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
      console.log(`[DB] Added missing column ${table}.${column}`);
    } catch (error) {
      // A failure here is worth seeing, but must not stop the server booting:
      // a venue mid-tournament is better served by an app that runs than one
      // that refuses to start over a column it may not even need yet.
      console.error(`[DB] Could not ensure ${table}.${column}:`, error);
    }
  }
}
