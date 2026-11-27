// Wide glTF points and lines: a POINTS or LINES primitive that asks for a width (primitive extras `lineWidth` or
// `pointSize`, as @margoengine/exporters writes them, or a BENTLEY_materials_line_style or _point_style material, as
// CesiumJS reads them) is drawn by @margoengine/lines or @margoengine/points at that width, following its node; the rest
// keep the 1 px glTF 2.0 section 3.7.2.1 recommends. Before 2026-11-27 every one of them drew 1 px wide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF, parseGLTFAsync } from '../dist/pbr.js';
import { wideStrokes } from '../dist/strokes.js';
import { sceneScope } from '../../shared/scene-scope.js';

/** A GLB whose one node holds: a 4 px strip, a world-unit line list with _WIDTH, Bentley points, a plain loop and a triangle. */
function strokesGLB({ skinned = false } = {}) {
  const floats = [
      // 0: strip, 3 points
      [0, 0, 0, 1, 0, 0, 1, 1, 0],
      // 1: line list, 4 points
      [0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
      // 2: _WIDTH of the line list
      [1, 2, 1, 0.5],
      // 3: points, 3
      [0, 2, 0, 1, 2, 0, 2, 2, 0],
      // 4: loop, 4 points
      [0, 3, 0, 1, 3, 0, 1, 4, 0, 0, 4, 0],
      // 5: triangle
      [0, 0, -1, 1, 0, -1, 0, 1, -1],
    ],
    types = ['VEC3', 'VEC3', 'SCALAR', 'VEC3', 'VEC3', 'VEC3'],
    width = { VEC3: 3, SCALAR: 1 },
    bin = new Float32Array(floats.flat()),
    bufferViews = [],
    accessors = [];
  let offset = 0;
  floats.forEach((values, i) => {
    bufferViews.push({ buffer: 0, byteOffset: offset * 4, byteLength: values.length * 4 });
    const count = values.length / width[types[i]],
      bounds =
        types[i] === 'VEC3'
          ? {
              min: [0, 1, 2].map((k) => Math.min(...values.filter((_, j) => j % 3 === k))),
              max: [0, 1, 2].map((k) => Math.max(...values.filter((_, j) => j % 3 === k))),
            }
          : {};
    accessors.push({ bufferView: i, componentType: 5126, count, type: types[i], ...bounds });
    offset += values.length;
  });
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_materials_unlit', 'BENTLEY_materials_point_style'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Strokes', mesh: 0, translation: [0, 0, 5] }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, mode: 3, material: 0, extras: { lineWidth: 4, lineWidthUnits: 'pixels' } },
          {
            attributes: { POSITION: 1, _WIDTH: 2 },
            mode: 1,
            material: 1,
            extras: { lineWidth: 0.1, lineWidthUnits: 'world' },
          },
          { attributes: { POSITION: 3 }, mode: 0, material: 2 },
          { attributes: { POSITION: 4 }, mode: 2, material: 0 },
          { attributes: { POSITION: 5 }, mode: 4 },
        ],
      },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] }, extensions: { KHR_materials_unlit: {} } },
      { pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 0.5] }, alphaMode: 'BLEND' },
      {
        pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] },
        extensions: { BENTLEY_materials_point_style: { diameter: 6 } },
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };
  if (skinned) {
    doc.nodes.push({ name: 'Joint' });
    doc.scenes[0].nodes.push(1);
    doc.nodes[0].skin = 0;
    doc.skins = [{ joints: [1] }];
  }
  let json = new TextEncoder().encode(JSON.stringify(doc));
  json = Uint8Array.from([...json, ...Array((4 - (json.length % 4)) % 4).fill(0x20)]);
  const bytes = new Uint8Array(bin.buffer),
    glb = new Uint8Array(12 + 8 + json.length + 8 + bytes.length),
    view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.length, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(json, 20);
  view.setUint32(20 + json.length, bytes.length, true);
  view.setUint32(24 + json.length, 0x004e4942, true);
  glb.set(bytes, 28 + json.length);
  return glb.buffer;
}

async function engine() {
  const gpu = mockGPU(),
    store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  // A 128 x 128 target shown 64 CSS pixels wide: two target pixels a CSS pixel.
  return new Engine(
    { width: 128, height: 128, clientWidth: 64, clientHeight: 64 },
    store,
    renderer,
    { position: [0, 5, 10], target: [0, 0, 0] },
    null,
  );
}

