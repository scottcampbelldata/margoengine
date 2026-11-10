import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';
import { compactInternals } from './compact-internals.js';
import { compactOutput } from './measure-size.js';

// The bundler hands the importer over in real form (macOS os.tmpdir() is /var/folders/..., a link to
// /private/var/folders/...), so both sides of the shared-helper test are compared as real paths.
const real = (path) => (existsSync(path) ? realpathSync(path) : path);

export async function compactPackage(name, directory = `packages/${name}`) {
  const root = resolve(directory, 'dist'),
    // Every packages/shared helper core and the stage import is bundled into them (shared is not published, so a
    // ../../shared import left in dist breaks an installed package; tests/dts-self-contained.test.js). Everything else stays
    // an import. A fixed list once missed the stage's glTF route and lights helpers.
    sharedDir = real(resolve(directory, '../shared')),
    isShared = (path) => dirname(real(path)) === sharedDir,
    files = (await readdir(root)).filter((file) => file.endsWith('.js'));
  for (const file of files)
    await writeFile(
      `${root}/${file}`,
      compactInternals(
        await readFile(resolve(directory, 'src', file.replace(/\.js$/, '.ts')), 'utf8'),
        await readFile(`${root}/${file}`, 'utf8'),
      ),
    );
  // Keep entry paths and identities intact, including the extension entry point.
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
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
          ((name !== 'stage' && name !== 'core') || !isShared(resolve(dirname(importer), id))),
        output: { ...compactOutput, comments: { annotation: true } },
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
