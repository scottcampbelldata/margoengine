// Seeded stress harness for core and stage (docs/architecture/operational-playbook.md, "Core and stage stress check").
// It drives the real built Engine, FrameGraph, GPURenderer and Stage on a fake WebGPU device and a fake
// requestAnimationFrame queue, both on the CPU, and checks lifecycle invariants after every step: one frame loop at most,
// no GPU work after dispose or on a destroyed device, every error reported exactly once (engine errors with a code),
// every pick settled, no unhandled rejection. Each run is one seed; a failure names the seed and the last steps.
// Replay one seed: MARGO_STRESS_SEED=<seed> node --test <file>. More runs: MARGO_STRESS_RUNS=<n>.
// Nothing here reads the clock: the only timer is the hard limit per run, which fails a run that hangs.
import assert from 'node:assert/strict';

/** mulberry32: a small seeded generator, so a seed always replays the same steps. */
export function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (list) => list[next.int(list.length)];
  next.chance = (p) => next() < p;
  return next;
}

/** Lets every queued microtask and immediate run (restores, pick continuations, device-lost handlers). */
export async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

const BUFFER = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
};
const TEXTURE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
class GPUError extends Error {}
class GPUValidationError extends GPUError {}
class GPUOutOfMemoryError extends GPUError {}
export { GPUValidationError, GPUOutOfMemoryError };
const GLOBALS = [
  'navigator',
  'GPUBufferUsage',
  'GPUTextureUsage',
  'GPUMapMode',
  'GPUValidationError',
  'GPUOutOfMemoryError',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];
/** Calls that release or detach and are fine on a destroyed device or after dispose. */
const CLEANUP = new Set(['destroy', 'unmap', 'unconfigure']);
/** The startup steps of GPURenderer.create, in order, where a fault can be placed. */
export const STARTUP_STEPS = ['adapter', 'device', 'compile1', 'compile2', 'context', 'configure'];

/**
 * One run's world: a seeded generator, the fake WebGPU binding (installed as globals until `restore`), the frame
 * queue, the error log and the invariant violations. `seed` names the run in every failure.
 */