test('parseGLTFAsync draws primitives that ask for a width with the lines and points plugins, the rest 1 px', async () => {
  const instance = await engine(),
    model = await parseGLTFAsync(instance, strokesGLB()),
    node = model.nodes[0],
    lines = instance.plugins.get('gltf-lines'),
    points = instance.plugins.get('gltf-points');
  assert.deepEqual(
    model.pointsAndLines.map((p) => [p.definition.mode, !!p.widened]),
    [
      [3, true],
      [1, true],
      [0, true],
      [2, false],
    ],
  );
  const [strip, list] = [...lines.lines];
  // The strip stays one polyline, so its join draws; the list stays segments.
  assert.equal(strip.mode, 'strip');
  assert.equal(strip.count, 3);
  assert.equal(strip.material.width, 4);
  assert.equal(strip.material.worldUnits, false);
  assert.deepEqual(Array.from(strip.material.color), [1, 0, 0]);
  assert.equal(strip.attachedMesh, node);
  assert.equal(list.mode, 'segments');
  assert.equal(list.count, 4);
  assert.equal(list.material.width, 0.1);
  assert.equal(list.material.worldUnits, true);
  assert.equal(list.material.opacity, 0.5, 'BLEND keeps the base alpha');
  assert.deepEqual(Array.from(list.widths), [1, 2, 1, 0.5], '_WIDTH multiplies the width');
  const [cloud] = [...points.pointClouds];
  assert.equal(cloud.count, 3);
  assert.equal(cloud.material.size, 6);
  assert.equal(cloud.material.sizeUnits, 'pixels');
  assert.equal(cloud.material.shape, 'round', 'a Bentley point is a disc');
  assert.equal(cloud.material.shading, 'sphere', 'a lit point material shades as a sphere');
  assert.equal(cloud.attachedMesh, node);
  // CSS pixels are the plugin's own unit (@margoengine/points tests/pixel-scale.test.js), so the file needs no override.
  assert.equal(points.pixelScale, undefined);
  model.dispose();
  assert.equal(instance.plugins.has('gltf-lines'), false, 'the last model gone takes the plugins with it');
  assert.equal(instance.plugins.has('gltf-points'), false);
});

test('decoders.strokes false, synchronous parseGLTF and a skinned node keep the 1 px draw', async () => {
  for (const load of [
    async (e) => parseGLTFAsync(e, strokesGLB(), { decoders: { strokes: false } }),
    async (e) => parseGLTF(e, strokesGLB()),
    async (e) => parseGLTFAsync(e, strokesGLB({ skinned: true })),
  ]) {
    const instance = await engine(),
      model = await load(instance);
    assert.deepEqual(
      model.pointsAndLines.map((p) => !!p.widened),
      [false, false, false, false],
    );
    assert.equal(instance.plugins.has('gltf-lines'), false);
    model.dispose();
  }
});

test('parseGLTF draws wide with decoders.strokes passed, and two models share the plugins', async () => {
  const instance = await engine(),
    a = await parseGLTFAsync(instance, strokesGLB()),
    b = parseGLTF(instance, strokesGLB(), [], [], { strokes: wideStrokes });
  await b.attachStrokes();
  assert.equal(instance.plugins.get('gltf-lines').lines.size, 4);
  a.dispose();
  assert.equal(instance.plugins.get('gltf-lines').lines.size, 2, "the other model's lines stay");
  b.dispose();
  assert.equal(instance.plugins.has('gltf-lines'), false);
});

test('a model loaded into a second scene takes its plugins out of that scene, whichever scene is active', async () => {
  const instance = await engine(),
    other = instance.createScene('other'),
    model = await sceneScope(instance, other).run(() => parseGLTFAsync(instance, strokesGLB()));
  assert.equal(other.plugins.has('gltf-lines'), true, 'the plugins joined the model scene');
  assert.equal(instance.plugins.has('gltf-lines'), false, 'and not the active one');
  model.dispose();
  assert.equal(other.plugins.has('gltf-lines'), false, 'the last model gone takes the lines plugin from its scene');
  assert.equal(other.plugins.has('gltf-points'), false);
});

test('a width that is not a positive number with known units is not read', async () => {
  const { strokeWidth } = await import('../dist/strokes.js');
  const doc = { materials: [{ extensions: { BENTLEY_materials_line_style: { width: 3 } } }] },
    line = (extras, material) => strokeWidth(doc, { mode: 1, extras, material });
  assert.deepEqual(line({ lineWidth: 2 }), { kind: 'lines', size: 2, units: 'pixels', bentley: false });
  assert.deepEqual(line({ lineWidth: 0.2, lineWidthUnits: 'world' }), {
    kind: 'lines',
    size: 0.2,
    units: 'world',
    bentley: false,
  });
  for (const extras of [{ lineWidth: -1 }, { lineWidth: '2' }, { lineWidth: 2, lineWidthUnits: 'mm' }, 'text'])
    assert.equal(line(extras), undefined, JSON.stringify(extras));
  assert.deepEqual(line({ lineWidth: 0 }, 0), { kind: 'lines', size: 3, units: 'pixels', bentley: true });
  assert.equal(strokeWidth(doc, { mode: 4, extras: { lineWidth: 2 } }), undefined, 'triangles have no width');
});

test('a malformed line style extra keeps the Line default; the good ones beside it are drawn', async () => {
  const instance = await engine(),
    positions = new Float32Array([0, 0, 0, 1, 0, 0]),
    doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 24 }],
      bufferViews: [{ buffer: 0, byteLength: 24 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 0] }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0 },
              mode: 1,
              extras: {
                lineWidth: 5,
                lineJoin: 'sharp',
                lineCap: 'butt',
                lineMiterLimit: 0.5,
                lineDepthBias: 2,
                lineOnTop: 'yes',
                lineDash: [0, 1],
              },
            },
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    },
    model = await parseGLTFAsync(instance, doc, [positions]),
    [{ material }] = instance.plugins.get('gltf-lines').lines;
  assert.deepEqual(
    [material.cap, material.join, material.miterLimit, material.depthBias, material.onTop, material.dashed],
    ['butt', 'round', 4, 0, false, false],
  );
  model.dispose();
});
