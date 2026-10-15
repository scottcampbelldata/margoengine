// Raycaster against real gltf-pro PBRModels (helmet, skinned robot, a generated UV quad) and @margoengine/materials meshes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import {
  Raycaster,
  getPrimitiveBVH,
  hasPrimitiveBVH,
  setMeshLayers,
  engineModels,
  worldTriangles,
  MeshBVH,
} from '../dist/index.js';
import { rayTriangle } from '../dist/math.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { rng } from './reference.js';

const asset = (name) => readFileSync(new URL(`../../../examples/assets/${name}`, import.meta.url));
export function readGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    json = view.getUint32(12, true);
  return {
    doc: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + json))),
    binary: bytes.subarray(28 + json, 28 + json + view.getUint32(20 + json, true)),
  };
}
async function world(capacity = 1024) {
  const h = optionalGPU(),
    device = h.engine.gpu;
  device.queue.writeTexture = () => {};
  device.queue.copyExternalImageToTexture = () => {};
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(capacity),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const load = (bytes, use = true) => {
    const { doc, binary } = readGLB(bytes),
      model = new PBRModel(
        engine,
        new GLTFAsset(doc, [], binary),
        (doc.images ?? []).map(() => ({ width: 1, height: 1, close() {} })),
      );
    if (use) engine.use(model);
    return model;
  };
  return { h, engine, load };
}
/** A two-node glTF quad (-1..1 in XY, UV 0..1) under a translated, scaled and rotated parent; optional mirrored single-sided copy. */
function quadDoc({ doubleSided = true, mirror = false } = {}) {
  const data = [
    new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    new Uint32Array([0, 1, 2, 0, 2, 3]),
  ];
  const types = ['VEC3', 'VEC3', 'VEC2', 'SCALAR'],
    offsets = [],
    bytes = new Uint8Array(data.reduce((n, d) => n + d.byteLength, 0));
  let at = 0;
  for (const d of data) {
    offsets.push(at);
    bytes.set(new Uint8Array(d.buffer), at);
    at += d.byteLength;
  }
  return {
    doc: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bytes.length }],
      bufferViews: data.map((d, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: d.byteLength })),
      accessors: data.map((d, i) => ({
        bufferView: i,
        componentType: i === 3 ? 5125 : 5126,
        count: d.length / (i === 2 ? 2 : i === 3 ? 1 : 3),
        type: types[i],
      })),
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
      materials: [{ doubleSided }],
      nodes: [
        { children: [1], translation: [0.5, 0, -1], scale: [2, 2, 2] },
        { mesh: 0, rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)], scale: mirror ? [-1, 1, 1] : [1, 1, 1] },
      ],
    },
    buffers: [bytes],
  };
}
/** World-space brute force over every primitive triangle of a model, nearest hit. */
function brute(model, origin, direction) {
  const out = new Float64Array(4),
    w = new Float64Array(9);
  let best = null;
  for (const primitive of model.primitives) {
    const m = primitive.node.matrix,
      v = primitive.vertices,
      index = primitive.indices;
    for (let f = 0; f < index.length / 3; f++) {
      for (let k = 0; k < 3; k++) {
        const o = index[f * 3 + k] * 20;
        for (let r = 0; r < 3; r++) w[k * 3 + r] = m[r] * v[o] + m[4 + r] * v[o + 1] + m[8 + r] * v[o + 2] + m[12 + r];
      }
      if (
        rayTriangle(...origin, ...direction, ...w, 0, 0, best ? best.distance : Infinity, out) &&
        (!best || out[0] < best.distance)
      )
        best = { distance: out[0], primitive, faceIndex: f };
    }
  }
  return best;
}

