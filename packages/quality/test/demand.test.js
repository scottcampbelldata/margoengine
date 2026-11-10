import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOnDemand } from '../dist/demand.js';
function fixture(options = {}) {
  let id = 0,
    plugin;
  const queued = new Map(),
    frames = [],
    source = new EventTarget();
  const engine = {
    stop() {},
    use(p) {
      plugin = p;
    },
    sceneOf(p) {
      return plugin === p
        ? {
            removePlugin() {
              plugin = undefined;
              p.dispose();
            },
          }
        : undefined;
    },
    render(frame) {
      frames.push(frame);
      options.draw?.();
    },
  };
  const loop = renderOnDemand(engine, {
    sources: [source],
    request: (fn) => {
      queued.set(++id, fn);
      return id;
    },
    cancel: (id) => queued.delete(id),
    ...options,
  });
  const tick = (time = 10) => {
    const batch = [...queued.values()];
    queued.clear();
    batch.forEach((fn) => fn(time));
  };
  return {
    loop,
    queued,
    frames,
    source,
    tick,
    restore: () => plugin.onDeviceRestored(),
    remove: () => plugin.dispose(),
  };
}
test('coalesces dirty requests, stops completely, wakes on each source event', () => {
  const f = fixture();
  f.loop.invalidate();
  f.loop.invalidate();
  assert.equal(f.queued.size, 1);
  f.tick();
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].delta, 1 / 60, 'idle wake consumes queued damping without stepping app time');
  assert.equal(f.queued.size, 0);
  for (const event of ['start', 'change', 'end', 'load']) {
    f.source.dispatchEvent(new Event(event));
    f.tick();
  }
  assert.equal(f.frames.length, 5);
  assert.equal(f.loop.pending, false);
  f.loop.invalidate(3);
  f.loop.invalidate(2);
  f.tick();
  f.tick();
  f.tick();
  assert.equal(f.frames.length, 8);
  assert.equal(f.loop.pending, false);
});
test('nested animation holds, clock restart, delta cap and update continuation', () => {
  let remaining = 0;
  const deltas = [];
  const f = fixture({
    update: (dt) => {
      deltas.push(dt);
      return remaining-- > 0;
    },
  });
  const a = f.loop.animate(),
    b = f.loop.animate();
  f.tick(100);
  a();
  a();
  f.tick(1000);
  assert.equal(deltas[1], 0.1);
  b();
  f.tick(1010);
  assert.equal(f.loop.pending, false);
  remaining = 2;
  f.loop.invalidate();
  f.tick(9000);
  assert.equal(deltas.at(-1), 0);
  f.tick(9010);
  f.tick(9020);
  assert.equal(f.loop.pending, false);
});
test('invalidation during drawing survives and restoration gets two frames', () => {
  let again = true,
    f;
  f = fixture({
    draw: () => {
      if (again) {
        again = false;
        f.loop.invalidate();
      }
    },
  });
  f.tick();
  f.tick();
  assert.equal(f.frames.length, 2);
  assert.equal(f.loop.pending, false);
  f.restore();
  f.tick();
  f.tick();
  assert.equal(f.frames.length, 4);
  assert.equal(f.loop.pending, false);
});
test('loads preserve values and errors, disposal and abort cancel all future work', async () => {
  const abort = new AbortController(),
    f = fixture({ signal: abort.signal, initial: false });
  assert.equal(await f.loop.loaded(Promise.resolve(42)), 42);
  assert.equal(f.loop.pending, true);
  const failure = new Error('load');
  await assert.rejects(f.loop.loaded(Promise.reject(failure)), (e) => e === failure);
  abort.abort();
  assert.equal(f.queued.size, 0);
  f.source.dispatchEvent(new Event('change'));
  f.loop.invalidate();
  assert.equal(f.loop.pending, false);
  f.loop[Symbol.dispose]();
  const removed = fixture();
  removed.remove();
  assert.equal(removed.queued.size, 0);
});
test('invalid counts and deltas reject; thrown update cleans queued work', () => {
  const f = fixture();
  for (const n of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => f.loop.invalidate(n), RangeError);
  assert.throws(() => fixture({ maxDelta: NaN }), RangeError);
  const broken = fixture({
    update() {
      throw new Error('update');
    },
  });
  assert.throws(() => broken.tick(), /update/);
  assert.equal(broken.loop.pending, false);
});
