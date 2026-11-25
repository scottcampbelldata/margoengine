// KB-SIZE-PLATFORM1: core + stage must build to the same bytes on every machine. compactPackage bundles a package's
// files as one multi-entry library build, and the entry order decides how the bundler splits and orders the shared
// chunks, so a build that took the directory listing's order changed the bytes from one file system to another.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compactPackage } from '../scripts/compact-package.js';

const root = resolve(import.meta.dirname, '..');

/** tsc's output for a package, as build-modern hands it to compactPackage. */
function emit(name, out) {
  const config = join(out, '..', `${name}.tsconfig.json`);
  writeFileSync(
    config,
    JSON.stringify({
      extends: resolve(root, `packages/${name}/tsconfig.json`),
      compilerOptions: { outDir: out, declaration: false, declarationMap: false, sourceMap: false },
    }),
  );
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', config], {
    stdio: 'pipe',
    timeout: 120_000,
  });
}

const files = (dir) =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith('.js'))
      .sort()
      .map((file) => [file, readFileSync(join(dir, file), 'utf8')]),
  );

for (const name of ['core', 'stage'])
  test(`${name} compacts to the same bytes whatever order the file system lists its files in`, {
    timeout: 180_000,
  }, async () => {
    const temp = mkdtempSync(join(tmpdir(), `compact-order-${name}-`));
    try {
      const sorted = join(temp, 'sorted'),
        reversed = join(temp, 'reversed');
      emit(name, sorted);
      emit(name, reversed);
      const listed = async (dir) => (await readdir(dir)).sort();
      await compactPackage(name, resolve(root, `packages/${name}`), sorted, { list: listed });
      await compactPackage(name, resolve(root, `packages/${name}`), reversed, {
        list: async (dir) => (await listed(dir)).reverse(),
      });
      const a = files(sorted),
        b = files(reversed);
      assert.ok(Object.keys(a).length > 5, 'the package emitted its files');
      assert.deepEqual(Object.keys(b), Object.keys(a), 'the same chunk names');
      for (const file of Object.keys(a)) assert.equal(b[file], a[file], `${file}: the same bytes`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

// KB-SIZE-PLATFORM2: on Linux and macOS the bundler took an entry's import of a sibling entry into its own graph and
// moved the sibling's code into a hashed chunk behind a facade; Windows left the import alone, so core + stage differed
// by 12 B between the machines. An import between entries stays that import on every platform.
for (const name of ['core', 'stage'])
  test(`${name} keeps each entry's code in its own file and its imports of other entries as written`, {
    timeout: 180_000,
  }, async () => {
    const temp = mkdtempSync(join(tmpdir(), `compact-siblings-${name}-`));
    try {
      const out = join(temp, 'dist');
      emit(name, out);
      const emitted = files(out);
      await compactPackage(name, resolve(root, `packages/${name}`), out);
      const built = files(out),
        entries = Object.keys(emitted);
      for (const entry of entries) {
        const stem = entry.slice(0, -3),
          facade = Object.keys(built).find((file) => new RegExp(`^${stem}-[\w-]{8}\.js$`).test(file));
        assert.equal(facade, undefined, `${entry} was moved into ${facade}`);
        for (const [, sibling] of emitted[entry].matchAll(/^import [^;]*?from '\.\/([\w-]+\.js)';/gm))
          assert.ok(built[entry].includes(`"./${sibling}"`), `${entry} still imports ./${sibling}`);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
