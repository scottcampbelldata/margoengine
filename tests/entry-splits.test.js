// Small entries split out of heavy package roots (docs/renames-2026-10-24.md): each serves the same bindings as its
// root, and loading it, or a consumer that switched to it, statically loads none of the heavy entries it used to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSync } from 'rolldown/utils';

const root = join(import.meta.dirname, '..');
const splits = [
  ['@margoengine/decoders/texture', '@margoengine/decoders'],
  ['@margoengine/gltf-pro/coordinates', '@margoengine/gltf-pro'],
  ['@margoengine/materials/atlas', '@margoengine/materials'],
  ['@margoengine/animation/sampling', '@margoengine/animation'],
  ['@margoengine/loaders/common', '@margoengine/loaders'],
  ['@margoengine/loaders/usd', '@margoengine/loaders'],
  ['@margoengine/geometry/shapes', '@margoengine/geometry'],
  ['@margoengine/geometry/primitives', '@margoengine/geometry'],
  ['@margoengine/geometry/utils', '@margoengine/geometry'],
];

/** Bare specifiers a dist file loads statically, following its relative imports (type-only imports are erased). */
function staticImports(file, seen = new Set(), out = new Set()) {
  if (seen.has(file) || !existsSync(file)) return out;
  seen.add(file);
  const { program } = parseSync(file, readFileSync(file, 'utf8'));
  for (const node of program.body) {
    if (!node.source || !/^(Import|ExportAll|ExportNamed)Declaration$/.test(node.type)) continue;
    const spec = node.source.value;
    if (spec.startsWith('.')) staticImports(join(dirname(file), spec), seen, out);
    else out.add(spec);
  }
  return out;
}
const dist = (pkg, entry) => join(root, 'packages', pkg, 'dist', entry + '.js');

for (const [sub, whole] of splits)
  test(`${sub} serves the same bindings as ${whole}`, async () => {
    const [part, all] = await Promise.all([import(sub), import(whole)]);
    assert.ok(Object.keys(part).length > 0);
    for (const [name, value] of Object.entries(part)) assert.equal(all[name], value, `${sub} ${name}`);
  });

test('the split entries load no other package beyond core and math', () => {
  for (const [sub] of splits) {
    const [, pkg, entry] = /^@margoengine\/([^/]+)\/(.+)$/.exec(sub);
    const foreign = [...staticImports(dist(pkg, entry))].filter((s) => !/^@margoengine\/(core|math)(\/|$)/.test(s));
    assert.deepEqual(foreign, [], sub);
  }
});

test('consumers load the split entries instead of the heavy roots', () => {
  for (const [file, heavy] of [
    [dist('gltf-pro', 'index'), '@margoengine/decoders'],
    [dist('materials', 'transmission'), '@margoengine/gltf-pro'],
    [dist('lightmap', 'index'), '@margoengine/materials'],
    [dist('animator', 'index'), '@margoengine/animation'],
    [dist('usdz', 'index'), '@margoengine/loaders'],
    [dist('usdz', 'worker'), '@margoengine/loaders'],
    [dist('usdz', 'worker'), '@margoengine/gltf-pro'],
    [dist('fbx', 'worker'), '@margoengine/gltf-pro'],
    [dist('fbx', 'worker'), '@margoengine/exporters'],
    [dist('ifc', 'index'), '@margoengine/loaders'],
    [dist('machinery', 'edges'), '@margoengine/geometry'],
    [dist('loaders', 'font'), '@margoengine/geometry'],
    [dist('loaders', 'svg'), '@margoengine/geometry'],
    [dist('procedural', 'index'), '@margoengine/geometry'],
    [dist('terrain', 'index'), '@margoengine/geometry'],
  ])
    assert.ok(!staticImports(file).has(heavy), `${file} loads ${heavy}`);
});

test('the split entries work on their own', async () => {
  const { getBytesPerRow, getSupportedTranscodeFormat } = await import('@margoengine/decoders/texture');
  assert.equal(getBytesPerRow('bc7-rgba-unorm', 10), 48);
  assert.equal(getSupportedTranscodeFormat({ features: new Set(['texture-compression-astc']) }), 'astc-4x4');
  const { textureCoordinates } = await import('@margoengine/gltf-pro/coordinates');
  assert.deepEqual(textureCoordinates({ texCoord: 1 }), { texCoord: 1 });
  const { packAtlas } = await import('@margoengine/materials/atlas');
  assert.equal(packAtlas([{ data: new Uint8Array(64), width: 4, height: 4 }]).regions.length, 1);
  const { sampleTrack } = await import('@margoengine/animation/sampling');
  assert.ok(sampleTrack);
  const { computeVertexNormals, LoaderError } = await import('@margoengine/loaders/common');
  assert.ok(new LoaderError('x', 'invalid') instanceof Error);
  assert.ok(computeVertexNormals);
  const { readUSDA } = await import('@margoengine/loaders/usd');
  assert.ok(readUSDA);
  const { boxGeometry } = await import('@margoengine/geometry/primitives');
  const { mergeGeometries } = await import('@margoengine/geometry/utils');
  const { triangulate } = await import('@margoengine/geometry/shapes');
  const box = boxGeometry();
  assert.equal(mergeGeometries([box, box]).positions.length, box.positions.length * 2);
  assert.equal(triangulate([0, 0, 1, 0, 0, 1]).length, 3);
});
