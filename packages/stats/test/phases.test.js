import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Stats } from '../dist/index.js';
import { FramePhases } from '../dist/phases.js';

// An engine with the frame path of core's WebGPU renderer: every step spends a set time on a clock the test moves.
function rig(t, { backend = 'webgpu' } = {}) {
  const passes = [],
    callbacks = new Set(),
    r = {
      now: 100,
      passes,
      callbacks,
      plugin: null,
      commands: [],
      device: {
        createCommandEncoder() {
          return { finish: () => 'commands' };
        },
        queue: {
          submit(commands) {
            r.commands.push(commands);
            r.now += 2;
          },
        },
      },
      engine: {
        gpu: null,
        store: {
          tick(culling) {
            r.culling = culling;
            r.ticked = this;
            r.now += 3;
          },
        },
        use(plugin) {
          r.plugin = plugin;
          plugin.setup(r.engine);
          plugin.registerPasses({ add: (pass) => passes.push(pass) });
        },
        onFrame(callback) {
          callbacks.add(callback);
          return () => callbacks.delete(callback);
        },
        sceneOf(plugin) {
          return r.plugin === plugin ? r.engine : undefined;
        },
        removePlugin(name) {
          r.removed = name;
          if (r.plugin?.name === name) r.plugin = null;
        },
      },
      view(pass) {
        // One view: tick, collect, encoder, graph, finish, submit.
        r.engine.store.tick(true);
        r.now += 5;
        const encoder = backend === 'webgpu' ? r.device.createCommandEncoder() : null;
        const context = { backend };
        passes[0].execute(context);
        r.now += 7;
        pass?.();
        passes[1].execute(context);
        if (encoder) {
          r.now += 1;
          r.device.queue.submit([encoder.finish()]);
        }
      },
      /** One whole rAF frame, closed as the browser would by running its microtasks. */
      async frame(pass, views = 1) {
        callbacks.forEach((callback) => callback(r.engine, 0.016));
        r.now += 4;
        r.plugin.onPreUpdate(0.016);
        r.now += 1;
        for (let i = 0; i < views; i++) r.view(pass);
        r.now += 0.5;
        await null;
      },
    };
  if (backend === 'webgpu') r.engine.gpu = r.device;
  t.mock.method(performance, 'now', () => r.now);
  return r;
}

test('a frame splits into update, tick, cull, encode and submit, which add up to the total', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine);
  await r.frame();
  assert.deepEqual(phases.last, { update: 5, tick: 3, cull: 5, encode: 8, submit: 2, other: 0.5, total: 23.5 });
  assert.equal(phases.frames, 1);
  assert.equal(r.culling, true, 'the argument reaches the kernel');
  assert.equal(r.ticked, r.engine.store, 'and the receiver');
  assert.deepEqual(r.commands, [['commands']]);
  phases.dispose();
});

test('views in one frame add into that frame', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine);
  await r.frame(undefined, 3);
  assert.equal(phases.frames, 1);
  assert.equal(phases.last.tick, 9);
  assert.equal(phases.last.encode, 24);
  assert.equal(phases.last.submit, 6);
  const { total, ...parts } = phases.last;
  assert.equal(
    Object.values(parts).reduce((a, b) => a + b),
    total,
  );
  phases.dispose();
});

test('a submit inside a pass goes back to encoding, and is timed as submit', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine);
  await r.frame(() => {
    r.device.queue.submit(['pass']);
    r.now += 10;
  });
  assert.equal(phases.last.submit, 4);
  assert.equal(phases.last.encode, 18);
  assert.equal(phases.last.other, 0.5);
  phases.dispose();
});

test('a submit from a plugin update stays update afterwards, and the next frame starts clean', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine);
  await r.frame();
  r.plugin.onPreUpdate(0.016);
  r.device.queue.submit(['update']);
  r.now += 6;
  await null;
  assert.deepEqual(phases.last, { update: 6, tick: 0, cull: 0, encode: 0, submit: 2, other: 0, total: 8 });
  phases.dispose();
});

test('engine.render without the loop opens its frame at the plugin update', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine);
  r.plugin.onPreUpdate(0);
  r.view();
  await null;
  assert.equal(phases.frames, 1);
  assert.equal(phases.last.tick, 3);
  phases.dispose();
});

