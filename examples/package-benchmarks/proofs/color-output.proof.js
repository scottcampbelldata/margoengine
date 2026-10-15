// Proof for ColorOutput (Display P3 / HDR canvas, 5h.c + 5l.i): without it attached, Tonemap makes exactly the GPU calls
// it made before (alone, DOF-sourced, as a PostStack's display effect before FXAA; resizes, option edits, LUT, format and
// sample-count changes, a rejected frame, device restoration, disposal; 1x and 4x), and TransparentCanvas/ColorBackground
// do too. ColorOutput itself on an sRGB/SDR display is covered by packages/environment/tests/output.test.js (identical
// configuration and GPU calls to an engine without it).
// Run: node examples/package-benchmarks/proofs/color-output.proof.js [ref] [pin] [--current]
// Pinned: 7dcc958 against 225b1d6, the commit that made this claim. --current: 7dcc958 against the working tree.
import assert from 'node:assert/strict';
import { refs, versions, ignoreAgx, entryAt } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';
import { wgsl } from '../../../packages/core/src/shaders.ts';

const { ref, pin } = refs('7dcc958', '225b1d6', '7dcc958'),
  { PostStack, FXAA, Bloom } = await entryAt('post', 'src/index.ts', pin); // the stack around the effects
const tonemap = await versions('tonemap', ref, undefined, pin),
  dof = await versions('dof', ref, undefined, pin),
  environment = await versions('environment', ref, undefined, pin);
let lut = 'LUT_3D_SIZE 33\n';
for (let b = 0; b < 33; b++)
  for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) lut += `${r / 32} ${g / 32} ${(b / 32) * 0.9}\n`;

function story(make, samples, edit) {
  // A minimal plugin host (PostStack attaches its members through it).
  const gpu = mockGPU(),
    plugins = new Map(),
    list = [{ order: 0, execute: (c) => c.draw() }],
    view = context(gpu, { samples, shader: wgsl, format: 'bgra8unorm' });
  const engine = {
    gpu: gpu.device,
    canvas: { getContext: () => null },
    plugins,
    hasPlugin: (name) => plugins.has(name),
    use(plugin) {
      plugin.setup(engine);
      plugin.registerPasses?.({ add: (pass) => list.push(pass) });
      plugins.set(plugin.name, plugin);
      return engine;
    },
    removePlugin(name) {
      const plugin = plugins.get(name);
      plugins.delete(name);
      plugin?.dispose?.();
    },
  };
  return gpu.record(() => {
    const effects = make(engine);
    for (const effect of effects) engine.use(effect);
    list.sort((a, b) => a.order - b.order);
    for (let i = 0; i < 24; i++) {
      if (i === 4) {
        view.state.width = 640;
        view.state.height = 360;
      }
      if (i === 9) view.state.depthFormat = 'depth32float';
      if (i === 12) view.state.samples = samples === 4 ? 1 : 4;
      if (i === 14) view.state.format = 'rgba8unorm';
      if (i === 18) for (const effect of effects) effect.onDeviceRestored?.(engine);
      edit(i, effects, view.state);
      view.begin(i);
      try {
        for (const pass of list) pass.execute(view.c);
      } catch (error) {
        gpu.note('throw', error.constructor.name, error.message);
      }
      view.end();
    }
    for (const effect of effects) effect.dispose();
  });
}
const grade = (i, e) => {
  if (i === 6) e.options.exposure = 1;
  if (i === 7) e.setLUT(lut);
  if (i === 8) e.options.curve = 'acescg';
  if (i === 10) e.options.curve = 'agx';
  if (i === 11) e.setLUT(null);
  if (i === 16) e.options.contrast = 9;
  if (i === 17) e.options.contrast = 1;
};
const cases = {
  'Tonemap alone': (side) => [[new tonemap[side].Tonemap({ curve: 'neutral' })], (i, [e]) => grade(i, e)],
  'DOF -> Tonemap': (side) => {
    const d = new dof[side].DOF();
    return [[d, new tonemap[side].Tonemap({ source: () => d.outputTexture })], (i, [, e]) => grade(i, e)];
  },
  'PostStack Bloom + Tonemap + FXAA': (side) => {
    const t = new tonemap[side].Tonemap({ curve: 'agx' });
    return [[new PostStack([new Bloom({ strength: 0.6 }), t, new FXAA()])], (i) => grade(i, t)];
  },
  'TransparentCanvas': (side) => [[new environment[side].TransparentCanvas()], () => {}],
  'ColorBackground gradient': (side) => [
    [new environment[side].ColorBackground({ color: '#336699', bottom: '#102030' })],
    (i, [e]) => {
      if (i === 6) e.color = '#ff0000';
    },
  ],
};
let calls = 0;
for (const [label, make] of Object.entries(cases))
  for (const samples of [1, 4]) {
    const run = (side) => {
      let edit;
      const expected = story(
        () => {
          const [effects, e] = make(side);
          edit = e;
          return effects;
        },
        samples,
        (...args) => edit(...args),
      );
      return ignoreAgx(expected, ref);
    };
    const expected = run('baseline');
    assert.ok(expected.length > 100, `${label} story must exercise the GPU`);
    assert.deepEqual(run('candidate'), expected, `${label} GPU calls differ at ${samples}x`);
    calls += expected.length;
  }
console.log(
  `Without ColorOutput, GPU call sequences identical to ${ref}: ${calls} recorded calls across ${Object.keys(cases).length * 2} stories.`,
);
