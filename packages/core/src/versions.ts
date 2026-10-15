import { readFile, stat } from 'node:fs/promises';
import { safeStoragePath } from './storage.ts';

export type EnvironmentVersions = {
  liquidsoap?: string;
  icecast?: string;
  ffmpeg?: string;
  verifiedAt?: string;
};
export function parseEnvironmentVersions(output: string): EnvironmentVersions {
  const versions: EnvironmentVersions = {};
  const version = String.raw`(\d+\.\d+(?:\.\d+)?(?:[-+~][a-zA-Z0-9._-]+)?)`;
  for (const line of output.split(/\r?\n/)) {
    const verified = /^Verified at (\S+)$/.exec(line);
    if (verified && Number.isFinite(Date.parse(verified[1]))) versions.verifiedAt = verified[1];
    for (const product of ['liquidsoap', 'icecast', 'ffmpeg'] as const) {
      const match = new RegExp(`^${product}\\s+(?:version\\s+)?${version}(?:\\s|$)`, 'i').exec(
        line,
      );
      if (match) versions[product] = match[1];
    }
  }
  return versions;
}
export async function readEnvironmentVersions(storageRoot: string): Promise<EnvironmentVersions> {
  try {
    const filename = await safeStoragePath(storageRoot, 'tmp/environment-versions.txt');
    const info = await stat(/* turbopackIgnore: true */ filename);
    if (!info.isFile() || info.size > 128 * 1024) return {};
    return parseEnvironmentVersions(await readFile(/* turbopackIgnore: true */ filename, 'utf8'));
  } catch {
    // Bootstrap may not have recorded installed tools yet; absent values remain unverified.
    return {};
  }
}
