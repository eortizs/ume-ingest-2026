import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const umeStandardSrc = path.resolve(here, '../ume-standard/src/index.ts');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      'ume-standard': umeStandardSrc,
      'server-only': path.resolve(here, 'tests/_stubs/server-only.ts'),
    },
  },
});