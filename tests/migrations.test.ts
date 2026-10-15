import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { projectRoot } from '@radio/config';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('radio-migrate-test-')
    )
      throw new Error('Unsafe migration test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

async function databaseUrl() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'radio-migrate-test-'));
  directories.push(directory);
  return `file:${path.join(directory, 'radio.db').replaceAll('\\', '/')}`;
}

function migrate(url: string, rustLog: string) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(projectRoot, 'scripts', 'migrate.ts')],
    {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: url, RUST_LOG: rustLog },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );
}

it('creates a fresh SQLite database despite inherited warning-only Rust logs', async () => {
  const url = await databaseUrl();
  const result = migrate(url, 'warn');
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    expect(await db.track.count()).toBe(0);
    const migrations = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    expect(migrations).toEqual([{ migration_name: '20261013000000_initial' }]);
  } finally {
    await db.$disconnect();
  }
}, 45_000);

it('repeated migration deployment preserves records and a single applied migration', async () => {
  const url = await databaseUrl();
  const initial = migrate(url, 'info');
  expect(initial.status, initial.stderr || initial.error?.message).toBe(0);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const track = await db.track.create({
      data: {
        path: '/existing/track.mp3',
        title: 'Existing track',
        artist: 'Existing artist',
        durationSec: 180,
      },
    });
    await db.$disconnect();
    const repeated = migrate(url, 'error');
    expect(repeated.status, repeated.stderr || repeated.error?.message).toBe(0);
    expect(await db.track.findUnique({ where: { id: track.id } })).toMatchObject({
      title: 'Existing track',
      artist: 'Existing artist',
    });
    const migrations = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    expect(migrations).toEqual([{ migration_name: '20261013000000_initial' }]);
  } finally {
    await db.$disconnect();
  }
}, 60_000);
