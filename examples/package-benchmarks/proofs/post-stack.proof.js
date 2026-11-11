// Proof for the PostStack change: every effect used alone (post Bloom and SSAO, dof, tonemap alone and DOF-sourced,
// creative PostProcessing) makes exactly the GPU calls it made before, over a story of resizes, option edits, format
// and sample-count changes, a rejected frame, device restoration and disposal at 1x and 4x.
// Run: node examples/package-benchmarks/proofs/post-stack.proof.js [ref] [pin] [--current]
// Pinned: 5b1fe66^ against 5b1fe66, the commit that added PostStack and made this claim. --current: 57250a49 against the
// working tree, including the approved multilevel Bloom, PBR Neutral display and Tonemap default (claims.md).
// creative's PostProcessing is always 5b1fe66^ against 3319317: it lost bloom and the sky backdrop after 3319317.
import assert from 'node:assert/strict';
import { refs, versions, ignoreAgx, golden, fact, readOnly, coreAt } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';

const before = '5b1fe66^',
  { ref, pin } = refs(before, '5b1fe66', 'bc82057e40'),
  { wgsl } = await coreAt(pin);
const post = await versions('post', ref, undefined, pin),
  dof = await versions('dof', ref, undefined, pin),
  tonemap = await versions('tonemap', ref, undefined, pin);
// creative's pair is historical in every mode (5b1fe66^ -> 3319317); a --current run reading golden outputs has neither
// commit, so it reads the pair's stored result, a fact about those two commits.
const creative = readOnly() ? {} : await versions('creative', before, 'src/post.ts', '3319317');

/** Runs `effects` (made by `make(gpu)`) with the core main pass for 24 frames, applying `edit(frame, effects, state)` first. */
function story(make, samples, edit) {
  const gpu = mockGPU(),
    engine = { gpu: gpu.device, hasPlugin: () => false, sceneOf: () => undefined, removePlugin() {} },
    view = context(gpu, { samples, shader: wgsl, format: 'bgra8unorm' });
  return gpu.record(() => {
    const effects = make(engine),
      list = [{ order: 0, execute: (c) => c.draw() }];
    for (const effect of effects) {
      effect.setup(engine);
      effect.registerPasses({ add: (pass) => list.push(pass) });
    }
    list.sort((a, b) => a.order - b.order);
    for (let i = 0; i < 24; i++) {
      if (i === 4) {
        view.state.width = 640;
        view.state.height = 360;
      }
      if (i === 9) view.state.depthFormat = 'depth32float';
      if (i === 12) view.state.samples = samples === 4 ? 1 : 4;
      if (i === 14) view.state.format = 'rgba8unorm';
      if (i === 18) for (const effect of effects) effect.onDeviceRestored(engine);
      edit(i, effects, view.state);
      view.begin(i);
      try {
        for (const pass of list) pass.execute(view.c);
      } catch (error) {
        gpu.note('throw');
      }
      view.end();
    }
    for (const effect of effects) effect.dispose();
  });
}
const cases = {
  'post Bloom': [
    (m) => [new m.Bloom({ strength: 0.6 })],
    (i, [e]) => {
      if (i === 6) e.options.threshold = 2;
      if (i === 16) e.options.strength = 9;
      if (i === 17) e.options.strength = 1;
    },
    post,
  ],
  'post SSAO': [
    (m) => [new m.SSAO()],
    (i, [e]) => {
      if (i === 6) e.options.radius = 2;
      if (i === 8) e.enabled = false;
      if (i === 10) e.enabled = true;
      if (i === 16) e.options.samples = 0;
      if (i === 17) e.options.samples = 8;
    },
    post,
  ],
  'dof DOF': [
    (m) => [new m.DOF({ aperture: 2 })],
    (i, [e]) => {
      if (i === 6) e.options.focalDistance = 8;
      if (i === 8) e.enabled = false;
      if (i === 16) e.options.aperture = -1;
      if (i === 17) e.options.aperture = 4;
    },
    dof,
  ],
  'tonemap Tonemap': [
    (m) => [new m.Tonemap({ curve: 'neutral' })],
    (i, [e]) => {
      if (i === 6) e.options.exposure = 1;
      if (i === 8) e.options.curve = 'acescg';
      if (i === 16) e.options.contrast = 9;
      if (i === 17) e.options.contrast = 1;
    },
    tonemap,
  ],
  'creative PostProcessing': [
    (m) => [new m.PostProcessing({ bloom: 0.5, atmosphere: { sky: true, density: 0.1 } })],
    (i, [e]) => {
      if (i === 6) e.options.bloom = 0;
      if (i === 8) e.options.bloom = 1;
      if (i === 16) e.options.grain = 2;
      if (i === 17) e.options.grain = 0.1;
    },
    creative,
  ],
};
let calls = 0;
for (const [label, [make, edit, module]] of Object.entries(cases))
  for (const samples of [1, 4]) {
    const base = module === creative ? before : ref;
    const compare = (expected, actual) => {
      assert.ok(
        expected.length > 300 && expected.some((entry) => entry[0] === 'throw'),
        `${label} story must exercise the GPU and an error path`,
      );
      assert.deepEqual(actual, expected, `${label} GPU calls differ at ${samples}x`);
      return expected.length;
    };
    if (module === creative) {
      calls += fact(`${label} ${samples}x: ${before} -> 3319317 identical calls`, () =>
        compare(
          ignoreAgx(
            story(() => make(module.baseline), samples, edit),
            base,
          ),
          ignoreAgx(
            story(() => make(module.candidate), samples, edit),
            base,
          ),
        ),
      );
      continue;
    }
    const expected = await golden(`${label} ${samples}x`, () =>
        ignoreAgx(
          story(() => make(module.baseline), samples, edit),
          base,
        ),
      ),
      actual = ignoreAgx(
        story(() => make(module.candidate), samples, edit),
        base,
      );
    assert.ok(
      expected.length > 300 && expected.some((entry) => entry[0] === 'throw'),
      `${label} story must exercise the GPU and an error path`,
    );
    assert.deepEqual(actual, expected, `${label} GPU calls differ at ${samples}x`);
    calls += expected.length;
  }
// The documented DOF -> Tonemap({source}) chain, both packages at once.
for (const samples of [1, 4]) {
  const chain = (side) =>
    ignoreAgx(
      story(
        () => {
          const d = new dof[side].DOF();
          return [d, new tonemap[side].Tonemap({ source: () => d.outputTexture })];
        },
        samples,
        () => {},
      ),
      ref,
    );
  const expected = await golden(`DOF -> Tonemap ${samples}x`, () => chain('baseline'));
  assert.deepEqual(chain('candidate'), expected, `DOF -> Tonemap chain differs at ${samples}x`);
  calls += expected.length;
}
console.log(
  `Single-effect GPU sequences match the historical tape, ${ref} -> ${pin ?? 'working tree'} (creative: ${before} -> 3319317): ${calls} control calls across 12 stories.`,
);
