import { constants } from 'node:fs';
import { access, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RadioError } from '@radio/shared';

function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
/** Resolve existing ancestors as well as lexical paths to reject symlink escapes on reads and writes. */
export async function safeStoragePath(
  root: string,
  requested: string,
  mustExist = true,
): Promise<string> {
  const base = path.resolve(root);
  const target = path.resolve(base, requested);
  if (!contained(base, target) || /[\r\n\0]/.test(requested))
    throw new RadioError('UNSAFE_PATH', 'Ruta de almacenamiento inválida', 400);
  const resolvedRoot = await realpath(base);
  let ancestor = target;
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      if (!contained(resolvedRoot, resolved))
        throw new RadioError('UNSAFE_PATH', 'Un enlace sale del almacenamiento', 400);
      if (mustExist && ancestor !== target)
        throw new RadioError('FILE_MISSING', 'El archivo no existe', 404);
      return target;
    } catch (error) {
      if (error instanceof RadioError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor)
        throw new RadioError('UNSAFE_PATH', 'No se puede resolver la ruta', 400);
      ancestor = parent;
    }
  }
}
export async function readableAudio(root: string, file: string): Promise<boolean> {
  try {
    const safe = await safeStoragePath(root, file);
    await access(safe, constants.R_OK);
    const info = await stat(/* turbopackIgnore: true */ safe);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
export async function initializeStorage(root: string) {
  await mkdir(root, { recursive: true });
  for (const dir of ['music', 'jingles', 'generated', 'fallback', 'tmp']) {
    const safe = await safeStoragePath(root, dir, false);
    await mkdir(safe, { recursive: true });
    await safeStoragePath(root, dir);
  }
}
export async function atomicWrite(root: string, file: string, text: string) {
  const target = await safeStoragePath(root, file, false);
  await mkdir(path.dirname(target), { recursive: true });
  await safeStoragePath(root, target, false);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
}
