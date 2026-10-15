import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { projectRoot } from '@radio/config';
const destination = path.join(projectRoot, '.env');
let content: string;
try {
  content = await readFile(destination, 'utf8');
} catch {
  content = await readFile(path.join(projectRoot, '.env.example'), 'utf8');
}
for (const key of [
  'ADMIN_TOKEN',
  'ICECAST_SOURCE_PASSWORD',
  'ICECAST_ADMIN_PASSWORD',
  'ICECAST_RELAY_PASSWORD',
]) {
  const pattern = new RegExp(`^${key}=$`, 'm');
  if (pattern.test(content))
    content = content.replace(pattern, `${key}=${randomBytes(24).toString('hex')}`);
}
await writeFile(destination, content, { mode: 0o600 });
console.log('.env local preparado. Las credenciales no se muestran.');
