// Root Vite config for `npm run modern:dev:extensions` and `npm run dev:examples` (vite started at the repository root).
// Without it Vite's dependency scan reads every HTML file in the checkout. That includes the rival comparison pages
// (they import three, babylon, vtk.js and other engines that are deliberately not installed here, and are served by
// their own scripts, never by Vite) and local test output, so the scan failed and pre-bundling was skipped for every
// Margo page. `npm run check:dev-servers` keeps this honest.
import { execFileSync } from 'node:child_process';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Top-level folders git ignores in this checkout (.gitignore and the local exclude file): build and test output,
 * lane scratch folders and local-only folders. Their names are read from git, so no tracked file has to spell out a
 * local-only folder. The root dev servers run from a git checkout.
 */
export function ignoredRootFolders(run = execFileSync) {
  let listed;
  try {
    listed = run(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'],
      { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' },
    );
  } catch (error) {
    throw gitListError(error);
  }
  return listed
    .split('\n')
    .filter((path) => /^[^/]+\/$/.test(path));
}

/**
 * The coded error for a git that could not list the ignored folders (KB-L5a-6). Exit status 0xC0000142
 * (STATUS_DLL_INIT_FAILED, 3221225794) means Windows could not start the git process at all: it failed while loading
 * its DLLs, which happens when the session runs out of desktop heap with many processes open. It is not a git or Vite
 * error, so the message says so instead of the bare "Command failed". Nothing retries it: the dev server stops.
 */
export function gitListError(error) {
  const status = error?.status;
  const cause =
    status === 3221225794
      ? 'Windows could not start git (exit 0xC0000142, STATUS_DLL_INIT_FAILED: a process failed to initialise, usually ' +
        'because the desktop heap ran out with many processes open; close some browsers or GPU tests and start again)'
      : error?.code === 'ENOENT'
        ? 'git is not on PATH'
        : `git exited with status ${status ?? 'none'}${error?.stderr ? `: ${String(error.stderr).trim()}` : ''}`;
  return Object.assign(
    new Error(
      `ERR_DEV_SERVER_GIT_LIST: the root Vite config could not list the git-ignored folders: ${cause}. ` +
        'See docs/known-bugs.md (KB-L5a-6).',
      { cause: error },
    ),
    { code: 'ERR_DEV_SERVER_GIT_LIST' },
  );
}

/**
 * The dev server's file watcher sees only the files it has served. Vite watches its whole root by default, and chokidar
 * opens one native watch for every file it finds there: 62,864 paths in a lane checkout with built packages, examples and
 * tests, all opened before the first page could be served. Three sciviz tabs open at `npm run dev:examples` start took
 * 56.4 s to load on the workstation, 1.2 to 1.7 s with this (docs/limits.md). Here the root's entries are
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

/**
 * The root address is the one line `npm run dev:examples` prints, and the repository root has no page: a new reader who
 * opened it got a blank 404. It now sends them to the quickstart page that README "Build something in 5 minutes" names.
 * Only the bare root is redirected; every other path is served as before.
 */
export const QUICKSTART_PAGE = '/examples/quickstart/';
export const rootToQuickstart = {
  name: 'margo-root-to-quickstart',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/' && !request.url?.startsWith('/?')) return next();
      response.statusCode = 302;
      response.setHeader('Location', QUICKSTART_PAGE);
      response.end();
    });
  },
};

/**
 * Film and example assets (Blender builds, downloaded CC0 scans) never go into git (Scott, 2026-11-16): they live in a
 * library folder beside the checkouts, `MARGO_ASSET_LIBRARY` or else `../../Assets/blender-library` from the
 * repository (the development root's Assets folder). This serves that folder read-only at
 * `/asset-library/` on every dev server the root config starts, the shot tool's included, so a page loads
 * `/asset-library/kitty-hawk/flyer-1903/flyer-1903.glb` without the files being copied into the repository. Paths
 * that leave the folder answer 403 and missing files 404 (never Vite's HTML fallback, which would hand a loader a page).
 */
export const ASSET_LIBRARY_PREFIX = '/asset-library/';

const ASSET_TYPES = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

export function assetLibraryRoot(env = process.env) {
  return resolve(env.MARGO_ASSET_LIBRARY || resolve(fileURLToPath(new URL('.', import.meta.url)), '../../Assets/blender-library'));
}

export function assetLibrary({ root = assetLibraryRoot() } = {}) {
  return {
    name: 'margo-asset-library',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(ASSET_LIBRARY_PREFIX)) return next();
        const send = (status, text) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end(text);
        };
        if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'read only');
        let name;
        try {
          name = decodeURIComponent(request.url.slice(ASSET_LIBRARY_PREFIX.length).split(/[?#]/)[0]);
        } catch {
          return send(400, 'bad path');
        }
        let base;
        try {
          base = realpathSync.native(root);
        } catch {
          return send(404, `no asset library at ${root} (set MARGO_ASSET_LIBRARY)`);
        }
        const file = resolve(base, name),
          rel = relative(base, file);
        if (!name || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return send(403, 'outside the asset library');
        let stat;
        try {
          stat = statSync(file);
        } catch {
          return send(404, `not in the asset library: ${name}`);
        }
        if (!stat.isFile()) return send(404, `not a file: ${name}`);
        response.statusCode = 200;
        response.setHeader('Content-Type', ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
        response.setHeader('Content-Length', String(stat.size));
        response.setHeader('Cache-Control', 'no-cache');
        if (request.method === 'HEAD') return response.end();
        createReadStream(file).pipe(response);
      });
    },
  };
}

const servedOnly = servedFilesWatch();

export default defineConfig({
  plugins: [servedOnly.plugin, rootToQuickstart, assetLibrary()],
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
