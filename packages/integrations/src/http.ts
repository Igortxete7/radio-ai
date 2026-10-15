import { setTimeout as delay } from 'node:timers/promises';
import { RadioError } from '@radio/shared';

export function httpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RadioError('INVALID_SOURCE_URL', 'URL de fuente inválida', 400);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new RadioError(
      'INVALID_SOURCE_URL',
      'La fuente debe usar HTTP o HTTPS sin credenciales en la URL',
      400,
    );
  }
  return url;
}

export async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new RadioError(
      'UPSTREAM_TOO_LARGE',
      'La respuesta del proveedor supera el tamaño permitido',
      502,
    );
  }
  if (!response.body)
    throw new RadioError('UPSTREAM_RESPONSE', 'Respuesta vacía del proveedor', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes)
        throw new RadioError(
          'UPSTREAM_TOO_LARGE',
          'La respuesta del proveedor supera el tamaño permitido',
          502,
        );
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function fetchText(
  url: URL,
  timeoutMs: number,
  options: {
    headers?: Record<string, string>;
    attempts?: number;
    maxBytes?: number;
    followRedirects?: boolean;
  } = {},
): Promise<string> {
  const attempts = options.attempts ?? 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      let target = url;
      for (let redirect = 0; redirect <= 3; redirect++) {
        const response = await fetch(target, {
          signal,
          headers: {
            'user-agent': 'Radio-AI/1.0 (configured radio source adapter)',
            accept:
              'application/json, application/rss+xml, application/atom+xml, application/xml, text/xml',
            ...(redirect === 0 ? options.headers : {}),
          },
          redirect: 'manual',
        });
        const location = response.headers.get('location');
        if (
          options.followRedirects &&
          [301, 302, 303, 307, 308].includes(response.status) &&
          location
        ) {
          await response.body?.cancel();
          if (redirect === 3)
            throw new RadioError('UPSTREAM_REDIRECT', 'Demasiadas redirecciones de la fuente', 502);
          const destination = httpUrl(new URL(location, target).href);
          if (target.protocol === 'https:' && destination.protocol !== 'https:')
            throw new RadioError(
              'UPSTREAM_REDIRECT',
              'La fuente redirige a una conexión no cifrada',
              502,
            );
          target = destination;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new RadioError(
            'UPSTREAM_HTTP',
            `El proveedor respondió HTTP ${response.status}`,
            502,
            response.status === 429 || response.status >= 500,
          );
        }
        const body = await readLimitedBody(response, options.maxBytes ?? 2 * 1024 * 1024);
        const httpCharset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(
          response.headers.get('content-type') ?? '',
        )?.[1];
        const xmlCharset = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(
          body.subarray(0, 256).toString('ascii'),
        )?.[1];
        try {
          return new TextDecoder(httpCharset ?? xmlCharset ?? 'utf-8').decode(body);
        } catch {
          throw new RadioError('UPSTREAM_ENCODING', 'Codificación de fuente no admitida', 502);
        }
      }
    } catch (error) {
      const failure =
        error instanceof RadioError
          ? error
          : new RadioError(
              error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
                ? 'UPSTREAM_TIMEOUT'
                : 'UPSTREAM_UNAVAILABLE',
              'No se pudo obtener la fuente dentro del tiempo permitido',
              502,
              true,
            );
      if (!failure.retryable || attempt === attempts - 1) throw failure;
      await delay(150 * (attempt + 1));
    }
  }
  throw new RadioError('UPSTREAM_UNAVAILABLE', 'Fuente no disponible', 502, true);
}

export async function fetchJson(
  url: URL,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  const text = await fetchText(url, timeoutMs, { headers });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RadioError('UPSTREAM_RESPONSE', 'El proveedor devolvió JSON inválido', 502);
  }
}
