/**
 * A Vite plugin that turns the dev server's file watcher off, for every suite and harness that builds a server with
 * Vite's `createServer` (startDevServer in scripts/browser.js uses it too). With a watcher, a build in the same
 * checkout that rewrites a module the page loaded (a package's `npm run build` writing its dist) makes Vite send the
 * page a full reload, and the next `page.evaluate` fails with "Execution context was destroyed" (KB-DEVWATCH-TEXT1).
 * `server.watch: null` in an inline config does not work: Vite's mergeConfig skips null values, so it is set once the
 * config is resolved. tests/dev-server-watch.test.js checks that every createServer call in the repository passes it.
 */
export function noFileWatcher() {
  return {
    name: 'margo-no-file-watcher',
    enforce: 'pre',
    configResolved: (config) => {
      config.server.watch = null;
    },
  };
}
