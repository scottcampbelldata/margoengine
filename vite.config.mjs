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

/**
 * The dev server's file watcher sees only the files it has served. Vite watches its whole root by default, and chokidar
 * opens one native watch for every file it finds there: 62,864 paths in a lane checkout with built packages, examples and
 * tests, all opened before the first page could be served. Three sciviz tabs open at `npm run dev:examples` start took
 * 56.4 s to load on the dev PC, 1.2 to 1.7 s with this (docs/limits.md). Here the root's entries are
 * ignored, and each file is added to the watcher when the server first transforms it (the page's html, its modules,
 * the package builds they import), so editing a page or rebuilding a package still reloads it. A file that is removed
 * (a clean rebuild) is dropped and added again on its next request.
 */
export function servedFilesWatch() {
  const key = (path) => {
    const slashed = path.replace(/\\/g, '/');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  const served = new Set();
  let root = '',
    watcher;
  const watch = (file) => {
    const id = file.split('?')[0];
    if (!watcher || id.startsWith('\0') || !key(id).startsWith(root)) return;
    const k = key(id);
    if (served.has(k)) return;
    served.add(k);
    watcher.add(id);
  };
  return {
    /** chokidar's `ignored`: true for every path under the root that the server has not served. */
    ignored: (path) => {
      const k = key(path);
      return !(k === root.slice(0, -1) || served.has(k));
    },
    plugin: {
      name: 'margo-watch-served-files',
      apply: 'serve',
      configResolved(config) {
        root = key(config.root).replace(/\/?$/, '/');
        for (const file of config.configFileDependencies) served.add(key(file));
      },
      configureServer(server) {
        watcher = server.watcher;
        watcher.on('unlink', (path) => served.delete(key(path)));
      },
      transformIndexHtml: {
        order: 'pre',
        handler(html, context) {
          if (context.filename) watch(context.filename);
        },
      },
      transform(code, id) {
        watch(id);
      },
    },
  };
}

const servedOnly = servedFilesWatch();

export default defineConfig({
  plugins: [servedOnly.plugin],
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
  server: { watch: { ignored: [servedOnly.ignored] } },
});
