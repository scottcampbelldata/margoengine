// three.js-style live material use on createMesh meshes: swapping mesh.material, with what it keeps and frees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Skeleton, Skin } from '../../animation/dist/index.js';
import { Material, PhongMaterial, UnlitMaterial, createMesh } from '../dist/index.js';

async function scene() {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  let n = 0;
  const frame = () =>
    gpu.record(() => {
      store.tick(false);
      view.begin(n++);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, frame, id: (value) => gpu.snap(value), record: (work) => gpu.record(work) };
}
const of = (log, name) => log.filter((e) => e[0] === name);
const codes = (log) => of(log, 'module').map((e) => e[2].code);
const floats = (hex) => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);
// Buffers created in `log` with the size of a Phong uniform (specular rgb + shininess).
const phongBuffers = (log) => of(log, 'buffer').filter((e) => e[2].size === 16 && e[2].usage & GPUBufferUsage.UNIFORM);
// Two quads side by side, one group each.
const quads = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0],
  normals: Array.from({ length: 8 }, () => [0, 0, 1]).flat(),
  uvs: Array.from({ length: 2 }, () => [0, 0, 1, 0, 1, 1, 0, 1]).flat(),
  indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  groups: [
    { start: 0, count: 6, materialIndex: 0 },
    { start: 6, count: 6, materialIndex: 1 },
  ],
};
const quad = { ...quads, groups: undefined };

test('mesh.material = other draws the new material next frame and moves per-engine uniforms between materials', async () => {
  const s = await scene();
  const red = new PhongMaterial({ color: [1, 0, 0] }),
    blue = new PhongMaterial({ color: [0, 0, 1], shininess: 8 }),
    mesh = createMesh(s.engine, quad, red),
    other = createMesh(s.engine, quad, red);
  let log = s.frame();
  const [redBuffer] = phongBuffers(log);
  assert.equal(phongBuffers(log).length, 1, 'meshes sharing a material share its uniform');
  mesh.material = blue;
  assert.equal(mesh.material, blue);
  assert.equal(mesh.primitives[0].material.base, blue.color, 'gltf-pro reads the new material');
  log = s.frame();
  const [blueBuffer] = phongBuffers(log);
  assert.ok(blueBuffer, 'the new material gets its uniform on first draw');
  const phong = of(log, 'writeBuffer').filter((e) => e[1] === blueBuffer[1]);
  assert.deepEqual([...floats(phong[0][3])], [...blue.specular, 8].map(Math.fround));
  // The beauty uniform carries the new base colour (floats 76-79).
  const frames = of(log, 'writeBuffer')
    .filter((e) => e[3].length === 880 * 2)
    .map((e) => [...floats(e[3]).slice(76, 80)]);
  assert.ok(frames.some((v) => v.join() === '0,0,1,1'));
  assert.ok(
    frames.some((v) => v.join() === '1,0,0,1'),
    'the other mesh keeps the old one',
  );
  assert.equal(of(log, 'renderPipeline').length, 0, 'the same shading reuses its pipeline');
  log = s.record(() => {
    other.material = new UnlitMaterial({ color: [0, 1, 0] });
  });
  assert.deepEqual(of(log, 'destroy'), [['destroy', redBuffer[1]]], 'the last use of a material frees its uniform');
  log = s.frame();
  assert.ok(
    codes(log).some((c) => c.includes('mat_out(')),
    'a different shading compiles its own pipeline',
  );
  log = s.record(() => mesh.dispose());
  assert.deepEqual(
    of(log, 'destroy').filter((e) => e[1] === blueBuffer[1]),
    [['destroy', blueBuffer[1]]],
    'disposing the mesh releases the swapped-in material',
  );
  s.engine.dispose();
});

