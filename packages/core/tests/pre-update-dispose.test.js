// KB-STRESS-2 (core stress check, seeds 2654435943 and stage 1462, 2026-11-15): dispose() inside a plugin's
// onPreUpdate went on with the frame. update() resized, ticked the transform store dispose() had just freed, and threw
// "Transforms disposed", which the frame loop reported through onError for a dispose the app asked for. With views, the
// next view then threw "Engine disposed", and a renderer that does not ignore draws after dispose (an
// EngineOptions.fallback) was drawn through after it was freed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera, Engine } from '../dist/index.js';
import { frames, install } from './fake-gpu.js';

const quitter = (engine) => ({ name: 'quitter', setup() {}, onPreUpdate: () => engine.dispose() });

// A fallback renderer that records each draw and whether it came after its own dispose.
function recorder() {
  const renderer = {
    backend: 'webgl2',
    disposed: false,
    draws: [],
    add() {},
    remove() {},
    render: (camera, lighting, batches, graph, delta, view) => renderer.draws.push({ view, disposed: renderer.disposed }),
    dispose: () => (renderer.disposed = true),
  };
  return renderer;
}

test('dispose() inside onPreUpdate in the frame loop ends the frame and reports nothing', async () => {
  const gpu = install(),
    raf = frames();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
      errors = [];
    engine.onError = (error) => errors.push(error);
    engine.use(quitter(engine));
    engine.start();
    raf.refresh(16);
    assert.deepEqual(errors, [], 'no "Transforms disposed" for a dispose the app asked for');
    assert.equal(raf.queue.size, 0, 'the disposed engine schedules nothing');
    assert.equal(gpu.devices[0].submits, 0, 'nothing drew');
  } finally {
    raf.uninstall();
    gpu.uninstall();
  }
});

test('dispose() inside onPreUpdate during render() returns without a throw or a draw', async () => {
  const gpu = install();
  try {
    const renderer = recorder(),
      engine = await Engine.create(gpu.canvas, { capacity: 8, backend: 'webgl2', fallback: () => renderer });
    engine.use(quitter(engine));
    assert.doesNotThrow(() => engine.render());
    assert.equal(engine.disposed, true);
    assert.deepEqual(renderer.draws, [], 'the freed renderer is not drawn through');
  } finally {
    gpu.uninstall();
  }
});

test('dispose() inside onPreUpdate with views draws no later view', async () => {
  const gpu = install();
  try {
    const renderer = recorder(),
      engine = await Engine.create(gpu.canvas, { capacity: 8, backend: 'webgl2', fallback: () => renderer }),
      second = engine.createScene();
    // The second scene's plugin disposes: its onPreUpdate runs at the second view, after the first view drew.
    engine.use(quitter(engine), second);
    const views = [
      { camera: new Camera(), viewport: [0, 0, 0.5, 1] },
      { camera: new Camera(), viewport: [0.5, 0, 0.5, 1], scene: second },
      { camera: new Camera(), viewport: [0, 0, 1, 1] },
    ];
    assert.doesNotThrow(() => engine.render({ views }));
    assert.equal(engine.disposed, true);
    assert.equal(renderer.draws.length, 1, 'only the view before the dispose drew');
    assert.equal(renderer.draws[0].disposed, false);
  } finally {
    gpu.uninstall();
  }
});

test('an error a plugin throws after dispose() in onPreUpdate is still reported', async () => {
  const gpu = install();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
      mine = new Error('the app throws');
    engine.use({
      name: 'thrower',
      setup() {},
      onPreUpdate: () => {
        engine.dispose();
        throw mine;
      },
    });
    assert.throws(() => engine.render(), (error) => error === mine);
  } finally {
    gpu.uninstall();
  }
});
