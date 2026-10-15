import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@radio/config';
import { createDatabase } from '@radio/db';
import { RadioService } from '@radio/core';

const config = loadConfig();
const database = createDatabase(config.dbUrl);
const execute = promisify(execFile);
const report = { checkedAt: new Date().toISOString() };
async function api(route) {
  const response = await fetch(`http://127.0.0.1:3000${route}`, {
    headers: { Authorization: `Bearer ${config.adminToken}` },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `${route} must succeed with the private admin token`);
  return (await response.json()).data;
}
try {
  const current = await api('/api/now-playing');
  const history = await api('/api/history');
  assert(current.current?.eventId, 'Now playing must contain an actual Liquidsoap event');
  assert(Array.isArray(history) && history.length > 0, 'Playback history must be populated');
  const now = Date.now();
  const startedAt = new Date(current.current.startedAt).getTime();
  assert(
    startedAt <= now + 2000 && startedAt > now - 120000,
    'Current playback must have a recent UTC instant',
  );
  assert(
    history.every((event) => new Date(event.startedAt).getTime() <= now + 2000),
    'History must not contain future playback',
  );
  assert(
    history.every(
      (event, index) =>
        index === 0 || new Date(event.startedAt) <= new Date(history[index - 1].startedAt),
    ),
    'History must be chronological',
  );
  assert.equal(
    await database.track.count({ where: { lastPlayedAt: { gt: new Date(now + 2000) } } }),
    0,
  );
  report.nowPlaying = {
    eventId: current.current.eventId,
    confidence: current.current.confidence,
    startedAt: current.current.startedAt,
  };
  report.historyEvents = history.length;
  report.historyChronology = 'UTC, descending, no future events or track timestamps';
  const service = new RadioService(
    {
      ...config,
      openaiApiKey: 'radio-ai-deliberately-invalid-resilience-key',
      openaiTimeoutMs: 5000,
    },
    database,
  );
  const [failed, decoded] = await Promise.all([
    service.generateBreak('ident'),
    execute('bash', ['scripts/smoke-stream.sh'], { cwd: config.root, timeout: 45000 }),
  ]);
  assert.equal(failed.status, 'FAILED', 'An invalid key must fail the break without enqueueing');
  assert.equal(await database.queueItem.count({ where: { assetId: failed.id } }), 0);
  assert(decoded.stdout.includes('stream.smoke.passed'));
  report.invalidKey = { status: failed.status, errorCode: failed.errorCode, queuedItems: 0 };
  report.simultaneousStreamDecodeSeconds = 10;
  await service.shutdown();
  await writeFile(
    path.join(config.storageRoot, 'tmp', 'runtime-validation.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ event: 'radio.runtime.validation.passed', ...report }));
} finally {
  await database.$disconnect();
}
