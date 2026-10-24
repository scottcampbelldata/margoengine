// Per-material clipping planes: validation and normalisation, the shader patch every shading gets, the uniform it
// binds, and the clip handed to shadow casters. The drawn result is checked on a real GPU by the visual check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { pbrShader } from '../../gltf-pro/src/shader.ts';
import {
  Material,
  LambertMaterial,
  ToonMaterial,
  UnlitMaterial,
  NormalMaterial,
  PhongMaterial,
  MatcapMaterial,
  DepthMaterial,
  createMesh,
} from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
async function world() {
  const h = optionalGPU(),
    device = h.engine.gpu;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  return { engine, device };
}

test('clipping planes are validated, normalised, live and carried by clone and copy', () => {
  const m = new Material({ clippingPlanes: [[0, 2, 0, -1]] });
  assert.deepEqual(m.clippingPlanes, [[0, 1, 0, -0.5]]);
  assert.equal(m.clipShadows, true);
  m.clippingPlanes[0][1] = 9;
  assert.deepEqual(m.clippingPlanes, [[0, 1, 0, -0.5]], 'reading gives copies');
  m.clippingPlanes = [
    [1, 0, 0, 0],
    [0, 0, -3, 3],
  ];
  assert.deepEqual(m.clippingPlanes[1], [0, 0, -1, 1]);
  const c = m.clone();
  m.clippingPlanes = [];
  assert.equal(c.clippingPlanes.length, 2, 'a clone keeps its own planes');
  m.copy(c);
  assert.equal(m.clippingPlanes.length, 2);
  m.clipShadows = false;
  assert.equal(new Material({ clipShadows: false }).clipShadows, false);
  assert.throws(() => (m.clippingPlanes = [[0, 0, 0, 1]]), { name: 'TypeError', message: /non-zero normal/ });
  assert.throws(() => (m.clippingPlanes = [[0, 1, 0]]), { name: 'TypeError', message: /four finite numbers/ });
  assert.throws(() => (m.clippingPlanes = [[0, 1, 0, Number.NaN]]), TypeError);
  assert.throws(() => (m.clippingPlanes = new Array(7).fill([0, 1, 0, 0])), {
    name: 'RangeError',
    message: /at most 6/,
  });
  assert.throws(() => (m.clippingPlanes = 'up'), TypeError);
  assert.throws(() => (m.clipShadows = 1), TypeError);
});

test('every material class gets the clip in its fragments and binds the plane uniform', async () => {
  const { engine } = await world(),
    source = pbrShader;
  for (const make of [
    () => new Material(),
    () => new Material({ metalnessMap: undefined, clearcoat: 0.5 }),
    () => new LambertMaterial(),
    () => new PhongMaterial(),
    () => new ToonMaterial(),
    () => new UnlitMaterial(),
    () => new NormalMaterial(),
    () => new MatcapMaterial(),
    () => new DepthMaterial(),
  ]) {
    const material = make(),
      mesh = createMesh(engine, triangle, material),
      shading = mesh.primitives[0].material.shading,
      plain = shading.shader(source, 2);
    assert.doesNotMatch(plain, /materialClip/, `${material.shading}: no planes, no clip`);
    material.clippingPlanes = [[0, 1, 0, -0.25]];
    const code = shading.shader(source, 2);
    assert.match(code, /@group\(2\) @binding\(199\) var<uniform> materialClip:materialClipPlanes;/, material.shading);
    const fragments = code.match(/@fragment\s+fn\s+\w+\(i:Out/g).length;
    assert.ok(fragments >= 1);
    // Each return of each fragment, and the shared surface().
    assert.ok(
      code.split('materialClip.settings.x').length - 1 >= fragments + +code.includes('fn surface('),
      `${material.shading}: every fragment and the shared surface clip`,
    );
    const entry = shading.bindings().find((e) => e.binding === 199),
      data = new Float32Array(entry.resource.buffer.data);
    assert.deepEqual(Array.from(data.subarray(0, 4)), [0, 1, 0, -0.25]);
    assert.equal(data[24], 1, 'plane count');
    mesh.dispose();
  }
});

test('clipped materials hand their planes to shadow casters unless clipShadows is off', async () => {
  const { engine } = await world(),
    material = new Material({ clippingPlanes: [[1, 0, 0, 0]] }),
    mesh = createMesh(engine, triangle, material);
  const clip = mesh.shadowPrimitives[0].clip;
  assert.ok(clip?.buffer, 'casters bind the material clip');
  assert.equal(mesh.shadowPrimitives[0].dynamic, true, 'clipped casters redraw (live planes)');
  assert.equal(mesh.shadowPrimitives[0].clip, clip, 'the binding is kept while the buffer lives');
  material.clipShadows = false;
  assert.equal(mesh.shadowPrimitives[0].clip, undefined);
  material.clipShadows = true;
  material.clippingPlanes = [];
  assert.equal(mesh.shadowPrimitives[0].clip, undefined);
});

test('clipIntersection: union by default, intersection on request, in the uniform and every clip site', async () => {
  const { engine } = await world(),
    material = new Material({
      clippingPlanes: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
    }),
    mesh = createMesh(engine, triangle, material),
    shading = mesh.primitives[0].material.shading;
  assert.equal(material.clipIntersection, false);
  const code = shading.shader(pbrShader, 2);
  // Each site counts the planes the point is behind, then discards on any (union) or all (intersection).
  const sites = code.split('materialClip.settings.y>0.5').length - 1;
  assert.ok(sites >= 2, 'fragments and the shared surface read the mode');
  assert.equal(code.split('materialClip.settings.x').length - 1, sites, 'every clip site reads the mode');
  const data = () => new Float32Array(shading.bindings().find((e) => e.binding === 199).resource.buffer.data);
  assert.deepEqual([data()[24], data()[25]], [2, 0]);
  material.clipIntersection = true;
  assert.deepEqual([data()[24], data()[25]], [2, 1], 'live: the mode is a uniform value');
  assert.equal(shading.shader(pbrShader, 2), code, 'switching the mode compiles nothing new');
  assert.equal(
    mesh.shadowPrimitives[0].clip.buffer,
    shading.bindings().find((e) => e.binding === 199).resource.buffer,
    'shadow casters read the same uniform, mode included',
  );
  assert.equal(new Material({ clipIntersection: true }).clipIntersection, true);
  assert.equal(material.clone().clipIntersection, true, 'clone keeps the mode');
  assert.throws(() => (material.clipIntersection = 'all'), { name: 'TypeError', message: /clipIntersection/ });
});
