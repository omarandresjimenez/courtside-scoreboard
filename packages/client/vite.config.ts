import legacy from '@vitejs/plugin-legacy';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// Served by the same Node process as the API in production (Set 02) —
// during development, Vite's dev server proxies API/socket traffic to it.
//
// legacy() exists for TV screens: a smart TV's built-in browser can be old
// enough to choke while just *parsing* modern syntax (optional chaining,
// nullish coalescing, class fields — all used throughout this app), which
// fails before any of our code runs and can't be caught by an error
// handler. The plugin emits a second, ES5-transpiled + polyfilled bundle
// behind a <script nomodule> tag, which only browsers lacking ES module
// support ever load — modern browsers are unaffected.
export default defineConfig({
  plugins: [
    react(),
    // Self-signed HTTPS for the dev server — phones on the LAN need a secure
    // context for getUserMedia (camera capture), which browsers hide entirely
    // on a plain http:// address that isn't localhost. Visiting the https://
    // address will show a one-time "not private" warning to click through.
    basicSsl(),
    legacy({
      // Without an explicit target, the plugin falls back to browserslist's
      // "defaults" query, which already includes browsers that natively
      // support optional chaining / nullish coalescing — so Babel decided
      // there was nothing to transpile, and the "legacy" bundle shipped
      // that syntax completely untouched. Adding `ie 11` forces the target
      // down far enough that Babel down-levels everything (classes,
      // let/const, arrow functions, ?./??, all of it) to real ES5.
      targets: ['defaults', 'ie 11'],
      additionalLegacyPolyfills: ['whatwg-fetch'],
    }),
  ],
  build: {
    // Vite 8 defaults to its newer Rolldown/oxc minifier, which doesn't
    // respect `terserOptions` and (as observed) re-introduces ES6+ syntax
    // like template literals into the legacy chunk's output regardless of
    // Babel's down-leveling. Terser has long-proven ES5-safety guarantees
    // for exactly this legacy-bundle use case, so it's forced explicitly.
    minify: 'terser',
    terserOptions: { ecma: 5 },
    cssMinify: 'esbuild',
  },
  server: {
    host: true, // reachable from other devices on the LAN, not just localhost
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
