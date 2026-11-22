import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf/dist/pbr.js';
import { extendedMaterials } from '../../gltf/dist/extended.js';
import { Animation } from '../dist/index.js';
import { pointerChannels } from '../dist/pointer.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';

// KHR_materials_ior: an IOR of 0 switches the material to the specular-glossiness mode for good; animation updates of
// it are ignored, and no sampler targeting the IOR may key a value below 1, 0 included.
async function iorModel(t, ior, values, interpolation) {
  const gpu = mockGPU(),
    engine = new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(64), {
      backend: 'webgpu',
      gpu: gpu.device,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  t.after(() => engine.dispose());
  const input = animatedTriangle(),
    data = Float32Array.from(values),
    index = input.buffers.length,
    times = input.buffers.length + 1;
  input.doc.materials[0].extensions = { KHR_materials_ior: { ior } };
  input.buffers.push(data, Float32Array.from([0, 1]));
  input.doc.buffers.push({ byteLength: data.byteLength }, { byteLength: 8 });
  input.doc.bufferViews.push({ buffer: index, byteLength: data.byteLength }, { buffer: times, byteLength: 8 });
  input.doc.accessors.push(
    { bufferView: index, componentType: 5126, count: values.length, type: 'SCALAR' },
    { bufferView: times, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
  );
  input.doc.animations = [
    {
      samplers: [{ input: times, output: index, ...(interpolation ? { interpolation } : {}) }],
      channels: [
        {
          sampler: 0,
          target: {
            path: 'pointer',
            extensions: {
              KHR_animation_pointer: { pointer: '/materials/0/extensions/KHR_materials_ior/ior' },
            },
          },
        },
      ],
    },
  ];
  const model = parseGLTF(engine, input.doc, input.buffers, [], { materials: extendedMaterials });
  return { model, material: model.primitives[0].material };
}

test('an IOR pointer drives a material whose JSON IOR is not 0', async (t) => {
  const { model, material } = await iorModel(t, 1.5, [1.5, 2]);
  const animation = new Animation(model, { pointers: pointerChannels, loop: false });
  assert.deepEqual(animation.warnings, []);
  animation.seek(1);
  assert.equal(material.ext[1], 2);
});

test('an IOR pointer on a material whose JSON IOR is 0 is skipped; the mode stays', async (t) => {
  const { model, material } = await iorModel(t, 0, [1.5, 2]);
  const animation = new Animation(model, { pointers: pointerChannels, loop: false });
  assert.equal(animation.warnings.length, 1);
  assert.match(animation.warnings[0], /IOR of 0.*skipped/);
  for (const time of [0, 0.5, 1]) {
    animation.seek(time);
    assert.equal(material.ext[1], 0);
  }
});

for (const [ior, values] of [
  [1.5, [1.5, 0]],
  [1.5, [0.5, 1.5]],
  [0, [0, 0]],
])
  test(`an IOR sampler keying ${values} on a JSON IOR of ${ior} is refused`, async (t) => {
    const { model } = await iorModel(t, ior, values);
    assert.throws(
      () => new Animation(model, { pointers: pointerChannels, loop: false }),
      (error) => error instanceof RangeError && /keys an IOR of 0?\.?5?.*1 or more/.test(error.message),
    );
  });

test('a cubic IOR spline that dips below 1 between its keys writes 1, never the 0 mode', async (t) => {
  // Keys of 1 at t = 0 and 1, out tangent -4 at t = 0: the Hermite curve reaches 0.4375 at t = 0.25.
  const { model, material } = await iorModel(t, 1.5, [0, 1, -4, 0, 1, 0], 'CUBICSPLINE');
  const animation = new Animation(model, { pointers: pointerChannels, loop: false });
  animation.seek(0.25);
  assert.equal(material.ext[1], 1);
  animation.seek(0.5);
  assert.equal(material.ext[1], 1);
});
