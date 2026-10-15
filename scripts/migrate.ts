import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@radio/config';
const config = loadConfig();
mkdirSync(path.dirname(config.dbUrl.slice(5)), { recursive: true });
// Prisma 6.19 needs the INFO startup line to detect a missing SQLite database:
// its CLI parser discards the first stderr line before reading the P1003 error.
// Limit this workaround to the migration process; keep the application's logs.
// https://github.com/prisma/orm/issues/29355
execFileSync(
  process.execPath,
  [path.join(config.root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
  {
    cwd: config.root,
    env: { ...process.env, DATABASE_URL: config.dbUrl, RUST_LOG: 'info' },
    stdio: 'inherit',
  },
);
