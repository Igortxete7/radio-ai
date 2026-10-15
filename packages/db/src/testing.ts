import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectRoot } from '@radio/config';
import { createDatabase } from './index.ts';
export async function createTestDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'radio-test-'));
  const db = createDatabase(`file:${path.join(directory, 'radio.db').replaceAll('\\', '/')}`);
  const migrationRoot = path.join(projectRoot, 'prisma', 'migrations');
  for (const name of (await readdir(migrationRoot)).sort()) {
    if (name.endsWith('.toml')) continue;
    const sql = await readFile(path.join(migrationRoot, name, 'migration.sql'), 'utf8');
    for (const statement of sql
      .split(';')
      .map((v) => v.trim())
      .filter(Boolean)) {
      if (/PRAGMA/i.test(statement)) await db.$queryRawUnsafe(statement);
      else await db.$executeRawUnsafe(statement);
    }
  }
  return {
    db,
    directory,
    cleanup: async () => {
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
