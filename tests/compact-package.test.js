import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { compactPackage } from '../scripts/compact-package.js';

test('stage compaction packages shared chunks and preserves module identities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'margo-compact-')),
    stage = join(root, 'packages/margoengine'),
    dist = join(stage, 'dist'),
    shared = join(root, 'packages/shared');
  t.after(() => rm(root, { recursive: true, force: true }));
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

  await compactPackage('margoengine', stage);

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
});
