// A plugin leaves the scene it was attached to, never the active one: the class check behind `npm run hygiene`
// (scripts/support/plugin-scene-owner.mjs) and the sites it found (docs/integration-fixtures.md, "Scene owner").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { OPEN, engineRemovals, pluginSceneOwnerFindings } from '../scripts/support/plugin-scene-owner.mjs';

const root = resolve(import.meta.dirname, '..');

test('self-test: every one-argument removePlugin on an engine is found, scene-owned forms are not', () => {
  const wrong = [
    'this.engine?.removePlugin(this.name)',
    'this.engine.removePlugin(this.name)',
    'this.#engine?.removePlugin(this.name)',
    'engine.removePlugin(name)',
    'engine?.removePlugin(`${this.name}-points`)',
    'this.runtime?.removePlugin(this.name)',
    'this.mesh.root.engine.removePlugin(this.name)',
    'figure.engine.removePlugin("x")',
    '(this.engine as Engine).removePlugin(this.name)',
    'this.engine!.removePlugin(this.name)',
    // An opt-out needs the exact marker and a reason, on the line just above.
    '// scene-owner: active scene on purpose\nengine.removePlugin(name)',
    '// scene-owner: active scene on purpose, the stage plugin lives there\n\nengine.removePlugin(name)',
    '// active scene on purpose, no marker\nengine.removePlugin(name)',
  ];
  const right = [
    'this.engine?.sceneOf(this)?.removePlugin(this.name)',
    'this.#engine?.sceneOf(this)?.removePlugin(this.name)',
    'engine.sceneOf(plugin)?.removePlugin(name)',
    'engine.removePlugin(name, scene)',
    'scene.removePlugin(name)',
    'this.scene.removePlugin(this.pluginName)',
    'owner.removePlugin(name)',
    'engine.scene.removePlugin("margoengine-controls")',
    '// engine.removePlugin(name) in a comment',
    '/** `engine.removePlugin(pass.name)` calls it. */',
    "const text = 'engine.removePlugin(name)';",
    '// scene-owner: active scene on purpose, the stage plugin lives there\nengine.removePlugin(name)',
    '  // scene-owner: active scene on purpose, same call as the attach\n  engine.removePlugin(name)',
  ];
  for (const call of wrong) {
    const found = engineRemovals(`class A { dispose() {\n${call};\n} }`);
    assert.equal(found.length, 1, `must be found: ${call}`);
  }
  for (const call of right)
    assert.deepEqual(engineRemovals(`class A { dispose() {\n${call};\n} }`), [], `must pass: ${call}`);
  assert.deepEqual(
    engineRemovals('a();\nb();\nthis.engine?.removePlugin(this.name);\n').map((f) => f.line),
    [3],
    'findings carry their line',
  );
});

test('no package source removes a plugin from the active scene instead of its own', () => {
  assert.deepEqual(pluginSceneOwnerFindings(root), []);
});

test('open sites pass only by file and exact call; a listed site that is gone fails', () => {
  const site = OPEN[0];
  // The same call text in another file, or another call in a listed file, is a finding.
  const moved = [{ ...site, file: 'packages/physics/src/other.ts' }, ...OPEN.slice(1)];
  const findings = pluginSceneOwnerFindings(root, moved);
  assert.ok(findings.some((f) => f.startsWith(`${site.file}:`) && f.endsWith(site.call)), findings.join('\n'));
  assert.ok(findings.some((f) => f.includes('packages/physics/src/other.ts: listed open site')), findings.join('\n'));
  const stale = [...OPEN, { file: site.file, call: 'engine.removePlugin(gone)', bug: site.bug }];
  assert.deepEqual(pluginSceneOwnerFindings(root, stale), [
    `${site.file}: listed open site "engine.removePlugin(gone)" is gone; drop it from OPEN`,
  ]);
});

test('hygiene runs the check and every open site cites its known-bugs entry', () => {
  assert.match(readFileSync(resolve(root, 'scripts/hygiene.js'), 'utf8'), /assertPluginsLeaveOwnScene\(root\);/);
  const bugs = readFileSync(resolve(root, 'docs/known-bugs.md'), 'utf8');
  assert.ok(OPEN.length > 0);
  for (const { file, call, bug } of OPEN) {
    assert.match(file, /^packages\/(physics|physics2d|ragdoll|sciviz)\/src\/[\w/-]+\.ts$/, 'only physics and sciviz may stay open');
    assert.ok(call.includes('removePlugin('), file);
    const id = /"(plugin scene owner \((?:physics|sciviz)\))"/.exec(bug)?.[1];
    assert.ok(id && bugs.includes(`### ${id}`), `${file}: docs/known-bugs.md needs the "${id}" entry it cites`);
    assert.ok(bugs.includes(file.replace(/^packages\//, '')), `${file} is named in docs/known-bugs.md`);
  }
});

// The sites list 5 batch I1 fixed with the check (main's lane E fixed creative, labels, points, tiles, lod/auto,
// materials batched and nodes, rigging, usdz, gltf/pbr, mcp, scatter and html before it), each now detaching from its
// own scene. A site that goes back to the active-scene form fails the test above; this list keeps the count honest if
// a file moves.
const FIXED = {
  clustered: ['area-texture', 'area', 'contact', 'directional', 'ies', 'index', 'layers', 'projector', 'shadows', 'shapes', 'stochastic'],
  lighting2d: ['cookie', 'emissive', 'gi', 'height', 'soft'],
  materials: ['stencil-buffer'],
  sky: ['night-backdrop'],
  selection: ['picking'],
  shadows: ['index', 'virtual'],
  tilemap: ['iso', 'objects', 'renderer'],
  toon: ['hatch', 'index', 'models'],
  vfx: ['base'],
  'voxel-pathtracer': ['tracer'],
  voxel: ['render', 'stream'],
  weather: ['drive', 'hail', 'scene-patch'],
};
test('each site fixed with the check removes its plugin through the scene it joined', () => {
  for (const [pkg, files] of Object.entries(FIXED))
    for (const file of files) {
      const path = `packages/${pkg}/src/${file}.ts`;
      const source = readFileSync(resolve(root, path), 'utf8');
      assert.deepEqual(engineRemovals(source, path), [], path);
      assert.match(source, /sceneOf(\?\.)?\(/,`${path} detaches through its scene`);
    }
});
