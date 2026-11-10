import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionPresetWGSL, transitionPresets, createPresetTransition } from '../dist/presets.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('preset parameters validate before GPU access and own their generated constants', () => {
  assert.deepEqual(transitionPresets, [
    'slide',
    'push',
    'zoom',
    'iris',
    'cube',
    'page-curl',
    'swirl',
    'fade-through-color',
  ]);
  assert.ok(Object.isFrozen(transitionPresets));
  for (const bad of ['other', null, 0]) assert.throws(() => transitionPresetWGSL(bad), RangeError);
  for (const options of [
    { direction: [0, 0] },
    { direction: [Infinity, 0] },
    { direction: [1] },
    { center: [-1, 0] },
    { color: [0, 0, 0] },
    { color: [0, 0, NaN, 1] },
    { softness: -1 },
    { softness: NaN },
    { strength: 0 },
    { strength: 9 },
    { easing: 'other' },
  ])
    assert.throws(() => transitionPresetWGSL('push', options), RangeError);
  const options = { direction: [2, 0], color: [1, 0, 0, 1] };
  const code = transitionPresetWGSL('fade-through-color', options);
  options.color[0] = 0;
  assert.equal(code, transitionPresetWGSL('fade-through-color', { direction: [1, 0], color: [1, 0, 0, 1] }));
  assert.notEqual(code, transitionPresetWGSL('fade-through-color', options));
});

test('every preset attaches through the validated custom path and disposes all owned resources', async () => {
  for (const kind of transitionPresets) {
    const h = optionalGPU(),
      d = h.engine.gpu;
    d.pushErrorScope = () => {};
    d.popErrorScope = async () => null;
    d.createPipelineLayout = (x) => x;
    d.createShaderModule = (x) => ({ ...x, getCompilationInfo: async () => ({ messages: [] }) });
    d.createRenderPipelineAsync = async (x) => d.createRenderPipeline(x);
    const effect = await createPresetTransition(h.engine, kind);
    h.frame();
    effect.start('wipe', 1);
    h.frame();
    assert.equal(effect.progress, 0.1);
    effect.dispose();
    assert.ok(h.resources.every((r) => r.destroyed));
    const c = new AbortController();
    c.abort();
    await assert.rejects(createPresetTransition(h.engine, kind, { signal: c.signal }), { name: 'AbortError' });
    assert.equal(h.engine.plugins.size, 0);
  }
});
