import type { RadioConfig } from '@radio/config';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@radio/db';
import {
  AemetWeatherProvider,
  OpenMeteoWeatherProvider,
  RssNewsProvider,
} from '@radio/integrations';
import {
  RadioError,
  type NewsCandidate,
  type NewsProvider,
  type WeatherBrief,
  type WeatherProvider,
} from '@radio/shared';
import type { EventWriter } from './library.ts';
import { runtimeConfig, type SafeSettings } from './settings.ts';

export type SourceState = {
  ok: boolean;
  stale: boolean;
  enabled: boolean;
  lastAttempt?: string;
  lastSuccess?: string;
  errorCode?: string;
  items?: number;
  sourceStatuses?: unknown[];
};
export const errorCode = (error: unknown, fallback = 'INTERNAL_ERROR') =>
  error instanceof RadioError ? error.code : fallback;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const weatherKey = (settings: SafeSettings) =>
  `weather:${createHash('sha256')
    .update(JSON.stringify({ provider: settings.weatherProvider, location: settings.location }))
    .digest('hex')
    .slice(0, 24)}`;
const newsKey = (settings: SafeSettings) =>
  `news:${createHash('sha256').update(JSON.stringify(settings.newsSources)).digest('hex').slice(0, 24)}`;
export class Sources {
  constructor(
    private config: RadioConfig,
    private db: PrismaClient,
    private now: () => Date,
    private event: EventWriter,
    private ports: { weather?: WeatherProvider; news?: NewsProvider },
  ) {}
  private async storeStatus(key: string, value: Record<string, unknown>) {
    await this.db.radioSetting.upsert({
      where: { key: `source:${key}` },
      create: { key: `source:${key}`, valueJson: json(value) },
      update: { valueJson: json(value) },
    });
  }
  async context(
    settings: SafeSettings,
  ): Promise<{ weather?: WeatherBrief; news: NewsCandidate[] }> {
    const now = this.now().getTime();
    let weather: WeatherBrief | undefined;
    if (settings.weatherEnabled) {
      const snapshot = await this.db.weatherSnapshot.findFirst({
        where: { location: weatherKey(settings) },
        orderBy: { observedAt: 'desc' },
      });
      if (
        snapshot &&
        now - snapshot.observedAt.getTime() <= settings.weatherMaxAgeMinutes * 60_000 &&
        snapshot.observedAt.getTime() <= now + 300_000
      )
        weather = snapshot.payloadJson as WeatherBrief;
    }
    const names = settings.newsEnabled
      ? settings.newsSources.filter((s) => s.enabled !== false).map((s) => s.name)
      : [];
    const rows = names.length
      ? await this.db.newsItem.findMany({
          where: {
            source: { in: names },
            publishedAt: {
              gte: new Date(now - settings.newsMaxAgeHours * 3_600_000),
              lte: new Date(now + 300_000),
            },
          },
          orderBy: [{ priority: 'desc' }, { publishedAt: 'desc' }],
          take: 5,
        })
      : [];
    return {
      weather,
      news: rows.map((item) => ({
        ...item,
        summary: item.summary ?? undefined,
        publishedAt: item.publishedAt.toISOString(),
      })),
    };
  }
  async status(settings: SafeSettings): Promise<{
    weather: SourceState;
    news: SourceState;
    newsSources: SafeSettings['newsSources'];
    newsHeadlines: NewsCandidate[];
  }> {
    const [weatherRow, newsRow, context] = await Promise.all([
      this.db.radioSetting.findUnique({ where: { key: `source:${weatherKey(settings)}` } }),
      this.db.radioSetting.findUnique({ where: { key: `source:${newsKey(settings)}` } }),
      this.context(settings),
    ]);
    const state = (
      row: { valueJson: Prisma.JsonValue } | null,
      enabled: boolean,
      available: boolean,
    ): SourceState => {
      const payload =
        row?.valueJson && typeof row.valueJson === 'object' && !Array.isArray(row.valueJson)
          ? (row.valueJson as Record<string, unknown>)
          : {};
      return {
        ...payload,
        ok: enabled && payload.ok === true && available,
        enabled,
        stale: enabled && !available,
      } as SourceState;
    };
    const newsPayload = newsRow?.valueJson as Record<string, unknown> | undefined;
    const newsFresh =
      !!newsPayload?.lastSuccess &&
      this.now().getTime() - new Date(String(newsPayload.lastSuccess)).getTime() <
        settings.newsMaxAgeHours * 3_600_000;
    const news = state(
      newsRow,
      settings.newsEnabled,
      newsFresh && settings.newsSources.some((source) => source.enabled !== false),
    );
    if (settings.newsEnabled && !settings.newsSources.some((source) => source.enabled !== false))
      news.errorCode = 'NEWS_NOT_CONFIGURED';
    return {
      weather: state(weatherRow, settings.weatherEnabled, !!context.weather),
      news,
      newsSources: settings.newsSources,
      newsHeadlines: context.news,
    };
  }
  async refresh(settings: SafeSettings, force = false) {
    const runtime = runtimeConfig(this.config, settings);
    const status = await this.status(settings);
    const at = this.now().toISOString();
    const refreshWeather = async () => {
      if (!settings.weatherEnabled) return;
      if (
        !force &&
        status.weather.lastAttempt &&
        this.now().getTime() - new Date(status.weather.lastAttempt).getTime() < 60_000
      )
        return;
      if (
        !force &&
        !status.weather.stale &&
        status.weather.lastSuccess &&
        this.now().getTime() - new Date(status.weather.lastSuccess).getTime() <
          Math.min(settings.weatherMaxAgeMinutes * 30_000, 900_000)
      )
        return;
      try {
        const provider =
          this.ports.weather ??
          (settings.weatherProvider === 'aemet'
            ? new AemetWeatherProvider(runtime)
            : new OpenMeteoWeatherProvider(runtime));
        const payload = await provider.getCurrentAndForecast(settings.location);
        const observedAt = new Date(payload.observedAt);
        if (
          !Number.isFinite(observedAt.getTime()) ||
          observedAt.getTime() > this.now().getTime() + 300_000
        )
          throw new RadioError('WEATHER_TIMESTAMP_INVALID', 'Fecha meteorológica inválida', 502);
        await this.db.weatherSnapshot.create({
          data: { location: weatherKey(settings), observedAt, payloadJson: json(payload) },
        });
        await this.storeStatus(weatherKey(settings), {
          ok: true,
          lastAttempt: at,
          lastSuccess: at,
        });
        await this.event('weather.refresh.succeeded');
      } catch (error) {
        const code = errorCode(error, 'WEATHER_UNAVAILABLE');
        await this.storeStatus(weatherKey(settings), {
          ok: false,
          lastAttempt: at,
          lastSuccess: status.weather.lastSuccess,
          errorCode: code,
        });
        await this.event('weather.refresh.failed', 'warn', {}, code);
      }
    };
    const refreshNews = async () => {
      if (!settings.newsEnabled) return;
      if (
        !force &&
        status.news.lastAttempt &&
        this.now().getTime() - new Date(status.news.lastAttempt).getTime() < 300_000
      )
        return;
      const provider = this.ports.news ?? new RssNewsProvider(runtime);
      try {
        const fetched = await provider.fetchCandidates(this.now());
        const cutoff = this.now().getTime() - settings.newsMaxAgeHours * 3_600_000;
        const enabledNames = new Set(
          settings.newsSources.filter((s) => s.enabled !== false).map((s) => s.name),
        );
        let items = 0;
        for (const candidate of fetched) {
          const publishedAt = new Date(candidate.publishedAt);
          if (
            !enabledNames.has(candidate.source) ||
            !Number.isFinite(publishedAt.getTime()) ||
            publishedAt.getTime() < cutoff ||
            publishedAt.getTime() > this.now().getTime() + 300_000
          )
            continue;
          const { id, ...rest } = candidate;
          const data = { ...rest, publishedAt };
          await this.db.newsItem.upsert({
            where: { fingerprint: candidate.fingerprint },
            create: { id, ...data },
            update: data,
          });
          items++;
        }
        const sourceStatuses = 'sourceStatuses' in provider ? provider.sourceStatuses : undefined;
        await this.storeStatus(newsKey(settings), {
          ok: true,
          lastAttempt: at,
          lastSuccess: at,
          items,
          sourceStatuses,
        });
        await this.event('news.refresh.succeeded', 'info', { items });
      } catch (error) {
        const code = errorCode(error, 'NEWS_UNAVAILABLE');
        const sourceStatuses = 'sourceStatuses' in provider ? provider.sourceStatuses : undefined;
        await this.storeStatus(newsKey(settings), {
          ok: false,
          lastAttempt: at,
          lastSuccess: status.news.lastSuccess,
          errorCode: code,
          sourceStatuses,
        });
        await this.event('news.refresh.failed', 'warn', {}, code);
      }
    };
    await Promise.all([refreshWeather(), refreshNews()]);
    return this.status(settings);
  }
}
