import { expect, it } from 'vitest';
import { parseEnvironmentVersions } from './versions.ts';

it('lee sólo versiones verificadas por comandos y conserva su fecha', () => {
  const output =
    'Verified at 2026-10-14T10:00:00Z\nOS: Ubuntu 24.04\nLiquidsoap channel: v2.4.6\nv24.21.0\n11.11.0\nLiquidsoap 2.4.6\nCopyright\nIcecast 2.4.4\nffmpeg version 6.1.1-3ubuntu5 Copyright\n';
  expect(parseEnvironmentVersions(output)).toEqual({
    liquidsoap: '2.4.6',
    icecast: '2.4.4',
    ffmpeg: '6.1.1-3ubuntu5',
    verifiedAt: '2026-10-14T10:00:00Z',
  });
});
it('no presenta un canal configurado como una versión instalada', () => {
  expect(parseEnvironmentVersions('Liquidsoap channel: v2.5.0\nOS: Ubuntu 24.04')).toEqual({});
});
