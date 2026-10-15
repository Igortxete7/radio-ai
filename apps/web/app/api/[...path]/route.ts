import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '@radio/config';
import { RadioError } from '@radio/shared';
import { getService } from '../../../lib/service';
import {
  allowLogin,
  authenticated,
  createSession,
  safeOrigin,
  sessionCookie,
  validToken,
} from '../../../lib/auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const kindSchema = z.enum(['hourly', 'weather', 'news', 'music-link', 'ident']);
const patchSchema = z
  .object({
    title: z.string().min(1).max(250).optional(),
    artist: z.string().min(1).max(250).optional(),
    album: z.string().max(250).optional(),
    genre: z.string().max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const settingsSchema = z
  .object({
    stationName: z.string().min(1).max(120).optional(),
    persona: z.string().min(1).max(2000).optional(),
    textModel: z.string().min(1).max(100).optional(),
    ttsModel: z.string().min(1).max(100).optional(),
    ttsVoice: z.string().min(1).max(100).optional(),
    djHourlyEnabled: z.boolean().optional(),
    djTargetSeconds: z.number().min(15).max(120).optional(),
    trackRepeatHours: z.number().min(0).max(168).optional(),
    artistRepeatMinutes: z.number().min(0).max(1440).optional(),
    jingleMinTracks: z.number().int().min(1).max(50).optional(),
    jingleMaxTracks: z.number().int().min(1).max(50).optional(),
    weatherEnabled: z.boolean().optional(),
    newsEnabled: z.boolean().optional(),
    newsSources: z
      .array(
        z.object({
          name: z.string().min(1).max(150),
          url: z.url().startsWith('https://'),
          category: z.string().max(100),
          priority: z.number().min(0).max(1000),
          language: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .max(30)
      .optional(),
  })
  .strict();
function response(data: unknown, status = 200) {
  return NextResponse.json(
    { data, error: null },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
function failure(code: string, message: string, status: number) {
  return NextResponse.json(
    { data: null, error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > 20000)
    throw new RadioError('BODY_TOO_LARGE', 'La solicitud supera el tamaño permitido.', 413);
  const text = await request.text();
  if (text.length > 20000)
    throw new RadioError('BODY_TOO_LARGE', 'La solicitud supera el tamaño permitido.', 413);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new RadioError('INVALID_JSON', 'El contenido JSON no es válido.', 400);
  }
}
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const route = (await context.params).path.join('/');
    const config = loadConfig();
    const isAuth = authenticated(request, config.adminToken);
    if (request.method === 'GET' && route === 'session')
      return response({ authenticated: isAuth, configured: config.adminToken.length >= 24 });
    if (request.method === 'POST' && !safeOrigin(request, config.adminOrigin))
      return failure('INVALID_ORIGIN', 'Origen de solicitud no permitido.', 403);
    if (request.method === 'PATCH' && !safeOrigin(request, config.adminOrigin))
      return failure('INVALID_ORIGIN', 'Origen de solicitud no permitido.', 403);
    if (request.method === 'DELETE' && !safeOrigin(request, config.adminOrigin))
      return failure('INVALID_ORIGIN', 'Origen de solicitud no permitido.', 403);
    if (request.method === 'POST' && route === 'login') {
      if (!allowLogin('admin'))
        return failure('RATE_LIMITED', 'Demasiados intentos. Espera un minuto.', 429);
      const input = z.object({ token: z.string().min(1).max(256) }).parse(await body(request));
      if (!validToken(input.token, config.adminToken))
        return failure('UNAUTHORIZED', 'El token de administración no es válido.', 401);
      const result = response({ authenticated: true });
      result.cookies.set(sessionCookie, createSession(config.adminToken), {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.adminOrigin.startsWith('https://'),
        path: '/',
        maxAge: 12 * 3600,
      });
      return result;
    }
    if (request.method === 'POST' && route === 'logout') {
      const result = response({ authenticated: false });
      result.cookies.delete(sessionCookie);
      return result;
    }
    if (request.method === 'GET' && route === 'health' && !isAuth) {
      const health = await getService().health();
      return response({
        status: health.status,
        checkedAt: health.checkedAt,
        checks: Object.fromEntries(
          Object.entries(health.checks).map(([key, v]) => [key, { ok: v.ok }]),
        ),
      });
    }
    if (!isAuth) return failure('UNAUTHORIZED', 'Accede con el token de administración.', 401);
    const service = getService();
    const url = new URL(request.url);
    if (request.method === 'GET') {
      switch (route) {
        case 'health':
          return response(await service.health());
        case 'now-playing':
          return response(await service.nowPlaying());
        case 'queue':
          return response(await service.queue());
        case 'tracks':
          return response(
            await service.tracks({
              search: url.searchParams.get('search') ?? undefined,
              enabled: url.searchParams.has('enabled')
                ? url.searchParams.get('enabled') === 'true'
                : undefined,
              page: z.coerce
                .number()
                .int()
                .min(1)
                .parse(url.searchParams.get('page') ?? 1),
              pageSize: z.coerce
                .number()
                .int()
                .min(1)
                .max(100)
                .parse(url.searchParams.get('pageSize') ?? 30),
            }),
          );
        case 'history':
          return response(
            await service.history(
              z.coerce
                .number()
                .int()
                .min(1)
                .max(200)
                .parse(url.searchParams.get('limit') ?? 100),
            ),
          );
        case 'sources/status':
          return response(await service.sourcesStatus());
        case 'settings':
          return response(await service.settings());
        case 'system':
          return response(await service.system());
        case 'ai-breaks':
          return response(await service.breaks());
        case 'generated-audio': {
          const name = url.searchParams.get('file');
          if (!name) throw new RadioError('INVALID_PATH', 'Falta el archivo de audio.', 400);
          const root = await realpath(path.join(config.storageRoot, 'generated'));
          const candidate = await realpath(path.resolve(root, name));
          const relative = path.relative(root, candidate);
          if (relative.startsWith('..') || path.isAbsolute(relative) || !candidate.endsWith('.mp3'))
            throw new RadioError(
              'INVALID_PATH',
              'El archivo no está en el almacenamiento generado.',
              400,
            );
          const audio = await readFile(candidate);
          return new NextResponse(new Uint8Array(audio), {
            headers: {
              'Content-Type': 'audio/mpeg',
              'Cache-Control': 'no-store',
              'Content-Length': String(audio.length),
            },
          });
        }
      }
    }
    if (request.method === 'PATCH' && route.startsWith('tracks/'))
      return response(
        await service.updateTrack(route.slice(7), patchSchema.parse(await body(request))),
      );
    if (request.method === 'PATCH' && route === 'settings')
      return response(await service.updateSettings(settingsSchema.parse(await body(request))));
    if (request.method === 'DELETE' && route.startsWith('queue/'))
      return response(await service.removeQueue(route.slice(6)));
    if (request.method === 'POST') {
      switch (route) {
        case 'queue/skip':
          return response(await service.skip());
        case 'queue/push':
          return response(
            await service.enqueueTrack(
              z.object({ id: z.string().min(1).max(200) }).parse(await body(request)).id,
            ),
          );
        case 'library/scan':
          return response(await service.scanLibrary());
        case 'sources/refresh':
          return response(await service.refreshSources());
        case 'ai-breaks/preview':
          return response(
            await service.preview(
              z.object({ kind: kindSchema.optional() }).parse(await body(request)).kind,
            ),
          );
        case 'ai-breaks/test-tts':
          return response(
            await service.testTts(
              z.object({ text: z.string().min(1).max(5000).optional() }).parse(await body(request))
                .text,
            ),
          );
        case 'ai-breaks/generate':
          return response(
            await service.generateBreak(
              z.object({ kind: kindSchema.optional() }).parse(await body(request)).kind,
            ),
            201,
          );
      }
    }
    return failure('NOT_FOUND', 'No existe este recurso.', 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return failure(
        'VALIDATION_ERROR',
        error.issues.map((v) => `${v.path.join('.') || 'solicitud'}: ${v.message}`).join('; '),
        400,
      );
    if (error instanceof RadioError) return failure(error.code, error.message, error.status);
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'web',
        event: 'api.error',
        errorCode: 'INTERNAL_ERROR',
      }),
    );
    return failure(
      'INTERNAL_ERROR',
      'No se pudo completar la operación. Consulta Sistema e inténtalo de nuevo.',
      500,
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