test('a swap keeps the model, its lighting registrations, picking and sorting live', async () => {
  const s = await scene();
  const order = [],
    track = (name, m) => {
      const draw = m.draw.bind(m);
      m.draw = (...args) => {
        order.push(name);
        return draw(...args);
      };
      return m;
    };
  const first = track('first', createMesh(s.engine, quad, new Material()));
  track('second', createMesh(s.engine, quad, new Material(), { renderOrder: 1 }));
  first.addLighting({ shader: (code) => code + '\n// registered effect', bindings: () => [] });
  s.frame();
  assert.deepEqual(order, ['first', 'second']);
  first.material = new Material({ transparent: true, opacity: 0.5, side: 'back', shading: 'lambert' });
  order.length = 0;
  const log = s.frame();
  assert.deepEqual(order, ['second', 'first'], 'a transparent material draws after opaque meshes');
  assert.ok(s.engine.hasPlugin(first.name));
  assert.ok(
    codes(log).some((c) => c.includes('// registered effect') && c.includes('fn margoFront(')),
    'the model keeps its effect, now on the Lambert shader',
  );
  assert.equal(first.pickingPrimitives[0].side, 'back');
  assert.equal(first.pickingPrimitives[0].cutoff, 0.001, 'blended picking cutoff');
  s.engine.dispose();
});

test('grouped meshes swap the whole material array; invalid assignments throw and change nothing', async () => {
  const s = await scene();
  const a = new Material({ color: [1, 0, 0] }),
    b = new Material({ color: [0, 1, 0] }),
    c = new Material({ color: [0, 0, 1] }),
    mesh = createMesh(s.engine, quads, [a, b]),
    single = createMesh(s.engine, quad, a);
  assert.deepEqual(mesh.material, [a, b]);
  assert.ok(Object.isFrozen(mesh.material));
  mesh.material = [c, a];
  assert.deepEqual(mesh.material, [c, a]);
  assert.ok(Object.isFrozen(mesh.material));
  assert.deepEqual(
    mesh.primitives.map((p) => p.material.base),
    [c.color, a.color],
  );
  for (const [target, value, message] of [
    [mesh, a, /array of 2 Materials/],
    [mesh, [a], /array of 2 Materials/],
    [mesh, [a, {}], /array of 2 Materials/],
    [single, [a], /one Material/],
    [single, null, /one Material/],
  ])
    assert.throws(
      () => {
        target.material = value;
      },
      { name: 'TypeError', message },
    );
  assert.deepEqual(mesh.material, [c, a]);
  assert.equal(single.material, a);
  s.frame();
  single.dispose();
  assert.throws(
    () => {
      single.material = b;
    },
    { name: 'MargoError', code: 'disposed' },
  );
  s.engine.dispose();
});

test('a skinned mesh stays skinned across a material swap', async () => {
  const s = await scene(),
    mesh = createMesh(s.engine, quad, new Material()),
    skeleton = new Skeleton([
      { name: 'root', parent: -1 },
      { name: 'tip', parent: 0, translation: [0, 1, 0] },
    ]),
    skin = Skin.attach(mesh, skeleton, new Array(32).fill(0), new Array(32).fill(1));
  const deformed = mesh.primitives[0].deformed;
  mesh.material = new PhongMaterial({ color: '#ff8800' });
  assert.equal(mesh.primitives[0].deformed, deformed);
  assert.equal(typeof mesh.prepareDeformation, 'function');
  const log = s.frame();
  assert.ok(
    of(log, 'pass.setVertexBuffer').some((e) => e[1] === 0 && e[2] === s.id(deformed)),
    'the swapped material draws the deformed vertices',
  );
  assert.ok(codes(log).some((c) => c.includes('mat_phong')));
  skin.dispose();
  s.engine.dispose();
});

test('swapping between extended physical materials recompiles gltf-pro for the new lobes', async () => {
  const s = await scene(),
    mesh = createMesh(s.engine, quad, new Material({ iridescence: 1 }));
  let log = s.frame();
  assert.ok(codes(log).some((c) => c.includes('fn margoIridescence(')));
  mesh.material = new Material({ anisotropy: 1 });
  log = s.frame();
  const fresh = codes(log);
  assert.ok(fresh.some((c) => c.includes('fn margoAnisotropy(')));
  assert.ok(!fresh.some((c) => c.includes('fn margoIridescence(')), 'the old plan is not reused');
  mesh.material = new Material();
  log = s.frame();
  assert.ok(
    of(log, 'writeBuffer').some((e) => e[3].length === 880 * 2),
    'back to the standard uniform layout',
  );
  s.engine.dispose();
});
