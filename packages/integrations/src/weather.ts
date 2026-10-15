import { z } from 'zod';
import type { RadioConfig } from '@radio/config';
import {
  RadioError,
  type RadioLocation,
  type WeatherBrief,
  type WeatherProvider,
} from '@radio/shared';
import { fetchJson } from './http.ts';

// Codes and units: https://open-meteo.com/en/docs (WMO interpretation codes).
const conditions: Record<number, string> = {
  0: 'despejado',
  1: 'mayormente despejado',
  2: 'parcialmente nuboso',
  3: 'cubierto',
  45: 'niebla',
  48: 'niebla con escarcha',
  51: 'llovizna ligera',
  53: 'llovizna moderada',
  55: 'llovizna intensa',
  56: 'llovizna helada ligera',
  57: 'llovizna helada intensa',
  61: 'lluvia ligera',
  63: 'lluvia moderada',
  65: 'lluvia intensa',
  66: 'lluvia helada ligera',
  67: 'lluvia helada intensa',
  71: 'nieve ligera',
  73: 'nieve moderada',
  75: 'nieve intensa',
  77: 'nieve granulada',
  80: 'chubascos ligeros',
  81: 'chubascos moderados',
  82: 'chubascos intensos',
  85: 'chubascos de nieve ligeros',
  86: 'chubascos de nieve intensos',
  95: 'tormenta',
  96: 'tormenta con granizo ligero',
  97: 'tormenta intensa',
  99: 'tormenta con granizo intenso',
};
export function wmoCondition(code: number): string | undefined {
  return conditions[code];
}
const finite = z.number().finite();
const meteoSchema = z.object({
  current: z.object({
    time: finite.positive(),
    temperature_2m: finite.min(-100).max(70).optional(),
    apparent_temperature: finite.min(-100).max(80).optional(),
    weather_code: finite.optional(),
    wind_speed_10m: finite.min(0).max(500).optional(),
  }),
  daily: z
    .object({
      temperature_2m_max: z.array(finite.nullable()).optional(),
      temperature_2m_min: z.array(finite.nullable()).optional(),
      precipitation_probability_max: z.array(finite.min(0).max(100).nullable()).optional(),
    })
    .optional(),
});

export class OpenMeteoWeatherProvider implements WeatherProvider {
  constructor(private readonly config: RadioConfig) {}
  async getCurrentAndForecast(location: RadioLocation): Promise<WeatherBrief> {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    for (const [key, value] of Object.entries({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: this.config.timezone,
      timeformat: 'unixtime',
      forecast_days: '1',
      wind_speed_unit: 'kmh',
    }))
      url.searchParams.set(key, value);
    const payload = await fetchJson(url, this.config.fetchTimeoutMs);
    const parsed = meteoSchema.safeParse(payload);
    if (!parsed.success)
      throw new RadioError('WEATHER_RESPONSE', 'Respuesta meteorológica inválida', 502);
    const { current, daily } = parsed.data;
    const observedAt = new Date(current.time * 1000);
    if (!Number.isFinite(observedAt.valueOf()))
      throw new RadioError('WEATHER_RESPONSE', 'Fecha meteorológica inválida', 502);
    return {
      observedAt: observedAt.toISOString(),
      sourceName: 'Open-Meteo',
      temperatureC: current.temperature_2m,
      apparentTemperatureC: current.apparent_temperature,
      condition:
        current.weather_code === undefined ? undefined : wmoCondition(current.weather_code),
      windKph: current.wind_speed_10m,
      maxC: daily?.temperature_2m_max?.[0] ?? undefined,
      minC: daily?.temperature_2m_min?.[0] ?? undefined,
      precipitationProbabilityPct: daily?.precipitation_probability_max?.[0] ?? undefined,
    };
  }
}

const aemetEnvelope = z.object({ estado: z.number(), datos: z.url() });
const period = z.object({
  periodo: z.string().optional(),
  value: z.union([z.number(), z.string()]).optional(),
  descripcion: z.string().optional(),
});
const dailySchema = z
  .array(
    z.object({
      elaborado: z.string(),
      prediccion: z.object({
        dia: z.array(
          z.object({
            fecha: z.string(),
            temperatura: z.object({ maxima: finite, minima: finite }).optional(),
            estadoCielo: z.array(period).optional(),
            probPrecipitacion: z.array(period).optional(),
            viento: z
              .array(z.object({ periodo: z.string().optional(), velocidad: finite.optional() }))
              .optional(),
          }),
        ),
      }),
    }),
  )
  .min(1);
