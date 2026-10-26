import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: 'node_modules/.vite-cache',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    coverage: {
      include: ['src/domain/**', 'src/infra/ai/**', 'src/infra/config/**'],
      exclude: ['**/*.d.ts'],
    },
  },
});
