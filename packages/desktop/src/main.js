// Electron main process. Spawns the real Courtside Scoreboard server (the
// exact same code that `npm run start --workspace packages/server` runs)
// as a child process via tsx, and shows a small launcher window with the
// LAN address and admin password instead of requiring a CLI walkthrough.
//
// The subprocess runs through Electron's own bundled Node (via
// ELECTRON_RUN_AS_NODE), not a system Node install — that's what lets this
// app run on a machine with nothing else installed.

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 3000;
// A single generic password rather than a per-install random one: this is
// a LAN-only, single-admin tool (see Set 08 of the design spec), and typing
// in a generated secret added friction with no real benefit here. Kept as
// a named constant, matching the server's own default (see config.ts), so
// the desktop app and a plain `npm run dev` server agree without any
// configuration at all.
const ADMIN_PASSWORD = 'change-me';
// Bumped only when a release needs to replace an incompatible empty/legacy
// database (see ensureDatabase()) — not on every schema change. A per-user
// database created by an older install can predate a Prisma model added
// since (observed on Windows: `P2021 The table main.Tournament does not
// exist`), and unlike the server's own dev workflow, a packaged app has no
// `prisma migrate` available to fix it in place at runtime.
const DATABASE_TEMPLATE_VERSION = 1;

let serverProcess = null;
let launcherWindow = null;
let currentConfig = null;
let serverState = { status: 'starting', message: '' };

function resourcesPath() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
}

/**
 * The Dock/taskbar icon while running from source (`npm start` / `electron .`).
 * A packaged build already gets its icon baked into the .app/.exe by
 * electron-builder (see build-assets/icon.icns|.ico in package.json's
 * `build` config) — build-assets isn't copied into the packaged app's
 * resources, so this only resolves to a real file in dev.
 */
function devIconPath() {
  if (app.isPackaged) return null;
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon-1024.png';
  return path.join(__dirname, '..', 'build-assets', file);
}

function serverEntryPath() {
  return path.join(serverRootPath(), 'src', 'index.ts');
}

/**
 * The server package's own directory, used as the child process's `cwd`.
 *
 * This matters beyond tidiness: the server calls `import 'dotenv/config'`,
 * which loads `.env` relative to `process.cwd()`. Without this the child
 * inherited Electron's cwd (packages/desktop, or `/` for a packaged app) and
 * never found `packages/server/.env` — so Firebase credentials were silently
 * invisible and cloud sync stayed disabled, with the public scoreboard link in
 * the admin dashboard quietly showing "waiting for a match" forever.
 */
function serverRootPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '..', '..', 'server');
}

function clientDistPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'client-dist')
    : path.join(__dirname, '..', '..', 'client', 'dist');
}

