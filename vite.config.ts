import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadConfig } from './src/config.js';

const config = loadConfig();
const apiPort = config.port + 1; // dev API lives one port up (see src/server/index.ts)

export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: config.port,
    strictPort: true,
    proxy: {
      // changeOrigin must stay off: the API's origin check requires the
      // forwarded Host header to match the browser's Origin (host and port).
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
