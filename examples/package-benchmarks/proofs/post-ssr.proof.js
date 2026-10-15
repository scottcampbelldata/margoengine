// Proof for SSR (@margoengine/post/ssr): a PostStack without SSR makes exactly the GPU calls it made before SSR existed,
// over a story of resizes, option edits, depth-format, sample-count and canvas-format changes, a rejected frame, device
// restoration and disposal at 1x and 4x, for several effect lists. (The single-effect stories are post-stack.proof.js.)
// Run: node examples/package-benchmarks/proofs/post-ssr.proof.js [ref]   (ref: the commit before SSR, default 7c47a09)
import assert from 'node:assert/strict';
import {versions} from './compare.js';
import {mockGPU, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';

const ref = process.argv[2] ?? '7c47a09', post = await versions('post', ref);

function story(m, make, samples) {
  const gpu = mockGPU(), passes = [{order: 0, execute: c => c.draw()}], plugins = new Map();
  const engine = {gpu: gpu.device, hasPlugin: name => plugins.has(name),
    use(plugin) {plugin.setup(engine); plugin.registerPasses?.({add: pass => passes.push(pass)}); plugins.set(plugin.name, plugin); passes.sort((a, b) => a.order - b.order);},
    removePlugin(name) {const plugin = plugins.get(name); plugins.delete(name); plugin?.dispose?.();}};
  const view = context(gpu, {samples, shader: wgsl, format: 'bgra8unorm'});
  return gpu.record(() => {
    const effects = make(m), stack = new m.PostStack(effects); engine.use(stack);
    for (let i = 0; i < 24; i++) {
      if (i === 4) {view.state.width = 640; view.state.height = 360;}
      if (i === 9) view.state.depthFormat = 'depth32float';
      if (i === 12) view.state.samples = samples === 4 ? 1 : 4;
      if (i === 14) view.state.format = 'rgba8unorm';
      if (i === 18) for (const plugin of plugins.values()) plugin.onDeviceRestored?.(engine);
      for (const effect of effects) {
        if (effect instanceof m.SSAO) {if (i === 6) effect.options.radius = 2; if (i === 16) effect.options.samples = 0; if (i === 17) effect.options.samples = 8;}
        if (effect instanceof m.Bloom) {if (i === 6) effect.options.threshold = 2; if (i === 8) effect.options.strength = 3;}
      }
      view.begin(i);
      try {for (const pass of passes) pass.execute(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
      view.end();
    }
    stack.dispose();
  });
}
const lists = {
  'SSAO, Bloom, FXAA': m => [new m.SSAO(), new m.Bloom({strength: 0.6}), new m.FXAA()],
  'SSAO': m => [new m.SSAO()],
  'Bloom, FXAA': m => [new m.Bloom(), new m.FXAA()],
  'FXAA': m => [new m.FXAA()],
};
let calls = 0;
for (const [label, make] of Object.entries(lists)) for (const samples of [1, 4]) {
  const expected = story(post.baseline, make, samples), actual = story(post.candidate, make, samples);
  assert.ok(expected.length > 300, `${label} story must exercise the GPU`);
  assert.deepEqual(actual, expected, `PostStack [${label}] GPU calls differ at ${samples}x`); calls += expected.length;
}
assert.ok(post.candidate.SSR && !post.baseline.SSR, 'candidate has SSR, baseline does not');
console.log(`PostStack without SSR: GPU call sequences identical to ${ref}: ${calls} recorded calls across ${Object.keys(lists).length * 2} stories.`);
