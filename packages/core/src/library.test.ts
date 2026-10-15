import { afterEach, expect, it } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDatabase } from '@radio/db';
import { loadConfig } from '@radio/config';
import { LibraryScanner } from './library.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
function wave() {
  const b = Buffer.alloc(44 + 16000);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(16000, 40);
  return b;
}
it('escanea subcarpetas, aísla corrupción y conserva ediciones al cambiar el audio', async () => {
  const { db, directory, cleanup } = await createTestDatabase();
  cleanups.push(cleanup);
  const config = {
    ...loadConfig({ NODE_ENV: 'test' }),
    storageRoot: path.join(directory, 'storage'),
  };
  await mkdir(path.join(config.storageRoot, 'music', 'nested'), { recursive: true });
  const file = path.join(config.storageRoot, 'music', 'nested', 'Artista - Canción.wav');
  await writeFile(file, wave());
  await writeFile(path.join(config.storageRoot, 'music', 'corrupt.wav'), 'broken');
  const scanner = new LibraryScanner(config, db, undefined, {
    async inspect() {
      return { durationSec: 1, bytes: 16044 };
    },
  });
  const first = await scanner.scan();
  expect(first.discovered).toBe(1);
  expect(first.errors).toBe(1);
  const track = await db.track.findUniqueOrThrow({ where: { path: file } });
  expect(track.artist).toBe('Artista');
  expect(track.durationSec).toBe(1);
  await db.track.update({
    where: { id: track.id },
    data: { title: 'Mi edición', enabled: false, metadataEdited: true },
  });
  await writeFile(file, Buffer.concat([wave(), Buffer.from([0, 0])]));
  await scanner.scan();
  const changed = await db.track.findUniqueOrThrow({ where: { id: track.id } });
  expect(changed.title).toBe('Mi edición');
  expect(changed.enabled).toBe(false);
  expect(await readFile(path.join(config.storageRoot, 'music-playlist.m3u'), 'utf8')).not.toContain(
    file,
  );
});
it('deshabilita ausentes y restaura sólo los que antes estaban habilitados', async () => {
  const { db, directory, cleanup } = await createTestDatabase();
  cleanups.push(cleanup);
  const config = {
    ...loadConfig({ NODE_ENV: 'test' }),
    storageRoot: path.join(directory, 'storage'),
  };
  await mkdir(path.join(config.storageRoot, 'music'), { recursive: true });
  const file = path.join(config.storageRoot, 'music', 'Track.wav');
  await writeFile(file, wave());
  const scanner = new LibraryScanner(config, db, undefined, {
    async inspect() {
      return { durationSec: 1, bytes: 16044 };
    },
  });
  await scanner.scan();
  await rm(file);
  await scanner.scan();
  expect(await db.track.findUniqueOrThrow({ where: { path: file } })).toMatchObject({
    enabled: false,
    missing: true,
  });
  await writeFile(file, wave());
  await scanner.scan();
  expect(await db.track.findUniqueOrThrow({ where: { path: file } })).toMatchObject({
    enabled: true,
    missing: false,
  });
  await db.track.update({ where: { path: file }, data: { enabled: false } });
  await rm(file);
  await scanner.scan();
  await writeFile(file, wave());
  await scanner.scan();
  expect(await db.track.findUniqueOrThrow({ where: { path: file } })).toMatchObject({
    enabled: false,
    missing: false,
  });
});
it('excluye audio con contenedor válido cuando falla su decodificación', async () => {
  const { db, directory, cleanup } = await createTestDatabase();
  cleanups.push(cleanup);
  const config = {
    ...loadConfig({ NODE_ENV: 'test' }),
    storageRoot: path.join(directory, 'storage'),
  };
  await mkdir(path.join(config.storageRoot, 'music'), { recursive: true });
  await writeFile(path.join(config.storageRoot, 'music', 'corrupt-body.wav'), wave());
  const scanner = new LibraryScanner(config, db, undefined, {
    async inspect() {
      throw new Error('Corrupt audio body');
    },
  });
  expect((await scanner.scan()).errors).toBe(1);
  expect(await db.track.count({ where: { enabled: true } })).toBe(0);
});
