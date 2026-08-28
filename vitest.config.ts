import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that file sets root to src/ui for
// the SPA, which would hide the server-side tests from vitest.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Ticket 14: ControlKeys.test.tsx renders a standalone React component
    // and needs `document`/`window`. It opts into jsdom itself via a
    // `// @vitest-environment jsdom` docblock rather than switching the
    // whole suite — everything else here is server-side and stays on the
    // lighter default 'node' environment.
  },
});
