import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { RadioConfig } from '@radio/config';
import { Prisma, type PrismaClient } from '@radio/db';
import {
  LiquidsoapClient,
  FfprobeAudioInspector,
  OpenAIScriptGenerator,
  OpenAISpeechSynthesizer,
} from '@radio/integrations';
import {
  RadioError,
  type AudioInspector,
  type AutomationQueueItem,
  type BreakKind,
  type DjBreakContext,
  type NewsProvider,
  type PlaybackSnapshot,
  type RadioAutomationPort,
  type ScriptGenerator,
  type SpeechSynthesizer,
  type TrackRef,
  type WeatherProvider,
} from '@radio/shared';
import { LibraryScanner, type EventWriter } from './library.ts';
import { safeStoragePath, readableAudio, initializeStorage } from './storage.ts';
import { selectTrack } from './selection.ts';
import { hourlySlot } from './scheduler.ts';
import { validateScript } from './editorial.ts';
import { withLease } from './lease.ts';
import { readSettings, writeSettings, runtimeConfig, type SafeSettings } from './settings.ts';
import { Sources, errorCode } from './sources.ts';
import { readEnvironmentVersions } from './versions.ts';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const ACTIVE = ['PENDING', 'PUSHING', 'UNCERTAIN', 'ENQUEUED', 'CANCEL_REQUESTED'];
const BREAK_KINDS = ['hourly', 'weather', 'news', 'music-link', 'ident'] as const;
export type ComponentHealth = { ok: boolean; detail?: string; checkedAt?: string };
export type RadioHealth = {
  status: 'live' | 'degraded' | 'offline';
  checks: Record<
    'database' | 'library' | 'liquidsoap' | 'icecast' | 'worker' | 'openai' | 'weather' | 'news',
    ComponentHealth
  >;
  checkedAt: string;
  streamUrl: string;
};
export type RadioDependencies = {
  automation: RadioAutomationPort;
  weather: WeatherProvider;
  news: NewsProvider;
  scriptGenerator: ScriptGenerator;
  speech: SpeechSynthesizer;
  inspector: AudioInspector;
  now: () => Date;
  random: () => number;
  icecastHealth: () => Promise<ComponentHealth>;
};
export type TrackQuery = { search?: string; enabled?: boolean; page?: number; pageSize?: number };
export type TrackPatch = {
  title?: string;
  artist?: string;
  album?: string | null;
  genre?: string | null;
  enabled?: boolean;
};

