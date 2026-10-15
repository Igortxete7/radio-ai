import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.ts';
describe('environment configuration', () => {
  it('validates timezone, numeric ranges and source configuration', () => {
    expect(() => loadConfig({ TZ: 'Imaginary/City' })).toThrow();
    expect(() => loadConfig({ ADMIN_ORIGIN: 'ftp://example.com' })).toThrow();
    expect(() => loadConfig({ RADIO_LATITUDE: '100' })).toThrow();
    expect(() => loadConfig({ NEWS_SOURCES_JSON: '{bad' })).toThrow();
    expect(() => loadConfig({ JINGLE_MIN_TRACKS: '9', JINGLE_MAX_TRACKS: '5' })).toThrow();
  });
  it('parses false booleans and resolves storage/database independently of cwd', () => {
    const config = loadConfig({
      DJ_HOURLY_ENABLED: 'false',
      STORAGE_ROOT: './storage',
      DATABASE_URL: 'file:../storage/test.db',
    });
    expect(config.djHourlyEnabled).toBe(false);
    expect(config.dbUrl.replaceAll('\\', '/')).toMatch(/\/storage\/test.db$/);
    expect(config.storageRoot).toContain('storage');
  });
});
