import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkerCanvas } from '../dist/index.js';
import { ReceivedCanvas } from '../dist/canvas.js';
import { PointerLockControls } from '../../controls/dist/index.js';
import { Camera } from '../../core/dist/extension.js';

const setup = (t, request) => {
  const old = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null,
    defaultView: { devicePixelRatio: 1, matchMedia: () => new EventTarget() },
  });
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    clientWidth: 100,
    clientHeight: 100,
    style: { setProperty() {} },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  const calls = [];
  canvas.requestPointerLock =
    request ??
    ((options) => {
      calls.push(options);
      doc.pointerLockElement = canvas;
      doc.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    });
  doc.exitPointerLock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const { port1, port2 } = new MessageChannel();
  const page = new WorkerCanvas(canvas, {}, port1);
  const received = new ReceivedCanvas(new EventTarget(), undefined, port2, {
    width: 100,
    height: 100,
    left: 0,
    top: 0,
    ratio: 1,
  });
  t.after(() => {
    page.dispose();
    received.dispose();
    port1.close();
    port2.close();
    globalThis.ResizeObserver = old;
  });
  return { page, received, canvas, doc, calls };
};
const once = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));

test('worker requests native page lock with raw-input option, observes state, and exits', {
  timeout: 3000,
}, async (t) => {
  const { page, received, calls } = setup(t);
  await received.requestPointerLock({ unadjustedMovement: true });
  assert.equal(page.pointerLocked, true);
  assert.equal(received.pointerLocked, true);
  assert.deepEqual(calls, [{ unadjustedMovement: true }]);
  assert.equal(received.canvas.pointerLockElement, received.canvas);
  const change = once(received.canvas, 'pointerlockchange');
  received.exitPointerLock();
  await change;
  assert.equal(page.pointerLocked, false);
  assert.equal(received.pointerLocked, false);
});

test('page gesture can request lock and document movement reaches existing worker PointerLockControls exactly once', {
  timeout: 3000,
}, async (t) => {
  const { page, received, doc, canvas } = setup(t);
  const camera = new Camera({ position: [0, 0, 3], target: [0, 0, 0] });
  const controls = new PointerLockControls(camera, received.canvas);
  t.after(() => controls.dispose());
  await received.requestPointerLock();
  assert.equal(controls.isLocked, true);
  const moves = [];
  received.canvas.addEventListener('mousemove', (event) => moves.push([event.movementX, event.movementY]));
  const moved = once(received.canvas, 'mousemove');
  const before = [...camera.target];
  doc.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: 17, movementY: -9 }));
  await moved;
  assert.deepEqual(moves, [[17, -9]]);
  assert.notDeepEqual([...camera.target], before);
  const unlock = once(received.canvas, 'pointerlockchange');
  doc.exitPointerLock();
  await unlock;
  assert.equal(controls.isLocked, false);
  const lock = once(received.canvas, 'pointerlockchange');
  await page.requestPointerLock();
  await lock;
  assert.equal(received.pointerLocked, true);
  doc.pointerLockElement = new EventTarget();
  page.exitPointerLock();
  assert.notEqual(doc.pointerLockElement, null, 'another element keeps its lock');
  assert.notEqual(doc.pointerLockElement, canvas);
});

test('permission denial, native errors, timeout and unsupported pointer lock reject with diagnostics', {
  timeout: 3000,
}, async (t) => {
  const { received, canvas, page, doc } = setup(t, () => Promise.reject(new DOMException('Denied', 'NotAllowedError')));
  await assert.rejects(received.requestPointerLock(), { name: 'NotAllowedError' });
  canvas.requestPointerLock = () => {
    throw new Error('native failure');
  };
  await assert.rejects(received.requestPointerLock(), /native failure/);
  canvas.requestPointerLock = () => undefined;
  const forwarded = once(received.canvas, 'pointerlockerror');
  const direct = assert.rejects(page.requestPointerLock(), { code: 'failed' });
  doc.dispatchEvent(new Event('pointerlockerror'));
  await direct;
  await forwarded;
  delete canvas.requestPointerLock;
  await assert.rejects(received.requestPointerLock(), { code: 'unsupported' });
});

test('deadlines, AbortSignal and disposal settle requests without leaking a promise', { timeout: 3000 }, async (t) => {
  const { page, received } = setup(t, () => undefined);
  await assert.rejects(received.requestPointerLock({ timeout: 10 }), { code: 'timeout' });
  const controller = new AbortController();
  const pending = assert.rejects(received.requestPointerLock({ signal: controller.signal }), /stop/);
  controller.abort(new Error('stop'));
  await pending;
  for (const timeout of [0, -1, Infinity, NaN])
    await assert.rejects(received.requestPointerLock({ timeout }), RangeError);
  const disposed = assert.rejects(received.requestPointerLock(), { name: 'AbortError' });
  received.dispose();
  await disposed;
  await assert.rejects(received.requestPointerLock(), { name: 'AbortError' });
  page.dispose();
  await assert.rejects(page.requestPointerLock(), { code: 'state' });
});

test('disposal exits an owned lock and stops document movement forwarding', { timeout: 3000 }, async (t) => {
  const { page, received, doc } = setup(t);
  await received.requestPointerLock();
  page.dispose();
  page.dispose();
  assert.equal(doc.pointerLockElement, null);
  await once(received.signal, 'abort');
  assert.equal(received.signal.aborted, true);
});

test('disposing the worker end clears its lock state immediately', { timeout: 3000 }, async (t) => {
  const { received, doc } = setup(t);
  await received.requestPointerLock();
  const unlocked = once(doc, 'pointerlockchange');
  received.dispose();
  assert.equal(received.pointerLocked, false);
  assert.equal(received.canvas.pointerLockElement, null);
  await unlocked;
  assert.equal(doc.pointerLockElement, null);
});
