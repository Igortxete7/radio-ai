import { z } from 'zod';

export type TrackRef = {
  id: string;
  path: string;
  title: string;
  artist: string;
  durationSec: number;
};
export type RadioLocation = {
  name: string;
  latitude: number;
  longitude: number;
  aemetMunicipality?: string;
};
export type WeatherBrief = {
  observedAt: string;
  temperatureC?: number;
  apparentTemperatureC?: number;
  condition?: string;
  precipitationProbabilityPct?: number;
  maxC?: number;
  minC?: number;
  windKph?: number;
  sourceName: string;
};
export type NewsCandidate = {
  id: string;
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  summary?: string;
  fingerprint: string;
  priority: number;
  category: string;
};
export type NewsSource = {
  name: string;
  url: string;
  category: string;
  priority: number;
  language?: string;
  enabled?: boolean;
};
export type BreakKind = 'hourly' | 'weather' | 'news' | 'music-link' | 'ident';
export type DjBreakContext = {
  kind: BreakKind;
  localTimeIso: string;
  timezone: string;
  weather?: WeatherBrief;
  news: NewsCandidate[];
  previousTrack?: TrackRef;
  nextTrack?: TrackRef;
  targetSeconds: number;
  stationPersona: string;
  stationName: string;
};
export const generatedScriptSchema = z.object({
  opening: z.string().min(1).max(600),
  body: z.string().max(4000),
  closing: z.string().max(600),
  fullText: z.string().min(1).max(5000),
  mentionedNewsIds: z.array(z.string()).max(5),
  mentionsWeather: z.boolean(),
  mentionsNextTrack: z.boolean(),
  estimatedSeconds: z.number().min(5).max(180),
});
export type GeneratedScript = z.infer<typeof generatedScriptSchema>;
export type SpeechOptions = {
  outputPath: string;
  model: string;
  voice: string;
  instructions: string;
};
export type GeneratedAudio = { path: string; durationSec: number; bytes: number };
export interface ScriptGenerator {
  generate(context: DjBreakContext): Promise<GeneratedScript>;
}
export interface SpeechSynthesizer {
  synthesize(text: string, options: SpeechOptions): Promise<GeneratedAudio>;
}
export interface WeatherProvider {
  getCurrentAndForecast(location: RadioLocation): Promise<WeatherBrief>;
}
export interface NewsProvider {
  fetchCandidates(now: Date): Promise<NewsCandidate[]>;
}
export interface AudioInspector {
  inspect(path: string): Promise<{ durationSec: number; bytes: number }>;
}
export type QueueName = 'music' | 'priority';
export type AutomationQueueItem = { id: string; uri?: string; metadata?: Record<string, string> };
export type AutomationHealth = { ok: boolean; detail?: string };
export type PlaybackSnapshot = {
  eventId: string;
  queueItemId?: string;
  requestId?: string;
  path: string;
  title: string;
  artist?: string;
  startedAt: string;
  type: 'track' | 'jingle' | 'ai_break' | 'fallback';
};
export interface RadioAutomationPort {
  push(uri: string, metadata?: Record<string, string>, queue?: QueueName): Promise<string>;
  queue(queue?: QueueName): Promise<AutomationQueueItem[]>;
  remove(id: string, queue?: QueueName): Promise<void>;
  skip(): Promise<void>;
  health(): Promise<AutomationHealth>;
  current(): Promise<PlaybackSnapshot | null>;
  events(): Promise<PlaybackSnapshot[]>;
}
export class RadioError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 500,
    public retryable = false,
  ) {
    super(message);
    this.name = 'RadioError';
  }
}
export type ApiEnvelope<T> = {
  data: T | null;
  error: { code: string; message: string } | null;
  meta?: Record<string, unknown>;
};
