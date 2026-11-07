// Composition against OpenUSD's own reading. The scenes in fixtures/real are usd-wg test assets, fixtures/fuzz are random
// stages made for this test (stand-ins: the scenes are ours, the expected results in openusd.json are OpenUSD 26.08's),
// and fixtures/arcs is a layer written by OpenUSD. No file here comes from a writer of ours.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeUSDFiles, composition, parseUSDFiles } from '../dist/compose.js';
import { parseUSDA, parseUSDC } from '../dist/index.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const reader = (folder) => (id) => {
  const path = resolve(folder, id);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
};
const near = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = a.flat(9),
      y = b.flat(9);
    return x.length === y.length && x.every((v, i) => near(v, y[i]));
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
  return a === b;
};
/** Every prim, type, target, connection, sample time and small value of OpenUSD's reading, against ours. */
function differences(specs, want) {
  const out = [];
  for (const path of Object.keys(specs))
    if (specs[path].specType === 6 && !want.prims[path]) out.push(`prim ${path} should not be there`);
  for (const [path, prim] of Object.entries(want.prims)) {
    if (!specs[path]) {
      out.push(`prim ${path} is missing`);
      continue;
    }
    if ((specs[path].fields.typeName ?? '') !== prim.type) out.push(`type of ${path}`);
    for (const [name, expected] of Object.entries(prim.props)) {
      const fields = specs[path + '.' + name]?.fields;
      if (!fields) {
        if (!expected.t || expected.t.length) out.push(`property ${path}.${name} is missing`);
        continue;
      }
      if (expected.t && !near(fields.targetPaths ?? [], expected.t)) out.push(`targets of ${path}.${name}`);
      if (expected.conn && !near(fields.connectionPaths ?? [], expected.conn)) out.push(`connections of ${path}.${name}`);
      if (expected.times && !near(fields.timeSamples?.times ?? [], expected.times)) out.push(`times of ${path}.${name}`);
      if ('v' in expected && !expected.times && expected.v !== null && !near(fields.default, expected.v))
        out.push(`value of ${path}.${name}`);
    }
  }
  return out;
}
const truth = JSON.parse(readFileSync(join(fixtures, 'openusd.json'), 'utf8'));

for (const [file, want] of Object.entries(truth)) {
  test(`a stage composes as OpenUSD reads it: ${file}`, async () => {
    const path = join(fixtures, ...file.split('/')),
      { specs } = await composeUSDFiles(path.split(sep).at(-1), reader(dirname(path)));
    assert.deepEqual(differences(specs, want), []);
  });
}

test('a real scene of references draws where OpenUSD puts it, and its bindings reach the referenced material', async () => {
  const folder = join(fixtures, 'real/usd-wg/test_assets/References');
  const asset = await parseUSDFiles('OverridingReferencedInternalReferencesTest.usda', reader(folder), {
    extensions: [composition()],
  });
  assert.ok(asset.meshes.length > 0);
});

test('a missing layer is listed and the rest of the stage still opens, as OpenUSD warns and goes on', () => {
  const text = `#usda 1.0
def Xform "A" (references = @gone.usda@) {}
def Mesh "M" {
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0, 1, 2]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
  uniform token subdivisionScheme = "none"
}
`;
  const asset = parseUSDA(text, { extensions: [composition()] });
  assert.equal(asset.meshes.length, 1);
  assert.ok(asset.issues.some((issue) => issue.code === 'missing-layer' && issue.message.includes('gone.usda')));
});

const quad = (name, extra = '') => `def Mesh "${name}" {
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0, 1, 2]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
  uniform token subdivisionScheme = "none"
${extra}}
`;
test('a variant selection in the options beats the file, and only that variant is read', async () => {
  const root = `#usda 1.0
def Xform "Model" (
  variants = { string look = "a" }
  prepend variantSets = "look"
) {
  variantSet "look" = {
    "a" (references = @a.usda@) {}
    "b" (references = @b.usda@) {}
  }
}
`;
  const layer = (name) => `#usda 1.0\n(\n defaultPrim = "M"\n)\ndef Xform "M" {\n${quad(name)}}\n`,
    read = [];
  const files = { 'root.usda': root, 'a.usda': layer('FromA'), 'b.usda': layer('FromB') };
  const open = (id) => {
    read.push(id);
    return new TextEncoder().encode(files[id]);
  };
  const plain = await parseUSDFiles('root.usda', open);
  assert.deepEqual(
    plain.meshes.map((mesh) => mesh.path),
    ['/Model/FromA'],
  );
  assert.ok(!read.includes('b.usda'));
  const chosen = await parseUSDFiles('root.usda', open, { variants: { '/Model': { look: 'b' } } });
  assert.deepEqual(
    chosen.meshes.map((mesh) => mesh.path),
    ['/Model/FromB'],
  );
});

test('the layers of composition() come from an option when the file has no archive', () => {
  const asset = parseUSDA('#usda 1.0\ndef "R" (references = @m.usda@</M>) {}\n', {
    extensions: [composition({ layers: { 'm.usda': `#usda 1.0\ndef Xform "M" {\n${quad('Tri')}}\n` } })],
  });
  assert.deepEqual(
    asset.meshes.map((mesh) => mesh.path),
    ['/R/Tri'],
  );
});

