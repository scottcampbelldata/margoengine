import { lifetimeFault, ownedByEngine } from '../../../tests/support/owner-shell.js';

const TAG = 'margo-worker-canvas';

// Two message endpoints joined one task apart, as a worker and its page are. Plain event targets, so every listener
// the package adds is one the harness sees, in Node and in a browser alike.
function pair() {
  const a = new EventTarget(), b = new EventTarget();
  const post = (to) => (message) => setTimeout(() => to.dispatchEvent(new MessageEvent('message', { data: message })), 0);
  a.postMessage = post(b);
  b.postMessage = post(a);
  return [a, b];
}
const aborted = (signal) => new Promise((resolve) => signal.aborted ? resolve()
  : signal.addEventListener('abort', () => resolve(), { once: true }));

// The page's canvas and document, with the members the page side reads. A plain event target in both runtimes: the
// worker side never touches a real canvas here, and the transfer itself is the browser's (tests/browser-check.mjs).
function pageCanvas() {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible', pointerLockElement: null,
    defaultView: { devicePixelRatio: 1, matchMedia: () => new EventTarget() },
    exitPointerLock() {},
  });
  const offscreen = Object.assign(new EventTarget(), { width: 64, height: 32 });
  return Object.assign(new EventTarget(), {
    ownerDocument: document, clientWidth: 64, clientHeight: 32,
    style: { setProperty() {} },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 32 }),
    setPointerCapture() {},
    transferControlToOffscreen: () => offscreen,
  });
}

// A stand-in worker for transferCanvas that runs the worker side in this thread: it answers the page's ask, builds the
// ReceivedCanvas from the canvas message and its port, as receiveCanvas does, and confirms.
function canvasWorker(ReceivedCanvas, onReceived) {
  const worker = new EventTarget();
  const reply = (data) => setTimeout(() => worker.dispatchEvent(new MessageEvent('message', { data })), 0);
  worker.postMessage = (message) => {
    if (message?.[TAG] === 'ask') reply({ [TAG]: 'hello' });
    else if (message?.[TAG] === 'canvas') {
      onReceived(new ReceivedCanvas(message.canvas, message.data, message.port, message));
      reply({ [TAG]: 'received' });
    }
  };
  return worker;
}

