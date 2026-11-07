// KHR_interactivity end to end: the published conformance files against their oracle, then the graph on a loaded model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFAsset, parseGLTFAsync } from '@margoengine/gltf-pro';
import { loadBehaviorGraph } from '@margoengine/gltf-pro/interactivity';
import { GLTFInteractivity, sampleChannel } from '../dist/interactivity.js';
import { pointerWriter } from '../dist/pointer.js';
import { glbChunks } from '../../shared/glb.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

const fixtures = fileURLToPath(new URL('../../gltf-pro/tests/fixtures/interactivity/', import.meta.url));
const samples = process.env.MARGO_SPLAT_SAMPLES && join(process.env.MARGO_SPLAT_SAMPLES, 'interactivity');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

function glb(file) {
  const chunks = glbChunks(new Uint8Array(readFileSync(file))),
    doc = JSON.parse(new TextDecoder().decode(chunks[0].data));
  return { doc, asset: new GLTFAsset(doc, [], chunks[1]?.data) };
}
// A viewer's camera for the tests that read activeCamera; any real one passes them.
const camera = () => ({ position: [0, 1, 5], rotation: [0, 0, 0, 1], perspective: { aspectRatio: 1.5, yfov: 1, znear: 0.1, zfar: 100 } });
const advance = (graph, seconds) => {
  for (let i = 0, n = Math.ceil(seconds * 60); i <= n; i++) graph.tick(1 / 60);
};
const subTests = (oracle) => oracle.tests.flatMap((t) => t.subTests);

/** Runs one conformance file. `interact` plays its required user input. Returns the names of the sub-tests that failed. */
function conformance(file, oracleFile, interact) {
  const { asset, doc } = glb(file),
    oracle = read(oracleFile),
    { graph, rejected } = loadBehaviorGraph(asset, { sample: sampleChannel, camera });
  assert.ok(graph, `${file}: ${rejected}`);
  let duration = 0;
  graph.on('test/onStart', ({ expectedDuration }) => (duration = Math.max(duration, expectedDuration)));
  graph.start();
  advance(graph, 0.1);
  interact?.(graph, doc, oracle);
  advance(graph, duration + 0.5);
  assert.equal(graph.halted, undefined, file);
  const subs = subTests(oracle);
  return { count: subs.length, failed: subs.filter((s) => graph.variable(s.successResultVarId) !== true).map((s) => s.name) };
}
/** The required input of a UserInteractions file: a select lands on the target node, a hover enters and leaves it. */
function interactions(graph, doc, oracle) {
  const parent = (i) => doc.nodes.findIndex((n) => n.children?.includes(i));
  for (const step of oracle.requiredInteractions ?? oracle.tests[0].requiredInteractions) {
    const point = [0, 0, 0];
    for (let i = step.targetNodeId; i >= 0; i = parent(i)) (doc.nodes[i].translation ?? [0, 0, 0]).forEach((v, c) => (point[c] += v));
    if (step.type === 'select') graph.select(step.targetNodeId, { point, origin: [0, 0, 5] });
    else {
      graph.hover(step.targetNodeId);
      advance(graph, 0.1);
      graph.hover(undefined);
    }
    advance(graph, 0.1);
  }
}

test('the committed conformance files pass every sub-test, and the committed invalid graphs are rejected', () => {
  let count = 0;
  for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.glb'))) {
    const base = name.replace('.glb', ''),
      result = conformance(join(fixtures, name), join(fixtures, base + '.json'), base === 'eventOnSelect' ? interactions : undefined);
    assert.deepEqual(result.failed, [], name);
    count += result.count;
  }
  assert.ok(count > 40, `${count} sub-tests ran`);
  const invalid = readdirSync(join(fixtures, 'invalid'));
  assert.equal(invalid.length, 7);
  for (const name of invalid) {
    const { graph, rejected } = loadBehaviorGraph(new GLTFAsset(read(join(fixtures, 'invalid', name)), []), { sample: sampleChannel });
    assert.equal(graph, undefined, name);
    assert.ok(rejected, name);
  }
});

