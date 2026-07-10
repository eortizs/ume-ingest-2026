import type { NextConfig } from 'next';

const config: NextConfig = {
  basePath: '/ingest',
  assetPrefix: '/ingest',
  reactStrictMode: true,
  transpilePackages: ['ume-standard'],
  serverExternalPackages: ['pg', 'pdf-parse'],
  experimental: {
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
  },
};

export default config;