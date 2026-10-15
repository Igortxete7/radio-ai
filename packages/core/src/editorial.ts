import {
  generatedScriptSchema,
  RadioError,
  type DjBreakContext,
  type GeneratedScript,
} from '@radio/shared';
export function validateScript(value: unknown, context: DjBreakContext): GeneratedScript {
  const script = generatedScriptSchema.parse(value);
  const available = new Set(context.news.map((item) => item.id));
  if (
    script.mentionedNewsIds.some((id) => !available.has(id)) ||
    new Set(script.mentionedNewsIds).size !== script.mentionedNewsIds.length
  )
    throw new RadioError('SCRIPT_SOURCE_INVALID', 'El guion menciona noticias no disponibles', 422);
  if (script.mentionsWeather && !context.weather)
    throw new RadioError('SCRIPT_WEATHER_INVALID', 'El guion menciona tiempo no disponible', 422);
  if (script.mentionsNextTrack && !context.nextTrack)
    throw new RadioError(
      'SCRIPT_TRACK_INVALID',
      'El guion menciona una canción no disponible',
      422,
    );
  if (
    script.estimatedSeconds > context.targetSeconds * 1.6 ||
    script.estimatedSeconds < Math.max(5, context.targetSeconds * 0.35)
  )
    throw new RadioError('SCRIPT_DURATION_INVALID', 'Duración estimada fuera del objetivo', 422);
  const spokenSeconds = script.fullText.trim().split(/\s+/).length / 3;
  if (spokenSeconds > context.targetSeconds * 1.9)
    throw new RadioError('SCRIPT_TOO_LONG', 'El texto excede la duración de locución', 422);
  if (/https?:\/\/|www\./i.test(script.fullText))
    throw new RadioError('SCRIPT_URL_INVALID', 'El guion contiene una URL para locución', 422);
  return script;
}