// The one failure: the asset declares /scene an int and expects 0, the glTF Object Model table says ref. This runtime keeps
// the specification, so the sub-test stays failed; see docs/limits.md.
const knownFailure = 'pointer/CoreReadOnlyPointers_GetTests :: /scene isValid';

test('the whole conformance suite: 1,155 of 1,156 sub-tests and 187 of 187 invalid graphs', { skip: !(samples && existsSync(samples)) }, () => {
  const failed = [];
  let total = 0;
  for (const index of ['test-index.json', 'mathtests-index.json'])
    for (const entry of read(join(samples, index))) {
      const base = entry.variants['test-Json'].replace('.json', ''),
        result = conformance(join(samples, entry.name, 'glTF-Binary', base + '.glb'), join(samples, entry.name, 'test-Json', base + '.json'));
      total += result.count;
      failed.push(...result.failed.map((name) => `${entry.name} :: ${name}`));
    }
  for (const base of ['eventOnHover', 'eventOnSelect']) {
    const dir = join(samples, 'UserInteractions', base),
      result = conformance(join(dir, 'glTF-Binary', base + '.glb'), join(dir, 'test-Json', base + '.json'), interactions);
    total += result.count;
    failed.push(...result.failed);
  }
  const load = (base) => {
    const dir = join(samples, 'InterGlb', base);
    return {
      oracle: read(join(dir, 'test-Json', base + '.json')),
      graph: loadBehaviorGraph(glb(join(dir, 'glTF-Binary', base + '.glb')).asset, { sample: sampleChannel, camera }).graph,
    };
  };
  const a = load('RefEcho_FileA'),
    b = load('RefEcho_FileB');
  a.graph.link(b.graph);
  b.graph.start();
  a.graph.start();
  for (let i = 0; i < 300; i++) {
    a.graph.tick(1 / 60);
    b.graph.tick(1 / 60);
  }
  for (const { graph, oracle } of [a, b])
    for (const s of subTests(oracle)) {
      total++;
      if (graph.variable(s.successResultVarId) !== true) failed.push(s.name);
    }
  assert.equal(total, 1156);
  assert.deepEqual(failed, [knownFailure]);
  const invalid = read(join(samples, 'invalid/invalid-index.json'));
  assert.equal(invalid.length, 187);
  for (const entry of invalid) {
    const doc = read(join(samples, entry.name, entry.variants.glTF));
    assert.equal(loadBehaviorGraph(new GLTFAsset(doc, []), { sample: sampleChannel }).graph, undefined, entry.label);
  }
});

