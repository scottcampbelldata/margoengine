import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { compactPackage } from '../scripts/compact-package.js';

test('stage compaction packages shared chunks and preserves module identities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'margo-compact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await stageCompaction(root);
});

// macOS os.tmpdir() is /var/folders/..., a link to /private/var/folders/..., and the bundler names importers by their
// real path. An explicit link puts the same split on any system.
test('stage compaction finds the shared helpers when the checkout is reached through a symlink', async (t) => {
  // The link lives in test-results/, not in the temp folder: Windows 11 (build 26300) refuses to make a folder through
  // a junction that sits in the temp folder (EEXIST or ENOENT), whatever it points at, and allows it elsewhere.
  const links = resolve(import.meta.dirname, '../test-results');
  await mkdir(links, { recursive: true });
  const real = await mkdtemp(join(tmpdir(), 'margo-compact-real-')),
    holder = await mkdtemp(join(links, 'margo-compact-link-')),
    root = join(holder, 'checkout');
  t.after(() => Promise.all([real, holder].map((dir) => rm(dir, { recursive: true, force: true }))));
  await symlink(real, root, 'junction');
  await stageCompaction(root);
});

async function stageCompaction(root) {
  const stage = join(root, 'packages/stage'),
    dist = join(stage, 'dist'),
    shared = join(root, 'packages/shared');
  await Promise.all([
    mkdir(dist, { recursive: true }),
    mkdir(join(stage, 'src'), { recursive: true }),
    mkdir(shared, { recursive: true }),
  ]);
  await writeFile(join(stage, 'package.json'), '{"type":"module"}');
  const helper = 'export const registry = new WeakMap(); export const lookup = mesh => registry.get(mesh);';
  await writeFile(join(shared, 'mesh-source.js'), helper);
  const modules = {
    index:
      "import {registry} from '../../shared/mesh-source.js'; export {lookup} from './model.js'; export const register = (mesh, value) => registry.set(mesh, value);",
    model: "import {lookup} from '../../shared/mesh-source.js'; export {lookup};",
  };
  for (const [name, code] of Object.entries(modules))
    await Promise.all([writeFile(join(stage, `src/${name}.ts`), code), writeFile(join(dist, `${name}.js`), code)]);

  await compactPackage('stage', stage);

  const files = await readdir(dist);
  assert.ok(files.includes('index.js') && files.includes('model.js'));
  assert.ok(files.length > 2, 'the shared helper must exercise a generated chunk');
  for (const file of files) {
    const code = await readFile(join(dist, file), 'utf8');
    for (const [, spec] of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(dist, file)), spec);
      assert.ok(!relative(dist, target).startsWith('..'), `${file} imports outside dist: ${spec}`);
      await readFile(target);
    }
  }
  // A packed consumer has neither the shared source directory nor the TS sources.
  await rm(shared, { recursive: true });
  await rm(join(stage, 'src'), { recursive: true });
  const entry = await import(pathToFileURL(join(dist, 'index.js')).href),
    model = await import(pathToFileURL(join(dist, 'model.js')).href),
    mesh = {};
  entry.register(mesh, 'triangles');
  assert.equal(model.lookup(mesh), 'triangles');
  assert.equal(entry.lookup, model.lookup);
}

test('core compaction ships the canonical clear helper without requiring sibling checkout files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'margo-core-clear-')),
    core = join(root, 'packages/core'),
    dist = join(core, 'dist'),
    shared = join(root, 'packages/shared');
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(dist, { recursive: true }),
    mkdir(join(core, 'src'), { recursive: true }),
    mkdir(shared, { recursive: true }),
  ]);
  await writeFile(join(core, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(shared, 'clear-color.js'),
    await readFile(new URL('../packages/shared/clear-color.js', import.meta.url)),
  );
  const modules = {
    index: "export {clearColorValue, defaultClear} from './renderer.js';",
    renderer: "export {clearColorValue, defaultClear} from '../../shared/clear-color.js';",
  };
  for (const [name, code] of Object.entries(modules))
    await Promise.all([writeFile(join(core, `src/${name}.ts`), code), writeFile(join(dist, `${name}.js`), code)]);
  await compactPackage('core', core);
  for (const file of await readdir(dist)) {
    const code = await readFile(join(dist, file), 'utf8');
    for (const [, spec] of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(dist, file)), spec);
      assert.ok(!relative(dist, target).startsWith('..'), `${file} imports outside dist: ${spec}`);
      await readFile(target);
    }
  }
  await rm(shared, { recursive: true });
  await rm(join(core, 'src'), { recursive: true });
  const entry = await import(pathToFileURL(join(dist, 'index.js')).href),
    renderer = await import(pathToFileURL(join(dist, 'renderer.js')).href);
  assert.equal(entry.clearColorValue, renderer.clearColorValue);
  assert.equal(entry.defaultClear, renderer.defaultClear);
  assert.equal(entry.clearColorValue(undefined), entry.defaultClear);
  assert.deepEqual(entry.defaultClear, [0.018, 0.023, 0.035, 1]);
  assert.deepEqual(entry.clearColorValue('#2a6cba'), [42 / 255, 108 / 255, 186 / 255, 1]);
  assert.throws(() => entry.clearColorValue('bad'), { name: 'RangeError', message: 'Invalid color; use #rrggbb' });
});
