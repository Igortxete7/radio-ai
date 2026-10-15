import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hourlySlot, selectTrack, validateScript, safeStoragePath } from './index.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tracks = [
  {
    id: 'a',
    path: 'a.mp3',
    title: 'A',
    artist: 'Uno',
    durationSec: 30,
    enabled: true,
    missing: false,
    lastPlayedAt: null,
    playCount: 0,
  },
  {
    id: 'b',
    path: 'b.mp3',
    title: 'B',
    artist: 'Dos',
    durationSec: 30,
    enabled: true,
    missing: false,
    lastPlayedAt: null,
    playCount: 0,
  },
  {
    id: 'c',
    path: 'c.mp3',
    title: 'C',
    artist: 'Uno',
    durationSec: 30,
    enabled: true,
    missing: false,
    lastPlayedAt: null,
    playCount: 0,
  },
];
describe('programación musical', () => {
  it('excluye canciones y artistas que ya están en la cola', () => {
    const result = selectTrack(
      tracks,
      [],
      [tracks[0]],
      { trackRepeatHours: 24, artistRepeatMinutes: 90 },
      new Date(),
      () => 0.5,
    );
    expect(result?.track.id).toBe('b');
    expect(result?.relaxed).toEqual([]);
  });
  it('relaja primero artista y después canción sin duplicar pistas en cola', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    const recent = [{ assetId: 'a', artist: 'Uno', startedAt: new Date('2026-10-13T09:30:00Z') }];
    expect(
      selectTrack([tracks[2]], recent, [], { trackRepeatHours: 24, artistRepeatMinutes: 90 }, now)
        ?.relaxed,
    ).toEqual(['artist']);
    expect(
      selectTrack([tracks[0]], recent, [], { trackRepeatHours: 24, artistRepeatMinutes: 90 }, now)
        ?.relaxed,
    ).toEqual(['artist', 'track']);
    expect(
      selectTrack(
        [tracks[0]],
        [],
        [tracks[0]],
        { trackRepeatHours: 24, artistRepeatMinutes: 90 },
        now,
      ),
    ).toBeNull();
  });
  it('nunca utiliza archivos deshabilitados o ausentes', () => {
    expect(
      selectTrack(
        [
          { ...tracks[0], enabled: false },
          { ...tracks[1], missing: true },
        ],
        [],
        [],
        { trackRepeatHours: 0, artistRepeatMinutes: 0 },
        new Date(),
      ),
    ).toBeNull();
  });
  it('reconoce una intención antigua por su ruta aunque no incluya assetId', () => {
    expect(
      selectTrack(
        [tracks[0]],
        [],
        [{ path: 'a.mp3' }],
        { trackRepeatHours: 0, artistRepeatMinutes: 0 },
        new Date(),
      ),
    ).toBeNull();
  });
});
describe('horas editoriales', () => {
  it('distingue ambas horas repetidas en el cambio de horario de Madrid', () => {
    const first = hourlySlot(new Date('2026-10-25T00:56:00Z'), 'Europe/Madrid');
    const second = hourlySlot(new Date('2026-10-25T01:56:00Z'), 'Europe/Madrid');
    expect(first.scheduledFor.toISOString()).toBe('2026-10-25T01:00:00.000Z');
    expect(second.scheduledFor.toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
  });
  it('omite la hora inexistente en primavera', () => {
    expect(hourlySlot(new Date('2026-03-29T00:56:00Z'), 'Europe/Madrid').localTimeIso).toContain(
      '03:00:00',
    );
  });
});
describe('storage y validación editorial', () => {
  it('rechaza traversal y enlaces simbólicos fuera del almacenamiento', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'radio-safe-'));
    dirs.push(root);
    await mkdir(path.join(root, 'storage'));
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside', 'audio.mp3'), 'audio');
    await symlink(path.join(root, 'outside'), path.join(root, 'storage', 'escape'), 'junction');
    await expect(
      safeStoragePath(path.join(root, 'storage'), '../outside/audio.mp3'),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(
      safeStoragePath(path.join(root, 'storage'), 'escape/audio.mp3'),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(
      safeStoragePath(path.join(root, 'storage'), 'escape/new.mp3', false),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
  it('rechaza noticias o menciones que no existen en el contexto', () => {
    const context = {
      kind: 'hourly' as const,
      localTimeIso: '2026-10-13T12:00:00+02:00',
      timezone: 'Europe/Madrid',
      news: [],
      targetSeconds: 55,
      stationPersona: 'Cercano',
      stationName: 'Radio',
    };
    const script = {
      opening: 'Hola',
      body: 'Seguimos con música',
      closing: 'Hasta pronto',
      fullText: 'Hola. Seguimos con música. Hasta pronto.',
      mentionedNewsIds: ['inventada'],
      mentionsWeather: false,
      mentionsNextTrack: false,
      estimatedSeconds: 40,
    };
    expect(() => validateScript(script, context)).toThrow();
    expect(() =>
      validateScript({ ...script, mentionedNewsIds: [], mentionsWeather: true }, context),
    ).toThrow();
  });
});
