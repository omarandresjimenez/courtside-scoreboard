import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by the same Node process as the API in production (Set 02) —
// during development, Vite's dev server proxies API/socket traffic to it.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from other devices on the LAN, not just localhost
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