function tsxCliPath() {
  if (app.isPackaged) {
    // main.js itself runs from inside app.asar in a packaged build, so
    // require.resolve() below would search relative to the archive and
    // fail to find tsx at all — it was copied to a real, external
    // node_modules next to the other extraResources instead (see
    // package.json's `build.extraResources`), not into the asar.
    return path.join(process.resourcesPath, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
  // tsx's package.json doesn't `export` ./dist/cli.mjs directly, so this
  // resolves the package root (which IS exported) and does plain path
  // math from there instead of asking Node to resolve the deep subpath.
  const tsxPkg = require.resolve('tsx/package.json');
  return path.join(path.dirname(tsxPkg), 'dist', 'cli.mjs');
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function loadOrCreateConfig() {
  const file = configPath();
  let stored = {};
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Corrupt config file — fall through and write a fresh one below.
    }
  }
  const cfg = {
    // Always the fixed generic password (see ADMIN_PASSWORD above) — an
    // install that already has one from before this password stopped
    // being randomly generated ends up on the fixed value too, rather
    // than keeping its old random one forever.
    adminPassword: ADMIN_PASSWORD,
    // Carried over from any existing config, defaulting to 0 (older than
    // any real template) rather than the current version — an install
    // from before this field existed must still go through
    // ensureDatabase()'s upgrade check, not be assumed already current.
    databaseTemplateVersion: stored.databaseTemplateVersion ?? 0,
  };
  saveConfig(cfg);
  return cfg;
}

function ensureDatabase(cfg) {
  const dbPath = path.join(app.getPath('userData'), 'courtside.db');
  const templatePath = path.join(resourcesPath(), 'template.db');

  if (!fs.existsSync(dbPath)) {
    fs.copyFileSync(templatePath, dbPath);
    cfg.databaseTemplateVersion = DATABASE_TEMPLATE_VERSION;
    saveConfig(cfg);
    return dbPath;
  }

  if (cfg.databaseTemplateVersion !== DATABASE_TEMPLATE_VERSION) {
    // This per-user database predates a Prisma model added since it was
    // created — Prisma throws (observed: P2021, "table does not exist")
    // rather than working with a stale schema, and a packaged app has no
    // `prisma migrate` to fix it in place at runtime. Keep the old file
    // as a backup rather than deleting it: it's the umpire's own match
    // history, not disposable, even though this recovery path doesn't
    // attempt to merge its contents into the new one.
    const backupPath = path.join(app.getPath('userData'), `courtside.legacy-${Date.now()}.db`);
    fs.renameSync(dbPath, backupPath);
    fs.copyFileSync(templatePath, dbPath);
    cfg.databaseTemplateVersion = DATABASE_TEMPLATE_VERSION;
    saveConfig(cfg);
  }

  return dbPath;
}

function lanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

function notifyLauncher() {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  launcherWindow.webContents.send('server-state', {
    ...serverState,
    addresses: lanAddresses(),
    port: PORT,
  });
}

function startServer(cfg) {
  currentConfig = cfg;
  const dbPath = ensureDatabase(cfg);
  serverState = { status: 'starting', message: '' };

  serverProcess = spawn(process.execPath, [tsxCliPath(), serverEntryPath()], {
    // See serverRootPath(): dotenv resolves `.env` from cwd, so this is what
    // lets the packaged app pick up Firebase credentials at all. Everything
    // else the server needs is passed absolutely below, so moving cwd is safe.
    cwd: serverRootPath(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      ADMIN_PASSWORD: cfg.adminPassword,
      DATABASE_URL: `file:${dbPath}`,
      CLIENT_DIST_PATH: clientDistPath(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('listening on port')) {
      serverState = { status: 'running', message: '' };
      notifyLauncher();
    }
  });

  serverProcess.stderr.on('data', (chunk) => {
    serverState = { status: 'error', message: chunk.toString() };
    notifyLauncher();
  });

  serverProcess.on('exit', (code) => {
    if (code !== 0 && code !== null && serverState.status !== 'error') {
      serverState = {
        status: 'error',
        message: `Server process exited unexpectedly (code ${code}).`,
      };
      notifyLauncher();
    }
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function createLauncherWindow() {
  const icon = devIconPath();
  launcherWindow = new BrowserWindow({
    width: 540,
    height: 760,
    resizable: false,
    title: 'Courtside Scoreboard',
    backgroundColor: '#0a0e1a',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWindow.webContents.once('did-finish-load', notifyLauncher);
}

ipcMain.handle('get-state', () => {
  notifyLauncher();
  return null;
});

ipcMain.handle('open-dashboard', (_event, tournament) => {
  return openDashboard(tournament);
});

async function apiRequest(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': currentConfig?.adminPassword ?? '',
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed.');
  return body;
}

ipcMain.handle('list-tournaments', () => apiRequest('/api/tournaments'));

ipcMain.handle('create-tournament', (_event, name) =>
  apiRequest('/api/tournaments', { method: 'POST', body: JSON.stringify({ name }) }),
);

function openDashboard(tournament) {
  if (!tournament) return;
  const address = lanAddresses()[0] ?? 'localhost';
  // The admin dashboard picks this up once and stores it locally, so the
  // person running this app never has to see or type a password — it
  // still protects the API from anyone else on the LAN, who won't have it.
  const password = encodeURIComponent(currentConfig?.adminPassword ?? '');
  shell.openExternal(
    `http://${address}:${PORT}/admin?adminPassword=${password}&tournamentId=${encodeURIComponent(tournament.tournamentId)}&tournamentName=${encodeURIComponent(tournament.name)}&tournamentDate=${encodeURIComponent(tournament.date)}`,
  );
}

app.whenReady().then(() => {
  const icon = devIconPath();
  if (icon && process.platform === 'darwin') app.dock?.setIcon(icon);

  const cfg = loadOrCreateConfig();
  startServer(cfg);
  createLauncherWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
  });
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopServer);
