// The handshake, forwarding and lifecycle of a worker canvas, with both ends in one Node thread: a MessageChannel plays
// the worker's postMessage, plain objects play the two canvases. tests/browser-check.mjs proves them on a real worker.
import assert from 'node:assert/strict';
import { packageFolder, readmeTypeErrors } from '../../../scripts/support/readme-types.mjs';
import { afterEach, beforeEach, test } from 'node:test';
import { transferCanvas, WorkerCanvas, workerCanvasSupported } from '../dist/index.js';
import { ReceivedCanvas, receiveCanvas } from '../dist/canvas.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A page document and canvas with the members the page side reads. */
const pageCanvas = ({ transfer } = {}) => {
  const document = new EventTarget();
  Object.assign(document, {
    visibilityState: 'visible',
    defaultView: { devicePixelRatio: 2, matchMedia: () => new EventTarget() },
  });
  const canvas = new EventTarget(),
    offscreen = new EventTarget();
  Object.assign(offscreen, { width: 300, height: 150 });
  return Object.assign(canvas, {
    ownerDocument: document,
    clientWidth: 320,
    clientHeight: 200,
    captures: [],
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    offscreen,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture(id) { this.captures.push(id); },
    transferControlToOffscreen: transfer ?? (() => offscreen),
  });
};

/** Joins this thread's `globalThis` (the worker's end) to a worker object (the page's end), as structured messages. */
const link = () => {
  const worker = new EventTarget(),
    inbox = new EventTarget(),
    sent = [],
    hold = { open: true };
  // Canvases are not transferable in Node, so messages pass by reference, one task later as postMessage does.
  worker.postMessage = (message) => {
    sent.push(message);
    setTimeout(() => hold.open && inbox.dispatchEvent(new MessageEvent('message', { data: message })));
  };
  globalThis.postMessage = (message) =>
    setTimeout(() => hold.open && worker.dispatchEvent(new MessageEvent('message', { data: message })));
  globalThis.addEventListener = inbox.addEventListener.bind(inbox);
  globalThis.removeEventListener = inbox.removeEventListener.bind(inbox);
  return { worker, sent, hold };
};

