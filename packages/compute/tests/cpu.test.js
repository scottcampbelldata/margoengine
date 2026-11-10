import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';

test('createCompute falls back to the CPU without WebGPU; backend webgpu still rejects', async () => {
  assert.equal(globalThis.navigator?.gpu, undefined);
  using gpu = await createCompute();
  assert.equal(gpu.backend, 'cpu');
  assert.equal(gpu.f16, false);
  await assert.rejects(
    () => createCompute({ backend: 'webgpu' }),
    (e) => e.name === 'MargoError' && e.code === 'unsupported' && /errors#compute/.test(e.message),
  );
  await assert.rejects(() => createCompute({ backend: 'gpu' }), TypeError);
  using cpu = await createCompute({ backend: 'cpu' });
  assert.equal(cpu.backend, 'cpu');
});

import { cpuCases } from './cpu-cases.js';
cpuCases(createCompute, 'cpu');
