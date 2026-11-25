import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';
import { compactInternals } from './compact-internals.js';
import { compactOutput } from './measure-size.js';
import { distDir } from './support/dist-dir.mjs';

// The bundler hands the importer over in real form (macOS os.tmpdir() is /var/folders/..., a link to
// /private/var/folders/...), so both sides of the shared-helper test are compared as real paths.
const real = (path) => (existsSync(path) ? realpathSync(path) : path);

/**
 * `list` reads the build folder's file names (tests swap it). The names are sorted by code unit because the order of the
 * library entries decides how rolldown orders the shared imports and names the locals, so it changes the bytes, and a
 * directory listing's order belongs to the file system, not to Node (NTFS collates names case-insensitively, so `_`
 * and capitals already sort differently there than by code unit). tests/compact-package-order.test.js (KB-SIZE-PLATFORM1).
 */
export async function compactPackage(
  name,
  directory = `packages/${name}`,
  dist = distDir(directory),
  { list = readdir } = {},
) {
  const root = resolve(dist),
    // Every packages/shared helper core and the stage import is bundled into them (shared is not published, so a
    // ../../shared import left in dist breaks an installed package; tests/dts-self-contained.test.js). Everything else stays
    // an import. A fixed list once missed the stage's glTF route and lights helpers.
    sharedDir = real(resolve(directory, '../shared')),
    isShared = (path) => dirname(real(path)) === sharedDir,
    // Sorted: readdir order is the file system's (APFS is not alphabetical), and the entry order decides chunk layout.
    files = (await list(root)).filter((file) => file.endsWith('.js')).sort();
  for (const file of files)
    await writeFile(
      `${root}/${file}`,
      compactInternals(
        await readFile(resolve(directory, 'src', file.replace(/\.js$/, '.ts')), 'utf8'),
        await readFile(`${root}/${file}`, 'utf8'),
      ),
    );
  // Keep entry paths and identities intact, including the extension entry point: an import of one dist file by another
  // stays that import. It is resolved here to an id that names no file, because given the relative path itself the
  // bundler recognised the sibling entry on Linux and macOS (and bundled it behind a facade) but not on Windows, so
  // core + stage built to different bytes (KB-SIZE-PLATFORM2, tests/compact-package-order.test.js).
  const sibling = 'margo-sibling:',
    distRoot = real(root),
    isSibling = (id, importer) => id.startsWith('.') && real(dirname(resolve(dirname(importer), id))) === distRoot;
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    plugins: [
      {
        name: 'margo-sibling-entries',
        enforce: 'pre',
        resolveId: (id, importer) =>
          importer && isSibling(id, importer) ? { id: sibling + id.slice(2), external: true } : null,
      },
    ],
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: {
        entry: Object.fromEntries(files.map((file) => [file.slice(0, -3), `${root}/${file}`])),
        formats: ['es'],
        fileName: (_, name) => `${name}.js`,
      },
      rollupOptions: {
        external: (id, importer) =>
          !!importer &&
          !id.startsWith(sibling) &&
          !isSibling(id, importer) &&
          ((name !== 'stage' && name !== 'core') || !isShared(resolve(dirname(importer), id))),
        output: {
          ...compactOutput,
          comments: { annotation: true },
          paths: (id) => (id.startsWith(sibling) ? `./${id.slice(sibling.length)}` : id),
        },
      },
    },
  });
  const chunks = output[0].output;
  for (const file of files)
    assert.ok(
      chunks.some((chunk) => chunk.fileName === file && chunk.isEntry),
      `Missing library entry: ${file}`,
    );
  // Bundling shared helpers can emit additional chunks; they belong in the package too.
  for (const chunk of chunks) {
    assert.equal(chunk.type, 'chunk');
    assert.equal(dirname(resolve(root, chunk.fileName)), root, 'Library chunk escaped dist');
    assert.ok(chunk.fileName.endsWith('.js'), 'Unexpected library chunk');
    await writeFile(`${root}/${chunk.fileName}`, chunk.code);
  }
}