const keep = {};
const names = ['postMessage', 'addEventListener', 'removeEventListener', 'ResizeObserver', 'devicePixelRatio', 'margoLow'];
const open = [];
beforeEach(() => {
  for (const name of names) keep[name] = globalThis[name];
  globalThis.ResizeObserver = class {
    static last;
    constructor(callback) {
      this.callback = callback;
      this.constructor.last = this;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
});
afterEach(() => {
  for (const item of open.splice(0)) item.dispose();
  for (const name of names)
    if (keep[name] === undefined) delete globalThis[name];
    else globalThis[name] = keep[name];
});

const connect = async (options) => {
  const canvas = pageCanvas(),
    { worker, sent } = link(),
    [view, received] = await Promise.all([transferCanvas(canvas, worker, options), receiveCanvas()]);
  open.push(view, received);
  return { canvas, worker, sent, view, received };
};

test('the canvas moves once both sides are there, whichever comes first', async () => {
  // The worker asks first, and its hello is lost: nobody listens yet. The page's ask brings another.
  const canvas = pageCanvas(),
    { worker } = link(),
    receiving = receiveCanvas();
  await tick();
  const view = await transferCanvas(canvas, worker, { data: { scene: 'plaza' } }),
    received = await receiving;
  open.push(view, received);
  assert.ok(view instanceof WorkerCanvas);
  assert.ok(received instanceof ReceivedCanvas);
  assert.equal(received.canvas, canvas.offscreen);
  assert.deepEqual(received.data, { scene: 'plaza' });
});

test('a worker that asks late still gets the canvas, and the page says hello to neither twice', async () => {
  let transfers = 0;
  const canvas = pageCanvas(),
    { worker } = link();
  const real = canvas.transferControlToOffscreen;
  canvas.transferControlToOffscreen = () => (transfers++, real());
  const page = transferCanvas(canvas, worker);
  await tick();
  const received = await receiveCanvas(),
    view = await page;
  open.push(view, received);
  assert.equal(transfers, 1);
});

test('the canvas reads as the page canvas: size, rectangle, capture and pixel ratio', async () => {
  const { received } = await connect(),
    canvas = received.canvas;
  assert.equal(canvas.clientWidth, 320);
  assert.equal(canvas.clientHeight, 200);
  assert.equal(globalThis.devicePixelRatio, 2);
  assert.deepEqual(canvas.getBoundingClientRect(), {
    left: 10,
    top: 20,
    width: 320,
    height: 200,
    x: 10,
    y: 20,
    right: 330,
    bottom: 220,
  });
  assert.equal(canvas.hasPointerCapture(1), false);
  canvas.setPointerCapture(1);
  assert.equal(canvas.hasPointerCapture(1), true);
  canvas.releasePointerCapture(1);
  assert.equal(canvas.hasPointerCapture(1), false);
});

test('a resize on the page reaches the worker, pixel ratio and light tier included', async () => {
  const { canvas, received } = await connect();
  Object.assign(canvas, { clientWidth: 640, clientHeight: 480 });
  canvas.ownerDocument.defaultView.devicePixelRatio = 3;
  globalThis.margoLow = 1.5;
  ResizeObserver.last.callback();
  await tick();
  assert.equal(received.canvas.clientWidth, 640);
  assert.equal(received.canvas.clientHeight, 480);
  assert.equal(globalThis.devicePixelRatio, 3);
  assert.equal(globalThis.margoLow, 1.5);
});

test('only events the worker listens for cross, with their values', async () => {
  const { canvas, received } = await connect(),
    seen = [];
  canvas.dispatchEvent(new Event('pointerdown'));
  await tick();
  received.canvas.addEventListener('pointerdown', (event) => seen.push(event));
  await tick();
  const down = Object.assign(new Event('pointerdown'), { pointerId: 7, button: 2, clientX: 40, shiftKey: true });
  canvas.dispatchEvent(down);
  await tick();
  assert.equal(seen.length, 1, 'the event before the listener stayed on the page');
  assert.equal(seen[0].target, received.canvas);
  assert.equal(seen[0].pointerId, 7);
  assert.equal(seen[0].button, 2);
  assert.equal(seen[0].clientX, 40);
  assert.equal(seen[0].shiftKey, true);
  assert.deepEqual(canvas.captures, [], 'a scripted event has no pointer to capture');
});

test('a real pointer press captures the pointer on the page', async () => {
  const { canvas, received } = await connect();
  received.canvas.addEventListener('pointerdown', () => {});
  await tick();
  const down = new Event('pointerdown');
  Object.defineProperty(down, 'isTrusted', { value: true });
  down.pointerId = 3;
  canvas.dispatchEvent(down);
  assert.deepEqual(canvas.captures, [3]);
});

test('wheel and contextmenu defaults stop on the page once the worker listens, others do not', async () => {
  const { canvas, received } = await connect(),
    fire = (name) => {
      const event = new Event(name, { cancelable: true });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
  assert.equal(fire('wheel'), false, 'nobody in the worker wants the wheel, so the page scrolls');
  for (const name of ['wheel', 'contextmenu', 'pointermove']) received.canvas.addEventListener(name, () => {});
  await tick();
  assert.equal(fire('wheel'), true);
  assert.equal(fire('contextmenu'), true);
  assert.equal(fire('pointermove'), false);
});

test('key events come from the document, since an unfocused canvas gets none', async () => {
  const { canvas, received } = await connect(),
    keys = [];
  received.canvas.addEventListener('keydown', (event) => keys.push(event.key));
  await tick();
  canvas.ownerDocument.dispatchEvent(Object.assign(new Event('keydown'), { key: 'w' }));
  await tick();
  assert.deepEqual(keys, ['w']);
});

test('a type the page does not know stays in the worker', async () => {
  const { canvas, received } = await connect(),
    seen = [];
  received.canvas.addEventListener('contextlost', () => seen.push('lost'));
  await tick();
  canvas.dispatchEvent(new Event('contextlost'));
  await tick();
  assert.deepEqual(seen, []);
  received.canvas.dispatchEvent(new Event('contextlost'));
  assert.deepEqual(seen, ['lost']);
});

test('a style written in the worker lands on the page canvas, and restoring it clears it', async () => {
  const { canvas, received } = await connect(),
    style = received.canvas.style,
    before = style.touchAction;
  assert.equal(before, '');
  style.touchAction = 'none';
  await tick();
  assert.equal(canvas.style.values['touch-action'], 'none');
  assert.equal(style.touchAction, 'none');
  style.touchAction = before;
  await tick();
  assert.equal(canvas.style.values['touch-action'], '');
});

/** The frame loop's parts `ReceivedCanvas` touches. */
const fakeEngine = () => {
  const callbacks = new Set();
  return {
    maxDelta: 0.1,
    disposed: false,
    use() {},
    onFrame(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    frame() {
      for (const callback of callbacks) callback();
    },
    dispose() {
      this.disposed = true;
    },
    callbacks,
  };
};

test('coming back from a hidden page steps 0 for one frame, however often it flips', async () => {
  const { canvas, received } = await connect(),
    engine = fakeEngine(),
    visibility = (state) => {
      canvas.ownerDocument.visibilityState = state;
      canvas.ownerDocument.dispatchEvent(new Event('visibilitychange'));
    };
  received.attach(engine);
  engine.maxDelta = 0.05;
  visibility('hidden');
  await tick();
  assert.equal(received.hidden, true);
  assert.equal(engine.maxDelta, 0.05, 'going hidden changes nothing');
  visibility('visible');
  await tick();
  assert.equal(engine.maxDelta, 0);
  visibility('hidden');
  visibility('visible');
  await tick();
  engine.frame();
  assert.equal(engine.maxDelta, 0.05, 'the app value comes back, not the 0');
  assert.equal(engine.callbacks.size, 0);
});

test('page dispose stops forwarding, aborts the worker side and disposes its engine, once', async () => {
  const { canvas, view, received } = await connect(),
    engine = fakeEngine(),
    seen = [];
  received.attach(engine);
  received.canvas.addEventListener('pointerdown', () => seen.push('down'));
  await tick();
  view.dispose();
  view.dispose();
  canvas.dispatchEvent(new Event('pointerdown'));
  await tick();
  assert.equal(view.disposed, true);
  assert.equal(ResizeObserver.last.disconnected, true);
  assert.equal(received.signal.aborted, true);
  assert.equal(engine.disposed, true);
  assert.deepEqual(seen, []);
});

test('disposing the worker end releases the page end', async () => {
  const { view, received } = await connect();
  received.dispose();
  await tick();
  assert.equal(view.disposed, true);
});

test('using disposes both ends', async () => {
  const { view, received } = await connect();
  view[Symbol.dispose]();
  received[Symbol.dispose]();
  assert.equal(view.disposed, true);
  assert.equal(received.signal.aborted, true);
});

const code = (expected) => (error) => error.code === expected;

test('a canvas that cannot move rejects with the code that says why, and names the fix', async () => {
  await assert.rejects(transferCanvas({}, new EventTarget()), code('unsupported'));
  await assert.rejects(transferCanvas(pageCanvas(), {}), TypeError);
  await assert.rejects(transferCanvas(pageCanvas(), link().worker, { timeout: 0 }), RangeError);
  await assert.rejects(transferCanvas(pageCanvas(), link().worker, { timeout: Number.NaN }), RangeError);
  const moved = pageCanvas({
      transfer() {
        throw new DOMException('no', 'InvalidStateError');
      },
    }),
    { worker } = link(),
    failure = transferCanvas(moved, worker),
    waiting = receiveCanvas({ timeout: 20 }).catch((error) => error);
  await assert.rejects(failure, (error) => error.code === 'state' && error.cause.name === 'InvalidStateError');
  assert.equal((await waiting).code, 'timeout');
});

test('waits end: a timeout, an abort, a worker that fails to start', async () => {
  const { worker, hold } = link();
  hold.open = false;
  await assert.rejects(transferCanvas(pageCanvas(), worker, { timeout: 5 }), code('timeout'));
  const controller = new AbortController(),
    canvas = pageCanvas(),
    pending = transferCanvas(canvas, worker, { signal: controller.signal });
  controller.abort(new Error('left the page'));
  await assert.rejects(pending, /left the page/);
  await assert.rejects(transferCanvas(canvas, worker, { signal: AbortSignal.abort(new Error('gone')) }), /gone/);
  const starting = transferCanvas(pageCanvas(), worker);
  worker.dispatchEvent(Object.assign(new Event('error'), { message: 'SyntaxError' }));
  await assert.rejects(starting, (error) => error.code === 'failed' && /SyntaxError/.test(error.message));
  await assert.rejects(receiveCanvas({ timeout: -1 }), RangeError);
  await assert.rejects(receiveCanvas({ signal: AbortSignal.abort(new Error('gone')) }), /gone/);
  const receiver = new AbortController(),
    receiving = receiveCanvas({ signal: receiver.signal });
  receiver.abort(new Error('stopped'));
  await assert.rejects(receiving, /stopped/);
});

test('without a window the page side says the feature is missing', () => {
  assert.equal(workerCanvasSupported(), false);
});

test('the README examples type-check as written', () => {
  assert.deepEqual(readmeTypeErrors(packageFolder(import.meta.url)), []);
});
