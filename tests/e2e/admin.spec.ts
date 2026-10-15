import { test, expect, type Page, type Request, type Route } from '@playwright/test';

async function login(page: Page) {
  const session = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/session' && response.status() === 200,
  );
  await page.goto('/');
  await session;
  await expect(page.getByRole('heading', { name: 'Radio AI', exact: true })).toBeVisible();
  await page
    .getByLabel('Token de administración')
    .fill('radio-e2e-test-token-with-sufficient-length');
  await page.getByRole('button', { name: 'Acceder al panel' }).click();
  await expect(page.getByRole('heading', { name: 'En directo', exact: true })).toBeVisible();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function requestCompletion(page: Page, request: Request) {
  return new Promise<void>((resolve) => {
    const complete = (finished: Request) => {
      if (finished !== request) return;
      page.off('requestfinished', complete);
      page.off('requestfailed', complete);
      resolve();
    };
    page.on('requestfinished', complete);
    page.on('requestfailed', complete);
  });
}

const liveHealth = {
  status: 'live',
  checkedAt: '2026-10-14T12:00:00.000Z',
  streamUrl: 'http://127.0.0.1:8000/radio.mp3',
  checks: {
    database: { ok: true },
    library: { ok: true, detail: '1 canción reproducible' },
    liquidsoap: { ok: true },
    icecast: { ok: true },
    worker: { ok: true },
    openai: { ok: true },
    weather: { ok: true },
    news: { ok: true },
  },
};
const liveNow = { current: null, next: null, lastBreak: null, nextBreak: null, events: [] };
function liveData(endpoint: string): unknown {
  return endpoint === 'health' ? liveHealth : endpoint === 'now-playing' ? liveNow : [];
}
async function fulfill(route: Route, data: unknown) {
  try {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  } catch (error) {
    // Aborting an obsolete GET is also a valid way to prevent stale updates.
    if (!route.request().failure()) throw error;
  }
}
function track(title: string, id: string) {
  return {
    id,
    path: `/music/${id}.mp3`,
    title,
    artist: 'Artista de prueba',
    album: null,
    genre: null,
    durationSec: 180,
    bpm: null,
    enabled: true,
    missing: false,
    contentHash: null,
    fileSize: 1000,
    mtimeMs: 0,
    metadataEdited: false,
    lastPlayedAt: null,
    playCount: 0,
    createdAt: '2026-10-14T12:00:00.000Z',
    updatedAt: '2026-10-14T12:00:00.000Z',
  };
}
function library(title: string, id: string) {
  return { items: [track(title, id)], total: 1, page: 1, pageSize: 25 };
}
async function waitForResponseRender(page: Page) {
  // Network completion precedes React committing state. Wait for browser paint
  // opportunities so an immediate positive assertion cannot miss the late result.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test('authenticated console loads real state and protects broadcast controls', async ({ page }) => {
  // Keep browser checks independent of credentials and paid text generation.
  await page.route('**/api/ai-breaks/preview', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        data: null,
        error: { code: 'OPENAI_CONFIG', message: 'La clave de OpenAI no está configurada.' },
      }),
    }),
  );
  await login(page);
  await expect(
    page.getByText('La voz del DJ está generada por inteligencia artificial.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Saltar', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Buscar canciones' })).toBeVisible();
  await page.getByRole('button', { name: 'DJ IA', exact: true }).click();
  await page.getByRole('button', { name: 'Previsualizar guion' }).click();
  await expect(page.locator('.notice[role="alert"]')).toContainText(
    /OpenAI|clave|configurada|operación/i,
    {
      timeout: 60000,
    },
  );
});

test('load fault preserves live health when the queue endpoint fails', async ({ page }) => {
  await page.route(/\/api\/(health|now-playing|queue)$/, async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (endpoint === 'queue') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          data: null,
          error: {
            code: 'QUEUE_UNAVAILABLE',
            message: 'La cola no está disponible temporalmente.',
          },
        }),
      });
      return;
    }
    await fulfill(route, liveData(endpoint));
  });
  const healthResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/health',
  );
  const queueResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/queue',
  );
  await login(page);
  expect((await healthResponse).status()).toBe(200);
  expect((await queueResponse).status()).toBe(503);
  await expect(page.locator('.notice[role="alert"]')).toContainText(
    'La cola no está disponible temporalmente.',
  );
  await expect(page.locator('.player-top .status')).toHaveText('En directo');
  await expect(page.locator('.health-list')).toContainText('Liquidsoap');
});

