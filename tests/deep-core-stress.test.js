// Core stress check (docs/architecture/operational-playbook.md, "Core and stage stress check"): seeded runs of the real
// built Engine, FrameGraph and GPURenderer on a fake WebGPU device and frame queue (tests/support/core-stress.js). Each
// family drives one class of lifecycle, async and error-path bug the core audit found (docs/work-lists/
// core-stage-audit-plan.md): picks while meshes change (B1), errors in every pass (B2, B4), device loss at every startup
// step (B3), stop/start/dispose re-entered from every callback (B6), and dispose during async work. A failure prints its
// seed; MARGO_STRESS_SEED=<seed> replays it, MARGO_STRESS_RUNS=<n> runs more seeds (npm run check:core-stress).
import test from 'node:test';
import { Engine, box } from '../packages/core/dist/index.js';
import { flush, GPUOutOfMemoryError, GPUValidationError, STARTUP_STEPS, stress } from './support/core-stress.js';

const RUNS = 40;

async function engineIn(world, options = {}) {
  const engine = await Engine.create(world.canvas, { capacity: 32, ...options });
  engine.onError = world.report;
  return engine;
}
/** Disposes twice (the second is a no-op) and closes the world: no GPU work may follow. */
function close(world, engine) {
  world.step('dispose');
  engine.dispose();
  world.closed = true;
  engine.dispose();
}

test('picks answer for the mesh under the cursor while other meshes are created and removed (B1 class)', () =>
  stress('pick-while-meshes-change', 0xb1, RUNS, async (w) => {
    const engine = await engineIn(w),
      shape = box(),
      others = [];
    let hero = engine.createMesh().setGeometry(shape);
    w.cursor = () => hero;
    for (let i = w.rng.int(4); i--; ) others.push(engine.createMesh().setGeometry(shape));
    engine.render();
    for (let s = 0; s < 40; s++) {
      const op = w.rng.pick(['pick', 'pick', 'create', 'remove', 'hero', 'render', 'answer', 'answer', 'flush']);
      w.step(op);
      if (op === 'pick' && w.picks.filter((p) => !p.settled).length < 3) w.pick(engine);
      else if (op === 'create') others.push(engine.createMesh().setGeometry(shape));
      else if (op === 'remove' && others.length) w.disposeMesh(others.splice(w.rng.int(others.length), 1)[0]);
      else if (op === 'hero') {
        // The cursor's mesh goes; a new one takes its freed slot and its place under the cursor.
        w.disposeMesh(hero);
        hero = engine.createMesh().setGeometry(shape);
      } else if (op === 'render') engine.render();
      // A readback settles in its own task: its continuation runs before any other step.
      else if (op === 'answer') w.answer(), await flush(1);
      else if (op === 'flush') await flush(2);
    }
    if (w.rng.chance(0.5)) {
      for (let i = 0; i < 4; i++) w.answer(), await flush(2);
    }
    close(w, engine);
  }));

const SITES = ['preUpdate0', 'preUpdate1', 'pass0', 'pass1', 'pass2', 'graph', 'main', 'callback'];
const KINDS = ['error', 'invalid-state', 'operation', 'validation', 'lost', 'oom'];

test('an error in each plugin and frame-graph pass is reported once and the engine keeps drawing; a real loss restores (B2, B4 class)', () =>
  stress('errors-in-passes', 0xb2, RUNS, async (w) => {
    const engine = await engineIn(w),
      shape = box(),
      model = { running: false };
    for (let i = 1 + w.rng.int(4); i--; ) engine.createMesh().setGeometry(shape);
    engine.onError = (error) => {
      w.report(error);
      model.running = false;
    };
    const orders = [-1, 1, 2];
    for (const k of [0, 1, 2])
      engine.use({
        name: `plugin${k}`,
        setup() {},
        onPreUpdate: () => w.trip(`preUpdate${k}`),
        registerPasses(graph) {
          graph.add({ name: `pass${k}`, order: orders[k], execute: () => w.trip(`pass${k}`) });
        },
      });
    // A pass with no plugin behind it.
    engine.frameGraph.add({ name: 'free', order: 3, execute: () => w.trip('graph') });
    engine.onFrame(() => w.trip('callback'));
    const start = () => {
      engine.start();
      model.running = true;
    };
    start();
    let losses = 0;
    for (let round = 0; round < 6; round++) {
      for (let i = w.rng.int(3); i--; ) w.refresh(), await flush(2);
      const kind = w.rng.pick(losses ? KINDS.slice(0, 4) : KINDS),
        site = w.rng.pick(SITES),
        tag = `injected ${kind} ${round}`,
        device = w.devices.at(-1),
        devices = w.devices.length,
        live = w.live();
      w.step(`inject ${kind} at ${kind === 'validation' || kind === 'oom' ? 'device' : site}`);
      if (kind === 'validation' || kind === 'oom') {
        losses += kind === 'oom';
        w.expectText(tag);
        device.fire(new (kind === 'oom' ? GPUOutOfMemoryError : GPUValidationError)(tag));
      } else {
        const error =
          kind === 'error'
            ? new Error(tag)
            : new DOMException(tag, kind === 'invalid-state' ? 'InvalidStateError' : 'OperationError');
        w.armed = { site, error, before: kind === 'lost' ? () => device.lose('lost inside a pass') : undefined };
        if (kind === 'lost') {
          losses++;
          // Thrown on a device that is lost: a loss, restored; it may be reported once.
          w.allowed.add(error);
        } else w.expectOnce(error);
      }
      // Up to 5 refreshes, restarting a stopped loop as an app would, until a frame draws on a live device.
      for (let i = 0; i < 5 && w.live() === live; i++) {
        w.refresh();
        await flush();
        if (!model.running) start();
      }
      if (w.armed) w.violate(`the ${kind} armed at ${site} never ran`);
      w.armed = null;
      if (w.live() === live) w.violate(`no frame drew on a live device within 5 refreshes after a ${kind} at ${site}`);
      const restored = w.devices.length > devices;
      if (['error', 'invalid-state', 'operation', 'validation'].includes(kind) && restored)
        w.violate(`a ${kind} at ${site} on a healthy device replaced the device`);
      if ((kind === 'lost' || kind === 'oom') && !restored) w.violate(`a ${kind} was not restored`);
    }
    close(w, engine);
  }));