/** A GLB of one triangle whose graph makes `op` paint it green, with `extra` merged into the document. */
function file(graph, extra = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    json = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_interactivity'],
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        buffers: [{ byteLength: 36 }],
        extensions: { KHR_interactivity: { graph: 0, graphs: [graph] } },
        ...extra,
      }),
    ),
    length = Math.ceil(json.byteLength / 4) * 4,
    total = 12 + 8 + length + 8 + 36,
    bytes = new Uint8Array(total),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + length);
  bytes.set(json, 20);
  view.setUint32(20 + length, 36, true);
  view.setUint32(24 + length, 0x004e4942, true);
  bytes.set(new Uint8Array(positions.buffer), 28 + length);
  return bytes;
}
const [INT, FLOAT3, REF] = [1, 2, 3];
const paint = {
  types: [{ signature: 'float4' }, { signature: 'int' }, { signature: 'float3' }, { signature: 'ref' }],
  declarations: [{
  op: 'event/onSelect',
  extension: 'KHR_node_selectability',
  outputValueSockets: {
    selectedNode: { type: REF },
    selectionRayOrigin: { type: FLOAT3 },
    selectionPoint: { type: FLOAT3 },
    controllerIndex: { type: INT },
    event: { type: REF },
  },
}, { op: 'pointer/set' }],
  nodes: [
    { declaration: 0, configuration: { nodeIndex: { value: [0] } }, flows: { out: { node: 1, socket: 'in' } } },
    {
      declaration: 1,
      configuration: { pointer: { value: ['/materials/0/pbrMetallicRoughness/baseColorFactor'] }, type: { value: [0] } },
      values: { value: { type: 0, value: [0, 1, 0, 1] } },
    },
  ],
};
/** A canvas the tests can press: the engine's stand-in canvas with real event dispatch. */
async function clickable(bytes, options) {
  const engine = await loadedPBREngine(),
    events = new EventTarget(),
    picks = [];
  Object.assign(engine.canvas, {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  });
  const model = await parseGLTFAsync(engine, bytes, {});
  engine.camera.update(128 / 96, true);
  // The Node shim has no GPU, so the picker and its geometry snapshot stand in here; the GPU check runs the real ones.
  engine.use({ name: 'stand-in picker', setup() {}, onPick: async () => null });
  engine.pick = async (x, y) => {
    picks.push([x, y]);
    return model.nodes[0];
  };
  const quad = (z) => new Float32Array(3 * 20).map((_, i) => (i % 20 === 2 ? z : i % 20 === 0 ? [-9, 9, 0][(i / 20) | 0] : i % 20 === 1 ? [-9, -9, 9][(i / 20) | 0] : 0));
  model.readPickingGeometry = async () => [{ vertices: quad(0), indices: new Uint32Array([0, 1, 2]), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), nodeIndex: 0 }];
  const behaviour = GLTFInteractivity.attach(model, options),
    press = (type, x, y) => events.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y }));
  return { engine, model, behaviour, press, picks, listeners: events };
}
const painted = (model) => [...model.primitives[0].material.base];
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a click on the canvas picks the node and the graph paints its material on the loaded model', async () => {
  const { engine, model, behaviour, press, picks } = await clickable(file(paint));
  assert.deepEqual(painted(model), [1, 0, 0, 1]);
  press('pointerdown', 60, 70);
  press('pointerup', 61, 70);
  await settled();
  // The event ran the flow on the spot; the frame loop owns time, not input.
  assert.deepEqual(picks, [[51, 50]]);
  assert.deepEqual(painted(model), [0, 1, 0, 1]);
  assert.deepEqual(behaviour.notes, []);
  engine.dispose?.();
});

test('a click reports where the ray met the node, in world space, and the camera it came from', async () => {
  const { behaviour, press } = await clickable(file(paint)),
    calls = [],
    select = behaviour.graph.select.bind(behaviour.graph);
  behaviour.graph.select = (node, info) => (calls.push([node, info]), select(node, info));
  // The middle of the 128 x 96 canvas, seen from (0, 0, 4), meets the z = 0 plane at the origin.
  press('pointerdown', 74, 68);
  press('pointerup', 74, 68);
  await settled();
  await settled();
  assert.equal(calls.length, 1);
  const [[node, { point, origin }]] = calls;
  assert.equal(node, 0);
  assert.deepEqual(origin, [0, 0, 4]);
  // float32 camera matrix over four units of depth.
  assert.ok(Math.hypot(...point) < 1e-4, String(point));
});

test('a click passes through an unselectable node to the node behind it', async () => {
  const twoNodes = {
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, extensions: { KHR_node_selectability: { selectable: false } } }, { mesh: 0 }],
  };
  const { behaviour, press, model } = await clickable(
      file({ ...paint, nodes: [{ ...paint.nodes[0], configuration: { nodeIndex: { value: [1] } } }, paint.nodes[1]] }, twoNodes),
    ),
    front = await model.readPickingGeometry();
  model.readPickingGeometry = async () => [
    { ...front[0], nodeIndex: 1, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1]) },
    { ...front[0], nodeIndex: 0, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1]) },
  ];
  assert.ok(behaviour.graph);
  press('pointerdown', 74, 68);
  press('pointerup', 74, 68);
  await settled();
  await settled();
  assert.deepEqual(painted(model), [0, 1, 0, 1]);
});

test('a press that drags selects nothing: it moved the camera', async () => {
  const { model, press, picks } = await clickable(file(paint));
  press('pointerdown', 60, 70);
  press('pointerup', 90, 70);
  await settled();
  assert.deepEqual(picks, []);
  assert.deepEqual(painted(model), [1, 0, 0, 1]);
});