export class RadioService {
  private automation: RadioAutomationPort;
  private inspector: AudioInspector;
  private now: () => Date;
  private random: () => number;
  private scanner: LibraryScanner;
  private sources: Sources;
  private running = false;
  private stopped = false;
  private activeTick: Promise<unknown> | null = null;
  private event: EventWriter;
  constructor(
    private config: RadioConfig,
    private db: PrismaClient,
    private dependencies: Partial<RadioDependencies> = {},
  ) {
    this.automation = dependencies.automation ?? new LiquidsoapClient(config);
    this.inspector = dependencies.inspector ?? new FfprobeAudioInspector(config);
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
    this.event = async (event, level = 'info', detail = {}, code) => {
      const data = {
        timestamp: this.now(),
        level,
        service: 'radio-core',
        event,
        errorCode: code,
        detailJson: json(detail),
      };
      await db.systemEvent.create({ data }).catch(() => {});
      if (config.nodeEnv !== 'test')
        console.log(JSON.stringify({ ...data, timestamp: data.timestamp.toISOString() }));
    };
    this.scanner = new LibraryScanner(config, db, this.event, this.inspector);
    this.sources = new Sources(config, db, this.now, this.event, dependencies);
  }
  async settings() {
    return readSettings(this.config, this.db);
  }
  async updateSettings(patch: Record<string, unknown>) {
    const result = await writeSettings(this.config, this.db, patch);
    await this.event('settings.updated', 'info', { keys: Object.keys(patch) });
    return result;
  }
  async tracks(query: TrackQuery = {}) {
    const parsed = z
      .object({
        search: z.string().max(200).optional(),
        enabled: z.boolean().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(25),
      })
      .parse(query);
    const where: Prisma.TrackWhereInput = {
      enabled: parsed.enabled,
      ...(parsed.search
        ? {
            OR: [
              { title: { contains: parsed.search } },
              { artist: { contains: parsed.search } },
              { album: { contains: parsed.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.track.findMany({
        where,
        orderBy: [{ artist: 'asc' }, { title: 'asc' }],
        skip: (parsed.page - 1) * parsed.pageSize,
        take: parsed.pageSize,
      }),
      this.db.track.count({ where }),
    ]);
    return { items, total, page: parsed.page, pageSize: parsed.pageSize };
  }
  async updateTrack(id: string, patch: TrackPatch) {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(500).optional(),
        artist: z.string().trim().min(1).max(500).optional(),
        album: z.string().max(500).nullable().optional(),
        genre: z.string().max(300).nullable().optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .parse(patch);
    const existing = await this.db.track.findUnique({ where: { id } });
    if (!existing) throw new RadioError('TRACK_NOT_FOUND', 'Canción no encontrada', 404);
    if (existing.missing && parsed.enabled === true)
      throw new RadioError(
        'TRACK_MISSING',
        'El archivo debe recuperarse antes de habilitarlo',
        409,
      );
    const metadataEdited = ['title', 'artist', 'album', 'genre'].some((key) => key in parsed);
    const track = await this.db.track.update({
      where: { id },
      data: { ...parsed, ...(metadataEdited ? { metadataEdited: true } : {}) },
    });
    if (existing.missing && parsed.enabled === false)
      await this.db.radioSetting.upsert({
        where: { key: `missing-enabled:${id}` },
        create: { key: `missing-enabled:${id}`, valueJson: false },
        update: { valueJson: false },
      });
    await initializeStorage(this.config.storageRoot);
    await this.scanner.writePlaylist();
    if (parsed.enabled === false) {
      for (const item of await this.db.queueItem.findMany({
        where: { assetId: id, type: 'track', state: { in: ACTIVE } },
      }))
        await this.removeQueue(item.id);
      await this.event('track.disabled', 'info', { id });
    }
    return track;
  }
  async scanLibrary() {
    const result = await withLease(this.db, 'scan', this.now, () => this.scanner.scan());
    if (result === null) throw new RadioError('SCAN_BUSY', 'Ya hay un escaneo en curso', 409, true);
    return result;
  }
  async queue() {
    return this.db.queueItem.findMany({
      where: { state: { in: ACTIVE } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }
  async history(limit = 50) {
    return this.db.playEvent.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.max(1, Math.min(200, Math.floor(limit))),
    });
  }
  async breaks() {
    return this.db.aiBreak.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }
  async sourcesStatus() {
    return this.sources.status(await this.settings());
  }
  async refreshSources() {
    return this.sources.refresh(await this.settings(), true);
  }
  async skip() {
    await this.automation.skip();
    await this.event('queue.skip.requested');
    return { skipped: true };
  }
  private remoteMatches(
    item: { id: string; path: string; queueRequestId: string | null },
    entry: AutomationQueueItem,
  ) {
    if (entry.metadata?.queue_item_id) return entry.metadata.queue_item_id === item.id;
    return (
      (entry.uri === item.path || entry.metadata?.filename === item.path) &&
      (!item.queueRequestId || entry.id === item.queueRequestId)
    );
  }
  private async removeRemote(item: {
    id: string;
    path: string;
    queueRequestId: string | null;
    priority: number;
  }) {
    const queue = item.priority > 0 ? 'priority' : 'music';
    const remote = await this.automation.queue(queue);
    const found = remote.find((entry) => this.remoteMatches(item, entry));
    if (!found)
      throw new RadioError(
        'QUEUE_NOT_PRESENT',
        'El elemento no aparece en la cola del motor; se reconciliará con la reproducción',
        409,
        true,
      );
    await this.automation.remove(found.id, queue);
  }
  async removeQueue(id: string) {
    const item = await this.db.queueItem.findUnique({ where: { id } });
    if (!item) throw new RadioError('QUEUE_NOT_FOUND', 'Elemento de cola no encontrado', 404);
    if (item.state === 'PLAYED')
      throw new RadioError('QUEUE_ALREADY_PLAYED', 'El elemento ya se ha reproducido', 409);
    if (['REMOVED', 'CANCELLED'].includes(item.state)) return item;
    // Only a successful PENDING compare-and-set proves no remote push can have begun.
    const pendingRemoved = await this.db.$transaction(async (tx) => {
      const changed = await tx.queueItem.updateMany({
        where: { id, state: 'PENDING' },
        data: { state: 'REMOVED', updatedAt: this.now() },
      });
      if (changed.count && item.type === 'ai_break' && item.assetId)
        await tx.aiBreak.updateMany({
          where: { id: item.assetId, status: { not: 'PLAYED' } },
          data: { status: 'CANCELLED' },
        });
      return changed.count;
    });
    if (pendingRemoved) return this.db.queueItem.findUniqueOrThrow({ where: { id } });
    const current = await this.db.$transaction(async (tx) => {
      await tx.queueItem.updateMany({
        where: { id, state: { in: ACTIVE } },
        data: { state: 'CANCEL_REQUESTED', updatedAt: this.now() },
      });
      return tx.queueItem.findUniqueOrThrow({ where: { id } });
    });
    if (current.state === 'PLAYED')
      throw new RadioError('QUEUE_ALREADY_PLAYED', 'El elemento ya se ha reproducido', 409);
    if (current.state !== 'CANCEL_REQUESTED') return current;
    try {
      await this.removeRemote(current);
      await this.db.$transaction(async (tx) => {
        const changed = await tx.queueItem.updateMany({
          where: { id, state: 'CANCEL_REQUESTED' },
          data: { state: 'REMOVED', updatedAt: this.now() },
        });
        if (changed.count && item.type === 'ai_break' && item.assetId)
          await tx.aiBreak.updateMany({
            where: { id: item.assetId, status: { not: 'PLAYED' } },
            data: { status: 'CANCELLED' },
          });
      });
    } catch (error) {
      await this.event(
        'queue.remove.failed',
        'warn',
        { id },
        errorCode(error, 'LIQUIDSOAP_UNAVAILABLE'),
      );
    }
    return this.db.queueItem.findUniqueOrThrow({ where: { id } });
  }
  private async pushItem(id: string) {
    let item = await this.db.queueItem.findUniqueOrThrow({ where: { id } });
    if (item.state !== 'PENDING') return item;
    if (!(await readableAudio(this.config.storageRoot, item.path))) {
      const failed = await this.db.queueItem.updateMany({
        where: { id, state: 'PENDING', updatedAt: item.updatedAt },
        data: { state: 'FAILED', errorCode: 'AUDIO_UNREADABLE' },
      });
      if (!failed.count) return this.db.queueItem.findUniqueOrThrow({ where: { id } });
      throw new RadioError('AUDIO_UNREADABLE', 'El audio no está disponible', 422);
    }
    const claimed = await this.db.queueItem.updateMany({
      where: { id, state: 'PENDING' },
      data: { state: 'PUSHING', updatedAt: this.now() },
    });
    if (claimed.count !== 1) return this.db.queueItem.findUniqueOrThrow({ where: { id } });
    item = await this.db.queueItem.findUniqueOrThrow({ where: { id } });
    try {
      const requestId = await this.automation.push(
        item.path,
        {
          queue_item_id: item.id,
          asset_id: item.assetId ?? '',
          type: item.type,
          title: item.title,
          artist: item.artist ?? this.config.stationName,
          ...(item.type === 'ai_break' ? { break_id: item.assetId ?? '' } : {}),
        },
        item.priority > 0 ? 'priority' : 'music',
      );
      const acknowledged = await this.db.$transaction(async (tx) => {
        const changed = await tx.queueItem.updateMany({
          where: { id, state: 'PUSHING' },
          data: {
            state: 'ENQUEUED',
            queueRequestId: requestId,
            errorCode: null,
            updatedAt: this.now(),
          },
        });
        if (!changed.count)
          await tx.queueItem.updateMany({ where: { id }, data: { queueRequestId: requestId } });
        const current = await tx.queueItem.findUniqueOrThrow({ where: { id } });
        if (item.type === 'ai_break' && item.assetId && current.state === 'ENQUEUED')
          await tx.aiBreak.updateMany({
            where: { id: item.assetId, status: { notIn: ['PLAYED', 'CANCELLED'] } },
            data: { status: 'ENQUEUED', queueRequestId: requestId },
          });
        return current;
      });
      if (acknowledged.state === 'CANCEL_REQUESTED') {
        try {
          await this.removeRemote(acknowledged);
          await this.db.queueItem.updateMany({
            where: { id, state: 'CANCEL_REQUESTED' },
            data: { state: 'REMOVED', updatedAt: this.now() },
          });
          if (item.type === 'ai_break' && item.assetId)
            await this.db.aiBreak.updateMany({
              where: { id: item.assetId, status: { not: 'PLAYED' } },
              data: { status: 'CANCELLED' },
            });
        } catch (error) {
          await this.event(
            'queue.remove.failed',
            'warn',
            { id },
            errorCode(error, 'LIQUIDSOAP_UNAVAILABLE'),
          );
        }
      }
      await this.event(item.type === 'ai_break' ? 'ai_break.enqueued' : 'queue.enqueued', 'info', {
        id,
        requestId,
      });
      return this.db.queueItem.findUniqueOrThrow({ where: { id } });
    } catch (error) {
      await this.db.queueItem
        .updateMany({
          where: { id, state: 'PUSHING' },
          data: { state: 'UNCERTAIN', errorCode: 'QUEUE_PUSH_UNCERTAIN', updatedAt: this.now() },
        })
        .catch(() => {});
      await this.event(
        'queue.push.uncertain',
        'warn',
        { id },
        errorCode(error, 'QUEUE_PUSH_UNCERTAIN'),
      );
      throw new RadioError(
        'QUEUE_PUSH_UNCERTAIN',
        'La respuesta del motor de audio se perdió; se reconciliará sin repetir la orden',
        503,
        true,
      );
    }
  }
  async enqueueTrack(id: string) {
    const result = await withLease(this.db, 'queue-mutation', this.now, async () => {
      const track = await this.db.track.findUnique({ where: { id } });
      if (!track) throw new RadioError('TRACK_NOT_FOUND', 'Canción no encontrada', 404);
      if (
        !track.enabled ||
        track.missing ||
        !(await readableAudio(this.config.storageRoot, track.path))
      )
        throw new RadioError(
          'TRACK_UNPLAYABLE',
          'Canción deshabilitada o archivo no disponible',
          422,
        );
      const existing = await this.db.queueItem.findFirst({
        where: { type: 'track', assetId: id, state: { in: ACTIVE } },
      });
      if (existing) return existing;
      const item = await this.db.queueItem.create({
        data: {
          type: 'track',
          assetId: id,
          path: track.path,
          title: track.title,
          artist: track.artist,
          dedupeKey: `track:${id}:${randomUUID()}`,
        },
      });
      return this.pushItem(item.id);
    });
    if (result === null)
      throw new RadioError('QUEUE_BUSY', 'Otra orden está modificando la cola', 409, true);
    return result;
  }
  private async recordSnapshot(snapshot: PlaybackSnapshot) {
    if (!snapshot.eventId || !Number.isFinite(new Date(snapshot.startedAt).getTime())) return;
    const startedAt = new Date(snapshot.startedAt);
    // Native request IDs restart with Liquidsoap. Stable application IDs, then active path/type, establish identity.
    const item = snapshot.queueItemId
      ? await this.db.queueItem.findUnique({ where: { id: snapshot.queueItemId } })
      : await this.db.queueItem.findFirst({
          where: { path: snapshot.path, type: snapshot.type, state: { in: ACTIVE } },
          orderBy: { createdAt: 'asc' },
        });
    const track =
      snapshot.type === 'track'
        ? item?.assetId
          ? await this.db.track.findUnique({ where: { id: item.assetId } })
          : await this.db.track.findUnique({ where: { path: snapshot.path } })
        : null;
    const aiBreak =
      snapshot.type === 'ai_break'
        ? item?.assetId
          ? await this.db.aiBreak.findUnique({ where: { id: item.assetId } })
          : await this.db.aiBreak.findFirst({ where: { audioPath: snapshot.path } })
        : null;
    const jingle =
      snapshot.type === 'jingle'
        ? await this.db.jingle.findUnique({ where: { path: snapshot.path } })
        : null;
    try {
      await this.db.$transaction(async (tx) => {
        if (await tx.playEvent.findUnique({ where: { externalId: snapshot.eventId } })) return;
        await tx.playEvent.updateMany({
          where: { status: 'PLAYING', startedAt: { lt: startedAt } },
          data: { status: 'PLAYED', endedAt: startedAt },
        });
        const following = await tx.playEvent.findFirst({
          where: { startedAt: { gt: startedAt } },
          orderBy: { startedAt: 'asc' },
        });
        await tx.playEvent.create({
          data: {
            externalId: snapshot.eventId,
            type: snapshot.type,
            assetId: track?.id ?? aiBreak?.id ?? jingle?.id,
            queueItemId: item?.id,
            title: snapshot.title || track?.title || 'Radio AI',
            artist: snapshot.artist,
            path: snapshot.path,
            startedAt,
            status: following ? 'PLAYED' : 'PLAYING',
            endedAt: following?.startedAt,
          },
        });
        if (track) {
          await tx.track.update({ where: { id: track.id }, data: { playCount: { increment: 1 } } });
          await tx.track.updateMany({
            where: {
              id: track.id,
              OR: [{ lastPlayedAt: null }, { lastPlayedAt: { lt: startedAt } }],
            },
            data: { lastPlayedAt: startedAt },
          });
        }
        if (item)
          await tx.queueItem.update({
            where: { id: item.id },
            data: {
              state: 'PLAYED',
              queueRequestId: snapshot.requestId ?? item.queueRequestId,
              errorCode: null,
            },
          });
        if (aiBreak)
          await tx.aiBreak.update({ where: { id: aiBreak.id }, data: { status: 'PLAYED' } });
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  private async reconcile() {
    const [music, priority, events, current] = await Promise.all([
      this.automation.queue('music'),
      this.automation.queue('priority'),
      this.automation.events(),
      this.automation.current(),
    ]);
    const snapshots = [...events, ...(current ? [current] : [])].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    );
    for (const snapshot of snapshots) await this.recordSnapshot(snapshot);
    const remote = [...music, ...priority];
    for (const item of await this.queue()) {
      const expected = { id: item.id, state: item.state, updatedAt: item.updatedAt };
      const found = remote.find((entry) => this.remoteMatches(item, entry));
      if (found) {
        if (item.state === 'CANCEL_REQUESTED') {
          await this.removeRemote(item);
          await this.db.$transaction(async (tx) => {
            const changed = await tx.queueItem.updateMany({
              where: expected,
              data: { state: 'REMOVED', queueRequestId: found.id },
            });
            if (changed.count && item.type === 'ai_break' && item.assetId)
              await tx.aiBreak.updateMany({
                where: { id: item.assetId, status: { not: 'PLAYED' } },
                data: { status: 'CANCELLED' },
              });
          });
          continue;
        }
        await this.db.$transaction(async (tx) => {
          const changed = await tx.queueItem.updateMany({
            where: expected,
            data: { state: 'ENQUEUED', queueRequestId: found.id, errorCode: null },
          });
          if (changed.count && item.type === 'ai_break' && item.assetId)
            await tx.aiBreak.updateMany({
              where: { id: item.assetId, status: { notIn: ['PLAYED', 'CANCELLED', 'EXPIRED'] } },
              data: { status: 'ENQUEUED', queueRequestId: found.id },
            });
        });
      } else if (item.state === 'PENDING') await this.pushItem(item.id);
      else if (item.state === 'ENQUEUED') {
        // The engine can dequeue between our queue and playback snapshots; retain identity until the next poll.
        const changed = await this.db.queueItem.updateMany({
          where: expected,
          data: { state: 'UNCERTAIN', errorCode: 'QUEUE_REQUEST_MISSING', updatedAt: this.now() },
        });
        if (changed.count)
          await this.event(
            'queue.request.missing',
            'warn',
            { id: item.id },
            'QUEUE_REQUEST_MISSING',
          );
      } else if (
        ['PUSHING', 'UNCERTAIN', 'CANCEL_REQUESTED'].includes(item.state) &&
        this.now().getTime() - item.updatedAt.getTime() > 300_000
      ) {
        const changed = await this.db.$transaction(async (tx) => {
          const changed = await tx.queueItem.updateMany({
            where: expected,
            data: { state: 'ABANDONED', errorCode: 'QUEUE_PUSH_UNCERTAIN' },
          });
          if (changed.count && item.type === 'ai_break' && item.assetId)
            await tx.aiBreak.updateMany({
              where: { id: item.assetId, status: { notIn: ['PLAYED', 'CANCELLED', 'EXPIRED'] } },
              data: { status: 'FAILED', errorCode: 'QUEUE_PUSH_UNCERTAIN', retryable: false },
            });
          return changed.count;
        });
        if (changed)
          await this.event(
            'queue.uncertain.abandoned',
            'warn',
            { id: item.id },
            'QUEUE_PUSH_UNCERTAIN',
          );
      }
      // An ambiguous order is never replayed; after bounded absence it frees queue capacity. Late events still reconcile.
    }
    return { remote, current };
  }
  async nowPlaying() {
    let live: PlaybackSnapshot | null = null;
    let connected = false;
    try {
      live = await this.automation.current();
      connected = true;
      if (live) await this.recordSnapshot(live);
    } catch {
      // Persisted history remains available and is explicitly marked stale when the engine is unreachable.
    }
    const [last, queue, lastBreak, nextBreak, events] = await Promise.all([
      this.db.playEvent.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.queue(),
      this.db.aiBreak.findFirst({ where: { status: 'PLAYED' }, orderBy: { updatedAt: 'desc' } }),
      this.db.aiBreak.findFirst({
        where: {
          status: {
            in: [
              'PLANNED',
              'GENERATING_CONTEXT',
              'GENERATING_SCRIPT',
              'GENERATING_AUDIO',
              'READY',
              'ENQUEUED',
            ],
          },
          OR: [
            { dedupeKey: { not: { startsWith: 'hourly:' } } },
            { scheduledFor: { gte: new Date(this.now().getTime() - 300_000) } },
          ],
        },
        orderBy: { scheduledFor: 'asc' },
      }),
      this.db.systemEvent.findMany({ orderBy: { timestamp: 'desc' }, take: 10 }),
    ]);
    const current = live
      ? { ...live, status: 'PLAYING', confidence: 'live', updatedAt: this.now().toISOString() }
      : last
        ? { ...last, confidence: 'stale', updatedAt: last.startedAt.toISOString() }
        : null;
    return { current, next: queue[0] ?? null, lastBreak, nextBreak, events, connected };
  }
  private async icecastCheck(): Promise<ComponentHealth> {
    if (this.dependencies.icecastHealth) return this.dependencies.icecastHealth();
    try {
      const response = await fetch(
        `http://${this.config.icecastHost}:${this.config.icecastPort}/status-json.xsl`,
        { signal: AbortSignal.timeout(this.config.fetchTimeoutMs), cache: 'no-store' },
      );
      if (!response.ok) return { ok: false, detail: `Icecast HTTP ${response.status}` };
      const body = (await response.json()) as {
        icestats?: { source?: { listenurl?: string } | { listenurl?: string }[] };
      };
      const value = body.icestats?.source;
      const sources = value ? (Array.isArray(value) ? value : [value]) : [];
      const online = sources.some((source) => {
        try {
          return new URL(source.listenurl ?? '').pathname === this.config.icecastMount;
        } catch {
          return false;
        }
      });
      return {
        ok: online,
        detail: online ? 'Mountpoint con fuente activa' : 'Mountpoint sin fuente',
      };
    } catch {
      return { ok: false, detail: 'Icecast no responde' };
    }
  }
  async health(): Promise<RadioHealth> {
    const at = this.now().toISOString();
    const checks: RadioHealth['checks'] = {
      database: { ok: false },
      library: { ok: false },
      liquidsoap: { ok: false },
      icecast: { ok: false },
      worker: { ok: false },
      openai: { ok: false },
      weather: { ok: false },
      news: { ok: false },
    };
    const results = await Promise.allSettled([
      (async () => {
        await this.db.$queryRaw`SELECT 1`;
        checks.database = { ok: true };
        const [tracks, heartbeat, lastAi] = await Promise.all([
          this.db.track.findMany({
            where: { enabled: true, missing: false },
            select: { path: true },
          }),
          this.db.radioSetting.findUnique({ where: { key: 'internal:workerHeartbeat' } }),
          this.db.aiBreak.findFirst({ orderBy: { updatedAt: 'desc' } }),
        ]);
        let count = 0;
        for (const track of tracks)
          if (await readableAudio(this.config.storageRoot, track.path)) count++;
        checks.library = { ok: count > 0, detail: `${count} canciones reproducibles` };
        const beat = heartbeat?.valueJson as { at?: string } | undefined;
        const age = beat?.at ? this.now().getTime() - new Date(beat.at).getTime() : Infinity;
        checks.worker = {
          ok: age >= 0 && age <= this.config.workerHeartbeatMaxSeconds * 1000,
          detail: beat?.at ?? 'Sin heartbeat',
        };
        checks.openai = {
          ok: !!this.config.openaiApiKey && lastAi?.status !== 'FAILED',
          detail: !this.config.openaiApiKey
            ? 'Clave sin configurar'
            : lastAi?.status === 'FAILED'
              ? (lastAi.errorCode ?? 'Última generación fallida')
              : 'Configurado; sin prueba periódica',
        };
        const status = await this.sourcesStatus();
        checks.weather = {
          ok: status.weather.ok || !status.weather.enabled,
          detail: status.weather.enabled
            ? status.weather.stale
              ? 'Datos ausentes o caducados'
              : (status.weather.errorCode ?? 'Datos recientes')
            : 'Desactivado',
        };
        checks.news = {
          ok: status.news.ok || !status.news.enabled,
          detail: status.news.enabled
            ? status.news.stale
              ? 'Fuentes sin actualización reciente'
              : (status.news.errorCode ?? 'Actualizado')
            : 'Desactivado',
        };
      })(),
      (async () => {
        checks.liquidsoap = await this.automation.health();
      })(),
      (async () => {
        checks.icecast = await this.icecastCheck();
      })(),
    ]);
    for (let index = 0; index < results.length; index++)
      if (results[index].status === 'rejected') {
        if (index === 0) checks.database = { ok: false, detail: 'Base de datos no disponible' };
        if (index === 1) checks.liquidsoap = { ok: false, detail: 'Liquidsoap no responde' };
        if (index === 2) checks.icecast = { ok: false, detail: 'Icecast no responde' };
      }
    const onAir = checks.liquidsoap.ok && checks.icecast.ok;
    return {
      status: !onAir ? 'offline' : Object.values(checks).every((c) => c.ok) ? 'live' : 'degraded',
      checks,
      checkedAt: at,
      streamUrl: this.config.streamPublicUrl,
    };
  }
  private async buildContext(
    kind: BreakKind,
    scheduledFor: Date,
    settings: SafeSettings,
    includeNextTrack = true,
  ): Promise<DjBreakContext> {
    await this.sources.refresh(settings);
    const [{ weather, news }, previous, queue] = await Promise.all([
      this.sources.context(settings),
      this.db.playEvent.findFirst({ where: { type: 'track' }, orderBy: { startedAt: 'desc' } }),
      this.queue(),
    ]);
    const next = queue.find((item) => item.type === 'track');
    let nextTrack: TrackRef | undefined;
    if (includeNextTrack && next?.assetId) {
      const track = await this.db.track.findUnique({ where: { id: next.assetId } });
      if (
        track &&
        track.enabled &&
        !track.missing &&
        (await readableAudio(this.config.storageRoot, track.path))
      )
        nextTrack = {
          id: track.id,
          path: track.path,
          title: track.title,
          artist: track.artist,
          durationSec: track.durationSec,
        };
    }
    return {
      kind,
      localTimeIso: DateTime.fromJSDate(scheduledFor, { zone: settings.timezone }).toISO()!,
      timezone: settings.timezone,
      weather,
      news,
      previousTrack: previous?.assetId
        ? {
            id: previous.assetId,
            path: previous.path ?? '',
            title: previous.title,
            artist: previous.artist ?? 'Desconocido',
            durationSec: 0,
          }
        : undefined,
      nextTrack,
      targetSeconds: settings.djTargetSeconds,
      stationPersona: settings.persona,
      stationName: settings.stationName,
    };
  }
  async preview(kind: BreakKind = 'hourly') {
    z.enum(BREAK_KINDS).parse(kind);
    const settings = await this.settings();
    const context = await this.buildContext(kind, this.now(), settings);
    const script = validateScript(
      await (
        this.dependencies.scriptGenerator ??
        new OpenAIScriptGenerator(runtimeConfig(this.config, settings))
      ).generate(context),
      context,
    );
    return { context, script };
  }
  private async assertStorageSpace() {
    await initializeStorage(this.config.storageRoot);
    const volume = await statfs(this.config.storageRoot);
    if (volume.bavail * volume.bsize < 16 * 1024 * 1024)
      throw new RadioError(
        'STORAGE_LOW_SPACE',
        'Se necesitan al menos 16 MiB libres para generar audio',
        503,
        false,
      );
  }
  private async produceAudio(text: string, relative: string, settings: SafeSettings) {
    await this.assertStorageSpace();
    const target = await safeStoragePath(this.config.storageRoot, relative, false);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = await safeStoragePath(
      this.config.storageRoot,
      `${target}.${randomUUID()}.part.mp3`,
      false,
    );
    try {
      const speech =
        this.dependencies.speech ??
        new OpenAISpeechSynthesizer(runtimeConfig(this.config, settings), this.inspector);
      const audio = await speech.synthesize(text, {
        outputPath: temporary,
        model: settings.ttsModel,
        voice: settings.ttsVoice,
        instructions: `Locución de radio musical en español de España. ${settings.persona}. Ritmo ágil e inteligible y pausas naturales.`,
      });
      if (path.resolve(audio.path) !== path.resolve(temporary))
        throw new RadioError(
          'AUDIO_PATH_INVALID',
          'El proveedor escribió en una ruta inesperada',
          502,
        );
      const safe = await safeStoragePath(this.config.storageRoot, temporary);
      const info = await this.inspector.inspect(safe);
      const file = await stat(safe);
      if (
        !Number.isFinite(info.durationSec) ||
        info.durationSec < 1 ||
        info.durationSec > 180 ||
        info.bytes <= 0 ||
        file.size <= 0
      )
        throw new RadioError('AUDIO_VALIDATION_FAILED', 'Audio vacío o duración inválida', 422);
      await safeStoragePath(this.config.storageRoot, target, false);
      await rename(safe, target);
      return { audioPath: target, durationSec: info.durationSec, bytes: file.size };
    } catch (error) {
      await rm(await safeStoragePath(this.config.storageRoot, temporary, false), {
        force: true,
      }).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
        throw new RadioError(
          'STORAGE_LOW_SPACE',
          'El almacenamiento se ha quedado sin espacio',
          503,
          false,
        );
      throw error;
    }
  }
  async testTts(
    text = 'Esta es Radio AI. Esta voz está generada por inteligencia artificial. Seguimos con buena música.',
  ) {
    const validated = z.string().trim().min(1).max(2000).parse(text);
    const settings = await this.settings();
    const day = DateTime.fromJSDate(this.now(), { zone: settings.timezone }).toFormat('yyyy/MM/dd');
    return this.produceAudio(validated, `generated/${day}/test-${randomUUID()}.mp3`, settings);
  }
  private async prepareBreak(id: string, settings: SafeSettings) {
    const value = await withLease(this.db, `break:${id}`, this.now, async () => {
      let item = await this.db.aiBreak.findUniqueOrThrow({ where: { id } });
      if (['READY', 'ENQUEUED', 'PLAYED', 'CANCELLED', 'EXPIRED'].includes(item.status))
        return item;
      const attemptKey = `internal:break-attempt:${id}`;
      const saved = await this.db.radioSetting.findUnique({ where: { key: attemptKey } });
      const prior = saved?.valueJson as { attempt?: number; at?: string } | undefined;
      const attempt = (prior?.attempt ?? 0) + 1;
      if (attempt > 3) return item;
      if (
        item.status === 'FAILED' &&
        (!item.retryable ||
          (prior?.at && this.now().getTime() - new Date(prior.at).getTime() < 60_000))
      )
        return item;
      await this.db.radioSetting.upsert({
        where: { key: attemptKey },
        create: { key: attemptKey, valueJson: { attempt, at: this.now().toISOString() } },
        update: { valueJson: { attempt, at: this.now().toISOString() } },
      });
      try {
        await this.assertStorageSpace();
        await this.db.aiBreak.update({
          where: { id },
          data: { status: 'GENERATING_CONTEXT', errorCode: null, retryable: false },
        });
        const context = await this.buildContext(
          item.kind as BreakKind,
          item.scheduledFor,
          settings,
          false,
        );
        await this.db.aiBreak.update({
          where: { id },
          data: { status: 'GENERATING_SCRIPT', contextJson: json(context) },
        });
        const script = validateScript(
          await (
            this.dependencies.scriptGenerator ??
            new OpenAIScriptGenerator(runtimeConfig(this.config, settings))
          ).generate(context),
          context,
        );
        await this.db.aiBreak.update({
          where: { id },
          data: {
            status: 'GENERATING_AUDIO',
            script: script.fullText,
            contextJson: json({ ...context, generatedScript: script }),
          },
        });
        const day = DateTime.fromJSDate(item.scheduledFor, { zone: settings.timezone }).toFormat(
          'yyyy/MM/dd',
        );
        const audio = await this.produceAudio(
          script.fullText,
          `generated/${day}/${id}.mp3`,
          settings,
        );
        if (
          audio.durationSec > settings.djTargetSeconds * 1.8 ||
          audio.durationSec < Math.max(5, settings.djTargetSeconds * 0.25)
        )
          throw new RadioError(
            'AUDIO_DURATION_INVALID',
            'La duración del audio no corresponde al objetivo',
            422,
          );
        const expired =
          item.dedupeKey.startsWith('hourly:') &&
          item.scheduledFor.getTime() < this.now().getTime() - 300_000;
        await this.db.aiBreak.updateMany({
          where: { id, status: 'GENERATING_AUDIO' },
          data: {
            status: expired ? 'EXPIRED' : 'READY',
            audioPath: audio.audioPath,
            durationSec: audio.durationSec,
            errorCode: expired ? 'HOURLY_EXPIRED' : null,
            retryable: false,
          },
        });
        item = await this.db.aiBreak.findUniqueOrThrow({ where: { id } });
        await this.event(item.status === 'READY' ? 'ai_break.ready' : 'ai_break.expired', 'info', {
          id,
          durationSec: audio.durationSec,
        });
        return item;
      } catch (error) {
        const code = errorCode(error, 'AI_GENERATION_FAILED');
        const retryable = attempt < 3 && (error instanceof RadioError ? error.retryable : true);
        await this.db.aiBreak.updateMany({
          where: { id, status: { notIn: ['PLAYED', 'ENQUEUED', 'CANCELLED', 'EXPIRED'] } },
          data: { status: 'FAILED', errorCode: code, retryable },
        });
        item = await this.db.aiBreak.findUniqueOrThrow({ where: { id } });
        await this.event('ai_break.failed', 'warn', { id, attempt, retryable }, code);
        return item;
      }
    });
    return value ?? this.db.aiBreak.findUniqueOrThrow({ where: { id } });
  }
  private async enqueueBreak(id: string) {
    const item = await this.db.aiBreak.findUniqueOrThrow({ where: { id } });
    if (item.status !== 'READY' || !item.audioPath) return item;
    const context = item.contextJson as {
      generatedScript?: { mentionsNextTrack?: boolean };
    } | null;
    if (context?.generatedScript?.mentionsNextTrack) {
      return this.db.aiBreak.update({
        where: { id },
        data: { status: 'FAILED', errorCode: 'SCRIPT_TRACK_UNRESERVED', retryable: false },
      });
    }
    const queueItem = await this.db.queueItem.upsert({
      where: { dedupeKey: `break:${id}` },
      create: {
        type: 'ai_break',
        assetId: id,
        path: item.audioPath,
        title: `${this.config.stationName} · DJ IA`,
        artist: this.config.stationName,
        priority: 100,
        scheduledFor: item.scheduledFor,
        dedupeKey: `break:${id}`,
      },
      update: {},
    });
    await this.pushItem(queueItem.id);
    return this.db.aiBreak.findUniqueOrThrow({ where: { id } });
  }
  async generateBreak(kind: BreakKind = 'hourly') {
    z.enum(BREAK_KINDS).parse(kind);
    const settings = await this.settings();
    const item = await this.db.aiBreak.create({
      data: { kind, scheduledFor: this.now(), dedupeKey: `manual:${randomUUID()}` },
    });
    await this.event('ai_break.planned', 'info', { id: item.id });
    const prepared = await this.prepareBreak(item.id, settings);
    if (prepared.status === 'READY') {
      try {
        return await this.enqueueBreak(item.id);
      } catch (error) {
        await this.event('ai_break.enqueue.failed', 'warn', { id: item.id }, errorCode(error));
      }
    }
    return this.db.aiBreak.findUniqueOrThrow({ where: { id: item.id } });
  }
  private async schedule(settings: SafeSettings) {
    const now = this.now();
    const expired = await this.db.aiBreak.findMany({
      where: {
        dedupeKey: { startsWith: 'hourly:' },
        scheduledFor: { lt: new Date(now.getTime() - 300_000) },
        status: {
          in: ['PLANNED', 'GENERATING_CONTEXT', 'GENERATING_SCRIPT', 'GENERATING_AUDIO', 'READY'],
        },
      },
      select: { id: true },
    });
    if (expired.length) {
      await this.db.aiBreak.updateMany({
        where: {
          id: { in: expired.map((item) => item.id) },
          status: {
            in: ['PLANNED', 'GENERATING_CONTEXT', 'GENERATING_SCRIPT', 'GENERATING_AUDIO', 'READY'],
          },
        },
        data: { status: 'EXPIRED', errorCode: 'HOURLY_EXPIRED', retryable: false },
      });
      await this.event('ai_break.expired', 'info', { ids: expired.map((item) => item.id) });
    }
    if (!settings.djHourlyEnabled) return;
    const slot = hourlySlot(now, settings.timezone);
    const until = slot.scheduledFor.getTime() - now.getTime();
    if (until <= settings.djPrepareMinutesBefore * 60_000) {
      const item = await this.db.aiBreak.upsert({
        where: { dedupeKey: slot.dedupeKey },
        create: { kind: 'hourly', scheduledFor: slot.scheduledFor, dedupeKey: slot.dedupeKey },
        update: {},
      });
      await this.prepareBreak(item.id, settings);
    }
    // A three-minute lease can outlive the nominal hour. Recover within the same five-minute freshness window.
    const interrupted = await this.db.aiBreak.findMany({
      where: {
        dedupeKey: { startsWith: 'hourly:' },
        status: {
          in: ['PLANNED', 'GENERATING_CONTEXT', 'GENERATING_SCRIPT', 'GENERATING_AUDIO', 'FAILED'],
        },
        scheduledFor: {
          gte: new Date(now.getTime() - 300_000),
          lte: new Date(now.getTime() + settings.djPrepareMinutesBefore * 60_000),
        },
      },
    });
    for (const item of interrupted)
      if (item.status !== 'FAILED' || item.retryable) await this.prepareBreak(item.id, settings);
    const ready = await this.db.aiBreak.findMany({
      where: {
        dedupeKey: { startsWith: 'hourly:' },
        status: 'READY',
        scheduledFor: {
          lte: new Date(now.getTime() + settings.djEnqueueMinutesBefore * 60_000),
          gte: new Date(now.getTime() - 300_000),
        },
      },
    });
    for (const item of ready)
      try {
        await this.enqueueBreak(item.id);
      } catch (error) {
        await this.event('ai_break.enqueue.failed', 'warn', { id: item.id }, errorCode(error));
      }
  }
  private async fillMusic(settings: SafeSettings, current: PlaybackSnapshot | null) {
    const tracks = await this.db.track.findMany({ where: { enabled: true, missing: false } });
    const readable = await Promise.all(
      tracks.map(async (track) =>
        (await readableAudio(this.config.storageRoot, track.path)) ? track : null,
      ),
    );
    const candidates = readable.filter(
      (track): track is NonNullable<typeof track> => track !== null,
    );
    const since = new Date(
      this.now().getTime() -
        Math.max(settings.trackRepeatHours * 3_600_000, settings.artistRepeatMinutes * 60_000),
    );
    const recent = await this.db.playEvent.findMany({
      where: { type: 'track', startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
      take: 5000,
    });
    let queued = await this.queue();
    const currentTrack =
      current?.type === 'track' ? candidates.find((track) => track.path === current.path) : null;
    for (
      let count = queued.filter((item) => item.type === 'track').length;
      count < settings.musicQueueTarget;
      count++
    ) {
      const picked = selectTrack(
        candidates,
        recent,
        [
          ...queued.filter((q) => q.type === 'track'),
          ...(currentTrack
            ? [{ assetId: currentTrack.id, artist: currentTrack.artist }]
            : current?.type === 'track'
              ? [{ artist: current.artist }]
              : []),
        ],
        settings,
        this.now(),
        this.random,
      );
      if (!picked) break;
      if (picked.relaxed.length)
        await this.event('constraints.relaxed', 'warn', {
          constraints: picked.relaxed,
          trackId: picked.track.id,
        });
      await this.enqueueTrack(picked.track.id);
      await this.event('selection.track.chosen', 'info', { trackId: picked.track.id });
      queued = await this.queue();
    }
  }
  private async scheduleJingle(settings: SafeSettings) {
    if ((await this.queue()).some((item) => item.type === 'jingle')) return;
    const lastJingle = await this.db.playEvent.findFirst({
      where: { type: 'jingle' },
      orderBy: { startedAt: 'desc' },
    });
    const count = await this.db.playEvent.count({
      where: { type: 'track', ...(lastJingle ? { startedAt: { gt: lastJingle.startedAt } } : {}) },
    });
    const saved = await this.db.radioSetting.findUnique({
      where: { key: 'internal:jingleCadence' },
    });
    let target = typeof saved?.valueJson === 'number' ? saved.valueJson : 0;
    if (target < settings.jingleMinTracks || target > settings.jingleMaxTracks) {
      target =
        settings.jingleMinTracks +
        Math.floor(this.random() * (settings.jingleMaxTracks - settings.jingleMinTracks + 1));
      await this.db.radioSetting.upsert({
        where: { key: 'internal:jingleCadence' },
        create: { key: 'internal:jingleCadence', valueJson: target },
        update: { valueJson: target },
      });
    }
    if (count < target) return;
    const jingles = await this.db.jingle.findMany({ where: { enabled: true } });
    const playable = [];
    for (const jingle of jingles)
      if (await readableAudio(this.config.storageRoot, jingle.path)) playable.push(jingle);
    if (!playable.length) return;
    const jingle = playable[Math.floor(this.random() * playable.length)];
    const item = await this.db.queueItem
      .create({
        data: {
          type: 'jingle',
          assetId: jingle.id,
          path: jingle.path,
          title: jingle.name,
          artist: settings.stationName,
          priority: 50,
          dedupeKey: `jingle:${lastJingle?.id ?? 'first'}:${count}`,
        },
      })
      .catch(async (error) => {
        if ((error as { code?: string }).code === 'P2002') return null;
        throw error;
      });
    if (item) {
      await this.pushItem(item.id);
      await this.db.radioSetting.update({
        where: { key: 'internal:jingleCadence' },
        data: { valueJson: 0 },
      });
    }
  }
  private async cleanupGenerated(settings: SafeSettings) {
    const prior = await this.db.radioSetting.findUnique({ where: { key: 'internal:lastCleanup' } });
    if (
      typeof prior?.valueJson === 'string' &&
      this.now().getTime() - new Date(prior.valueJson).getTime() < 3_600_000
    )
      return;
    const cutoff = this.now().getTime() - settings.generatedRetentionDays * 86_400_000;
    const retained = new Set(
      (
        await this.db.queueItem.findMany({
          where: { state: { in: ACTIVE } },
          select: { path: true },
        })
      ).map((q) => q.path),
    );
    for (const item of await this.db.aiBreak.findMany({
      where: { status: { in: ['READY', 'ENQUEUED', 'GENERATING_AUDIO'] } },
      select: { audioPath: true },
    }))
      if (item.audioPath) retained.add(item.audioPath);
    const playing = await this.db.playEvent.findFirst({
      where: { status: 'PLAYING' },
      orderBy: { startedAt: 'desc' },
    });
    if (playing?.path) retained.add(playing.path);
    let visited = 0;
    const walk = async (dir: string) => {
      for (const entry of await readdir(await safeStoragePath(this.config.storageRoot, dir), {
        withFileTypes: true,
      })) {
        if (++visited > 10000) return;
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && !retained.has(file)) {
          const safe = await safeStoragePath(this.config.storageRoot, file);
          if ((await stat(safe)).mtimeMs < cutoff) await rm(safe);
        }
      }
    };
    await walk(path.join(this.config.storageRoot, 'generated'));
    await this.db.radioSetting.upsert({
      where: { key: 'internal:lastCleanup' },
      create: { key: 'internal:lastCleanup', valueJson: this.now().toISOString() },
      update: { valueJson: this.now().toISOString() },
    });
  }
  async tick() {
    if (this.running || this.stopped) return { skipped: true };
    this.running = true;
    const heartbeat = setInterval(
      () => {
        const at = this.now().toISOString();
        void this.db.radioSetting
          .upsert({
            where: { key: 'internal:workerHeartbeat' },
            create: { key: 'internal:workerHeartbeat', valueJson: { at, pid: process.pid } },
            update: { valueJson: { at, pid: process.pid } },
          })
          .catch(() => {});
      },
      Math.min(10000, this.config.workerHeartbeatMaxSeconds * 500),
    );
    heartbeat.unref();
    const run = async () => {
      const at = this.now().toISOString();
      await this.db.radioSetting.upsert({
        where: { key: 'internal:workerHeartbeat' },
        create: { key: 'internal:workerHeartbeat', valueJson: { at, pid: process.pid } },
        update: { valueJson: { at, pid: process.pid } },
      });
      const result = await withLease(this.db, 'tick', this.now, async () => {
        await initializeStorage(this.config.storageRoot);
        const settings = await this.settings();
        const lastScan = await this.db.radioSetting.findUnique({
          where: { key: 'internal:lastScan' },
        });
        const scanAt = (lastScan?.valueJson as { completedAt?: string } | undefined)?.completedAt;
        if (
          !scanAt ||
          this.now().getTime() - new Date(scanAt).getTime() >=
            this.config.libraryScanIntervalSeconds * 1000
        )
          try {
            await this.scanLibrary();
          } catch (error) {
            await this.event('library.scan.failed', 'warn', {}, errorCode(error));
          }
        let connected = false;
        let current: PlaybackSnapshot | null = null;
        try {
          current = (await this.reconcile()).current;
          connected = true;
        } catch (error) {
          await this.event(
            'liquidsoap.disconnected',
            'warn',
            {},
            errorCode(error, 'LIQUIDSOAP_UNAVAILABLE'),
          );
        }
        await this.schedule(settings);
        if (connected) {
          await this.fillMusic(settings, current);
          await this.scheduleJingle(settings);
        }
        await this.sources.refresh(settings);
        await this.cleanupGenerated(settings);
        return { skipped: false, connected };
      });
      return result ?? { skipped: true };
    };
    this.activeTick = run();
    try {
      return await this.activeTick;
    } finally {
      clearInterval(heartbeat);
      this.running = false;
      this.activeTick = null;
    }
  }
  async system() {
    const [health, heartbeat, errors] = await Promise.all([
      this.health(),
      this.db.radioSetting.findUnique({ where: { key: 'internal:workerHeartbeat' } }),
      this.db.systemEvent.findMany({
        where: { level: { in: ['warn', 'error'] } },
        orderBy: { timestamp: 'desc' },
        take: 30,
      }),
    ]);
    let generatedBytes = 0;
    let files = 0;
    const count = async (dir: string) => {
      try {
        for (const entry of await readdir(await safeStoragePath(this.config.storageRoot, dir), {
          withFileTypes: true,
        })) {
          if (files > 10000) break;
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await count(file);
          else if (entry.isFile()) {
            files++;
            generatedBytes += (await stat(await safeStoragePath(this.config.storageRoot, file)))
              .size;
          }
        }
      } catch {
        // A missing or unreadable generated directory does not prevent reporting the remaining system checks.
      }
    };
    await count(path.join(this.config.storageRoot, 'generated'));
    let disk: { availableBytes: number; totalBytes: number } | null = null;
    try {
      const volume = await statfs(this.config.storageRoot);
      disk = {
        availableBytes: volume.bavail * volume.bsize,
        totalBytes: volume.blocks * volume.bsize,
      };
    } catch {
      // Some filesystems cannot report capacity; null expresses that the measurement is unavailable.
    }
    return {
      health,
      nodeVersion: process.version,
      versions: {
        node: process.version,
        ...(await readEnvironmentVersions(this.config.storageRoot)),
      },
      uptimeSeconds: process.uptime(),
      heartbeat: heartbeat?.valueJson ?? null,
      generated: { bytes: generatedBytes, files },
      disk,
      errors,
      configured: {
        openai: !!this.config.openaiApiKey,
        aemet: !!this.config.aemetApiKey,
        admin: !!this.config.adminToken,
      },
      timezone: (await this.settings()).timezone,
    };
  }
  async shutdown() {
    this.stopped = true;
    const pending = this.activeTick;
    if (pending)
      await Promise.race([
        pending.catch(() => {}),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15000);
          timer.unref();
        }),
      ]);
  }
}
