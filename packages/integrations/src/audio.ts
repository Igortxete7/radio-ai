import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { RadioConfig } from '@radio/config';
import { RadioError, type AudioInspector } from '@radio/shared';
import { z } from 'zod';

export type ProbeRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;
const executeProbe: ProbeRunner = (executable, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
const probeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      nb_read_frames: z.string().optional(),
      duration: z.string().optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional() }).optional(),
});

export class FfprobeAudioInspector implements AudioInspector {
  constructor(
    private readonly config: RadioConfig,
    private readonly execute: ProbeRunner = executeProbe,
  ) {}
  async inspect(filename: string): Promise<{ durationSec: number; bytes: number }> {
    let information: Awaited<ReturnType<typeof stat>>;
    try {
      information = await stat(filename);
    } catch {
      throw new RadioError('AUDIO_MISSING', 'No existe el fichero de audio', 422);
    }
    if (!information.isFile() || information.size <= 0)
      throw new RadioError('AUDIO_INVALID', 'Fichero de audio vacío o inválido', 422);
    try {
      // -count_frames decodes the stream, rather than trusting the container
      // duration alone. execFile passes the path as a literal argument, no shell.
      const result = await this.execute(
        this.config.ffprobePath,
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=codec_type,nb_read_frames,duration:format=duration',
          '-of',
          'json',
          '-i',
          filename,
        ],
        this.config.openaiTimeoutMs,
      );
      if (result.stderr.trim()) throw new Error('ffprobe decode errors');
      const parsed = probeSchema.parse(JSON.parse(result.stdout));
      const audio = parsed.streams.find((stream) => stream.codec_type === 'audio');
      const durationSec = Number(parsed.format?.duration ?? audio?.duration);
      if (
        !audio ||
        !Number.isFinite(Number(audio.nb_read_frames)) ||
        Number(audio.nb_read_frames) <= 0 ||
        !Number.isFinite(durationSec) ||
        durationSec <= 0 ||
        durationSec > 86400
      )
        throw new Error('Invalid duration or stream');
      return { durationSec, bytes: information.size };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new RadioError(
          'FFPROBE_UNAVAILABLE',
          'No se encuentra ffprobe; revisa FFPROBE_PATH',
          503,
        );
      throw new RadioError(
        'AUDIO_INVALID',
        'El fichero no contiene audio decodificable con duración válida',
        422,
      );
    }
  }
}
