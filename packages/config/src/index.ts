import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

function findRoot() {
  if (process.env.RADIO_PROJECT_ROOT) return path.resolve(process.env.RADIO_PROJECT_ROOT);
  let candidate = process.cwd();
  for (let depth = 0; depth < 8; depth++) {
    if (
      existsSync(path.join(candidate, '.env.example')) &&
      existsSync(path.join(candidate, 'prisma', 'schema.prisma'))
    )
      return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}
export const projectRoot = findRoot();
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });
const bool = z.preprocess((v) => v === 'true' || v === true, z.boolean());
const sources = z
  .array(
    z.object({
      name: z.string().min(1),
      url: z.url(),
      category: z.string().default('general'),
      priority: z.number().default(50),
      language: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  )
  .max(30);
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TZ: z
    .string()
    .default('Europe/Madrid')
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('es', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'Zona horaria inválida'),
  DATABASE_URL: z.string().default('file:../storage/radio.db'),
  STORAGE_ROOT: z.string().default('./storage'),
  STATION_NAME: z.string().min(1).max(120).default('Radio AI'),
  DJ_PERSONA: z
    .string()
    .min(1)
    .max(2000)
    .default('Cercano, ágil y profesional. Radio musical en español de España.'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_TEXT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_TTS_MODEL: z.string().min(1).default('gpt-4o-mini-tts'),
  OPENAI_TTS_VOICE: z.string().min(1).default('marin'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(100).max(180000).default(45000),
  WEATHER_PROVIDER: z.enum(['open-meteo', 'aemet']).default('open-meteo'),
  AEMET_API_KEY: z.string().default(''),
  AEMET_MUNICIPALITY: z.string().default('20069'),
  RADIO_LOCATION_NAME: z.string().default('Donostia / San Sebastián'),
  RADIO_LATITUDE: z.coerce.number().min(-90).max(90).default(43.3183),
  RADIO_LONGITUDE: z.coerce.number().min(-180).max(180).default(-1.9812),
  WEATHER_MAX_AGE_MINUTES: z.coerce.number().positive().default(60),
  NEWS_MAX_AGE_HOURS: z.coerce.number().positive().default(24),
  NEWS_SOURCES_JSON: z
    .string()
    .default('[]')
    .transform((v, ctx) => {
      try {
        return sources.parse(JSON.parse(v));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'NEWS_SOURCES_JSON inválido' });
        return z.NEVER;
      }
    }),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
  ICECAST_HOST: z.string().default('127.0.0.1'),
  ICECAST_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  ICECAST_MOUNT: z
    .string()
    .regex(/^\/[a-zA-Z0-9_.-]+$/)
    .default('/radio.mp3'),
  ICECAST_SOURCE_PASSWORD: z.string().default(''),
  STREAM_PUBLIC_URL: z.string().default('http://localhost:8000/radio.mp3'),
  LIQUIDSOAP_HOST: z.string().default('127.0.0.1'),
  LIQUIDSOAP_PORT: z.coerce.number().int().min(1).max(65535).default(1234),
  LIQUIDSOAP_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(4000),
  TRACK_REPEAT_HOURS: z.coerce.number().min(0).default(24),
  ARTIST_REPEAT_MINUTES: z.coerce.number().min(0).default(90),
  JINGLE_MIN_TRACKS: z.coerce.number().int().min(1).default(5),
  JINGLE_MAX_TRACKS: z.coerce.number().int().min(1).default(8),
  CROSSFADE_SECONDS: z.coerce.number().min(0).max(20).default(5),
  DJ_HOURLY_ENABLED: bool.default(true),
  DJ_PREPARE_MINUTES_BEFORE: z.coerce.number().int().min(1).max(30).default(5),
  DJ_ENQUEUE_MINUTES_BEFORE: z.coerce.number().min(0).max(5).default(1),
  DJ_TARGET_SECONDS: z.coerce.number().min(15).max(120).default(55),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  WORKER_HEARTBEAT_MAX_SECONDS: z.coerce.number().min(10).default(30),
  LIBRARY_SCAN_INTERVAL_SECONDS: z.coerce.number().min(10).default(300),
  MUSIC_QUEUE_TARGET: z.coerce.number().int().min(1).max(10).default(3),
  AUDIO_EXTENSIONS: z.string().default('.mp3,.m4a,.flac,.ogg,.wav'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  GENERATED_RETENTION_DAYS: z.coerce.number().min(1).default(14),
  ADMIN_TOKEN: z.string().default(''),
  ADMIN_ORIGIN: z
    .url()
    .refine(
      (v) => ['http:', 'https:'].includes(new URL(v).protocol),
      'ADMIN_ORIGIN debe usar HTTP o HTTPS',
    )
    .default('http://localhost:3000'),
});
export function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const e = envSchema.parse({ ...process.env, ...overrides });
  const storageRoot = path.resolve(projectRoot, e.STORAGE_ROOT);
  const dbUrl = e.DATABASE_URL.startsWith('file:')
    ? `file:${path.resolve(projectRoot, 'prisma', e.DATABASE_URL.slice(5)).replaceAll('\\', '/')}`
    : e.DATABASE_URL;
  if (!dbUrl.startsWith('file:'))
    throw new Error('El MVP utiliza SQLite: DATABASE_URL debe empezar por file:');
  if (e.JINGLE_MIN_TRACKS > e.JINGLE_MAX_TRACKS)
    throw new Error('JINGLE_MIN_TRACKS supera JINGLE_MAX_TRACKS');
  return {
    root: projectRoot,
    nodeEnv: e.NODE_ENV,
    dbUrl,
    storageRoot,
    timezone: e.TZ,
    stationName: e.STATION_NAME,
    persona: e.DJ_PERSONA,
    openaiApiKey: e.OPENAI_API_KEY,
    textModel: e.OPENAI_TEXT_MODEL,
    ttsModel: e.OPENAI_TTS_MODEL,
    ttsVoice: e.OPENAI_TTS_VOICE,
    openaiTimeoutMs: e.OPENAI_TIMEOUT_MS,
    weatherProvider: e.WEATHER_PROVIDER,
    aemetApiKey: e.AEMET_API_KEY,
    location: {
      name: e.RADIO_LOCATION_NAME,
      latitude: e.RADIO_LATITUDE,
      longitude: e.RADIO_LONGITUDE,
      aemetMunicipality: e.AEMET_MUNICIPALITY,
    },
    weatherMaxAgeMinutes: e.WEATHER_MAX_AGE_MINUTES,
    newsMaxAgeHours: e.NEWS_MAX_AGE_HOURS,
    newsSources: e.NEWS_SOURCES_JSON,
    fetchTimeoutMs: e.FETCH_TIMEOUT_MS,
    icecastHost: e.ICECAST_HOST,
    icecastPort: e.ICECAST_PORT,
    icecastMount: e.ICECAST_MOUNT,
    icecastSourcePassword: e.ICECAST_SOURCE_PASSWORD,
    streamPublicUrl: e.STREAM_PUBLIC_URL,
    liquidsoapHost: e.LIQUIDSOAP_HOST,
    liquidsoapPort: e.LIQUIDSOAP_PORT,
    liquidsoapTimeoutMs: e.LIQUIDSOAP_TIMEOUT_MS,
    trackRepeatHours: e.TRACK_REPEAT_HOURS,
    artistRepeatMinutes: e.ARTIST_REPEAT_MINUTES,
    jingleMinTracks: e.JINGLE_MIN_TRACKS,
    jingleMaxTracks: e.JINGLE_MAX_TRACKS,
    crossfadeSeconds: e.CROSSFADE_SECONDS,
    djHourlyEnabled: e.DJ_HOURLY_ENABLED,
    djPrepareMinutesBefore: e.DJ_PREPARE_MINUTES_BEFORE,
    djEnqueueMinutesBefore: e.DJ_ENQUEUE_MINUTES_BEFORE,
    djTargetSeconds: e.DJ_TARGET_SECONDS,
    workerIntervalMs: e.WORKER_INTERVAL_MS,
    workerHeartbeatMaxSeconds: e.WORKER_HEARTBEAT_MAX_SECONDS,
    libraryScanIntervalSeconds: e.LIBRARY_SCAN_INTERVAL_SECONDS,
    musicQueueTarget: e.MUSIC_QUEUE_TARGET,
    audioExtensions: e.AUDIO_EXTENSIONS.split(',').map((v) => v.trim().toLowerCase()),
    ffprobePath: e.FFPROBE_PATH,
    generatedRetentionDays: e.GENERATED_RETENTION_DAYS,
    adminToken: e.ADMIN_TOKEN,
    adminOrigin: new URL(e.ADMIN_ORIGIN).origin,
    emergencyPath: path.join(storageRoot, 'fallback', 'emergency.mp3'),
    envExists: existsSync(path.join(projectRoot, '.env')),
  };
}
export type RadioConfig = ReturnType<typeof loadConfig>;
