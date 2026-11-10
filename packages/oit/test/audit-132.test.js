// Regressions for the batch 132 audit of @margoengine/oit. Each test fails on the code before the audit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { OIT } from '../dist/index.js';
import { ExactOIT } from '../dist/exact.js';
import { PeelOIT } from '../dist/peel.js';
import { PreciseOIT } from '../dist/precise.js';
import { MomentOIT } from '../dist/moments.js';
import { TransparentDepth } from '../dist/depth.js';

const plugins = [
  ['OIT', () => new OIT()],
  ['ExactOIT', () => new ExactOIT()],
  ['PeelOIT', () => new PeelOIT()],
  ['PreciseOIT', () => new PreciseOIT()],
  ['MomentOIT', () => new MomentOIT()],
  ['TransparentDepth', () => new TransparentDepth()],
];

for (const [label, make] of plugins)
  test(`${label}.dispose leaves the scene it was attached to, not the active scene`, async () => {
    const gpu = mockGPU();
    gpu.device.features.add('float32-blendable');
    const engine = new Engine(
      { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
      await TransformStore.create(4),
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      {},
      null,
    );
    try {
      const other = engine.createScene('other'),
        plugin = make();
      other.use(plugin);
      assert.equal(engine.sceneOf(plugin), other);
      plugin.dispose();
      assert.equal(other.plugins.size, 0, 'the disposed plugin stayed registered in its scene');
      assert.equal(engine.sceneOf(plugin), undefined);
    } finally {
      engine.dispose();
    }
  });