test('navigation race cannot replace library rows with an older live response', async ({
  page,
}) => {
  const releaseLive = deferred();
  const liveStarted = deferred();
  const endpoints = new Set<string>();
  const completions: Promise<void>[] = [];
  await page.route(/\/api\/(health|now-playing|queue)$/, async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1)!;
    completions.push(requestCompletion(page, route.request()));
    endpoints.add(endpoint);
    if (endpoints.size === 3) liveStarted.resolve();
    await releaseLive.promise;
    await fulfill(route, liveData(endpoint));
  });
  await page.route(/\/api\/tracks\?/, (route) =>
    fulfill(route, library('Biblioteca vigente', 'library-current')),
  );
  try {
    await login(page);
    await liveStarted.promise;
    const libraryResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/tracks',
    );
    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await (await libraryResponse).finished();
    await expect(page.getByRole('row', { name: /Biblioteca vigente/ })).toBeVisible();
    releaseLive.resolve();
    await Promise.all(completions);
    await waitForResponseRender(page);
    await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /Biblioteca vigente/ })).toBeVisible();
  } finally {
    releaseLive.resolve();
  }
});

test('search race keeps the newest results after an older search finishes', async ({ page }) => {
  const releaseOlder = deferred();
  const olderStarted = deferred();
  const olderCompleted = deferred();
  await page.route(/\/api\/(health|now-playing|queue)$/, (route) =>
    fulfill(route, liveData(new URL(route.request().url()).pathname.split('/').at(-1)!)),
  );
  await page.route(/\/api\/tracks\?/, async (route) => {
    const search = new URL(route.request().url()).searchParams.get('search');
    if (search === 'antigua') {
      void requestCompletion(page, route.request()).then(olderCompleted.resolve);
      olderStarted.resolve();
      await releaseOlder.promise;
      await fulfill(route, library('Respuesta antigua', 'older-search'));
    } else if (search === 'nueva')
      await fulfill(route, library('Respuesta más nueva', 'newest-search'));
    else await fulfill(route, library('Catálogo inicial', 'initial-search'));
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await expect(page.getByRole('row', { name: /Catálogo inicial/ })).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Buscar canciones' });
    await search.fill('antigua');
    await olderStarted.promise;
    const newestResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/tracks' &&
        new URL(response.url()).searchParams.get('search') === 'nueva',
    );
    await search.fill('nueva');
    await (await newestResponse).finished();
    await expect(page.getByRole('row', { name: /Respuesta más nueva/ })).toBeVisible();
    releaseOlder.resolve();
    await olderCompleted.promise;
    await waitForResponseRender(page);
    await expect(search).toHaveValue('nueva');
    await expect(page.getByRole('row', { name: /Respuesta más nueva/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Respuesta antigua/ })).toHaveCount(0);
  } finally {
    releaseOlder.resolve();
  }
});
test('mutation completion refreshes the active view after navigation', async ({ page }) => {
  const releaseMutation = deferred();
  const mutationStarted = deferred();
  await page.route(/\/api\/(health|now-playing|queue)$/, (route) =>
    fulfill(route, liveData(new URL(route.request().url()).pathname.split('/').at(-1)!)),
  );
  await page.route(/\/api\/tracks\?/, (route) =>
    fulfill(route, library('Biblioteca tras operación', 'after-mutation')),
  );
  await page.route('**/api/ai-breaks/generate', async (route) => {
    mutationStarted.resolve();
    await releaseMutation.promise;
    await fulfill(route, { status: 'ENQUEUED' });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Generar DJ', exact: true }).click();
    await mutationStarted.promise;
    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await expect(page.getByRole('row', { name: /Biblioteca tras operación/ })).toBeVisible();
    releaseMutation.resolve();
    await expect(page.locator('.working')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /Biblioteca tras operación/ })).toBeVisible();
  } finally {
    releaseMutation.resolve();
  }
});

test('admin endpoints reject unauthenticated writes and foreign origins', async ({
  request,
  baseURL,
}) => {
  const unauth = await request.post('/api/queue/skip', {
    headers: { Origin: new URL(baseURL!).origin },
  });
  expect(unauth.status()).toBe(401);
  const foreign = await request.post('/api/queue/skip', {
    headers: { Origin: 'https://attacker.example' },
  });
  expect(foreign.status()).toBe(403);
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  const response = await health.text();
  expect(response).not.toContain('radio-e2e-test-token');
  expect(response).not.toContain('OPENAI_API_KEY');
});
