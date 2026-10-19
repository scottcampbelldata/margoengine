// Per-object Cast Shadows and Receive Shadows (Crocotile): shadows.add(source, {castShadow, receiveShadow}).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

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

test('a core mesh always receives: receiveShadow false is refused, castShadow false accepted', async () => {
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
    assert.throws(
      () => shadows.add(mesh, { receiveShadow: false }),
      (error) => error.name === 'MargoError' && error.code === 'unsupported',
    );
    const remove = shadows.add(mesh, { castShadow: false });
    remove();
  } finally {
    shadows.dispose();
    engine.dispose();
  }
});
