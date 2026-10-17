import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { sphereGeometry } from '../../geometry/dist/index.js';
import { Material, createMesh } from '../dist/index.js';

test('dispersion reserves physical rendering at zero without reserving transmission', () => {
  const plain = new Material();
  assert.equal(plain.dispersion, 0);
  assert.throws(() => {
    plain.dispersion = 1;
  }, /physical option at construction/);
  const material = new Material({ dispersion: 0 });
  assert.ok(material.physical);
  assert.deepEqual(material.extensions, ['dispersion']);
  assert.equal(material.dispersion, 0);
  assert.equal(material.transmissive, false);
  assert.equal(material.volume, undefined);
  assert.throws(() => {
    material.transmission = 0.5;
  }, /transmission at construction/);
  material.dispersion = 2.5;
  assert.equal(material.dispersion, 2.5);
  assert.equal(material.transmissive, false);
  assert.throws(() => new Material({ shading: 'basic', dispersion: 0 }), /standard shading/);
  const physical = new Material({ ior: 1.5 });
  physical.dispersion = 0.75;
  assert.equal(physical.dispersion, 0.75);
  const reserved = new Material({ transmission: 0, dispersion: 0 });
  assert.equal(reserved.transmissive, true);
  reserved.transmission = 1;
  assert.equal(reserved.transmission, 1);
});

test('dispersion rejects invalid factors at construction and during live edits', () => {
  const material = new Material({ dispersion: 0 });
  for (const value of [-0.01, NaN, Infinity, -Infinity, '0.5', null]) {
    assert.throws(() => new Material({ dispersion: value }), RangeError, String(value));
    assert.throws(
      () => {
        material.dispersion = value;
      },
      RangeError,
      String(value),
    );
    assert.equal(material.dispersion, 0);
  }
});

test('dispersion rejects factors that would overflow the GPU uniform', () => {
  assert.throws(() => new Material({ dispersion: 1e300 }), RangeError);
  const material = new Material({ dispersion: 0 });
  assert.throws(() => {
    material.dispersion = 1e300;
  }, RangeError);
});

test('constructed meshes upload live dispersion separately from the fallback transmission tint', async (t) => {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 6], target: [0, 0, 0] },
      null,
    );
  t.after(() => engine.dispose());
  engine.camera.update(4 / 3, true);
  const owner = new Material({ color: [0.8, 0.4, 0.2], transmission: 0.5, dispersion: 0 }),
    mesh = createMesh(engine, sphereGeometry(1, 8, 4), owner),
    material = mesh.primitives[0].material,
    view = context(gpu, { samples: 4, format: 'rgba16float', depthFormat: 'depth32float' }),
    frame = (n) => {
      store.tick(false);
      view.begin(n);
      mesh.draw(view.c, 'beauty', view.c.color, view.c.depth);
      return mesh.resources[0].values;
    };
  assert.equal(material.dispersion, 0);
  assert.equal(frame(0)[103], 0);
  owner.dispersion = 2.5;
  assert.equal(material.dispersion, 2.5);
  const values = frame(1);
  assert.equal(values[103], 2.5);
  assert.ok(Math.abs(values[102] - 0.1) < 1e-6, 'blue transmission tint remains in ext.z');
  owner.dispersion = 0;
  assert.equal(frame(2)[103], 0);
});
