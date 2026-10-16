import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';
import { compactInternals } from './compact-internals.js';
import { compactOutput } from './measure-size.js';

export async function compactPackage(name, directory = `packages/${name}`) {
  const root = resolve(directory, 'dist'),
    shared = resolve(directory, '../shared/mesh-source.js'),
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
        external: (id, importer) => !!importer && (name !== 'margoengine' || resolve(dirname(importer), id) !== shared),
        output: compactOutput,
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