test('dispose stops the input, and pointer: false never listens', async () => {
  const live = await clickable(file(paint));
  live.behaviour.dispose();
  assert.equal(live.engine.hasPlugin(live.behaviour.name), false);
  live.press('pointerdown', 60, 70);
  live.press('pointerup', 60, 70);
  await settled();
  assert.deepEqual(live.picks, []);
  const off = await clickable(file(paint), { pointer: false });
  off.press('pointerdown', 60, 70);
  off.press('pointerup', 60, 70);
  await settled();
  assert.deepEqual(off.picks, []);
});

test('a graph the specification rejects leaves the model drawn and says why', async () => {
  const { behaviour, model } = await clickable(file({ ...paint, declarations: [{ op: 'pointer/set' }], nodes: [{ declaration: 0 }] }));
  assert.equal(behaviour.graph, undefined);
  assert.match(behaviour.rejected, /pointer/);
  assert.equal(model.primitives.length, 1);
});

test('the frame loop drives time: a delay fires only after its seconds pass', async () => {
  const graph = {
    types: [{ signature: 'float4' }, { signature: 'int' }, { signature: 'float' }],
    declarations: [{ op: 'event/onStart' }, { op: 'flow/setDelay' }, { op: 'pointer/set' }],
    nodes: [
      { declaration: 0, flows: { out: { node: 1, socket: 'in' } } },
      { declaration: 1, values: { duration: { type: 2, value: [0.5] } }, flows: { done: { node: 2, socket: 'in' } } },
      paint.nodes[1],
    ].map((node, i) => (i === 2 ? { ...node, declaration: 2 } : node)),
  };
  const { model, behaviour } = await clickable(file(graph));
  behaviour.onPreUpdate(1 / 60);
  behaviour.onPreUpdate(0.4);
  assert.deepEqual(painted(model), [1, 0, 0, 1]);
  behaviour.onPreUpdate(0.2);
  assert.deepEqual(painted(model), [0, 1, 0, 1]);
});

test('activeCamera reads the viewer, as glTF places a camera, and shareCamera: false hides it', async () => {
  const graph = { types: [{ signature: 'int' }], declarations: [{ op: 'event/onStart' }], nodes: [{ declaration: 0 }] },
    { behaviour } = await clickable(file(graph)),
    view = behaviour.camera();
  assert.deepEqual(view.position, [0, 0, 4]);
  // Looking from +Z at the origin is a glTF camera's rest pose: the identity, either sign.
  assert.ok(Math.abs(Math.abs(view.rotation[3]) - 1) < 1e-6, String(view.rotation));
  assert.ok(view.perspective.znear > 0 && view.perspective.yfov > 0);
  assert.equal(view.perspective.aspectRatio, 128 / 96);
});

test('pointerWriter writes a node, a weight and a material of the live model, and reports what has no live value', async () => {
  const { model } = await clickable(file(paint));
  pointerWriter(model, '/nodes/0/translation')([1, 2, 3]);
  const { position } = model.nodes[0];
  assert.deepEqual([position.x, position.y, position.z], [1, 2, 3]);
  pointerWriter(model, '/materials/0/pbrMetallicRoughness/baseColorFactor')([0, 0, 1, 1]);
  assert.deepEqual(painted(model), [0, 0, 1, 1]);
  model.primitives[0].weights = [0, 0];
  pointerWriter(model, '/nodes/0/weights/1')([0.5]);
  assert.deepEqual(model.primitives[0].weights, [0, 0.5]);
  assert.equal(pointerWriter(model, '/materials/0/extensions/KHR_materials_iridescence/iridescenceFactor'), undefined);
});

test('a skin or morph file gets its deformation without any clip starting', async () => {
  const { model, behaviour, engine } = await clickable(
    file(paint, {
      meshes: [
        {
          weights: [0],
          primitives: [{ attributes: { POSITION: 0 }, material: 0, targets: [{ POSITION: 0 }] }],
        },
      ],
    }),
  );
  assert.ok(behaviour.graph);
  const animation = [...engine.plugins.values()].find((plugin) => 'playing' in plugin);
  assert.ok(animation, 'the deformation runs through Animation');
  assert.equal(animation.playing, false);
  assert.equal(model.primitives.length, 1);
});
