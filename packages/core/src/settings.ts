import { z } from 'zod';
import type { RadioConfig } from '@radio/config';
import type { PrismaClient } from '@radio/db';
import { RadioError } from '@radio/shared';

export const settingsSchema = z
  .object({
    stationName: z.string().trim().min(1).max(120),
    persona: z.string().trim().min(1).max(2000),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat('es', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    trackRepeatHours: z.number().min(0).max(720),
    artistRepeatMinutes: z.number().min(0).max(10080),
    jingleMinTracks: z.number().int().min(1).max(100),
    jingleMaxTracks: z.number().int().min(1).max(100),
    djHourlyEnabled: z.boolean(),
    djPrepareMinutesBefore: z.number().int().min(1).max(30),
    djEnqueueMinutesBefore: z.number().min(0).max(5),
    djTargetSeconds: z.number().min(15).max(120),
    ttsVoice: z.string().trim().min(1).max(100),
    textModel: z.string().trim().min(1).max(100),
    ttsModel: z.string().trim().min(1).max(100),
    musicQueueTarget: z.number().int().min(1).max(10),
    generatedRetentionDays: z.number().min(1).max(365),
    weatherEnabled: z.boolean(),
    newsEnabled: z.boolean(),
    weatherProvider: z.enum(['open-meteo', 'aemet']),
    weatherMaxAgeMinutes: z.number().min(1).max(1440),
    newsMaxAgeHours: z.number().min(1).max(168),
    location: z.object({
      name: z.string().trim().min(1).max(200),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      aemetMunicipality: z.string().max(20).optional(),
    }),
    newsSources: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(200),
          url: z.url().refine((v) => /^https?:\/\//i.test(v)),
          category: z.string().max(100),
          priority: z.number().min(0).max(1000),
          language: z.string().max(20).optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .max(30),
  })
  .strict();
export type SafeSettings = z.infer<typeof settingsSchema>;
export function runtimeConfig(config: RadioConfig, settings: SafeSettings): RadioConfig {
  return {
    ...config,
    ...settings,
    location: {
      ...settings.location,
      aemetMunicipality: settings.location.aemetMunicipality ?? config.location.aemetMunicipality,
    },
  };
}
export async function readSettings(config: RadioConfig, db: PrismaClient): Promise<SafeSettings> {
  const base: Record<string, unknown> = { ...config, weatherEnabled: true, newsEnabled: true };
  const editable = Object.fromEntries(
    Object.keys(settingsSchema.shape).map((key) => [key, base[key]]),
  );
  for (const row of await db.radioSetting.findMany({
    where: { key: { startsWith: 'setting:' } },
  })) {
    const key = row.key.slice(8);
    if (key in settingsSchema.shape) editable[key] = row.valueJson;
  }
  const parsed = settingsSchema.safeParse(editable);
  if (!parsed.success)
    throw new RadioError('SETTINGS_INVALID', 'La configuración guardada no es válida', 422);
  return parsed.data;
}
export async function writeSettings(
  config: RadioConfig,
  db: PrismaClient,
  patch: Record<string, unknown>,
) {
  const current = await readSettings(config, db);
  const parsed = settingsSchema.safeParse({ ...current, ...patch });
  if (
    !parsed.success ||
    parsed.data.jingleMinTracks > parsed.data.jingleMaxTracks ||
    parsed.data.djEnqueueMinutesBefore > parsed.data.djPrepareMinutesBefore
  )
    throw new RadioError('SETTINGS_INVALID', 'Ajustes desconocidos o fuera de rango', 422);
  await db.$transaction(
    Object.keys(patch).map((key) => {
      const valueJson = JSON.parse(JSON.stringify(parsed.data[key as keyof SafeSettings]));
      return db.radioSetting.upsert({
        where: { key: `setting:${key}` },
        create: { key: `setting:${key}`, valueJson },
        update: { valueJson },
      });
    }),
  );
  return parsed.data;
}
