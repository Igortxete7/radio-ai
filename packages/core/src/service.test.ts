import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDatabase } from '@radio/db';
import { loadConfig } from '@radio/config';
import type {
  AutomationQueueItem,
  DjBreakContext,
  GeneratedScript,
  PlaybackSnapshot,
  RadioAutomationPort,
} from '@radio/shared';
import { RadioError } from '@radio/shared';
import { RadioService, type RadioDependencies } from './service.ts';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
class Automation implements RadioAutomationPort {
  items: AutomationQueueItem[] = [];
  snapshots: PlaybackSnapshot[] = [];
  losePushResponse = false;
  async push(uri: string, metadata?: Record<string, string>) {
    const id = String(this.items.length + 1);
    this.items.push({ id, uri, metadata });
    if (this.losePushResponse) throw new RadioError('LIQUIDSOAP_TIMEOUT', 'timeout', 503, true);
    return id;
  }
  async queue() {
    return this.items;
  }
  async remove(id: string) {
    this.items = this.items.filter((x) => x.id !== id);
  }
  async skip() {}
  async health() {
    return { ok: true };
  }
  async current() {
    return this.snapshots.at(-1) ?? null;
  }
  async events() {
    return this.snapshots;
  }
}
async function setup(
  now = new Date('2026-10-13T10:55:00Z'),
  overrides: Partial<RadioDependencies> = {},
) {
  const { db, directory, cleanup } = await createTestDatabase();
  cleanups.push(cleanup);
  const config = {
    ...loadConfig({ NODE_ENV: 'test' }),
    storageRoot: path.join(directory, 'storage'),
    openaiApiKey: 'test',
    musicQueueTarget: 1,
    newsSources: [],
    djHourlyEnabled: false,
  };
  await mkdir(path.join(config.storageRoot, 'music'), { recursive: true });
  await mkdir(path.join(config.storageRoot, 'jingles'), { recursive: true });
  const automation = new Automation();
  const scriptGenerator = {
    async generate(context: DjBreakContext): Promise<GeneratedScript> {
      return {
        opening: 'Buenos días',
        body: 'Seguimos con buena música en la radio.',
        closing: 'Disfruta de la canción.',
        fullText: 'Buenos días. Seguimos con buena música en la radio. Disfruta de la canción.',
        mentionedNewsIds: [],
        mentionsWeather: false,
        mentionsNextTrack: !!context.nextTrack,
        estimatedSeconds: 30,
      };
    },
  };
  const service = new RadioService(config, db, {
    automation,
    scriptGenerator,
    weather: {
      async getCurrentAndForecast() {
        throw new RadioError('WEATHER_UNAVAILABLE', 'offline', 503, true);
      },
    },
    news: {
      async fetchCandidates() {
        return [];
      },
    },
    speech: {
      async synthesize(_text, options) {
        await writeFile(options.outputPath, Buffer.alloc(512));
        return { path: options.outputPath, durationSec: 30, bytes: 512 };
      },
    },
    inspector: {
      async inspect() {
        return { durationSec: 30, bytes: 512 };
      },
    },
    now: () => now,
    icecastHealth: async () => ({ ok: true }),
    ...overrides,
  });
  return {
    service,
    db,
    config,
    automation,
    setNow: (value: Date) => {
      now = value;
    },
  };
}
it('registra reproducción real una sola vez y sólo entonces actualiza PLAYED y playCount', async () => {
  const { service, db, config, automation } = await setup();
  const file = path.join(config.storageRoot, 'music', 'one.mp3');
  await writeFile(file, 'audio');
  const track = await db.track.create({
    data: { path: file, title: 'One', artist: 'Artist', durationSec: 30 },
  });
  const item = await service.enqueueTrack(track.id);
  expect((await db.track.findUniqueOrThrow({ where: { id: track.id } })).playCount).toBe(0);
  automation.snapshots = [
    {
      eventId: 'event-1',
      queueItemId: item.id,
      requestId: '1',
      path: file,
      title: 'One',
      artist: 'Artist',
      startedAt: '2026-10-13T10:55:00Z',
      type: 'track',
    },
  ];
  automation.items = [];
  await service.tick();
  await service.tick();
  expect(await db.playEvent.count()).toBe(1);
  expect((await db.track.findUniqueOrThrow({ where: { id: track.id } })).playCount).toBe(1);
  expect((await db.queueItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('PLAYED');
});
it('reconcilia un push aceptado con respuesta perdida sin duplicar tras recuperación', async () => {
  const { service, db, config, automation } = await setup();
  const file = path.join(config.storageRoot, 'music', 'one.mp3');
  await writeFile(file, 'audio');
  const track = await db.track.create({
    data: { path: file, title: 'One', artist: 'Artist', durationSec: 30 },
  });
  automation.losePushResponse = true;
  await expect(service.enqueueTrack(track.id)).rejects.toMatchObject({
    code: 'QUEUE_PUSH_UNCERTAIN',
  });
  await service.tick();
  const item = await db.queueItem.findFirstOrThrow();
  expect(item.state).toBe('ENQUEUED');
  expect(item.queueRequestId).toBe('1');
  expect(automation.items).toHaveLength(1);
});
it('una meteorología fallida no impide generar ni encolar audio válido', async () => {
  const { service, db } = await setup();
  const result = await service.generateBreak('hourly');
  expect(result.status).toBe('ENQUEUED');
  expect(result.audioPath).toContain('generated');
  expect(await db.weatherSnapshot.count()).toBe(0);
  expect((await service.sourcesStatus()).weather.ok).toBe(false);
});
it('aísla ajustes secretos y persiste sólo configuración funcional validada', async () => {
  const { service } = await setup();
  await expect(service.updateSettings({ openaiApiKey: 'secret' })).rejects.toMatchObject({
    code: 'SETTINGS_INVALID',
  });
  await service.updateSettings({
    stationName: 'Mi radio',
    newsEnabled: false,
    trackRepeatHours: 4,
  });
  expect(await service.settings()).toMatchObject({
    stationName: 'Mi radio',
    newsEnabled: false,
    trackRepeatHours: 4,
  });
  expect(JSON.stringify(await service.settings())).not.toContain('openaiApiKey');
});
it('un lease vencido permite recuperar un job horario con la misma clave única', async () => {
  const { service, db } = await setup();
  await db.jobRun.create({
    data: {
      jobName: 'scheduler',
      dedupeKey: 'lock:tick',
      scheduledFor: new Date('2026-10-13T10:00:00Z'),
      startedAt: new Date('2026-10-13T10:00:00Z'),
      status: 'RUNNING',
      error: 'dead-worker',
    },
  });
  await service.updateSettings({ djHourlyEnabled: true });
  await service.tick();
  await service.tick();
  expect(await db.aiBreak.count({ where: { dedupeKey: 'hourly:2026-10-13T11:00:00.000Z' } })).toBe(
    1,
  );
});
it('prepara a T-5, encola a T-1 una sola vez y marca PLAYED desde el evento', async () => {
  const { service, db, automation, setNow } = await setup();
  await service.updateSettings({ djHourlyEnabled: true });
  await service.tick();
  const prepared = await db.aiBreak.findFirstOrThrow();
  expect(prepared.status).toBe('READY');
  expect(automation.items).toHaveLength(0);
  setNow(new Date('2026-10-13T10:59:00Z'));
  await service.tick();
  await service.tick();
  expect(automation.items).toHaveLength(1);
  const queued = await db.queueItem.findFirstOrThrow({ where: { type: 'ai_break' } });
  automation.snapshots = [
    {
      eventId: 'break-event',
      queueItemId: queued.id,
      requestId: queued.queueRequestId!,
      path: queued.path,
      title: 'DJ IA',
      startedAt: '2026-10-13T11:01:00Z',
      type: 'ai_break',
    },
  ];
  automation.items = [];
  setNow(new Date('2026-10-13T11:01:00Z'));
  await service.tick();
  expect((await db.aiBreak.findUniqueOrThrow({ where: { id: prepared.id } })).status).toBe(
    'PLAYED',
  );
});
it('conserva una intención incierta sin evidencia y nunca reintenta el push', async () => {
  const { service, db, config, automation } = await setup();
  const file = path.join(config.storageRoot, 'music', 'one.mp3');
  await writeFile(file, 'audio');
  await db.queueItem.create({
    data: {
      type: 'track',
      path: file,
      title: 'One',
      state: 'PUSHING',
      dedupeKey: 'uncertain',
      updatedAt: new Date('2026-10-13T10:55:00Z'),
    },
  });
  await service.tick();
  await service.tick();
  expect(automation.items).toHaveLength(0);
  expect((await db.queueItem.findFirstOrThrow()).state).toBe('PUSHING');
});
it('el historial reconstruido después de now-playing cierra también los eventos antiguos', async () => {
  const { service, db, automation } = await setup();
  const early = {
    eventId: 'older',
    path: 'fallback.mp3',
    title: 'Older',
    startedAt: '2026-10-13T10:54:00Z',
    type: 'fallback' as const,
  };
  const latest = {
    ...early,
    eventId: 'latest',
    title: 'Latest',
    startedAt: '2026-10-13T10:55:00Z',
  };
  automation.snapshots = [latest];
  await service.nowPlaying();
  automation.snapshots = [early, latest];
  await service.tick();
  expect(await db.playEvent.count({ where: { status: 'PLAYING' } })).toBe(1);
  expect(await db.playEvent.findUniqueOrThrow({ where: { externalId: 'older' } })).toMatchObject({
    status: 'PLAYED',
    endedAt: new Date('2026-10-13T10:55:00Z'),
  });
});
it('una identidad rid reutilizada no cambia el contador de una canción histórica', async () => {
  const { service, db, config, automation } = await setup();
  const old = await db.track.create({
    data: {
      path: path.join(config.storageRoot, 'music', 'old.mp3'),
      title: 'Old',
      artist: 'Old Artist',
      durationSec: 30,
    },
  });
  const next = await db.track.create({
    data: {
      path: path.join(config.storageRoot, 'music', 'new.mp3'),
      title: 'New',
      artist: 'New Artist',
      durationSec: 30,
    },
  });
  await db.queueItem.create({
    data: {
      type: 'track',
      assetId: old.id,
      path: old.path,
      title: 'Old',
      state: 'PLAYED',
      queueRequestId: '1',
      dedupeKey: 'historical',
    },
  });
  automation.snapshots = [
    {
      eventId: 'new-boot:1',
      requestId: '1',
      path: next.path,
      title: 'New',
      artist: 'New Artist',
      startedAt: '2026-10-13T10:55:00Z',
      type: 'track',
    },
  ];
  await service.nowPlaying();
  expect((await db.track.findUniqueOrThrow({ where: { id: old.id } })).playCount).toBe(0);
  expect((await db.track.findUniqueOrThrow({ where: { id: next.id } })).playCount).toBe(1);
});
it('cambiar coordenadas con el mismo nombre no reutiliza meteorología del sitio anterior', async () => {
  let fail = false;
  const { service } = await setup(undefined, {
    weather: {
      async getCurrentAndForecast() {
        if (fail) throw new RadioError('WEATHER_UNAVAILABLE', 'offline', 503, true);
        return { observedAt: '2026-10-13T10:55:00Z', temperatureC: 23, sourceName: 'Weather' };
      },
    },
  });
  await service.refreshSources();
  expect((await service.preview()).context.weather?.temperatureC).toBe(23);
  fail = true;
  const current = await service.settings();
  await service.updateSettings({ location: { ...current.location, latitude: 44 } });
  expect((await service.preview()).context.weather).toBeUndefined();
  expect((await service.sourcesStatus()).weather.stale).toBe(true);
});
it('nunca encola una locución que no supera la inspección de audio', async () => {
  const { service, db, automation } = await setup(undefined, {
    inspector: {
      async inspect() {
        return { durationSec: 0, bytes: 512 };
      },
    },
  });
  const result = await service.generateBreak();
  expect(result.status).toBe('FAILED');
  expect(await db.queueItem.count()).toBe(0);
  expect(automation.items).toHaveLength(0);
});
it('no vuelve a encolar durante el hueco entre retirada de la cola y el evento de inicio', async () => {
  const { service, db, config, automation } = await setup();
  const file = path.join(config.storageRoot, 'music', 'transition.mp3');
  await writeFile(file, 'audio');
  const track = await db.track.create({
    data: { path: file, title: 'Transition', artist: 'Artist', durationSec: 30 },
  });
  const item = await service.enqueueTrack(track.id);
  automation.items = [];
  await service.tick();
  await service.tick();
  expect(automation.items).toHaveLength(0);
  expect((await db.queueItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe(
    'UNCERTAIN',
  );
});
it('preserva una cancelación que llega mientras el motor confirma el push', async () => {
  class BlockingAutomation extends Automation {
    resume!: () => void;
    private startedResolve!: () => void;
    started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
    private released = new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    override async push(uri: string, metadata?: Record<string, string>) {
      const id = await super.push(uri, metadata);
      this.startedResolve();
      await this.released;
      return id;
    }
  }
  const automation = new BlockingAutomation();
  const { service, db, config } = await setup(undefined, { automation });
  const file = path.join(config.storageRoot, 'music', 'cancel.mp3');
  await writeFile(file, 'audio');
  const track = await db.track.create({
    data: { path: file, title: 'Cancel', artist: 'Artist', durationSec: 30 },
  });
  const pending = service.enqueueTrack(track.id);
  await automation.started;
  const item = await db.queueItem.findFirstOrThrow();
  await service.removeQueue(item.id);
  automation.resume();
  await pending;
  expect((await db.queueItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('REMOVED');
  expect(automation.items).toHaveLength(0);
});
it('retira las intervenciones horarias antiguas y deja de mostrarlas como próximas', async () => {
  const { service, db } = await setup();
  await service.updateSettings({ djHourlyEnabled: true });
  const expired = await db.aiBreak.create({
    data: {
      kind: 'hourly',
      scheduledFor: new Date('2026-10-13T10:00:00Z'),
      status: 'READY',
      dedupeKey: 'hourly:2026-10-13T10:00:00.000Z',
      audioPath: 'old-hour.mp3',
    },
  });
  await service.tick();
  expect((await db.aiBreak.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe(
    'EXPIRED',
  );
  expect((await service.nowPlaying()).nextBreak?.id).not.toBe(expired.id);
});
it('recupera un job horario después de que venza su lease aunque la hora ya haya pasado', async () => {
  const { service, db, automation } = await setup(new Date('2026-10-13T11:02:00Z'));
  await service.updateSettings({ djHourlyEnabled: true });
  const item = await db.aiBreak.create({
    data: {
      kind: 'hourly',
      scheduledFor: new Date('2026-10-13T11:00:00Z'),
      status: 'GENERATING_AUDIO',
      dedupeKey: 'hourly:2026-10-13T11:00:00.000Z',
    },
  });
  await db.jobRun.create({
    data: {
      jobName: `break:${item.id}`,
      dedupeKey: `lock:break:${item.id}`,
      scheduledFor: item.scheduledFor,
      startedAt: new Date('2026-10-13T10:58:00Z'),
      status: 'RUNNING',
      error: 'dead-worker',
    },
  });
  await service.tick();
  await service.tick();
  expect((await db.aiBreak.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('ENQUEUED');
  expect(automation.items).toHaveLength(1);
});
it('una intervención horaria anticipada no promete una canción que puede sonar antes', async () => {
  const { service, db, config } = await setup();
  await service.updateSettings({ djHourlyEnabled: true });
  const file = path.join(config.storageRoot, 'music', 'before-break.mp3');
  await writeFile(file, 'audio');
  const track = await db.track.create({
    data: { path: file, title: 'Before', artist: 'Artist', durationSec: 30 },
  });
  await service.enqueueTrack(track.id);
  await service.tick();
  const item = await db.aiBreak.findFirstOrThrow();
  expect((item.contextJson as { nextTrack?: unknown }).nextTrack).toBeUndefined();
});
it('una reproducción confirmada antes del ack del push permanece PLAYED', async () => {
  class StartedBeforeAck extends Automation {
    resume!: () => void;
    private startedResolve!: () => void;
    started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
    private released = new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    override async push(uri: string, metadata?: Record<string, string>) {
      const id = await super.push(uri, metadata);
      this.items = [];
      this.snapshots = [
        {
          eventId: 'started-before-ack',
          queueItemId: metadata?.queue_item_id,
          requestId: id,
          path: uri,
          title: 'Playing',
          startedAt: '2026-10-13T10:55:00Z',
          type: 'track',
        },
      ];
      this.startedResolve();
      await this.released;
      return id;
    }
  }
  const automation = new StartedBeforeAck();
  const { service, db, config } = await setup(undefined, { automation });
  const file = path.join(config.storageRoot, 'music', 'already-playing.mp3');
  await writeFile(file, 'audio');
  const track = await db.track.create({
    data: { path: file, title: 'Playing', artist: 'Artist', durationSec: 30 },
  });
  const pending = service.enqueueTrack(track.id);
  await automation.started;
  await service.nowPlaying();
  automation.resume();
  const item = await pending;
  expect(item.state).toBe('PLAYED');
  expect((await db.track.findUniqueOrThrow({ where: { id: track.id } })).playCount).toBe(1);
});
it('una cancelación no elimina otro elemento cuyo rid fue reutilizado tras reiniciar Liquidsoap', async () => {
  const { service, db, config, automation } = await setup();
  const old = await db.queueItem.create({
    data: {
      type: 'track',
      path: path.join(config.storageRoot, 'music', 'old.mp3'),
      title: 'Old',
      state: 'ENQUEUED',
      queueRequestId: '1',
      dedupeKey: 'old-boot',
    },
  });
  automation.items = [
    {
      id: '1',
      uri: path.join(config.storageRoot, 'music', 'new.mp3'),
      metadata: { queue_item_id: 'new-boot-item' },
    },
  ];
  await service.removeQueue(old.id);
  expect(automation.items).toHaveLength(1);
  expect((await db.queueItem.findUniqueOrThrow({ where: { id: old.id } })).state).toBe(
    'CANCEL_REQUESTED',
  );
});
it('una lectura PENDING antigua no permite confirmar una cancelación sin retirar el push aceptado', async () => {
  class WaitingAck extends Automation {
    resume!: () => void;
    private accept!: () => void;
    accepted = new Promise<void>((resolve) => {
      this.accept = resolve;
    });
    private released = new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    override async push(uri: string, metadata?: Record<string, string>) {
      const id = await super.push(uri, metadata);
      this.accept();
      await this.released;
      return id;
    }
  }
  const automation = new WaitingAck();
  const { db, config } = await setup();
  const file = path.join(config.storageRoot, 'music', 'pending-read.mp3');
  await writeFile(file, 'audio');
  const item = await db.queueItem.create({
    data: { type: 'track', path: file, title: 'Pending', dedupeKey: 'pending-read' },
  });
  await db.radioSetting.create({
    data: { key: 'internal:lastScan', valueJson: { completedAt: '2026-10-13T10:55:00Z' } },
  });
  let releaseRead!: () => void;
  let signalRead!: () => void;
  const read = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let first = true;
  const delegate = new Proxy(db.queueItem, {
    get(target, key, receiver) {
      if (key === 'findUnique')
        return async (...args: unknown[]) => {
          const value = await Reflect.apply(Reflect.get(target, key), target, args);
          if (first) {
            first = false;
            signalRead();
            await heldRead;
          }
          return value;
        };
      return Reflect.get(target, key, receiver);
    },
  });
  const database = new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'queueItem') return delegate;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const service = new RadioService(config, database, {
    automation,
    now: () => new Date('2026-10-13T10:55:00Z'),
    weather: {
      async getCurrentAndForecast() {
        throw new RadioError('WEATHER_UNAVAILABLE', 'offline', 503);
      },
    },
    news: {
      async fetchCandidates() {
        return [];
      },
    },
  });
  const cancellation = service.removeQueue(item.id);
  await read;
  const tick = service.tick();
  await automation.accepted;
  releaseRead();
  await cancellation;
  automation.resume();
  await tick;
  expect((await db.queueItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('REMOVED');
  expect(automation.items).toHaveLength(0);
});
it('reconciliar una instantánea antigua no sobrescribe una reproducción confirmada por otro proceso', async () => {
  const { service, db, config, automation } = await setup();
  const file = path.join(config.storageRoot, 'music', 'other-process.mp3');
  await writeFile(file, 'audio');
  const track = await db.track.create({
    data: { path: file, title: 'Other', artist: 'Artist', durationSec: 30 },
  });
  const item = await service.enqueueTrack(track.id);
  let release!: () => void;
  let signal!: () => void;
  const captured = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = service.queue.bind(service);
  vi.spyOn(service, 'queue').mockImplementationOnce(async () => {
    const rows = await original();
    signal();
    await blocked;
    return rows;
  });
  const tick = service.tick();
  await captured;
  automation.snapshots = [
    {
      eventId: 'other-process-event',
      queueItemId: item.id,
      requestId: item.queueRequestId!,
      path: file,
      title: 'Other',
      startedAt: '2026-10-13T10:55:00Z',
      type: 'track',
    },
  ];
  const reader = new RadioService(config, db, {
    automation,
    now: () => new Date('2026-10-13T10:55:00Z'),
  });
  await reader.nowPlaying();
  release();
  await tick;
  expect((await db.queueItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('PLAYED');
  expect(await db.playEvent.count()).toBe(1);
});
it('una cancelación recuperada en reconciliación termina también el estado de la intervención', async () => {
  const { service, db, config, automation } = await setup();
  const file = path.join(config.storageRoot, 'manual-break.mp3');
  await writeFile(file, 'audio');
  const aiBreak = await db.aiBreak.create({
    data: {
      kind: 'hourly',
      scheduledFor: new Date('2026-10-13T10:55:00Z'),
      status: 'ENQUEUED',
      audioPath: file,
      dedupeKey: 'manual:cancel-recovered',
    },
  });
  const item = await db.queueItem.create({
    data: {
      type: 'ai_break',
      assetId: aiBreak.id,
      priority: 100,
      path: file,
      title: 'DJ',
      state: 'CANCEL_REQUESTED',
      dedupeKey: 'break:cancel-recovered',
    },
  });
  automation.items = [{ id: '1', uri: file, metadata: { queue_item_id: item.id } }];
  await service.tick();
  expect((await db.aiBreak.findUniqueOrThrow({ where: { id: aiBreak.id } })).status).toBe(
    'CANCELLED',
  );
  expect((await service.nowPlaying()).nextBreak).toBeNull();
});
it('una reconciliación pausada conserva la cancelación completada por otro proceso', async () => {
  const { service, db, config, automation } = await setup();
  const file = path.join(config.storageRoot, 'cancel-interleaving.mp3');
  await writeFile(file, 'audio');
  const aiBreak = await db.aiBreak.create({
    data: {
      kind: 'ident',
      scheduledFor: new Date('2026-10-13T10:55:00Z'),
      status: 'ENQUEUED',
      audioPath: file,
      dedupeKey: 'manual:cancel-interleaving',
    },
  });
  const item = await db.queueItem.create({
    data: {
      type: 'ai_break',
      assetId: aiBreak.id,
      priority: 100,
      path: file,
      title: 'DJ',
      state: 'ENQUEUED',
      queueRequestId: '1',
      dedupeKey: 'break:cancel-interleaving',
    },
  });
  automation.items = [{ id: '1', uri: file, metadata: { queue_item_id: item.id } }];
  let release!: () => void;
  let signal!: () => void;
  const captured = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = service.queue.bind(service);
  vi.spyOn(service, 'queue').mockImplementationOnce(async () => {
    const rows = await original();
    signal();
    await blocked;
    return rows;
  });
  const tick = service.tick();
  await captured;
  const remover = new RadioService(config, db, { automation });
  await remover.removeQueue(item.id);
  release();
  await tick;
  expect((await db.queueItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('REMOVED');
  expect((await db.aiBreak.findUniqueOrThrow({ where: { id: aiBreak.id } })).status).toBe(
    'CANCELLED',
  );
  expect(automation.items).toHaveLength(0);
});
