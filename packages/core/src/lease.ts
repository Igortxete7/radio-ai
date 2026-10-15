import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@radio/db';

/** SQLite compare-and-set lease, bounded and periodically renewed so a killed worker can recover. */
export async function withLease<T>(
  db: PrismaClient,
  key: string,
  now: () => Date,
  fn: () => Promise<T>,
  ttlMs = 180_000,
): Promise<T | null> {
  const owner = randomUUID();
  const at = now();
  const dedupeKey = `lock:${key}`;
  const existing = await db.jobRun.findUnique({ where: { dedupeKey } });
  if (!existing) {
    try {
      await db.jobRun.create({
        data: {
          jobName: key,
          dedupeKey,
          scheduledFor: at,
          startedAt: at,
          status: 'RUNNING',
          error: owner,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return null;
      throw error;
    }
  } else {
    const taken = await db.jobRun.updateMany({
      where: {
        id: existing.id,
        OR: [
          { status: { not: 'RUNNING' } },
          { startedAt: { lte: new Date(at.getTime() - ttlMs) } },
        ],
      },
      data: { status: 'RUNNING', startedAt: at, endedAt: null, error: owner },
    });
    if (taken.count !== 1) return null;
  }
  const timer = setInterval(
    () => {
      void db.jobRun
        .updateMany({
          where: { dedupeKey, error: owner, status: 'RUNNING' },
          data: { startedAt: now() },
        })
        .catch(() => {});
    },
    Math.floor(ttlMs / 3),
  );
  timer.unref();
  try {
    const value = await fn();
    await db.jobRun.updateMany({
      where: { dedupeKey, error: owner },
      data: { status: 'COMPLETED', endedAt: now(), error: null },
    });
    return value;
  } catch (error) {
    await db.jobRun
      .updateMany({
        where: { dedupeKey, error: owner },
        data: { status: 'FAILED', endedAt: now(), error: null },
      })
      .catch(() => {});
    throw error;
  } finally {
    clearInterval(timer);
  }
}
