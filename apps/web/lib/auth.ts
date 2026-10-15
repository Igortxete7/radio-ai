import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
export const sessionCookie = 'radio_session';
const hours = 12;
function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
export function validToken(value: string, token: string) {
  return token.length >= 24 && equal(value, token);
}
export function createSession(token: string, now = Date.now()) {
  const expires = String(now + hours * 3600000);
  return `${expires}.${createHmac('sha256', token).update(expires).digest('hex')}`;
}
export function authenticated(request: Request, token: string, now = Date.now()) {
  if (token.length < 24) return false;
  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ') && validToken(bearer.slice(7), token)) return true;
  const raw = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(sessionCookie + '='))
    ?.slice(sessionCookie.length + 1);
  if (!raw) return false;
  const [expires, signature] = raw.split('.');
  const remaining = Number(expires) - now;
  return (
    remaining > 0 &&
    remaining <= hours * 3600000 &&
    !!signature &&
    equal(signature, createHmac('sha256', token).update(expires).digest('hex'))
  );
}
export function safeOrigin(request: Request, adminOrigin = 'http://localhost:3000') {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('authorization')?.startsWith('Bearer ') === true;
  // Next may construct an internal loopback URL behind a reverse proxy.
  // Trust explicit origins, never arbitrary Host or forwarded headers.
  const permitted = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    new URL(adminOrigin).origin,
  ]);
  return permitted.has(origin);
}
const loginAttempts = new Map<string, { count: number; expires: number }>();
export function allowLogin(key: string, now = Date.now()) {
  for (const [k, v] of loginAttempts) if (v.expires <= now) loginAttempts.delete(k);
  const value = loginAttempts.get(key) ?? { count: 0, expires: now + 60000 };
  value.count++;
  loginAttempts.set(key, value);
  return value.count <= 10;
}