test('work outside a frame passes through untimed, a pick for one', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine);
  r.engine.store.tick(false);
  r.device.createCommandEncoder();
  r.device.queue.submit(['pick']);
  r.passes[0].execute({ backend: 'webgpu' });
  r.passes[1].execute({ backend: 'webgpu' });
  await null;
  assert.equal(phases.frames, 0);
  assert.equal(r.culling, false);
  assert.deepEqual(r.commands, [['pick']]);
  assert.equal(phases.average().total, 0);
  phases.dispose();
});

test('WebGL2 has no encoder or submit: the passes bound encoding', async (t) => {
  const r = rig(t, { backend: 'webgl2' }),
    phases = FramePhases.attach(r.engine);
  await r.frame();
  assert.deepEqual(phases.last, { update: 5, tick: 3, cull: 5, encode: 7, submit: 0, other: 0.5, total: 20.5 });
  phases.dispose();
});

test('the average covers the newest frames only', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine, { samples: 2 });
  await r.frame();
  await r.frame(() => (r.now += 10));
  await r.frame(() => (r.now += 20));
  const { average, last, frames } = JSON.parse(JSON.stringify(phases));
  assert.equal(frames, 3);
  assert.equal(last.encode, 28);
  assert.equal(average.encode, 23);
  phases.dispose();
});

test('a restored device is followed and the old one let go', async (t) => {
  const r = rig(t),
    old = r.device,
    { createCommandEncoder } = old,
    { submit } = old.queue,
    phases = FramePhases.attach(r.engine),
    fresh = { createCommandEncoder, queue: { submit: () => (r.now += 9) } };
  r.engine.gpu = r.device = fresh;
  phases.onDeviceRestored(r.engine);
  assert.equal(old.createCommandEncoder, createCommandEncoder);
  assert.equal(old.queue.submit, submit);
  await r.frame();
  assert.equal(phases.last.submit, 9);
  phases.dispose();
});

test('dispose gives everything back, ends the open frame unrecorded, and leaves a wrapper added later', async (t) => {
  const r = rig(t),
    { createCommandEncoder, queue } = r.device,
    { submit } = queue,
    { tick } = r.engine.store,
    phases = FramePhases.attach(r.engine);
  assert.throws(() => phases.setup(r.engine), { code: 'attached' });
  const later = () => {};
  queue.submit = later;
  r.plugin.onPreUpdate(0);
  phases.dispose();
  phases.dispose();
  await null;
  assert.equal(phases.frames, 0);
  assert.equal(r.device.createCommandEncoder, createCommandEncoder);
  assert.equal(r.engine.store.tick, tick);
  assert.equal(queue.submit, later);
  assert.notEqual(submit, later);
  assert.equal(r.removed, 'frame-phases');
  assert.equal(r.callbacks.size, 0);
  assert.throws(() => phases.setup(r.engine), { code: 'disposed' });
});

test('a frame that throws still closes, so the next one is right', async (t) => {
  const r = rig(t),
    phases = FramePhases.attach(r.engine);
  r.plugin.onPreUpdate(0);
  assert.throws(() => {
    r.view(() => {
      throw new Error('pass failed');
    });
  }, /pass failed/);
  await null;
  assert.equal(phases.frames, 1);
  await r.frame();
  assert.equal(phases.last.tick, 3);
  phases.dispose();
});

test('samples are checked', () => {
  assert.throws(() => new FramePhases({ samples: 1 }), RangeError);
  assert.throws(() => new FramePhases({ samples: 4097 }), RangeError);
  assert.throws(() => new FramePhases({ samples: 2.5 }), RangeError);
});

test('view shows the averages in the panel until dispose', async (t) => {
  const r = rig(t),
    dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const stats = new Stats({ parent: dom.window.document.body }),
    phases = FramePhases.attach(r.engine);
  await r.frame();
  phases.view(stats).view(stats);
  assert.match(stats.element.textContent, /CPU 23\.50 ms/);
  assert.match(stats.element.textContent, /tick 3\.00/);
  assert.match(stats.element.textContent, /submit 2\.00/);
  phases.dispose();
  assert.doesNotMatch(stats.element.textContent, /CPU 23/);
  stats.dispose();
  dom.window.close();
});
