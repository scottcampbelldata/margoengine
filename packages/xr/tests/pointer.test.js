import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { XRController } from '../dist/index.js';
import { XRPointerEvents } from '../dist/pointer.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const source = {
    targetRaySpace: {},
    gripSpace: {},
    profiles: [],
    handedness: 'right',
    targetRayMode: 'tracked-pointer',
  };
  const controller = new XRController(source);
  controller.targetRay = controller.grip = {};
  controller.targetRayMatrix.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  controller.gripMatrix.set(controller.targetRayMatrix);
  let frame;
  const session = new EventTarget();
  session.inputSources = [source];
  const host = {
    session,
    controllers: [controller],
    onFrame(fn) {
      frame = fn;
      return () => {
        frame = null;
      };
    },
  };
  const target = { id: 1 },
    other = { id: 2 },
    events = [],
    errors = [],
    calls = [];
  let ray = { mesh: target },
    sphere = null;
  const picker = {
    async ray(origin, direction) {
      calls.push([Array.from(origin), Array.from(direction)]);
      return typeof ray === 'function' ? ray() : ray;
    },
    async sphere() {
      return sphere;
    },
  };
  const pointers = XRPointerEvents.attach(host, picker, {
    types: ['ray'],
    onError: (e) => errors.push(e),
    onEvent: (e) => {
      events.push(e);
      options.receive?.(e);
    },
    ...options,
  });
  t.after(() => pointers.dispose());
  return {
    source,
    controller,
    session,
    host,
    pointers,
    target,
    other,
    events,
    errors,
    calls,
    ray(value) {
      ray = value;
    },
    sphere(value) {
      sphere = value;
    },
    step() {
      frame?.({});
    },
    async frame() {
      frame?.({});
      await settle();
    },
    native(type) {
      const event = new Event(type);
      event.inputSource = source;
      session.dispatchEvent(event);
    },
    types: () => events.map((e) => e.type),
    clear() {
      events.length = 0;
    },
  };
}
test('ray hover/move, press/release/click use selection hits and world -Z', async (t) => {
  const h = fixture(t);
  await h.frame();
  assert.deepEqual(h.calls[0], [
    [1, 2, 3],
    [-0, -0, -1],
  ]);
  assert.deepEqual(h.types(), ['pointerover', 'pointermove']);
  h.clear();
  h.controller.buttons[1] = 1;
  await h.frame();
  h.controller.buttons[1] = 0;
  await h.frame();
  assert.deepEqual(h.types(), ['pointermove', 'pointerdown', 'pointermove', 'pointerup', 'click']);
  assert.equal(new Set(h.events.map((e) => e.pointerId)).size, 1);
});
test('releasing over another mesh never clicks the old target', async (t) => {
  const h = fixture(t);
  h.controller.buttons[1] = 1;
  await h.frame();
  h.clear();
  h.ray({ mesh: h.other });
  h.controller.buttons[1] = 0;
  await h.frame();
  assert.deepEqual(h.types(), ['pointerout', 'pointerover', 'pointermove', 'pointerup']);
});
test('capture preserves the target through a miss and releases after click', async (t) => {
  const h = fixture(t, {
    receive(e) {
      if (e.type === 'pointerdown') e.setPointerCapture();
    },
  });
  h.controller.buttons[1] = 1;
  await h.frame();
  h.ray(null);
  h.clear();
  h.controller.buttons[1] = 0;
  await h.frame();
  assert.deepEqual(h.types(), ['pointermove', 'pointerup', 'click']);
  assert.ok(h.events.every((e) => e.target === h.target));
  h.clear();
  await h.frame();
  assert.deepEqual(h.types(), ['pointerout']);
});
test('a bubbling handler can capture its parent as the subsequent target', async (t) => {
  const parent = { id: 3 };
  const h = fixture(t, {
    receive(e) {
      if (e.type === 'pointerdown') e.setPointerCapture(parent);
    },
  });
  h.controller.buttons[1] = 1;
  await h.frame();
  h.clear();
  h.ray(null);
  h.controller.buttons[1] = 0;
  await h.frame();
  assert.ok(h.events.filter((e) => e.type !== 'pointerout').every((e) => e.target === parent));
  assert.equal(h.types().at(-1), 'click');
});
test('native select events work for sources with no gamepad and preserve quick presses', async (t) => {
  const h = fixture(t);
  await h.frame();
  h.clear();
  h.native('selectstart');
  h.native('selectend');
  await settle();
  assert.deepEqual(h.types(), ['pointermove', 'pointerdown', 'pointermove', 'pointerup', 'click']);
});
test('queued press/release edges survive delayed picks and copied poses', async (t) => {
  const h = fixture(t);
  let release;
  h.ray(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.step();
  await settle();
  h.controller.buttons[1] = 1;
  h.step();
  h.controller.buttons[1] = 0;
  h.step();
  h.controller.targetRayMatrix[12] = 99;
  h.ray({ mesh: h.target });
  release({ mesh: h.target });
  await settle();
  assert.deepEqual(h.types(), [
    'pointerover',
    'pointermove',
    'pointermove',
    'pointerdown',
    'pointermove',
    'pointerup',
    'click',
  ]);
  assert.equal(h.calls[1][0][0], 1);
});
test('tracking loss cancels a press and leaves hover without clicking', async (t) => {
  const h = fixture(t);
  h.controller.buttons[1] = 1;
  await h.frame();
  h.clear();
  h.controller.targetRay = null;
  await h.frame();
  assert.deepEqual(h.types(), ['pointercancel', 'pointerout']);
});
test('session end cancels immediately and pending readbacks emit nothing', async (t) => {
  const h = fixture(t);
  let release;
  h.ray(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.step();
  await settle();
  h.session.dispatchEvent(new Event('end'));
  release({ mesh: h.target });
  await settle();
  assert.deepEqual(h.events, []);
  assert.equal(getEventListeners(h.session, 'selectstart').length, 0);
});
test('input removal cancels immediately before the next frame', async (t) => {
  const h = fixture(t);
  h.controller.buttons[1] = 1;
  await h.frame();
  h.clear();
  h.session.inputSources = [];
  h.session.dispatchEvent(new Event('inputsourceschange'));
  assert.deepEqual(h.types(), ['pointercancel', 'pointerout']);
});
test('touch proximity wins over ray and creates a click on leaving contact', async (t) => {
  const h = fixture(t, { types: ['touch', 'grab', 'ray'] });
  h.source.hand = new Map([['index-finger-tip', {}]]);
  h.controller.handTracked[0] = 1;
  h.controller.handMatrices.set(h.controller.targetRayMatrix);
  h.sphere({ mesh: h.other });
  await h.frame();
  assert.ok(h.events.every((e) => e.pointerType === 'touch'));
  assert.deepEqual(h.types(), ['pointerover', 'pointermove', 'pointerdown']);
  h.clear();
  h.sphere(null);
  await h.frame();
  assert.deepEqual(h.types(), ['pointerout', 'pointerup', 'click']);
});
test('grab proximity uses squeeze and preserves its mode until release', async (t) => {
  const h = fixture(t, { types: ['grab', 'ray'] });
  h.sphere({ mesh: h.other });
  h.controller.buttons[4] = 1;
  await h.frame();
  h.clear();
  h.controller.buttons[4] = 0;
  await h.frame();
  assert.ok(h.events.every((e) => e.pointerType === 'grab'));
  assert.equal(h.types().at(-1), 'click');
});
test('instance identity changes hover and cannot click another instance', async (t) => {
  const h = fixture(t);
  h.ray({ mesh: h.target, instanceId: 0 });
  h.controller.buttons[1] = 1;
  await h.frame();
  h.clear();
  h.ray({ mesh: h.target, instanceId: 1 });
  h.controller.buttons[1] = 0;
  await h.frame();
  assert.deepEqual(h.types(), ['pointerout', 'pointerover', 'pointermove', 'pointerup']);
});
test('picker failures are reported and cancel prior pressed targets', async (t) => {
  const h = fixture(t);
  h.controller.buttons[1] = 1;
  await h.frame();
  h.clear();
  const error = new Error('readback failed');
  h.ray(() => {
    throw error;
  });
  await h.frame();
  assert.deepEqual(h.errors, [error]);
  assert.deepEqual(h.types(), ['pointercancel', 'pointerout']);
});
test('abort detaches once and an already aborted signal attaches nothing', async (t) => {
  const abort = new AbortController(),
    h = fixture(t, { signal: abort.signal });
  await h.frame();
  abort.abort();
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(getEventListeners(h.session, 'selectstart').length, 0);
  assert.throws(() => XRPointerEvents.attach(h.host, {}, { signal: abort.signal }), { name: 'AbortError' });
});
test('disposal in an over callback cannot deliver a later press', async (t) => {
  let pointers;
  const h = fixture(t, {
    receive(e) {
      if (e.type === 'pointerover') pointers.dispose();
    },
  });
  pointers = h.pointers;
  h.controller.buttons[1] = 1;
  await h.frame();
  assert.deepEqual(h.types(), ['pointerover', 'pointerout']);
});