// [step, create]: create 0 is Engine.create, create 1 the first restore. 'engine' loses the device just after
// Engine.create resolves; 'restored' just after the restore swapped the device in.
const LOSS_STEPS = [
  ...STARTUP_STEPS.filter((step) => step !== 'adapter').map((step) => [step, 0]),
  ['engine', 0],
  ...STARTUP_STEPS.map((step) => [step, 1]),
  ['restored', 1],
];
for (const [step, create] of LOSS_STEPS)
  test(`a device lost at ${step} of ${create ? 'the first restore' : 'startup'} is restored and draws again (B3 class)`, () =>
    stress(
      `startup-loss ${step}/${create}`,
      0xb3 + LOSS_STEPS.findIndex(([s, c]) => s === step && c === create),
      8,
      async (w) => {
        // 'adapter' has no device yet: a loss there is a lost device returned by requestDevice ('device').
        const fault = step === 'adapter' ? 'device' : step;
        if (!['engine', 'restored'].includes(step)) w.startup.push({ step: fault, create, action: 'lose' });
        const engine = await engineIn(w),
          shape = box();
        for (let i = w.rng.int(3); i--; ) engine.createMesh().setGeometry(shape);
        let running = false;
        engine.onError = (error) => {
          w.report(error);
          running = false;
        };
        const frames = async (n) => {
          for (let i = 0; i < n; i++) {
            if (!running) engine.start(), (running = true);
            w.refresh();
            await flush();
          }
        };
        // Live submits (on a device neither lost nor destroyed) counted when the loss happens: one must follow.
        let live = 0;
        if (step === 'engine') w.devices[0].lose('lost after startup');
        await frames(w.rng.int(3));
        if (create === 1) {
          if (!w.live()) await frames(1);
          w.devices[0].lose('the loss that starts the first restore');
          live = w.live();
          await flush();
          if (step === 'restored') {
            await frames(1);
            live = w.live();
            w.devices.at(-1).lose('lost just after the restore');
          }
        }
        await frames(8);
        if (w.live() === live)
          w.violate(`after a loss at ${step} of create ${create}: no frame drew on a restored device in 8 refreshes`);
        close(w, engine);
      },
    ));

const ACTIONS = [
  'stop',
  'start',
  'stop start',
  'start stop',
  'start start',
  'stop stop',
  'dispose',
  'dispose dispose',
  'dispose start',
  'throw',
];