test('Raycaster finds attached gltf-pro models, honours node transforms and matches brute force on the helmet', async () => {
  const { engine, load } = await world(),
    model = load(asset('damaged-helmet.glb')),
    raycaster = new Raycaster();
  model.root.setPosition([0.3, -0.2, 0.1]).setScale([1.5, 1.5, 1.5]).setRotation([0.3, 0.7, 0]);
  const core = engine.createMesh().setGeometry(box()).setPosition([0, 0, -5]);
  assert.deepEqual(engineModels(engine), [model]);
  const random = rng(5);
  let compared = 0,
    hits = 0;
  for (let i = 0; i < 120; i++) {
    const origin = [(random() * 2 - 1) * 4, (random() * 2 - 1) * 4, 4],
      target = [(random() * 2 - 1) * 1.6, (random() * 2 - 1) * 1.6, 0];
    const direction = target.map((v, k) => v - origin[k]),
      length = Math.hypot(...direction);
    raycaster.set(origin, direction);
    const found = raycaster.intersectEngine(engine).filter((h) => h.model),
      first = found[0];
    engine.store.tick(false);
    const reference = brute(
      model,
      origin,
      direction.map((v) => v / length),
    );
    assert.equal(!!first, !!reference, `ray ${i}`);
    compared++;
    if (!first) continue;
    hits++;
    assert.ok(
      Math.abs(first.distance - reference.distance) < 1e-4 * Math.max(1, reference.distance),
      `distance ${first.distance} vs ${reference.distance}`,
    );
    assert.equal(first.primitive, reference.primitive);
    assert.equal(first.model, model);
    assert.equal(first.mesh, first.primitive.node);
    assert.equal(first.primitiveIndex, model.primitives.indexOf(first.primitive));
    assert.equal(first.nodeIndex, first.primitive.nodeIndex);
    assert.ok(first.uv.every(Number.isFinite) && Math.abs(Math.hypot(...first.normal) - 1) < 1e-6);
    for (let k = 1; k < found.length; k++) assert.ok(found[k].distance >= found[k - 1].distance);
  }
  assert.ok(hits > 30 && hits < compared, ` ${hits} of ${compared} rays hit the helmet`);
  assert.ok(model.primitives.every((p) => hasPrimitiveBVH(p)));
  raycaster.set([0, 0, 10], [0, 0, -1]);
  assert.ok(
    raycaster.intersectEngine(engine).some((h) => h.mesh === core && !h.model),
    'core meshes still hit',
  );
  console.log(
    `helmet: ${model.primitives.reduce((n, p) => n + p.indices.length / 3, 0)} triangles, ${hits}/${compared} rays hit, all match brute force`,
  );
});

test('model hits report UV, front faces, materials sides, mirrored nodes, layers, filters, hidden and disposed models', async () => {
  const { engine } = await world(),
    make = (options) => {
      const { doc, buffers } = quadDoc(options),
        model = new PBRModel(engine, new GLTFAsset(doc, buffers));
      engine.use(model);
      return model;
    };
  const model = make(),
    raycaster = new Raycaster([0.5, 0.2, 5], [0, 0, -1]);
  // Parent: T(0.5,0,-1) S(2); child rotated 0.4 rad about Y. The ray along -Z through x=0.5 crosses the quad's vertical centre line.
  let [hit] = raycaster.intersectEngine(engine);
  assert.equal(raycaster.intersectEngine(engine).length, 1);
  assert.equal(hit.model, model);
  assert.equal(hit.mesh, model.nodes[1]);
  assert.equal(hit.nodeIndex, 1);
  assert.ok(Math.abs(hit.uv[0] - 0.5) < 1e-6 && Math.abs(hit.uv[1] - 0.55) < 1e-6, `${hit.uv}`);
  assert.ok(Math.abs(hit.point[2] + 1) < 1e-6 && hit.frontFace);
  raycaster.set([0.5 + 2 * Math.cos(0.4) * 0.5, 1, 5], [0, 0, -1]);
  [hit] = raycaster.intersectEngine(engine);
  assert.ok(Math.abs(hit.uv[0] - 0.75) < 1e-5 && Math.abs(hit.uv[1] - 0.75) < 1e-5, `uv ${hit.uv}`);
  // Back side: single-sided materials are skipped, double-sided ones are not; a mirrored node keeps its local front side.
  raycaster.set([0.5, 0.2, -5], [0, 0, 1]);
  assert.equal(raycaster.intersectEngine(engine)[0].frontFace, false);
  const single = make({ doubleSided: false }),
    mirrored = make({ doubleSided: false, mirror: true });
  single.root.setPosition([10, 0, 0]);
  mirrored.root.setPosition([20, 0, 0]);
  for (const [x, model, front] of [
    [10.5, single, true],
    [20.5, mirrored, true],
  ]) {
    raycaster.set([x, 0.2, 5], [0, 0, -1]);
    assert.equal(
      raycaster.intersectEngine(engine).some((h) => h.model === model),
      front,
      `${x} from +Z`,
    );
    raycaster.set([x, 0.2, -5], [0, 0, 1]);
    assert.equal(
      raycaster.intersectEngine(engine).some((h) => h.model === model),
      !front,
      `${x} from -Z`,
    );
  }
  raycaster.set([0.5, 0.2, 5], [0, 0, -1]);
  raycaster.layers = 1;
  setMeshLayers(model.root, 2);
  assert.equal(raycaster.intersectEngine(engine).length, 0, 'root layer');
  setMeshLayers(model.nodes[1], 1);
  assert.equal(raycaster.intersectEngine(engine).length, 1, 'node layer wins');
  setMeshLayers(model.nodes[1], 2);
  raycaster.layers = 2;
  assert.equal(raycaster.intersectEngine(engine).length, 1);
  raycaster.layers = 0xffffffff;
  raycaster.filter = (mesh, owner) => owner !== model;
  assert.equal(raycaster.intersectEngine(engine).length, 0, 'filter');
  raycaster.filter = null;
  model.root.visible = false;
  assert.equal(raycaster.intersectEngine(engine).length, 0, 'hidden root');
  model.root.visible = true;
  assert.equal(raycaster.intersectObjects(engine, [single]).length, 0, 'objects restrict the test');
  assert.equal(raycaster.intersectObjects(engine, [model])[0].model, model);
  raycaster.firstHitOnly = true;
  assert.equal(raycaster.intersectEngine(engine).length, 1);
  raycaster.firstHitOnly = false;
  model.dispose();
  assert.equal(raycaster.intersectEngine(engine).length, 0, 'disposed');
  assert.equal(raycaster.intersectObjects(engine, [model]).length, 0);
});

