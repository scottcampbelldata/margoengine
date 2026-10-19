// Per-object Cast Shadows and Receive Shadows (Crocotile): shadows.add(source, {castShadow, receiveShadow}) and core's
// mesh.receiveShadow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';
import { wgsl } from '../../core/src/shaders.ts';

test('castShadow false keeps a source out of the map, receiveShadow false out of the lighting', () => {
  const h = optionalGPU(),
    engine = h.engine,
    drawn = [],
    lit = [];
  engine.gpu.limits.maxTextureDimension2D = 8192;
  engine.gpu.limits.maxTextureArrayLayers = 256;
  engine.lighting = { direction: new Float32Array([1, 2, 3, 3]) };
  const source = (name) => ({
    drawShadow() {
      drawn.push(name);
    },
    addLighting(effect) {
      lit.push([name, effect]);
      return () => lit.push([name, 'removed']);
    },
  });
  const shadows = new Shadows({ resolution: 64 });
  engine.use(shadows);
  shadows.add(source('both'));
  shadows.add(source('cast only'), { receiveShadow: false });
  const removeReceiver = shadows.add(source('receive only'), { castShadow: false });
  shadows.add(source('neither'), { castShadow: false, receiveShadow: false });
  assert.deepEqual(
    lit.map(([name, effect]) => [name, effect === shadows]),
    [
      ['both', true],
      ['receive only', true],
    ],
  );
  h.context.shader = 'let linear=direct*vec3f(1);';
  engine.frameGraph.execute(h.context);
  assert.deepEqual(drawn, ['both', 'cast only', 'both', 'cast only', 'both', 'cast only', 'both', 'cast only']);
  removeReceiver();
  assert.deepEqual(lit.at(-1), ['receive only', 'removed']);
  for (const options of [{ castShadow: 1 }, { receiveShadow: 'no' }])
    assert.throws(() => shadows.add(source('bad'), options), TypeError);
  shadows.dispose();
});

test('receiveShadow false on a core mesh sets mesh.receiveShadow; the remover restores the earlier value', async () => {
  const gpu = mockGPU(),
    store = await TransformStore.create(4),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 2, 6], target: [0, 0, 0] },
      null,
    ),
    mesh = engine.createMesh().setGeometry(box()),
    shadows = new Shadows({ resolution: 64 });
  try {
    const remove = shadows.add(mesh, { receiveShadow: false });
    assert.equal(mesh.receiveShadow, false);
    remove();
    assert.equal(mesh.receiveShadow, true);
    mesh.receiveShadow = false;
    shadows.add(mesh, { receiveShadow: false })();
    assert.equal(mesh.receiveShadow, false, 'restores false when it was false');
    mesh.receiveShadow = true;
    shadows.add(mesh, { castShadow: false })();
    assert.equal(mesh.receiveShadow, true, 'castShadow alone leaves it alone');
  } finally {
    shadows.dispose();
    engine.dispose();
  }
});

test("core's shader keeps a non-receiving mesh's direct light, patched only while the engine has one", async () => {
  const gpu = mockGPU(),
    store = await TransformStore.create(4),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 2, 6], target: [0, 0, 0] },
      null,
    ),
    mesh = engine.createMesh().setGeometry(box()),
    shadows = new Shadows({ resolution: 64 }),
    custom = 'let linear=direct*vec3f(1);';
  engine.use(shadows);
  try {
    engine.render();
    const original = shadows.shader(wgsl),
      plain = shadows.shader(custom);
    assert.ok(original.includes('let linear=shadowLit(direct,i.position,i.normal)*frame.radiance.xyz'));
    mesh.receiveShadow = false;
    engine.render();
    const patched = shadows.shader(wgsl);
    assert.ok(
      patched.includes(
        'let linear=select(direct,shadowLit(direct,i.position,i.normal),fract(i.material.z+0.125)<0.25)*frame.radiance.xyz',
      ),
    );
    assert.equal(
      patched.replace(
        'select(direct,shadowLit(direct,i.position,i.normal),fract(i.material.z+0.125)<0.25)',
        'shadowLit(direct,i.position,i.normal)',
      ),
      original,
      'nothing else changes',
    );
    assert.equal(shadows.shader(custom), plain, 'a shader without core instances keeps the plain patch');
    mesh.receiveShadow = true;
    engine.render();
    assert.equal(shadows.shader(wgsl), original, 'the original text once no core mesh opts out');
  } finally {
    engine.dispose();
  }
});
