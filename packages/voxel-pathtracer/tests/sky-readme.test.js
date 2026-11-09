import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { transformWithOxc } from 'vite';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeEngine } from './support.js';

test('the sky README starts its viewport while full tracing compilation is pending', async () => {
  const markdown = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = markdown.slice(markdown.indexOf('## Multiple-scattering sky'));
  const example = section.match(/```ts\r?\n([\s\S]*?)```/)[1];
  const { code } = await transformWithOxc(example.replace(/^import .*;\r?\n/gm, ''), 'sky-readme.ts', {
    lang: 'ts',
  });
  const h = fakeEngine();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const create = h.device.createComputePipelineAsync;
  h.device.createComputePipelineAsync = async (descriptor) => {
    if (descriptor.compute.entryPoint === 'trace') await pending;
    return create(descriptor);
  };
  let starts = 0;
  let disposals = 0;
  let pagehide;
  h.engine.start = () => starts++;
  h.engine.dispose = () => disposals++;
  const run = new Function(
    'engineRuntime',
    'traceSkyEnvironment',
    'Engine',
    'VoxelPathTracer',
    'document',
    'window',
    `return (async()=>{${code};return {tracer};})()`,
  );
  h.engine.render = h.frame;
  let bakes = 0;
  const running = run(
    () => ({ gpu: h.device }),
    async (device) => {
      assert.equal(device, h.device);
      bakes++;
      return { background: [0.1, 0.2, 0.3] };
    },
    { create: async () => h.engine },
    VoxelPathTracer,
    { querySelector: () => ({}) },
    {
      addEventListener(name, listener, options) {
        assert.equal(name, 'pagehide');
        assert.equal(options.once, true);
        pagehide = listener;
      },
    },
  );
  let completed = false;
  running.then(() => {
    completed = true;
  });
  try {
    // One event-loop turn, with the trace promise still deliberately unresolved.
    // This checks initialization ordering without a wall-clock speed assertion.
    await setImmediate();
    assert.equal(completed, true, 'viewport initialization must not await full tracing compilation');
    const { tracer } = await running;
    assert.equal(starts, 1);
    assert.equal(bakes, 1);
    assert.equal(tracer.status, 'compiling');
    h.frame();
    await setImmediate();
    h.frame();
    assert.ok(
      h.device.passes.some((pass) =>
        pass.commands.some(([name, pipeline]) => name === 'setPipeline' && pipeline.compute?.entryPoint === 'preview'),
      ),
    );
    release();
    await tracer.ready;
    h.frame();
    await setImmediate();
    h.frame();
    assert.ok(tracer.stats.samples > 0, 'the same viewport progresses to the full tracer');
    pagehide();
    assert.equal(disposals, 1);
    assert.equal(tracer.status, 'disposed');
    assert.ok(h.device.buffers.every((buffer) => buffer.destroyed));
  } finally {
    release();
    const { tracer } = await running;
    tracer.dispose();
  }
});
