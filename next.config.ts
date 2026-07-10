import type { NextConfig } from 'next';

const config: NextConfig = {
  basePath: '/ingest',
  // Prefer /ingest/ for HTML; do NOT 308 POST /api/* which drops multipart bodies.
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
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