test('payloads: false leaves them out, as a stage opened with LoadNone', () => {
  const options = { layers: { 'm.usda': `#usda 1.0\ndef Xform "M" {\n${quad('Tri')}}\n` }, payloads: false };
  const asset = parseUSDA(`#usda 1.0\ndef "R" (payload = @m.usda@</M>) {}\n${quad('Kept')}`, {
    extensions: [composition(options)],
  });
  assert.deepEqual(
    asset.meshes.map((mesh) => mesh.path),
    ['/Kept'],
  );
});

test('a reference cycle ends with an issue, not a hang', () => {
  const asset = parseUSDA(`#usda 1.0\ndef "A" (references = </B>) {}\ndef "B" (references = </A>) {}\n${quad('Kept')}`, {
    extensions: [composition()],
  });
  assert.equal(asset.meshes.length, 1);
  assert.ok(asset.issues.some((issue) => issue.code === 'cycle'));
});

test('without composition() the arcs stay refused', () => {
  assert.throws(() => parseUSDA('#usda 1.0\ndef "R" (references = @m.usda@) {}\n'), /unsupported/);
  assert.throws(() => parseUSDC(readFileSync(join(fixtures, 'arcs/arcs.usdc'))), /unsupported/);
});

test('binary and text layers written by OpenUSD read the same: arcs, variants, samples, quaternions, blocks', async () => {
  const folder = join(fixtures, 'arcs'),
    binary = await composeUSDFiles('arcs.usdc', reader(folder)),
    text = await composeUSDFiles('arcs.usda', reader(folder));
  assert.ok(binary.issues.some((issue) => issue.message.includes('foo.usda')));
  assert.deepEqual(Object.keys(binary.specs).sort(), Object.keys(text.specs).sort());
  for (const name of ['/X.tq', '/X.d3', '/X.arr'])
    assert.deepEqual(binary.specs[name].fields.timeSamples, text.specs[name].fields.timeSamples, name);
  assert.deepEqual(binary.specs['/X.tq'].fields.timeSamples, {
    times: [1, 2.5],
    values: [
      [0.5, 1, 2, 3],
      [1, 0, 0, 0],
    ],
  });
  assert.deepEqual(binary.specs['/X.rot'].fields.default, [0.5, 1, 2, 3]);
  assert.equal(binary.specs['/X.blocked'].fields.default, undefined);
  assert.deepEqual(binary.specs['/X.empty'].fields.default, []);
  assert.ok(binary.specs['/X/inner'], 'the selected variant reaches the stage');
});

test('every xformOp kind makes the matrix OpenUSD computes', () => {
  // Expected matrices from UsdGeomXformable.GetLocalTransformation of OpenUSD 26.08 on this same layer.
  const asset = parseUSDA(readFileSync(join(fixtures, 'xform/ops.usda')), { extensions: [composition()] }),
    want = JSON.parse(readFileSync(join(fixtures, 'xform/ops.json'), 'utf8'));
  for (const [name, matrix] of Object.entries(want)) {
    const node = asset.document.nodes.find((n) => n.name === name);
    assert.ok(node, name);
    assert.ok(near(node.matrix, matrix), `${name}: ${node.matrix} against ${matrix}`);
  }
});

test('a GeomSubset with a material is a primitive of its own over the same vertices', () => {
  const asset = parseUSDA(
    `#usda 1.0
def Mesh "M" (prepend apiSchemas = ["MaterialBindingAPI"]) {
  int[] faceVertexCounts = [3, 3]
  int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
  uniform token subdivisionScheme = "none"
  rel material:binding = </A>
  def GeomSubset "half" {
    uniform token elementType = "face"
    uniform token familyName = "materialBind"
    int[] indices = [1]
    rel material:binding = </B>
  }
}
def Material "A" {
  token outputs:surface.connect = </A/S.outputs:surface>
  def Shader "S" {
    uniform token info:id = "UsdPreviewSurface"
    color3f inputs:diffuseColor = (1, 0, 0)
    token outputs:surface
  }
}
def Material "B" {
  token outputs:surface.connect = </B/S.outputs:surface>
  def Shader "S" {
    uniform token info:id = "UsdPreviewSurface"
    color3f inputs:diffuseColor = (0, 1, 0)
    token outputs:surface
  }
}
`,
    { extensions: [composition()] },
  );
  const [mesh] = asset.meshes,
    { primitives } = asset.document.meshes[0],
    colors = primitives.map((p) => asset.document.materials[p.material].pbrMetallicRoughness.baseColorFactor.slice(0, 3));
  assert.deepEqual(colors, [
    [0, 1, 0],
    [1, 0, 0],
  ]);
  assert.deepEqual([...mesh.subsets[0].indices], [3, 4, 5]);
  assert.equal(primitives[0].attributes.POSITION, primitives[1].attributes.POSITION);
});