export function createWorld(seed) {
  const rng = random(seed),
    saved = Object.fromEntries(GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])),
    api = new WeakMap(); // GPUDevice object -> its record
  const world = {
    seed,
    rng,
    steps: [],
    violations: [],
    devices: [],
    /** GPURenderer.create calls so far (requestAdapter calls). */
    creates: 0,
    /** A fault at a startup step: { step, create, action: 'lose' | 'hold' }. */
    startup: [],
    held: [],
    frames: new Map(),
    nextFrame: 1,
    time: 1000,
    submits: 0,
    /** Set by the scenario once dispose returned: any GPU work after it is a violation. */
    closed: false,
    /** One armed fault: { site, error, before? } thrown once at that site. */
    armed: null,
    reports: [],
    expected: [],
    texts: [],
    picks: [],
    readbacks: [],
    disposedMeshes: new WeakSet(),
    /** The mesh under the cursor: what a pick readback reports when its copy is submitted. */
    cursor: () => null,
    unhandled: [],
  };
  world.step = (text) => {
    world.steps.push(text);
    if (world.steps.length > 40) world.steps.shift();
  };
  world.violate = (text) => world.violations.push(text);

  // GPU work on a record: violations for a destroyed device or a disposed engine, and the armed 'main' fault.
  world.work = (d, what) => {
    if (d?.destroyed) world.violate(`GPU call ${what} on a destroyed device (device ${d.id})`);
    if (world.closed) world.violate(`GPU call ${what} after dispose`);
    if (world.armed?.site === 'main' && what.endsWith('.beginRenderPass')) {
      const { error, before } = world.armed;
      world.armed = null;
      before?.();
      throw error;
    }
  };
  /** Throws the armed fault when it is for `site`. */
  world.trip = (site) => {
    if (world.armed?.site !== site) return;
    const { error, before } = world.armed;
    world.armed = null;
    before?.();
    throw error;
  };

  const stub = (d, name, extra = {}) =>
    new Proxy(extra, {
      get(target, key) {
        if (key === 'then' || typeof key === 'symbol') return undefined;
        if (key in target) {
          const value = target[key];
          if (typeof value !== 'function' || CLEANUP.has(key)) return value;
          return (...args) => {
            world.work(d, `${name}.${key}`);
            return value.apply(target, args);
          };
        }
        return () => {
          world.work(d, `${name}.${key}`);
          return stub(d, key);
        };
      },
    });

  const startupFault = (step) => world.startup.find((f) => f.step === step && f.create === world.creates - 1);
  /** Applies a startup fault at `step` to device `d` (when there is one); a 'hold' returns a promise to wait on. */
  const atStep = (step, d) => {
    const fault = startupFault(step);
    if (!fault) return null;
    world.step(`startup ${step} of create ${fault.create}: ${fault.action}`);
    if (fault.action === 'lose') d?.lose(`lost at ${step}`);
    if (fault.action === 'hold')
      return new Promise((release) =>
        world.held.push({ step, release: () => (world.step(`release ${step}`), release()) }),
      );
    return null;
  };

  function makeDevice() {
    const listeners = new Set(),
      d = { id: world.devices.length, destroyed: false, lost: false, submits: 0, maps: new Set() };
    let resolveLost;
    const lost = new Promise((resolve) => (resolveLost = resolve));
    d.lose = (message = 'stress loss', reason = 'unknown') => {
      if (d.lost) return;
      d.lost = true;
      world.step(`device ${d.id} lost (${reason})`);
      for (const map of d.maps) map.fail(new DOMException('Device lost', 'OperationError'));
      d.maps.clear();
      resolveLost({ reason, message });
    };
    d.fire = (error) => {
      world.step(`device ${d.id} uncaptured ${error.constructor.name}`);
      for (const listener of [...listeners]) listener({ error });
    };
    const buffer = (descriptor) => {
      const bytes = new ArrayBuffer(Math.max(4, descriptor.size));
      return stub(d, 'buffer', {
        size: descriptor.size,
        usage: descriptor.usage,
        destroy() {},
        unmap() {},
        getMappedRange: () => bytes,
        mapAsync() {
          return new Promise((resolve, reject) => {
            const entry = {
              mesh: world.cursor(),
              pick: world.picks.find((p) => !p.settled && !p.read),
              outcome: 'pending',
              done: () => {
                if (entry.outcome !== 'pending') return;
                entry.outcome = 'resolved';
                d.maps.delete(entry);
                // The pick pass writes ids one up over a clear of 0 (KB-FX273).
                new Uint32Array(bytes)[0] = entry.mesh ? entry.mesh.id + 1 : 0;
                resolve();
              },
              fail: (error) => {
                if (entry.outcome !== 'pending') return;
                entry.outcome = 'rejected';
                reject(error);
              },
            };
            if (entry.pick) entry.pick.read = entry;
            if (d.lost || d.destroyed) return entry.fail(new DOMException('Device lost', 'OperationError'));
            d.maps.add(entry);
            world.readbacks.push(entry);
          });
        },
      });
    };
    const texture = (descriptor) => {
      const [width, height = 1] = Array.isArray(descriptor.size)
        ? descriptor.size
        : [descriptor.size.width, descriptor.size.height];
      return stub(d, 'texture', {
        width,
        height,
        format: descriptor.format,
        sampleCount: descriptor.sampleCount ?? 1,
        destroy() {},
      });
    };
    const pass = () => stub(d, 'pass', { end() {} });
    const encoder = () =>
      stub(d, 'encoder', {
        beginRenderPass: pass,
        finish: () => stub(d, 'commands'),
      });
    const device = stub(d, 'device', {
      features: new Set(),
      limits: {
        maxTextureArrayLayers: 256,
        maxBufferSize: 1 << 28,
        maxStorageBufferBindingSize: 1 << 27,
        maxTextureDimension2D: 8192,
      },
      lost,
      addEventListener: (type, listener) => type === 'uncapturederror' && listeners.add(listener),
      removeEventListener: (type, listener) => listeners.delete(listener),
      destroy() {
        if (d.destroyed) return;
        d.destroyed = true;
        world.step(`device ${d.id} destroyed`);
        for (const map of d.maps) map.fail(new DOMException('Device destroyed', 'AbortError'));
        d.maps.clear();
        d.lose('destroyed', 'destroyed');
      },
      queue: stub(d, 'queue', {
        submit() {
          d.submits++;
          world.submits++;
          if (!d.lost && !d.destroyed) world.liveSubmits = (world.liveSubmits ?? 0) + 1;
        },
        writeBuffer() {},
        writeTexture() {},
        onSubmittedWorkDone: async () => {},
      }),
      createBuffer: buffer,
      createTexture: texture,
      createCommandEncoder: encoder,
      async createRenderPipelineAsync() {
        const step = d.compiles++ ? 'compile2' : 'compile1';
        await atStep(step, d);
        return stub(d, 'pipeline');
      },
    });
    d.compiles = 0;
    d.device = device;
    api.set(device, d);
    world.devices.push(d);
    return d;
  }

  const adapter = {
    features: new Set(),
    limits: { maxTextureArrayLayers: 256, maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 27 },
    async requestDevice() {
      const d = makeDevice();
      await atStep('device', d);
      return d.device;
    },
  };
  /** The canvas context: its work goes to the device it is configured with. */
  const context = {
    device: null,
    configure({ device }) {
      const d = api.get(device);
      world.work(d, 'context.configure');
      context.device = d;
      atStep('configure', d);
    },
    unconfigure() {
      context.device = null;
    },
    getCurrentTexture() {
      world.work(context.device, 'context.getCurrentTexture');
      return canvasTexture({ size: [world.canvas.width, world.canvas.height], format: 'bgra8unorm' });
    },
  };
  // A texture made outside any device (the canvas texture): its calls belong to the configured device.
  const canvasTexture = (descriptor) =>
    stub(context.device, 'canvas-texture', {
      width: descriptor.size[0],
      height: descriptor.size[1],
      format: descriptor.format,
      destroy() {},
    });
  world.context = context;
  world.canvas = {
    width: 64,
    height: 48,
    clientWidth: 64,
    clientHeight: 48,
    getContext(type) {
      if (type !== 'webgpu') return null;
      const d = world.devices.at(-1);
      atStep('context', d);
      return context;
    },
  };

  const define = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define('navigator', {
    userAgent: 'stress',
    gpu: {
      async requestAdapter() {
        world.creates++;
        await atStep('adapter', null);
        return adapter;
      },
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  define('GPUBufferUsage', BUFFER);
  define('GPUTextureUsage', TEXTURE);
  define('GPUMapMode', { READ: 1, WRITE: 2 });
  define('GPUValidationError', GPUValidationError);
  define('GPUOutOfMemoryError', GPUOutOfMemoryError);
  define('requestAnimationFrame', (callback) => {
    const id = world.nextFrame++;
    world.frames.set(id, callback);
    return id;
  });
  define('cancelAnimationFrame', (id) => world.frames.delete(id));

  /** Frame callbacks waiting for the next display refresh: more than one means two frame loops. */
  world.pending = () => world.frames.size;
  /** One display refresh: runs every waiting frame callback once. Returns the submits it made. */
  world.refresh = () => {
    const before = world.submits,
      due = [...world.frames.values()];
    world.frames.clear();
    world.time += 16;
    for (const callback of due) callback(world.time);
    if (world.pending() > 1)
      world.violate(`${world.pending()} frame callbacks wait after one refresh (expected at most 1)`);
    return world.submits - before;
  };
  /** Releases every held startup step. */
  world.release = () => {
    for (const held of world.held.splice(0)) held.release();
  };

  /** The engine's error sink: records each report. */
  world.report = (error) => {
    world.step(`onError ${describe(error)}`);
    // After dispose the engine has nothing left to fail: only an error the app itself threw may still arrive.
    if (world.closed && !world.expected.includes(error))
      world.violate(`an error was reported after dispose: ${describe(error)}`);
    world.reports.push(error);
  };
  /** `error` must be reported exactly once by the end of the run. */
  world.expectOnce = (error) => world.expected.push(error);
  /** Exactly one report whose message holds `text`, with a code (an engine error made from an injected fault). */
  world.expectText = (text) => world.texts.push(text);
  /** Errors that may be reported at most once without a code (a fault thrown on a lost device). */
  world.allowed = new Set();
  /** Starts a pick through `engine` and records its outcome against the readback it gets. */
  world.pick = (engine, x = 1, y = 1) => {
    const entry = { settled: false, read: null, closedAtStart: world.closed };
    world.step('pick');
    // Listed before the call: the first pick reaches its readback synchronously.
    world.picks.push(entry);
    entry.promise = engine.pick(x, y).then(
      (mesh) => {
        entry.settled = true;
        const read = entry.read,
          expected =
            read?.outcome === 'resolved' && read.mesh && !world.disposedMeshes.has(read.mesh) ? read.mesh : null;
        if (mesh !== expected)
          world.violate(
            `pick resolved ${mesh ? `mesh ${mesh.id}` : 'null'}, expected ${expected ? `mesh ${expected.id}` : 'null'} (readback ${read?.outcome ?? 'none'})`,
          );
        if (!read && !world.closed && !entry.allowNoRead)
          world.violate('pick resolved without a readback on a live engine');
      },
      (error) => {
        entry.settled = true;
        if (!(entry.closedAtStart && error?.code === 'disposed')) world.violate(`pick rejected: ${describe(error)}`);
      },
    );
    return entry;
  };
  /** Settles the oldest waiting readback. */
  world.answer = () => {
    const entry = world.readbacks.find((r) => r.outcome === 'pending');
    if (entry) {
      world.step('readback answered');
      entry.done();
    }
  };
  world.disposeMesh = (mesh) => {
    world.disposedMeshes.add(mesh);
    mesh.dispose();
  };
  /** Live submits so far: submits on a device that is neither lost nor destroyed. */
  world.live = () => world.liveSubmits ?? 0;

  world.onUnhandled = (reason) => world.unhandled.push(reason);
  process.on('unhandledRejection', world.onUnhandled);

  /** The invariants every run ends with. */
  world.finish = async () => {
    for (const r of world.readbacks) r.done(), await flush(1);
    await flush();
    for (const pick of world.picks) if (!pick.settled) world.violate('a pick never settled');
    for (const error of world.expected) {
      const times = world.reports.filter((e) => e === error).length;
      if (times !== 1) world.violate(`${describe(error)} reported ${times} times (expected once)`);
    }
    for (const text of world.texts) {
      const hits = world.reports.filter((e) => String(e?.message).includes(text));
      if (hits.length !== 1) world.violate(`the error for "${text}" was reported ${hits.length} times (expected once)`);
      for (const e of hits) if (typeof e?.code !== 'string') world.violate(`the error for "${text}" has no code`);
    }
    const counts = new Map();
    for (const error of world.reports) counts.set(error, (counts.get(error) ?? 0) + 1);
    for (const [error, times] of counts) {
      if (times > 1 && !world.expected.includes(error) && !world.texts.some((t) => String(error?.message).includes(t)))
        world.violate(`${describe(error)} reported ${times} times`);
      if (!world.expected.includes(error) && !world.allowed.has(error) && typeof error?.code !== 'string')
        world.violate(`an engine error without a code was reported: ${describe(error)}`);
    }
    if (world.closed) {
      if (world.pending()) world.violate(`${world.pending()} frame callbacks wait after dispose`);
      for (const d of world.devices) if (!d.destroyed) world.violate(`device ${d.id} not destroyed after dispose`);
    }
    for (const reason of world.unhandled) world.violate(`unhandled rejection: ${describe(reason)}`);
  };
  world.restore = () => {
    process.off('unhandledRejection', world.onUnhandled);
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  };
  return world;
}

export const describe = (error) =>
  error === undefined
    ? 'undefined'
    : `${error?.name ?? typeof error}${error?.code ? ` [${error.code}]` : ''}: ${String(error?.message ?? error).split('; see ')[0]}`;

/** Hard limit for one run (seconds of wall time; a run takes milliseconds). It only fails a run that hangs. */
export const RUN_LIMIT_MS = 10_000;

/** Seeds for a scenario: MARGO_STRESS_SEED replays one; MARGO_STRESS_RUNS sets how many. */
export function seeds(base, runs) {
  if (process.env.MARGO_STRESS_SEED) return [Number(process.env.MARGO_STRESS_SEED) >>> 0];
  const count = Number(process.env.MARGO_STRESS_RUNS) || runs;
  return Array.from({ length: count }, (_, i) => (base + Math.imul(i, 0x9e3779b1)) >>> 0);
}

/**
 * Runs `scenario(world)` once per seed, each in a fresh world under the hard limit, then checks the end invariants.
 * The first failing seed fails the test with the seed, the violations and the last steps.
 */
export async function stress(name, base, runs, scenario) {
  const survey = [];
  for (const seed of seeds(base, runs)) {
    const world = createWorld(seed);
    let failure, limit;
    try {
      await Promise.race([
        scenario(world),
        new Promise((_, reject) => {
          limit = setTimeout(() => reject(new Error(`run hung past ${RUN_LIMIT_MS} ms`)), RUN_LIMIT_MS);
        }),
      ]);
      await world.finish();
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(limit);
      world.restore();
    }
    if ((failure || world.violations.length) && process.env.MARGO_STRESS_ALL) {
      // Survey mode (proof runs): every failing seed is kept, then one failure lists each violation with its seeds.
      survey.push({
        seed,
        lines: [...new Set([...world.violations, ...(failure ? [`threw ${describe(failure)}`] : [])])],
      });
      continue;
    }
    if (failure || world.violations.length)
      assert.fail(
        [
          `${name}: seed ${seed} failed (replay: MARGO_STRESS_SEED=${seed})`,
          ...(failure ? [`  threw ${describe(failure)}`] : []),
          ...[...new Set(world.violations)].map((v) => `  ${v}`),
          '  last steps:',
          ...world.steps.map((s) => `    ${s}`),
        ].join('\n'),
      );
  }
  if (survey.length) {
    const kinds = new Map();
    for (const { seed, lines } of survey)
      for (const line of new Set(lines.map((l) => l.replace(/\d+/g, '#'))))
        kinds.set(line, [...(kinds.get(line) ?? []), seed]);
    assert.fail(
      [
        `${name}: ${survey.length} failing seeds`,
        ...[...kinds].map(([line, list]) => `  ${list.length}x ${line} (seeds ${list.slice(0, 3).join(', ')})`),
      ].join('\n'),
    );
  }
}