// A port pair with a browser's `onmessage` attribute handler: Node's own MessagePort adds internal listeners of its own
// when the handler is set, which are the runtime's, not the package's. A message arrives a task later, also when its
// sender closes right after posting it, and never at a port that has closed.
class Port {
  onmessage = null;
  other = null;
  closed = false;
  postMessage(data) {
    if (this.closed) return;
    setTimeout(() => { if (!this.other.closed) this.other.onmessage?.({ data }); }, 0);
  }
  close() { this.closed = true; }
}
class Channel {
  constructor() {
    this.port1 = new Port();
    this.port2 = new Port();
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}
// The ResizeObserver and MessageChannel the page side uses, until the transfer settles. A browser's own observer
// refuses a canvas that is not an element.
async function withStandIns(fn) {
  const names = { ResizeObserver: class { observe() {} disconnect() {} }, MessageChannel: Channel };
  const had = Object.fromEntries(Object.keys(names).map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  for (const [n, value] of Object.entries(names))
    Object.defineProperty(globalThis, n, { configurable: true, writable: true, value });
  try { return await fn(); } finally {
    for (const [n, d] of Object.entries(had)) if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n];
  }
}

export async function fixtures(load = (entry) => import(entry)) {
  const { transferCanvas } = await load('../dist/index.js');
  const { ReceivedCanvas } = await load('../dist/canvas.js');
  const { RpcClient, RpcPool, exposeRpc } = await load('../dist/rpc.js');
  const { runScene } = await load('../dist/auto.js');
  const entries = [];
  // A client and a server over one channel, with a call in flight when the owner goes: the handler's signal aborts.
  entries.push({ name: 'RpcClient+exposeRpc', create({ scene }) {
    const [page, worker] = pair(), started = Promise.withResolvers();
    let handlerSignal;
    const server = exposeRpc({ wait(_, { signal }) {
      handlerSignal = signal;
      started.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }, worker);
    const client = new RpcClient(page), call = client.call('wait', [1]).catch(() => {});
    return started.promise.then(() => ownedByEngine(scene, 'RpcClient+exposeRpc', () => {
      client.dispose();
      server.dispose();
      if (!handlerSignal.aborted) lifetimeFault('a disposed RPC server leaves its running handler unaborted');
      return call;
    }));
  } });
  // A pool owns its workers: disposal cancels queued and running calls and terminates every one.
  entries.push({ name: 'RpcPool', async create({ scene }) {
    const made = [];
    const pool = new RpcPool(() => {
      const [page, worker] = pair();
      // Terminating a worker ends its server, as the thread's end does.
      const server = exposeRpc({ echo: (value) => value }, worker);
      made.push(page);
      return Object.assign(page, { terminated: false, terminate() { this.terminated = true; server.dispose(); } });
    }, { size: 2 });
    if ((await pool.call('echo', [3])) !== 3) lifetimeFault('an RPC pool answers a call');
    return ownedByEngine(scene, 'RpcPool', () => {
      pool.dispose();
      if (made.some((w) => !w.terminated)) lifetimeFault('a disposed RPC pool leaves a worker running');
    });
  } });
  // Both ends of a worker canvas. The page end forwards the events the worker listens for; the worker end gives the app
  // a lifetime signal (its own canvas listener goes with it). Each end closes the other a message later.
  const link = (engine, made) => {
    let received;
    const view = withStandIns(() => transferCanvas(pageCanvas(), canvasWorker(ReceivedCanvas, (r) => { received = r; }),
      { timeout: 2000, signal: new AbortController().signal }));
    return view.then(async (page) => {
      received.canvas.addEventListener('pointerdown', () => {}, { signal: received.signal });
      // The forwarding listener the page adds for it arrives a message later.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return made(page, received);
    });
  };
  // The page end is the owner: disposing it must close the worker end too.
  entries.push({ name: 'WorkerCanvas', create: ({ engine, scene }) => link(engine, (page, received) =>
    ownedByEngine(scene, 'WorkerCanvas', () => {
      page.dispose();
      return aborted(received.signal);
    })) });
  // The worker end alone, attached to the engine, as receiveCanvas builds it from the page's canvas message; the page
  // end is another thread's, so here it is a port that records what arrives. Disposal (or removing its registration)
  // aborts the app's signal, which takes the app's canvas listener with it, and tells the page.
  entries.push({ name: 'ReceivedCanvas.attach', create({ engine, scene }) {
    const { port1, port2 } = new Channel(), told = [];
    port1.onmessage = ({ data }) => told.push(data);
    const offscreen = Object.assign(new EventTarget(), { width: 64, height: 32 });
    const received = new ReceivedCanvas(offscreen, null, port2, { width: 64, height: 32, left: 0, top: 0, ratio: 1 });
    received.canvas.addEventListener('pointerdown', () => {}, { signal: received.signal });
    received.attach(engine);
    const plugin = engine.plugins.get('worker-canvas');
    return { plugin, dispose() {
      if (scene.plugins.get(plugin.name) === plugin) scene.removePlugin(plugin.name);
      received.dispose();
      if (!received.signal.aborted) lifetimeFault('a disposed received canvas leaves its signal unaborted');
    }, async cleanup() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!told.some((m) => m.closed)) lifetimeFault('a disposed received canvas never tells the page');
    } };
  } });
  // A page-mode scene: AutoScene disposal is asynchronous, the scene module's own dispose finishes a task later.
  entries.push({ name: 'AutoScene.page', async create({ scene }) {
    const data = { disposals: 0 }, canvas = new EventTarget();
    const running = await runScene(canvas, new URL('./owner-scene.js', import.meta.url),
      { mode: 'page', data, signal: new AbortController().signal, timeout: 2000 });
    const owned = ownedByEngine(scene, 'AutoScene.page', () => running.dispose().then(() => {
      if (data.disposals !== 1) lifetimeFault('an AutoScene disposal runs its scene cleanup once');
    }));
    return { plugin: owned.plugin, [Symbol.asyncDispose]: () => owned.dispose() };
  } });
  return entries;
}
