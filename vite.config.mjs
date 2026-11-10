// Root Vite config for `npm run modern:dev:extensions` and `npm run dev:examples` (vite started at the repository root).
// Without it Vite's dependency scan reads every HTML file in the checkout. That includes the rival comparison pages
// (they import three, babylon, vtk.js and other engines that are deliberately not installed here, and are served by
// their own scripts, never by Vite) and local test output, so the scan failed and pre-bundling was skipped for every
// Margo page. `npm run check:dev-servers` keeps this honest.
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    entries: [
      '**/*.html',
      '!**/node_modules/**',
      '!test-results/**',
      '!.lane/**',
      '!private/**',
      '!scripts/rival-*.html',
      '!scripts/sciviz-compare/**',
      '!packages/*/scripts/rival-page.html',
    ],
  },
});
