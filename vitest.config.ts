import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that file sets root to src/ui for
// the SPA, which would hide the server-side tests from vitest.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
