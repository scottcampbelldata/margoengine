// Root Vite config for `npm run modern:dev:extensions` and `npm run dev:examples` (vite started at the repository root).
// Without it Vite's dependency scan reads every HTML file in the checkout. That includes the rival comparison pages
// (they import three, babylon, vtk.js and other engines that are deliberately not installed here, and are served by
// their own scripts, never by Vite) and local test output, so the scan failed and pre-bundling was skipped for every
// Margo page. `npm run check:dev-servers` keeps this honest.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Top-level folders git ignores in this checkout (.gitignore and the local exclude file): build and test output,
 * lane scratch folders and local-only folders. Their names are read from git, so no tracked file has to spell out a
 * local-only folder. The root dev servers run from a git checkout.
 */
export function ignoredRootFolders() {
  return execFileSync(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'],
    { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' },
  )
    .split('\n')
    .filter((path) => /^[^/]+\/$/.test(path));
}

export default defineConfig({
  optimizeDeps: {
    entries: [
      '**/*.html',
      '!**/node_modules/**',
      ...ignoredRootFolders().map((folder) => `!${folder}**`),
      '!scripts/rival-*.html',
      '!scripts/sciviz-compare/**',
      '!packages/*/scripts/rival-page.html',
    ],
  },
});
