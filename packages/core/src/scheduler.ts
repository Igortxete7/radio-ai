import { DateTime } from 'luxon';
export function hourlySlot(now: Date, timezone: string) {
  const next = DateTime.fromJSDate(now, { zone: timezone }).startOf('hour').plus({ hours: 1 });
  if (!next.isValid) throw new Error('Zona editorial inválida');
  const scheduledFor = next.toUTC().toJSDate();
  return {
    scheduledFor,
    localTimeIso: next.toISO()!,
    dedupeKey: `hourly:${scheduledFor.toISOString()}`,
  };
}
