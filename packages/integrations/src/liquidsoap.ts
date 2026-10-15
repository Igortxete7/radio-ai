import net from 'node:net';
import { z } from 'zod';
import type { RadioConfig } from '@radio/config';
import {
  RadioError,
  type AutomationHealth,
  type AutomationQueueItem,
  type PlaybackSnapshot,
  type QueueName,
  type RadioAutomationPort,
} from '@radio/shared';

const controls = /\p{Cc}/u;
const snapshotSchema = z.object({
  eventId: z.string().min(1),
  queueItemId: z.string().optional(),
  requestId: z.string().optional(),
  path: z.string(),
  title: z.string(),
  artist: z.string().optional(),
  startedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  type: z.enum(['track', 'jingle', 'ai_break', 'fallback']),
});
const healthSchema = z.object({ ok: z.boolean(), detail: z.string().optional() });

function safeInput(value: string): void {
  if (!value || value.length > 16_384 || controls.test(value))
    throw new RadioError('INVALID_AUTOMATION_INPUT', 'Entrada de automatización inválida', 400);
}
function queueName(queue: QueueName): QueueName {
  if (queue !== 'music' && queue !== 'priority')
    throw new RadioError('INVALID_AUTOMATION_INPUT', 'Cola de automatización inválida', 400);
  return queue;
}
function requestId(id: string): string {
  if (!/^\d{1,12}$/.test(id))
    throw new RadioError('INVALID_AUTOMATION_INPUT', 'ID de petición inválido', 400);
  return id;
}

export function annotateUri(uri: string, metadata: Record<string, string> = {}): string {
  safeInput(uri);
  if (uri !== uri.trim())
    throw new RadioError('INVALID_AUTOMATION_INPUT', 'URI de audio inválida', 400);
  // Restrict executable Liquidsoap protocols, including nested annotate:.
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^(?:https?:\/\/|file:\/\/|[a-z]:[\\/])/i.test(uri)) {
    throw new RadioError('INVALID_AUTOMATION_INPUT', 'Protocolo de audio no permitido', 400);
  }
  const annotations = Object.entries(metadata).map(([key, value]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string')
      throw new RadioError('INVALID_AUTOMATION_INPUT', 'Metadato inválido', 400);
    if (value.length > 4096 || controls.test(value))
      throw new RadioError('INVALID_AUTOMATION_INPUT', 'Valor de metadato inválido', 400);
    return `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  });
  return annotations.length ? `annotate:${annotations.join(',')}:${uri}` : uri;
}

export function parseRequestMetadata(response: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of response.split(/\r?\n/)) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1).replace(/\\([\\"])/g, '$1');
      }
    }
    values[key] = value;
  }
  return values;
}

export class LiquidsoapClient implements RadioAutomationPort {
  constructor(private readonly config: RadioConfig) {}

  private async command(command: string): Promise<string> {
    safeInput(command);
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const socket = net.createConnection({
        host: this.config.liquidsoapHost,
        port: this.config.liquidsoapPort,
      });
      const finish = (error?: RadioError, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        if (error) reject(error);
        else resolve(value ?? '');
      };
      const deadline = setTimeout(
        () =>
          finish(
            new RadioError(
              'LIQUIDSOAP_TIMEOUT',
              'Liquidsoap no completó la respuesta a tiempo',
              503,
              true,
            ),
          ),
        this.config.liquidsoapTimeoutMs,
      );
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(`${command}\n`));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) {
          finish(new RadioError('LIQUIDSOAP_RESPONSE', 'Respuesta excesiva de Liquidsoap', 502));
          return;
        }
        const end = /(?:^|\r?\n)END\r?\n/.exec(buffer);
        if (!end) return;
        const response = buffer.slice(0, end.index).trim();
        if (/^(?:ERROR\b|Error\b|No such command\b|Unknown command\b)/m.test(response))
          finish(new RadioError('LIQUIDSOAP_COMMAND', 'Liquidsoap rechazó el comando', 502));
        else finish(undefined, response);
      });
      socket.once('error', () =>
        finish(
          new RadioError('LIQUIDSOAP_UNAVAILABLE', 'No se pudo conectar con Liquidsoap', 503, true),
        ),
      );
      socket.once('end', () =>
        finish(
          new RadioError(
            'LIQUIDSOAP_RESPONSE',
            'Liquidsoap cerró una respuesta incompleta',
            502,
            true,
          ),
        ),
      );
      socket.once('close', () =>
        finish(
          new RadioError(
            'LIQUIDSOAP_RESPONSE',
            'Liquidsoap cerró una respuesta incompleta',
            502,
            true,
          ),
        ),
      );
    });
  }

  async push(
    uri: string,
    metadata: Record<string, string> = {},
    queue: QueueName = 'music',
  ): Promise<string> {
    const result = await this.command(`${queueName(queue)}.push ${annotateUri(uri, metadata)}`);
    if (!/^\d+$/.test(result))
      throw new RadioError('LIQUIDSOAP_RESPONSE', 'Liquidsoap no devolvió un ID de petición', 502);
    return result;
  }

  async queue(queue: QueueName = 'music'): Promise<AutomationQueueItem[]> {
    const result = await this.command(`${queueName(queue)}.queue`);
    if (!result) return [];
    const ids = result.split(/\s+/);
    if (ids.length > 1000 || ids.some((id) => !/^\d{1,12}$/.test(id)))
      throw new RadioError('LIQUIDSOAP_RESPONSE', 'Lista de peticiones inválida', 502);
    const items: AutomationQueueItem[] = [];
    for (const id of ids) {
      try {
        const metadata = parseRequestMetadata(await this.command(`request.metadata ${id}`));
        items.push({ id, uri: metadata.initial_uri || metadata.filename, metadata });
      } catch (error) {
        // A request may start or expire between queue and metadata. Preserve rid.
        if (error instanceof RadioError && error.code === 'LIQUIDSOAP_COMMAND') items.push({ id });
        else throw error;
      }
    }
    return items;
  }

  async remove(id: string, queue: QueueName = 'music'): Promise<void> {
    await this.command(`${queueName(queue)}.remove ${requestId(id)}`);
  }
  async skip(): Promise<void> {
    await this.command('radio.skip');
  }
  private async json<T>(command: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.command(command);
    try {
      return schema.parse(JSON.parse(response));
    } catch {
      throw new RadioError('LIQUIDSOAP_RESPONSE', 'Estado inválido de Liquidsoap', 502);
    }
  }
  async health(): Promise<AutomationHealth> {
    try {
      return await this.json('radio.health', healthSchema);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof RadioError ? error.code : 'LIQUIDSOAP_UNAVAILABLE',
      };
    }
  }
  async current(): Promise<PlaybackSnapshot | null> {
    return this.json('radio.current', snapshotSchema.nullable());
  }
  async events(): Promise<PlaybackSnapshot[]> {
    return this.json('radio.events', z.array(snapshotSchema).max(256));
  }
}