function wholeDay<T extends { periodo?: string }>(values: T[] | undefined): T | undefined {
  return values?.find((value) => !value.periodo || value.periodo === '00-24') ?? values?.[0];
}

export class AemetWeatherProvider implements WeatherProvider {
  constructor(private readonly config: RadioConfig) {}
  async getCurrentAndForecast(location: RadioLocation): Promise<WeatherBrief> {
    if (!this.config.aemetApiKey)
      throw new RadioError('WEATHER_CONFIG', 'Falta AEMET_API_KEY', 503);
    const municipality = location.aemetMunicipality ?? this.config.location.aemetMunicipality;
    if (!/^\d{5}$/.test(municipality ?? ''))
      throw new RadioError('WEATHER_CONFIG', 'Municipio AEMET inválido', 400);
    // Official API: https://opendata.aemet.es/dist/ . The datos URL is fetched
    // separately, and the API key is never sent to that URL or a redirect.
    const url = new URL(
      `https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/${municipality}`,
    );
    const envelope = aemetEnvelope.safeParse(
      await fetchJson(url, this.config.fetchTimeoutMs, { api_key: this.config.aemetApiKey }),
    );
    if (!envelope.success || envelope.data.estado !== 200)
      throw new RadioError('WEATHER_RESPONSE', 'AEMET no devolvió una predicción válida', 502);
    const dataUrl = new URL(envelope.data.datos);
    if (
      dataUrl.protocol !== 'https:' ||
      dataUrl.hostname !== 'opendata.aemet.es' ||
      dataUrl.username ||
      dataUrl.password ||
      (dataUrl.port && dataUrl.port !== '443')
    )
      throw new RadioError('WEATHER_RESPONSE', 'URL de datos AEMET inválida', 502);
    const result = dailySchema.safeParse(await fetchJson(dataUrl, this.config.fetchTimeoutMs));
    if (!result.success) throw new RadioError('WEATHER_RESPONSE', 'Predicción AEMET inválida', 502);
    const forecast = result.data[0]!;
    const today = new Intl.DateTimeFormat('sv-SE', {
      timeZone: this.config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const day = forecast.prediccion.dia.find((value) => value.fecha.slice(0, 10) === today);
    if (!day)
      throw new RadioError('WEATHER_RESPONSE', 'AEMET no incluye la predicción de hoy', 502);
    // elaborado is a forecast issue timestamp, never a live observation.
    const issued = /(?:Z|[+-]\d{2}:?\d{2})$/.test(forecast.elaborado)
      ? new Date(forecast.elaborado)
      : localAemetDate(forecast.elaborado, this.config.timezone);
    if (!Number.isFinite(issued.valueOf()))
      throw new RadioError('WEATHER_RESPONSE', 'Fecha AEMET inválida', 502);
    const probability = Number(wholeDay(day.probPrecipitacion)?.value);
    const description = wholeDay(day.estadoCielo)
      ?.descripcion?.replace(/[\p{Cc}<>]/gu, '')
      .slice(0, 120);
    return {
      observedAt: issued.toISOString(),
      sourceName: 'AEMET (previsión)',
      maxC: day.temperatura?.maxima,
      minC: day.temperatura?.minima,
      condition: description ? `previsión: ${description.toLowerCase()}` : undefined,
      precipitationProbabilityPct:
        Number.isFinite(probability) && probability >= 0 && probability <= 100
          ? probability
          : undefined,
      windKph: wholeDay(day.viento)?.velocidad,
    };
  }
}

function localAemetDate(value: string, timeZone: string): Date {
  const date = new Date(`${value}Z`);
  if (!Number.isFinite(date.valueOf())) return date;
  let instant = date.valueOf();
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' });
  for (let i = 0; i < 2; i++) {
    const offset = formatter
      .formatToParts(new Date(instant))
      .find((part) => part.type === 'timeZoneName')?.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset ?? '');
    const minutes = match
      ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1)
      : 0;
    instant = date.valueOf() - minutes * 60_000;
  }
  return new Date(instant);
}
