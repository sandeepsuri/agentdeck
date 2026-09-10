import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that file sets root to src/ui for
// the SPA, which would hide the server-side tests from vitest.
export default defineConfig({
  test: {
    environment: 'node',
    // Vitest only defaults NODE_ENV to "test" when the caller has not set
    // it. Force the test build here so `npm run test` remains deterministic
    // when AgentDeck (or another production launcher) provides
    // NODE_ENV=production in the inherited environment. React's production
    // build intentionally does not support act(), which the jsdom component
    // tests use to flush renders and effects.
    env: { NODE_ENV: 'test' },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Ticket 14: ControlKeys.test.tsx renders a standalone React component
    // and needs `document`/`window`. It opts into jsdom itself via a
    // `// @vitest-environment jsdom` docblock rather than switching the
    // whole suite — everything else here is server-side and stays on the
    // lighter default 'node' environment.
  },
});
