import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { Animator } = await import('/packages/animator/dist/index.js');
    const { addStateLayer } = await import('/packages/animator/dist/layers.js');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      exactSize: [128, 128],
      capacity: 256,
      camera: { position: [200, 100, 250], target: [0, 35, 0], far: 1000 },
    });
    const model = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb');
    const animator = Animator.attach(Animation.attach(model), { initial: 'walk', states: { walk: 'Walk' } });
    const upper = addStateLayer(animator, {
      graph: { initial: 'survey', states: { survey: 'Survey', run: 'Run' } },
      weight: 0.5,
      mask: model.nodes.map((_, id) => id),
    });
    animator.onPreUpdate(0.2);
    upper.graph.animator.transition('run', 0.1);
    animator.onPreUpdate(0.15);
    await engine.render({ delta: 0 });
    window.layerFixture = { engine };
    return {
      base: animator.state,
      layer: upper.graph.state,
      time: upper.graph.animator.time,
      finite: model.nodes.every((node) => Array.from(node.matrix).every(Number.isFinite)),
    };
  });
  assert.deepEqual(result, { base: 'walk', layer: 'run', time: 0.15, finite: true });
  const png = await decodePNG(await browser.page.locator('canvas').screenshot());
  let lit = 0;
  for (let i = 0; i < png.data.length; i += 4) if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 80) lit++;
  assert.ok(lit > 30, `rendered Fox layer pixels: ${lit}`);
  await browser.page.evaluate(() => window.layerFixture.engine.dispose());
  console.log('State layers rendered Fox PASS', result, { lit });
} finally {
  await browser.close();
}
