const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', '..', 'server');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

fs.rmSync(path.join(serverPath, 'node_modules'), { recursive: true, force: true });
execFileSync(
  npm,
  [
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
  ],
  { stdio: 'inherit' },
);
