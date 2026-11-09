import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { transformWithOxc } from 'vite';
import { MediaVoxelPathTracer } from '../dist/media.js';
import { fakeEngine } from './support.js';

test('the media README starts its viewport while full tracing compilation is pending', async () => {
  const markdown = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = markdown.slice(markdown.indexOf('## Heterogeneous coloured media'));
  const example = section.match(/```ts\r?\n([\s\S]*?)```/)[1];
  const { code } = await transformWithOxc(example.replace(/^import .*;\r?\n/gm, ''), 'media-readme.ts', {
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
  let click;
  let appended;
  let removed = false;
  let image;
  const button = {
    addEventListener(name, listener) {
      assert.equal(name, 'click');
      click = listener;
    },
    remove() {
      removed = true;
    },
  };
  h.engine.start = () => starts++;
  h.engine.dispose = () => disposals++;
  const run = new Function(
    'Engine',
    'MediaVoxelPathTracer',
    'document',
    'window',
    'console',
    `return (async()=>{${code};return {tracer};})()`,
  );
  const running = run(
    { create: async () => h.engine },
    MediaVoxelPathTracer,
    {
      querySelector: () => ({}),
      createElement(name) {
        assert.equal(name, 'button');
        return button;
      },
      body: {
        append(element) {
          appended = element;
        },
      },
    },
    {
      addEventListener(name, listener, options) {
        assert.equal(name, 'pagehide');
        assert.equal(options.once, true);
        pagehide = listener;
      },
    },
    {
      log(value) {
        image = value;
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
    assert.equal(tracer.status, 'compiling');
    assert.equal(appended, button);
    assert.equal(image, undefined, 'startup must not begin an unsolicited off-screen render');
    const render = tracer.renderImage.bind(tracer);
    tracer.renderImage = (options) => {
      assert.equal(options.width, 32);
      assert.equal(options.height, 32);
      assert.equal(options.samples, 16);
      assert.ok(options.signal instanceof AbortSignal);
      return render(options);
    };
    h.frame();
    await setImmediate();
    h.frame();
    assert.ok(
      h.device.passes.some((pass) =>
        pass.commands.some(([name, pipeline]) => name === 'setPipeline' && pipeline.compute?.entryPoint === 'preview'),
      ),
    );
    const capturing = click();
    assert.equal(button.disabled, true);
    await setImmediate();
    assert.equal(image, undefined, 'a requested capture still waits for full tracing readiness');
    release();
    await tracer.ready;
    await capturing;
    assert.equal(button.disabled, false);
    assert.equal(image.width, 32);
    assert.equal(image.height, 32);
    assert.equal(image.color.length, 32 * 32 * 3);
    assert.ok(image.color.every(Number.isFinite));
    h.frame();
    await setImmediate();
    h.frame();
    assert.ok(tracer.stats.samples > 0, 'the same viewport progresses to the full media tracer');
    const error = new Error('capture failed');
    tracer.renderImage = () => Promise.reject(error);
    await assert.rejects(click(), (caught) => caught === error);
    assert.equal(button.disabled, false, 'capture errors propagate and restore the button');
    pagehide();
    assert.equal(disposals, 1);
    assert.equal(removed, true);
    assert.equal(tracer.status, 'disposed');
    assert.ok(h.device.buffers.every((buffer) => buffer.destroyed));
  } finally {
    release();
    const { tracer } = await running;
    tracer.dispose();
  }
});
