// Stage stress check (docs/architecture/operational-playbook.md, "Core and stage stress check"): the same seeded harness
// as tests/deep-core-stress.test.js (tests/support/core-stress.js), driven through the stage: createStage with a device
// lost at each startup step (B3 class), stop/start/dispose re-entered from onTick, onError and the camera-control
// plugin's frame (B6 class), picks while stage meshes change (B1 class), and dispose while a pick or a feature load
// waits. A failure prints its seed; MARGO_STRESS_SEED=<seed> replays it, MARGO_STRESS_RUNS=<n> runs more seeds.
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createStage } from '@margoengine/stage';
import { attachPlugin } from '../dist/feature.js';
import { flush, STARTUP_STEPS, stress } from '../../../tests/support/core-stress.js';

const RUNS = 30;

/** A host element (a div, so the stage owns its canvas) whose canvases draw through the world's fake WebGPU. */
function host(world) {
  const { document } = new JSDOM('<body><div id="scene"></div></body>').window,
    element = document.querySelector('#scene'),
    create = document.createElement.bind(document);
  document.createElement = (name) => {
    const made = create(name);
    if (name === 'canvas') {
      made.getContext = world.canvas.getContext;
      made.width = world.canvas.width;
      made.height = world.canvas.height;
    }
    return made;
  };
  return element;
}

async function stageIn(world, options = {}) {
  const element = host(world),
    stage = await createStage(element, { controls: world.rng.chance(0.5), onError: world.report, ...options });
  return { stage, element };
}
/** Disposes the stage twice (the second is a no-op): no GPU work may follow, the canvas and signal must be gone. */
function close(world, stage, element) {
  world.step('dispose');
  stage.dispose();
  world.closed = true;
  stage.dispose();
  if (!stage.signal.aborted) world.violate('stage.signal not aborted by dispose');
  if (element.querySelector('canvas')) world.violate('the stage canvas is still in the page after dispose');
}

for (const step of [...STARTUP_STEPS.filter((s) => s !== 'adapter'), 'engine'])
  test(`createStage with a device lost at ${step} restores and draws again (B3 class)`, () =>
    stress(`stage-startup-loss ${step}`, 0x5b3 + STARTUP_STEPS.indexOf(step), 6, async (w) => {
      if (step !== 'engine') w.startup.push({ step, create: 0, action: 'lose' });
      const { stage, element } = await stageIn(w);
      stage.box();
      if (step === 'engine') w.devices[0].lose('lost after createStage');
      const live = step === 'engine' ? w.live() : 0;
      for (let i = 0; i < 8; i++) (w.refresh(), await flush());
      if (w.live() === live) w.violate(`createStage after a loss at ${step}: no frame drew on a restored device in 8 refreshes`);
      close(w, stage, element);
    }));

const ACTIONS = ['stop', 'start', 'stop start', 'start stop', 'dispose', 'dispose dispose', 'dispose start', 'throw'];