test('orthographic cameras from @margoengine/cameras cast parallel rays that hit models', async () => {
  const { engine } = await world(),
    { doc, buffers } = quadDoc(),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    raycaster = new Raycaster();
  engine.use(model);
  engine.use(new CameraProjection({ mode: 'orthographic', height: 4 }));
  engine.camera.position = [0.5, 0, 3];
  engine.camera.target = [0.5, 0, -1];
  raycaster.setFromEngine(engine, 64, 48);
  const [center] = raycaster.intersectEngine(engine);
  assert.ok(center && Math.abs(center.uv[0] - 0.5) < 1e-4 && Math.abs(center.uv[1] - 0.5) < 1e-4, 'center');
  raycaster.setFromEngine(engine, 64, 24);
  assert.ok(Math.abs(raycaster.direction[1]) < 1e-9, 'parallel rays');
  assert.ok(Math.abs(raycaster.intersectEngine(engine)[0].point[1] - 1) < 1e-4, 'quarter height is one world unit up');
});

test('skinned robot primitives are hit in their bind pose and materials meshes are models too', async () => {
  const { engine, load } = await world(4096),
    robot = load(asset('robot-expressive.glb')),
    raycaster = new Raycaster();
  engine.store.tick(false);
  const b = robot.bounds;
  let hits = 0,
    skinned = 0;
  for (let i = 1; i < 12; i++)
    for (let j = 1; j < 12; j++) {
      const origin = [b[0] + ((b[3] - b[0]) * i) / 12, b[1] + ((b[4] - b[1]) * j) / 12, b[5] + 5],
        [first] = raycaster.set(origin, [0, 0, -1]).intersectEngine(engine),
        reference = brute(robot, origin, [0, 0, -1]);
      assert.equal(!!first, !!reference);
      if (!first) continue;
      hits++;
      if (first.primitive.node === robot.nodes[robot.primitives.at(-1).nodeIndex]) skinned++;
      assert.ok(
        first.model === robot &&
          Math.abs(first.distance - reference.distance) < 1e-4 &&
          first.primitive === reference.primitive,
      );
    }
  assert.ok(hits > 20 && skinned > 0, `${hits} hits, ${skinned} on the skinned body`);
  const material = new Material({ color: [1, 0, 0, 1] }),
    mesh = createMesh(
      engine,
      { positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0.5, 1] },
      material,
    );
  mesh.root.setPosition([50, 0, 0]);
  raycaster.set([50, 0, 5], [0, 0, -1]);
  const [hit] = raycaster.intersectEngine(engine);
  assert.equal(hit.model, mesh);
  assert.ok(Math.abs(hit.uv[0] - 0.5) < 1e-6 && Math.abs(hit.uv[1] - 0.5) < 1e-6, `${hit.uv}`);
  assert.equal(getPrimitiveBVH(mesh.primitives[0]), getPrimitiveBVH(mesh.primitives[0]), 'cached');
});

