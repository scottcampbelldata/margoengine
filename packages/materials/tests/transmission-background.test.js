import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { TransmissionLayers } from '../dist/transmission-layers.js';

function fixture() {
  const removed = [],
    calls = [],
    passes = [];
  const gpu = mockGPU().device;
  const engine = { gpu, sceneOf: () => undefined, removePlugin: (name) => removed.push(name) };
  const weighted = { order: 2.95, add: (model) => model.setTransparency({ targets: [{}, {}] }) };
  const owner = new TransmissionLayers({ weighted });
  owner.setup(engine);
  owner.registerPasses({ add: (pass) => passes.push(pass) });
  const model = (z) => {
    const disposers = new Set();
    const value = {
      bounds: [0, 0, z, 0, 0, z],
      root: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      setTransparency(hook) {
        value.hook = hook;
        return () => {
          delete value.hook;
        };
      },
      setTransmission(hook) {
        value.glass = hook;
        return () => {
          delete value.glass;
        };
      },
      onDispose(fn) {
        disposers.add(fn);
        return () => disposers.delete(fn);
      },
      dispose() {
        for (const fn of disposers) fn();
      },
      drawTransparent(_c, hook) {
        calls.push(z);
        hook.begin();
      },
    };
    return value;
  };
  return { owner, model, calls, passes, removed, gpu };
}

test('background passes precede the transmission capture and sorted layers draw once back to front', () => {
  const { owner, model, calls, passes } = fixture();
  const near = model(2),
    far = model(-2);
  const release = owner.addLayer(near);
  assert.equal(owner.addLayer(near), release);
  owner.addLayer(far);
  assert.deepEqual(
    passes.map((p) => p.order),
    [2.9, 3],
  );
  let ended = 0;
  passes[0].execute({
    backend: 'webgpu',
    format: 'rgba16float',
    camera: { position: [0, 0, 5] },
    encoder: {
      beginRenderPass: () => ({
        end() {
          ended++;
        },
      }),
    },
  });
  assert.deepEqual(calls, [-2, 2]);
  assert.equal(ended, 1);
  release();
  release();
  assert.equal(near.hook, undefined);
  owner.dispose();
  owner.dispose();
  assert.equal(far.hook, undefined);
});

test('weighted ownership, model disposal, glass exclusion and detached states', () => {
  const { owner, model } = fixture();
  const layer = model(-1),
    glass = model(0);
  owner.addLayer(layer, { mode: 'weighted' });
  assert.equal(layer.hook.targets.length, 2, 'real OIT accumulation and revealage');
  assert.throws(() => owner.addLayer(layer), /another mode/);
  assert.throws(() => owner.add(layer), /own background/);
  owner.add(glass);
  assert.throws(() => owner.addLayer(glass), /own glass/);
  layer.dispose();
  owner.dispose();
  assert.equal(glass.glass, undefined);
  assert.throws(
    () => owner.addLayer(model(1)),
    (e) => e.code === 'disposed',
  );
  assert.throws(
    () => new TransmissionLayers().add(glass),
    (e) => e.code === 'state',
  );
});

test('invalid scheduling and mode reject before changing model ownership', () => {
  for (const layerOrder of [0, 2, 3, Infinity, NaN])
    assert.throws(() => new TransmissionLayers({ layerOrder }), /layerOrder/);
  const { owner, model } = fixture();
  const layer = model(0);
  assert.throws(() => owner.addLayer(layer, { mode: 'other' }), /mode/);
  assert.equal(layer.hook, undefined);
  owner.dispose();
});
