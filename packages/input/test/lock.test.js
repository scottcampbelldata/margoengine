import test from 'node:test';
import assert from 'node:assert/strict';
import { PointerLock } from '../dist/lock.js';
import { Input } from '../dist/index.js';
const make = () => {
  const doc = new EventTarget();
  doc.pointerLockElement = null;
  const element = { ownerDocument: doc };
  doc.exitPointerLock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const acquire = () => {
    doc.pointerLockElement = element;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  element.requestPointerLock = () => {
    acquire();
    return Promise.resolve();
  };
  const lock = new PointerLock(element);
  return { doc, element, lock, acquire };
};
const move = (doc, x, y) => doc.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: x, movementY: y }));
test('raw lock captures relative counts once per tick, feeds Input and releases only its own lock', async () => {
  const { doc, lock } = make();
  const input = new Input(
    { look: [{ type: 'control', id: 'lock', axis: 'x', scale: 0.01 }] },
    { target: new EventTarget(), gamepads: () => [] },
  );
  lock.attach(input);
  move(doc, 100, 100);
  lock.update();
  assert.equal(lock.x, 0);
  await lock.request();
  assert.equal(lock.locked, true);
  assert.equal(lock.raw, true);
  move(doc, 12, -3);
  move(doc, 8, 1);
  move(doc, NaN, Infinity);
  lock.update();
  input.update();
  assert.equal(lock.x, 20);
  assert.equal(lock.y, -2);
  assert.equal(input.state('look').value, 0.2);
  lock.update();
  input.update();
  assert.equal(input.state('look').value, 0);
  move(doc, 5, 5);
  lock.release();
  lock.update();
  assert.equal(lock.x, 0);
  assert.equal(lock.locked, false);
  const other = {};
  doc.pointerLockElement = other;
  lock.dispose();
  assert.equal(doc.pointerLockElement, other);
  input.dispose();
});
test('only raw NotSupportedError negotiates an adjusted fallback, permission failures propagate', async () => {
  const { element, lock, acquire } = make(),
    calls = [];
  element.requestPointerLock = (options) => {
    calls.push(options.unadjustedMovement);
    if (options.unadjustedMovement) return Promise.reject(new DOMException('raw unavailable', 'NotSupportedError'));
    acquire();
    return Promise.resolve();
  };
  await lock.request();
  assert.deepEqual(calls, [true, false]);
  assert.equal(lock.raw, false);
  lock.release();
  await assert.rejects(lock.request({ fallback: false }), { name: 'NotSupportedError' });
  calls.length = 0;
  element.requestPointerLock = (options) => {
    calls.push(options.unadjustedMovement);
    return Promise.reject(new DOMException('denied', 'NotAllowedError'));
  };
  await assert.rejects(lock.request(), { name: 'NotAllowedError' });
  assert.deepEqual(calls, [true]);
  lock.dispose();
});
test('legacy void request settles on native events and does not claim confirmed raw movement', async () => {
  const { element, lock, acquire } = make();
  element.requestPointerLock = () => {
    queueMicrotask(acquire);
  };
  await lock.request();
  assert.equal(lock.raw, null);
  lock.release();
  element.requestPointerLock = () => {
    queueMicrotask(() => element.ownerDocument.dispatchEvent(new Event('pointerlockerror')));
  };
  await assert.rejects(lock.request(), { name: 'OperationError' });
  lock.dispose();
});
test('abort/disposal settle pending requests and a late native promise acquisition releases the lock', async () => {
  const { doc, element, lock, acquire } = make();
  let done;
  element.requestPointerLock = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  const controller = new AbortController(),
    pending = lock.request({ signal: controller.signal });
  await assert.rejects(lock.request(), { name: 'InvalidStateError' });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  acquire();
  done();
  await Promise.resolve();
  assert.equal(doc.pointerLockElement, null);
  const pending2 = lock.request();
  lock.dispose();
  await assert.rejects(pending2, { name: 'AbortError' });
  acquire();
  done();
  await Promise.resolve();
  assert.equal(doc.pointerLockElement, null);
  lock[Symbol.dispose]();
  await assert.rejects(lock.request(), { code: 'disposed' });
  assert.throws(() => lock.update(), { code: 'disposed' });
});
test('bounded waits, pre-abort, unsupported targets and invalid options fail explicitly', async () => {
  const { element, lock } = make();
  element.requestPointerLock = () => new Promise(() => {});
  await assert.rejects(lock.request({ timeout: 10 }), { name: 'TimeoutError' });
  await assert.rejects(lock.request({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  for (const timeout of [0, -1, Infinity, NaN]) await assert.rejects(lock.request({ timeout }), RangeError);
  element.requestPointerLock = undefined;
  assert.equal(lock.supported, false);
  await assert.rejects(lock.request(), { name: 'NotSupportedError' });
  lock.dispose();
});
