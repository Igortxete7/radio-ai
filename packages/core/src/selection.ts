export type SelectionTrack = {
  id: string;
  path: string;
  title: string;
  artist: string;
  durationSec: number;
  enabled: boolean;
  missing: boolean;
  lastPlayedAt: Date | null;
  playCount: number;
};
export type RecentPlay = { assetId: string | null; artist: string | null; startedAt: Date };
export type QueuedTrack = {
  id?: string;
  assetId?: string | null;
  artist?: string | null;
  path?: string;
};
const artistKey = (artist: string | null | undefined) =>
  artist?.trim().normalize('NFKC').toLocaleLowerCase('es') ?? '';
/** Queued tracks are never relaxed; a small library must not fill the queue with duplicates. */
export function selectTrack<T extends SelectionTrack>(
  tracks: T[],
  recent: RecentPlay[],
  queued: QueuedTrack[],
  rules: { trackRepeatHours: number; artistRepeatMinutes: number },
  now: Date,
  random: () => number = Math.random,
): { track: T; relaxed: ('artist' | 'track')[] } | null {
  const queuedIds = new Set(queued.map((t) => t.assetId ?? t.id));
  const queuedPaths = new Set(queued.map((t) => t.path).filter(Boolean));
  const queuedArtists = new Set(queued.map((t) => artistKey(t.artist)));
  const recentIds = new Set(
    recent
      .filter((e) => now.getTime() - e.startedAt.getTime() < rules.trackRepeatHours * 3_600_000)
      .map((e) => e.assetId),
  );
  const recentArtists = new Set(
    recent
      .filter((e) => now.getTime() - e.startedAt.getTime() < rules.artistRepeatMinutes * 60_000)
      .map((e) => artistKey(e.artist)),
  );
  const playable = tracks.filter(
    (t) => t.enabled && !t.missing && !queuedIds.has(t.id) && !queuedPaths.has(t.path),
  );
  for (const relaxed of [[], ['artist'], ['artist', 'track']] as ('artist' | 'track')[][]) {
    const candidates = playable.filter(
      (t) =>
        (relaxed.includes('track') || !recentIds.has(t.id)) &&
        (relaxed.includes('artist') ||
          (!recentArtists.has(artistKey(t.artist)) && !queuedArtists.has(artistKey(t.artist)))),
    );
    if (!candidates.length) continue;
    const sample: T[] = [];
    candidates.forEach((track, index) => {
      if (index < 200) sample.push(track);
      else {
        const slot = Math.floor(random() * (index + 1));
        if (slot < 200) sample[slot] = track;
      }
    });
    let best = sample[0];
    let bestScore = -Infinity;
    for (const track of sample) {
      const age = track.lastPlayedAt
        ? Math.max(0, (now.getTime() - track.lastPlayedAt.getTime()) / 3_600_000)
        : 168;
      const score = random() + Math.min(age / 168, 1) + 1 / (1 + track.playCount);
      if (score > bestScore) {
        best = track;
        bestScore = score;
      }
    }
    return { track: best, relaxed };
  }
  return null;
}
