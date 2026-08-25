import { PrismaClient } from '../../generated/prisma/index.js';

/** A single shared Prisma client — SQLite is one file, one connection is fine. */
export const prisma = new PrismaClient();
