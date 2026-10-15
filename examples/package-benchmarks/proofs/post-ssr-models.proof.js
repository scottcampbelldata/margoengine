// Proof for SSR's model capture (`ssr.add(model)`, HANDOFF 5l.l): with no model added, SSR makes exactly the GPU calls it
// made at 3cf1453 (before the capture), and stacks without SSR are unchanged too, over a story of resizes, option edits,
// SSR toggles, depth-format, sample-count and canvas-format changes, a rejected frame, device restoration and disposal at
// 1x and 4x, with core's plain shader and with an IBL-patched one (margoAmbient + environment's BRDF helper).
// gltf-pro's side (no capture hook set: identical calls) is oit-detached.proof.js and gltf-pro-lighting-hooks.proof.js
// run with the commit before the capture as ref.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/post-ssr-models.proof.js [ref]
import assert from 'node:assert/strict';
import {versions} from './compare.js';
import {mockGPU, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';

const ref = process.argv[2] ?? '3cf1453', post = await versions('post', ref);
const ibl = wgsl.replace(/let linear=([^;]+);/, 'let margoAmbient=vec3f(0.5);let linear=$1+margoAmbient;') + '\nfn iblBrdfTerms(nv:f32,r:f32)->vec2f {return vec2f(1,0);}';

function story(m, make, samples, shader) {
  const gpu = mockGPU(), passes = [{order: 0, execute: c => c.draw()}], plugins = new Map();
  const engine = {gpu: gpu.device, hasPlugin: name => plugins.has(name),
    use(plugin) {plugin.setup(engine); plugin.registerPasses?.({add: pass => passes.push(pass)}); plugins.set(plugin.name, plugin); passes.sort((a, b) => a.order - b.order);},
    removePlugin(name) {const plugin = plugins.get(name); plugins.delete(name); plugin?.dispose?.();}};
  const view = context(gpu, {samples, shader, format: 'bgra8unorm'});
  return gpu.record(() => {
    const effects = make(m), stack = new m.PostStack(effects); engine.use(stack);
    for (let i = 0; i < 24; i++) {
      if (i === 4) {view.state.width = 640; view.state.height = 360;}
      if (i === 9) view.state.depthFormat = 'depth32float';
      if (i === 12) view.state.samples = samples === 4 ? 1 : 4;
      if (i === 14) view.state.format = 'rgba8unorm';
      if (i === 18) for (const plugin of plugins.values()) plugin.onDeviceRestored?.(engine);
      for (const effect of effects) {
        if (effect instanceof m.SSR) {if (i === 5) effect.options.steps = 16; if (i === 7) effect.enabled = false; if (i === 8) effect.enabled = true; if (i === 16) effect.options.maxRoughness = 0; if (i === 17) effect.options.maxRoughness = 0.4;}
        if (effect instanceof m.SSAO) {if (i === 6) effect.options.radius = 2;}
        if (effect instanceof m.Bloom) {if (i === 8) effect.options.strength = 3;}
      }
      view.begin(i);
      try {for (const pass of passes) pass.execute(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
      view.end();
    }
    stack.dispose();
  });
}
const lists = {
  'SSR': m => [new m.SSR()],
  'SSAO, SSR, Bloom, FXAA': m => [new m.SSAO(), new m.SSR({maxRoughness: 0.8}), new m.Bloom({strength: 0.6}), new m.FXAA()],
  'SSAO, Bloom, FXAA': m => [new m.SSAO(), new m.Bloom({strength: 0.6}), new m.FXAA()],
  'FXAA': m => [new m.FXAA()],
};
let calls = 0, stories = 0;
for (const [label, make] of Object.entries(lists)) for (const samples of [1, 4]) for (const [name, shader] of [['core', wgsl], ['IBL', ibl]]) {
  const expected = story(post.baseline, make, samples, shader), actual = story(post.candidate, make, samples, shader);
  assert.ok(expected.length > 300, `${label} story must exercise the GPU`);
  assert.deepEqual(actual, expected, `PostStack [${label}] GPU calls differ at ${samples}x (${name} shader)`); calls += expected.length; stories++;
}
assert.ok(typeof post.candidate.SSR.prototype.add === 'function' && !post.baseline.SSR.prototype.add, 'candidate has ssr.add, baseline does not');
console.log(`SSR without added models and stacks without SSR: GPU call sequences identical to ${ref}: ${calls} recorded calls across ${stories} stories.`);
