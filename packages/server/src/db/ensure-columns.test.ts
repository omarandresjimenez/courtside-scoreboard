import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '../../generated/prisma/index.js';
import { ensureSchemaColumns, type RawSqlClient } from './ensure-columns.js';

/**
 * Exercises the real SQLite upgrade path against a throwaway file — a fake
 * Prisma client can't stand in here, since the whole point of this module is
 * raw ALTER TABLE / CREATE TABLE statements a mock would just no-op past.
 */
describe('ensureSchemaColumns', () => {
  let dir: string;
  let client: PrismaClient;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'courtside-ensure-columns-'));
    const dbPath = path.join(dir, 'test.db');
    client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

    // A stand-in for a database file built before this feature existed:
    // Tournament/Match/Player exist, but without the columns/tables this
    // module is responsible for adding.
    await client.$executeRawUnsafe(
      `CREATE TABLE "Tournament" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)`,
    );
    await client.$executeRawUnsafe(
      `CREATE TABLE "Match" ("id" TEXT NOT NULL PRIMARY KEY, "matchType" TEXT NOT NULL)`,
    );
    await client.$executeRawUnsafe(
      `CREATE TABLE "Player" ("id" TEXT NOT NULL PRIMARY KEY, "matchId" TEXT NOT NULL, "name" TEXT NOT NULL)`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Tournament" ("id", "name") VALUES ('t1', 'Test Open')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Player" ("id", "matchId", "name") VALUES ('p1', 'm1', 'Existing Player')`,
    );
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  async function columnsOf(table: string): Promise<string[]> {
    const rows = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("${table}")`,
    );
    return rows.map((r) => r.name);
  }

  it('adds every missing column, preserving existing rows', async () => {
    await ensureSchemaColumns(client);

    expect(await columnsOf('Player')).toEqual(
      expect.arrayContaining(['lastName', 'tournamentPlayerId']),
    );
    expect(await columnsOf('Match')).toEqual(expect.arrayContaining(['category']));

    const player = await client.$queryRawUnsafe<Array<{ name: string; lastName: string }>>(
      `SELECT name, lastName FROM "Player" WHERE id = 'p1'`,
    );
    expect(player[0]).toEqual({ name: 'Existing Player', lastName: '' });
  });

  it('creates the TournamentPlayer table and its indexes', async () => {
    await ensureSchemaColumns(client);

    expect(await columnsOf('TournamentPlayer')).toEqual(
      expect.arrayContaining(['id', 'tournamentId', 'firstName', 'lastName', 'categories', 'status']),
    );

    // Functional check, not just schema shape: the table must actually take
    // writes, including the default status the column definition promises.
    await client.$executeRawUnsafe(
      `INSERT INTO "TournamentPlayer" ("id", "tournamentId", "firstName", "lastName") VALUES ('tp1', 't1', 'Jane', 'Doe')`,
    );
    const rows = await client.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM "TournamentPlayer" WHERE id = 'tp1'`,
    );
    expect(rows[0]?.status).toBe('Accepted');
  });

  it('is idempotent — running it twice does not error or duplicate work', async () => {
    await ensureSchemaColumns(client);
    await expect(ensureSchemaColumns(client)).resolves.toBeUndefined();
    expect(await columnsOf('Player')).toEqual(
      expect.arrayContaining(['lastName', 'tournamentPlayerId']),
    );
  });

  it('logs and continues past a column it cannot add, without throwing', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const brokenClient: RawSqlClient = {
      $executeRawUnsafe: async () => {
        throw new Error('disk full');
      },
      $queryRawUnsafe: async () => {
        throw new Error('disk full');
      },
    };

    await expect(ensureSchemaColumns(brokenClient)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