test('stop, start and dispose re-entered from onFrame, pace, plugin callbacks, passes and onError keep one loop (B6 class)', () =>
  stress('reentrant-loop', 0xb6, RUNS, async (w) => {
    const engine = await engineIn(w),
      model = { running: false, disposed: false },
      disposals = new Map(),
      plan = new Map(),
      shape = box();
    engine.createMesh().setGeometry(shape);
    // Runs the action planned for `hook` this refresh, updating the model in the same order the engine sees.
    const act = (hook) => {
      const action = plan.get(hook);
      if (!action) return;
      plan.delete(hook);
      w.step(`${hook}: ${action}`);
      for (const verb of action.split(' '))
        if (verb === 'stop') engine.stop(), (model.running = false);
        else if (verb === 'start') {
          if (model.disposed) {
            // start() on a disposed engine throws its coded error; here it is caught, as an app's handler would.
            try {
              engine.start();
              w.violate('start() after dispose did not throw');
            } catch (error) {
              if (error?.code !== 'disposed') w.violate(`start() after dispose threw ${error}`);
            }
          } else engine.start(), (model.running = true);
        } else if (verb === 'dispose') {
          engine.dispose();
          model.disposed = true;
          model.running = false;
          w.closed = true;
        } else if (verb === 'throw') {
          // The frame stops its loop and reports the error.
          const error = new Error(`thrown from ${hook}`);
          w.expectOnce(error);
          model.running = false;
          throw error;
        }
    };
    engine.onError = (error) => {
      w.report(error);
      act('onError');
    };
    engine.pace = () => {
      act('pace');
      return w.rng.chance(0.8);
    };
    engine.onFrame(() => act('frame0'));
    engine.onFrame(() => act('frame1'));
    for (const k of [0, 1])
      engine.use({
        name: `plugin${k}`,
        setup() {},
        onPreUpdate: () => act(`preUpdate${k}`),
        registerPasses: (graph) => graph.add({ name: `pass${k}`, order: k + 1, execute: () => act(`pass${k}`) }),
        dispose: () => disposals.set(k, (disposals.get(k) ?? 0) + 1),
      });
    engine.start();
    model.running = true;
    for (let refresh = 0; refresh < 30 && !model.disposed; refresh++) {
      if (w.rng.chance(0.6)) {
        const hook = w.rng.pick(['frame0', 'frame1', 'pace', 'preUpdate0', 'preUpdate1', 'pass0', 'pass1', 'onError']);
        // A pass may stop and start the loop; disposing inside a pass is audit row B10 (open), not this family.
        // pace runs outside the frame's try: a throw there is the page's own uncaught error, not the engine's.
        let action = w.rng.pick(
          hook.startsWith('pass')
            ? ACTIONS.filter((a) => !a.includes('dispose'))
            : hook === 'pace'
              ? ACTIONS.slice(0, -1)
              : ACTIONS,
        );
        // onError runs only after a throw; plan one elsewhere so it runs.
        if (hook === 'onError') plan.set(w.rng.pick(['frame0', 'preUpdate0', 'pass1']), 'throw');
        if (hook === 'onError' && action === 'throw') action = 'stop';
        plan.set(hook, action);
      }
      const drawn = w.refresh();
      await flush(2);
      plan.clear();
      if (drawn > 1) w.violate(`${drawn} frames drew in one display refresh`);
      const expected = model.running && !model.disposed ? 1 : 0;
      if (w.pending() !== expected)
        w.violate(
          `${w.pending()} frame callbacks wait, expected ${expected} (${model.disposed ? 'disposed' : model.running ? 'running' : 'stopped'})`,
        );
      if (!model.running && !model.disposed && w.rng.chance(0.5)) engine.start(), (model.running = true);
    }
    if (!model.disposed) close(w, engine);
    for (const k of [0, 1])
      if (disposals.get(k) !== 1) w.violate(`plugin${k} disposed ${disposals.get(k) ?? 0} times (expected once)`);
  }));

test('dispose while a pick, a restore or startup is in flight leaves nothing running and nothing unsettled', () =>
  stress('dispose-during-async', 0xd5, RUNS, async (w) => {
    const what = w.rng.pick(['pick', 'restore', 'startup']);
    w.step(`dispose during ${what}`);
    if (what === 'startup') {
      const step = w.rng.pick(['adapter', 'device', 'compile1', 'compile2']),
        controller = new AbortController(),
        reason = new Error('page closed');
      w.startup.push({ step, create: 0, action: 'hold' });
      const pending = Engine.create(w.canvas, { capacity: 32, signal: controller.signal, backend: 'webgpu' });
      await flush();
      controller.abort(reason);
      const outcome = await pending.then(
        (engine) => (engine.dispose(), 'resolved'),
        (error) => (error === reason ? 'aborted' : `rejected ${error}`),
      );
      w.closed = true;
      w.release();
      await flush();
      if (outcome !== 'aborted') w.violate(`Engine.create aborted at ${step}: ${outcome}`);
      return;
    }
    const engine = await engineIn(w),
      shape = box();
    let hero = engine.createMesh().setGeometry(shape);
    w.cursor = () => hero;
    const where = w.rng.pick(['direct', 'frame', 'onError', 'preUpdate']);
    let disposeNow = false;
    const dispose = () => {
      if (!disposeNow) return;
      disposeNow = false;
      close(w, engine);
    };
    engine.onFrame(() => where === 'frame' && dispose());
    engine.use({ name: 'disposer', setup() {}, onPreUpdate: () => where === 'preUpdate' && dispose() });
    engine.onError = (error) => {
      w.report(error);
      if (where === 'onError') dispose();
    };
    if (w.rng.chance(0.5)) {
      engine.start();
      w.refresh();
    }
    if (what === 'pick') for (let i = 1 + w.rng.int(3); i--; ) w.pick(engine);
    else {
      w.startup.push({ step: w.rng.pick(['adapter', 'device', 'compile1', 'compile2']), create: 1, action: 'hold' });
      w.devices[0].lose('the loss that starts a restore');
      await flush();
      if (where !== 'direct') {
        engine.start();
      }
    }
    disposeNow = true;
    if (where === 'direct') dispose();
    else if (where === 'onError') {
      const error = new Error('trigger');
      w.expectOnce(error);
      engine.onFrame(() => {
        if (disposeNow) throw error;
      });
      engine.start();
      w.refresh();
    } else {
      engine.start();
      w.refresh();
    }
    if (!w.closed) {
      // The hook never ran (a restore skips drawing but still runs callbacks): dispose directly.
      w.step(`${where} did not run`);
      dispose();
    }
    w.release();
    await flush();
  }));