test('stop, start and dispose re-entered from onTick, onError and the controls frame keep one loop (B6 class)', () =>
  stress('stage-reentrant-loop', 0x5b6, RUNS, async (w) => {
    const { stage, element } = await stageIn(w, { controls: true }),
      engine = stage.engine,
      model = { running: true, disposed: false },
      plan = new Map();
    stage.box();
    const act = (hook) => {
      const action = plan.get(hook);
      if (!action) return;
      plan.delete(hook);
      w.step(`${hook}: ${action}`);
      for (const verb of action.split(' '))
        if (verb === 'stop') (engine.stop(), (model.running = false));
        else if (verb === 'start') {
          if (model.disposed) {
            try {
              engine.start();
              w.violate('start() after dispose did not throw');
            } catch (error) {
              if (error?.code !== 'disposed') w.violate(`start() after dispose threw ${error}`);
            }
          } else (engine.start(), (model.running = true));
        } else if (verb === 'dispose') {
          stage.dispose();
          model.disposed = true;
          model.running = false;
          w.closed = true;
        } else if (verb === 'throw') {
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
    stage.onTick(() => act('tick0'));
    stage.onTick(() => act('tick1'));
    // A plugin attached through the stage, beside its own controls plugin.
    stage.use({ name: 'app', setup() {}, onPreUpdate: () => act('preUpdate') });
    for (let refresh = 0; refresh < 25 && !model.disposed; refresh++) {
      if (w.rng.chance(0.6)) {
        const hook = w.rng.pick(['tick0', 'tick1', 'preUpdate', 'onError']);
        let action = w.rng.pick(ACTIONS);
        if (hook === 'onError') plan.set(w.rng.pick(['tick0', 'preUpdate']), 'throw');
        if (hook === 'onError' && action === 'throw') action = 'stop';
        plan.set(hook, action);
      }
      const drawn = w.refresh();
      await flush(2);
      plan.clear();
      if (drawn > 1) w.violate(`${drawn} frames drew in one display refresh`);
      const expected = model.running && !model.disposed ? 1 : 0;
      if (w.pending() !== expected)
        w.violate(`${w.pending()} frame callbacks wait, expected ${expected} (${model.disposed ? 'disposed' : model.running ? 'running' : 'stopped'})`);
      if (!model.running && !model.disposed && w.rng.chance(0.5)) (engine.start(), (model.running = true));
    }
    if (model.disposed) {
      w.closed = true;
      if (!stage.signal.aborted) w.violate('stage.signal not aborted by dispose');
      if (element.querySelector('canvas')) w.violate('the stage canvas is still in the page after dispose');
    } else close(w, stage, element);
  }));

test('stage picks answer for the mesh under the cursor while stage meshes are added and removed (B1 class)', () =>
  stress('stage-pick', 0x5b1, RUNS, async (w) => {
    const { stage, element } = await stageIn(w, { autoStart: false }),
      others = [];
    let hero = stage.box();
    w.cursor = () => hero;
    for (let s = 0; s < 30; s++) {
      const op = w.rng.pick(['pick', 'box', 'sphere', 'remove', 'hero', 'render', 'answer']);
      w.step(op);
      if (op === 'pick' && w.picks.filter((p) => !p.settled).length < 3) w.pick(stage.engine);
      else if (op === 'box') others.push(stage.box({ position: [w.rng(), 0, 0] }));
      else if (op === 'sphere') others.push(stage.sphere({ segments: 8 }));
      else if (op === 'remove' && others.length) w.disposeMesh(others.splice(w.rng.int(others.length), 1)[0]);
      else if (op === 'hero') {
        w.disposeMesh(hero);
        hero = stage.box();
      } else if (op === 'render') stage.engine.render();
      else if (op === 'answer') (w.answer(), await flush(1));
    }
    close(w, stage, element);
  }));

test('stage dispose while a pick or a feature load waits rejects or resolves each, and nothing runs after', () =>
  stress('stage-dispose-during-async', 0x5d5, RUNS, async (w) => {
    const { stage, element } = await stageIn(w),
      where = w.rng.pick(['direct', 'tick', 'onError']);
    let hero = stage.box(),
      attached = 0,
      disposeNow = false;
    w.cursor = () => hero;
    const loads = [],
      releases = [];
    for (let i = 1 + w.rng.int(2); i--; ) {
      const load = attachPlugin(
        stage,
        '@margoengine/stress-feature',
        () => new Promise((resolve) => releases.push(() => resolve({ ok: true }))),
        () => ({ name: `feature${i}`, setup: () => attached++ }),
      );
      loads.push(load.then(() => 'attached', (error) => (error?.name === 'AbortError' ? 'aborted' : `rejected ${error}`)));
    }
    for (let i = w.rng.int(3); i--; ) w.pick(stage.engine);
    const dispose = () => {
      if (!disposeNow) return;
      disposeNow = false;
      close(w, stage, element);
    };
    stage.onTick(() => where === 'tick' && dispose());
    stage.engine.onError = (error) => {
      w.report(error);
      if (where === 'onError') dispose();
    };
    disposeNow = true;
    if (where === 'direct') dispose();
    else {
      if (where === 'onError') {
        const error = new Error('trigger');
        w.expectOnce(error);
        stage.onTick(() => {
          if (disposeNow) throw error;
        });
      }
      stage.engine.start();
      w.refresh();
    }
    for (const release of releases) release();
    await flush();
    for (const outcome of await Promise.all(loads))
      if (outcome !== 'aborted') w.violate(`a feature load waiting at dispose ended ${outcome}`);
    if (attached) w.violate(`${attached} feature plugins attached after dispose`);
    hero = null;
  }));
