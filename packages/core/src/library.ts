import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { RadioConfig } from '@radio/config';
import type { PrismaClient } from '@radio/db';
import { FfprobeAudioInspector } from '@radio/integrations';
import { RadioError, type AudioInspector } from '@radio/shared';
import { atomicWrite, initializeStorage, readableAudio, safeStoragePath } from './storage.ts';

export type ScanResult = {
  discovered: number;
  updated: number;
  unchanged: number;
  missing: number;
  jingles: number;
  errors: number;
  completedAt: string;
};
export type EventWriter = (
  event: string,
  level?: 'info' | 'warn' | 'error',
  detail?: Record<string, unknown>,
  errorCode?: string,
) => Promise<void>;
export class LibraryScanner {
  private inspector: AudioInspector;
  constructor(
    private config: RadioConfig,
    private db: PrismaClient,
    private event: EventWriter = async () => {},
    inspector?: AudioInspector,
  ) {
    this.inspector = inspector ?? new FfprobeAudioInspector(config);
  }
  private async walk(directory: string, result: string[], errors: { value: number }) {
    let entries;
    try {
      entries = await readdir(await safeStoragePath(this.config.storageRoot, directory), {
        withFileTypes: true,
      });
    } catch {
      errors.value++;
      await this.event('library.directory.failed', 'warn', { directory }, 'DIRECTORY_UNREADABLE');
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      try {
        if (entry.isDirectory()) await this.walk(file, result, errors);
        else if (
          (entry.isFile() || entry.isSymbolicLink()) &&
          this.config.audioExtensions.includes(path.extname(file).toLowerCase())
        ) {
          await safeStoragePath(this.config.storageRoot, file);
          if ((await stat(file)).isFile()) result.push(file);
        }
      } catch {
        errors.value++;
        await this.event(
          'library.file.failed',
          'warn',
          { path: file },
          'UNSAFE_OR_UNREADABLE_FILE',
        );
      }
    }
  }
  private async markMissing(track: { id: string; enabled: boolean; missing: boolean }) {
    if (track.missing) return false;
    await this.db.$transaction(async (tx) => {
      await tx.radioSetting.upsert({
        where: { key: `missing-enabled:${track.id}` },
        create: { key: `missing-enabled:${track.id}`, valueJson: track.enabled },
        update: { valueJson: track.enabled },
      });
      await tx.track.update({ where: { id: track.id }, data: { missing: true, enabled: false } });
    });
    return true;
  }
  async writePlaylist() {
    const tracks = await this.db.track.findMany({
      where: { enabled: true, missing: false },
      orderBy: { path: 'asc' },
    });
    const playable: string[] = [];
    for (const track of tracks)
      if (await readableAudio(this.config.storageRoot, track.path)) playable.push(track.path);
    await atomicWrite(
      this.config.storageRoot,
      'music-playlist.m3u',
      playable.length ? `${playable.join('\n')}\n` : '',
    );
    return playable.length;
  }
  async scan(): Promise<ScanResult> {
    const started = Date.now();
    await initializeStorage(this.config.storageRoot);
    await this.event('library.scan.started');
    const result: ScanResult = {
      discovered: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      jingles: 0,
      errors: 0,
      completedAt: '',
    };
    const files: string[] = [];
    const walkErrors = { value: 0 };
    await this.walk(path.join(this.config.storageRoot, 'music'), files, walkErrors);
    const seen = new Set(files);
    for (const file of files) {
      try {
        const info = await stat(file);
        const existing = await this.db.track.findUnique({ where: { path: file } });
        if (
          existing &&
          !existing.missing &&
          existing.fileSize === info.size &&
          existing.mtimeMs === info.mtimeMs
        ) {
          result.unchanged++;
          continue;
        }
        const metadata = await parseFile(file, { duration: true });
        const inspected = await this.inspector.inspect(file);
        const durationSec = inspected.durationSec;
        if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0 || info.size <= 0)
          throw new Error('Invalid audio');
        const base = path.basename(file, path.extname(file));
        const split = base.indexOf(' - ');
        const title = metadata.common.title?.trim() || (split > 0 ? base.slice(split + 3) : base);
        const artist =
          metadata.common.artist?.trim() || (split > 0 ? base.slice(0, split) : 'Desconocido');
        let enabled = existing?.enabled ?? true;
        if (existing?.missing) {
          const saved = await this.db.radioSetting.findUnique({
            where: { key: `missing-enabled:${existing.id}` },
          });
          enabled = saved?.valueJson === true;
        }
        const logical = existing?.metadataEdited
          ? {}
          : {
              title,
              artist,
              album: metadata.common.album ?? null,
              genre: metadata.common.genre?.join(', ') ?? null,
            };
        await this.db.track.upsert({
          where: { path: file },
          create: {
            path: file,
            title,
            artist,
            album: metadata.common.album ?? null,
            genre: metadata.common.genre?.join(', ') ?? null,
            durationSec,
            fileSize: info.size,
            mtimeMs: info.mtimeMs,
          },
          update: {
            ...logical,
            durationSec,
            fileSize: info.size,
            mtimeMs: info.mtimeMs,
            missing: false,
            enabled,
          },
        });
        if (existing) result.updated++;
        else {
          result.discovered++;
          await this.event('track.discovered', 'info', { path: file });
        }
      } catch (error) {
        if (/^P\d{4}$/.test(String((error as { code?: string }).code))) throw error;
        result.errors++;
        const existing = await this.db.track.findUnique({ where: { path: file } });
        if (existing && !(error instanceof RadioError && error.code === 'FFPROBE_UNAVAILABLE'))
          await this.markMissing(existing);
        await this.event(
          'library.file.failed',
          'warn',
          { path: file },
          error instanceof RadioError ? error.code : 'AUDIO_METADATA_INVALID',
        );
      }
    }
    // A directory failure does not prove its files were deleted, so do not disable unseen tracks in that scan.
    if (walkErrors.value === 0)
      for (const track of await this.db.track.findMany())
        if (!seen.has(track.path) && (await this.markMissing(track))) {
          result.missing++;
          await this.event('track.missing', 'warn', { id: track.id });
        }
    const jingles: string[] = [];
    await this.walk(path.join(this.config.storageRoot, 'jingles'), jingles, walkErrors);
    for (const file of jingles)
      try {
        const metadata = await parseFile(file, { duration: true });
        const inspected = await this.inspector.inspect(file);
        if (!inspected.durationSec || inspected.durationSec <= 0) throw new Error('Invalid jingle');
        await this.db.jingle.upsert({
          where: { path: file },
          create: {
            path: file,
            name: metadata.common.title ?? path.basename(file, path.extname(file)),
            durationSec: inspected.durationSec,
          },
          update: { durationSec: inspected.durationSec },
        });
        result.jingles++;
      } catch {
        result.errors++;
        await this.event('jingle.file.failed', 'warn', { path: file }, 'AUDIO_METADATA_INVALID');
      }
    result.errors += walkErrors.value;
    await this.writePlaylist();
    result.completedAt = new Date().toISOString();
    await this.db.radioSetting.upsert({
      where: { key: 'internal:lastScan' },
      create: { key: 'internal:lastScan', valueJson: { ...result } },
      update: { valueJson: { ...result } },
    });
    await this.event('library.scan.completed', 'info', {
      ...result,
      durationMs: Date.now() - started,
    });
    return result;
  }
}
