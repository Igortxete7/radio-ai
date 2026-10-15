import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: [
    '@radio/core',
    '@radio/config',
    '@radio/db',
    '@radio/shared',
    '@radio/integrations',
  ],
  serverExternalPackages: ['@prisma/client', 'prisma', 'music-metadata'],
  outputFileTracingExcludes: {
    '/*': ['../../storage/**/*', '../../.env', '../../.env.*'],
  },
  poweredByHeader: false,
};
export default config;
