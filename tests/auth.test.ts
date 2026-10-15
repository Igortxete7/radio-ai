import { describe, expect, it } from 'vitest';
import { authenticated, createSession, safeOrigin, validToken } from '../apps/web/lib/auth.ts';
describe('admin authentication', () => {
  const token = 'test-token-with-at-least-24-characters';
  it('accepts configured TLS proxy origin independently of Next internal URL', () => {
    const request = new Request('https://127.0.0.1:3000/api/login', {
      headers: { origin: 'https://radio.example.com' },
    });
    expect(safeOrigin(request, 'https://radio.example.com')).toBe(true);
    expect(safeOrigin(request, 'https://other.example.com')).toBe(false);
  });
  it('accepts valid signed session and rejects expired or modified signatures', () => {
    const now = 100000000;
    const session = createSession(token, now);
    const request = (v: string) =>
      new Request('http://localhost:3000/api/tracks', {
        headers: { cookie: `radio_session=${v}` },
      });
    expect(authenticated(request(session), token, now)).toBe(true);
    expect(authenticated(request(session + 'a'), token, now)).toBe(false);
    expect(authenticated(request(session), token, now + 13 * 3600000)).toBe(false);
    expect(authenticated(request(session), '', now)).toBe(false);
  });
  it('rejects unsafe origins and missing origin with cookie auth', () => {
    expect(
      safeOrigin(
        new Request('http://localhost:3000/api/queue/skip', {
          headers: { origin: 'https://attacker.example' },
        }),
      ),
    ).toBe(false);
    expect(safeOrigin(new Request('http://localhost:3000/api/queue/skip'))).toBe(false);
    expect(
      safeOrigin(
        new Request('http://localhost:3000/api/queue/skip', {
          headers: { origin: 'http://localhost:3000' },
        }),
      ),
    ).toBe(true);
    expect(validToken('incorrect', token)).toBe(false);
  });
});
