// Builds a fresh, empty, fully-migrated SQLite file and drops it into
// resources/template.db, which electron-builder ships alongside the app.
// On first launch, main.js copies this into the user's data directory —
// so the packaged app never needs to run Prisma's migration engine at
// runtime, only @prisma/client (see main.js's ensureDatabase()).
//
// Run as a developer-machine build step (via `npm run dist`), not inside
// the packaged app, so relying on npx/npm being on PATH here is fine.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const templatePath = path.join(__dirname, '..', 'resources', 'template.db');
const schemaPath = path.join(__dirname, '..', '..', 'server', 'prisma', 'schema.prisma');

fs.rmSync(templatePath, { force: true });
fs.mkdirSync(path.dirname(templatePath), { recursive: true });

execSync(`npx prisma db push --schema="${schemaPath}" --skip-generate --accept-data-loss`, {
  env: { ...process.env, DATABASE_URL: `file:${templatePath}` },
  stdio: 'inherit',
});

console.log(`Template database written to ${templatePath}`);
