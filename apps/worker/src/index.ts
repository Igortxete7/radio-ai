import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '@radio/config';
import { createDatabase } from '@radio/db';
import { RadioService } from '@radio/core';
import { RadioError } from '@radio/shared';

const config = loadConfig();
const db = createDatabase(config.dbUrl);
const radio = new RadioService(config, db);
const abort = new AbortController();
let shuttingDown = false;
const log = (level: string, event: string, extra: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: 'radio-worker',
      event,
      ...extra,
    }),
  );
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  abort.abort();
  log('info', 'worker.shutdown', { signal });
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  await radio.shutdown();
  await db.$disconnect();
  clearTimeout(deadline);
  process.exit(0);
}
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
log('info', 'worker.started', {
  node: process.version,
  timezone: config.timezone,
  pid: process.pid,
});
while (!abort.signal.aborted) {
  const started = Date.now();
  try {
    await radio.tick();
  } catch (error) {
    log('error', 'worker.tick.failed', {
      errorCode: error instanceof RadioError ? error.code : 'WORKER_TICK_FAILED',
      durationMs: Date.now() - started,
    });
  }
  if (!abort.signal.aborted)
    try {
      await delay(Math.max(100, config.workerIntervalMs - (Date.now() - started)), undefined, {
        signal: abort.signal,
      });
    } catch {
      // AbortController wakes the interval immediately during a requested shutdown.
    }
}
