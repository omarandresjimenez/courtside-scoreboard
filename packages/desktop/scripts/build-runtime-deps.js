const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', '..', 'server');

fs.rmSync(path.join(serverPath, 'node_modules'), { recursive: true, force: true });

const result = spawnSync('npm', [
  'install',
  '--prefix',
  serverPath,
  '--no-save',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '@courtside/shared@file:../shared',
  '@prisma/client',
  'cors',
  'dotenv',
  'express',
  'socket.io',
  'tsx',
], {
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status);