test('worldTriangles merges models, instances and core meshes in world space; rays agree with the Raycaster', async () => {
  const { engine, load } = await world(),
    helmet = load(asset('damaged-helmet.glb'));
  helmet.root.setPosition([0.3, -0.2, 0.1]).setScale([1.5, 1.5, 1.5]).setRotation([0.3, 0.7, 0]);
  const { doc, buffers } = quadDoc(),
    quad = new PBRModel(engine, new GLTFAsset(doc, buffers));
  const core = engine.createMesh().setGeometry(box()).setPosition([0, 0, -5]).setScale([2, 1, 1]);
  // A structural instanced model (gltf-pro PBRInstances shape): two copies of a triangle, 24 floats per instance.
  const node = engine.createMesh().setPosition([0, 3, 0]),
    data = new Float32Array(48),
    vertices = new Float32Array(60);
  vertices.set([0, 0, 0], 0);
  vertices.set([1, 0, 0], 20);
  vertices.set([0, 1, 0], 40);
  data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);
  data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1], 24);
  const instanced = {
    root: node,
    primitives: [
      {
        node,
        vertices,
        indices: new Uint32Array([0, 1, 2]),
        material: { settings: [0, 0, 1] },
        instances: { count: 2, data },
      },
    ],
  };
  const t = worldTriangles(engine, [helmet, quad, core, instanced]);
  const count = (models, size) => models.reduce((n, m) => n + m.primitives.reduce((k, p) => k + size(p), 0), 0);
  assert.equal(
    t.indices.length,
    (count([helmet, quad], (p) => p.indices.length / 3) + core.geometry.indices.length / 3 + 2) * 3,
  );
  assert.equal(
    t.vertices.length,
    (count([helmet, quad], (p) => p.vertices.length / 20) + core.geometry.vertices.length / 6 + 6) * 3,
  );
  assert.deepEqual([...t.vertices.slice(-9)], [-2, 3, 0, -1, 3, 0, -2, 4, 0], 'second instance');
  const bvh = MeshBVH.build({ positions: t.vertices, indices: t.indices }),
    raycaster = new Raycaster(),
    random = rng(9);
  raycaster.side = 'double';
  let hits = 0;
  for (let i = 0; i < 80; i++) {
    const origin = [(random() * 2 - 1) * 2, (random() * 2 - 1) * 2 + 1, 6],
      direction = [(random() * 2 - 1) * 0.3, (random() * 2 - 1) * 0.3, -1];
    const [first] = raycaster.set(origin, direction).intersectObjects(engine, [helmet, quad, core, instanced]);
    const length = Math.hypot(...direction),
      merged = bvh.raycastFirst({ origin, direction: direction.map((v) => v / length) }, { side: 'double' });
    assert.equal(!!merged, !!first, `ray ${i}`);
    if (first) {
      hits++;
      assert.ok(Math.abs(merged.distance - first.distance) < 1e-4, `ray ${i}: ${merged.distance} vs ${first.distance}`);
    }
  }
  assert.ok(hits > 20, `${hits} rays hit`);
  const filtered = worldTriangles(engine, [helmet, quad, core], { filter: (mesh, model) => model !== helmet });
  assert.equal(filtered.indices.length, (2 + core.geometry.indices.length / 3) * 3);
  helmet.root.setPosition([10, 0, 0]);
  assert.ok(worldTriangles(engine, [helmet]).vertices[0] > 5, 'refreshes world matrices by default');
  quad.dispose();
  assert.equal(worldTriangles(engine, [quad]).indices.length, 0, 'disposed models are skipped');
});
