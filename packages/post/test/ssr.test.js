import test from 'node:test';
import assert from 'node:assert/strict';
import {mockGPU, context} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {FrameGraph} from '../../core/dist/extension.js';
import {wgsl} from '../../core/dist/shaders.js';
import {PostStack, SSR, SSAO} from '../dist/index.js';

function harness(samples = 4, shader = wgsl) {
  const gpu = mockGPU(), graph = new FrameGraph(), plugins = new Map(), resources = []; let host = false;
  for (const kind of ['createTexture', 'createBuffer']) {const create = gpu.device[kind]; gpu.device[kind] = descriptor => {const r = create(descriptor); if (!host) resources.push(r); return r;};}
  const engine = {gpu: gpu.device, frameGraph: graph, hasPlugin: name => plugins.has(name),
    use(plugin) {
      if (plugins.has(plugin.name)) throw new TypeError('Invalid plugin');
      try {graph.withOwner(plugin.name, () => {plugin.setup(engine); plugin.registerPasses?.(graph);}); plugins.set(plugin.name, plugin);}
      catch (error) {graph.removeOwner(plugin.name); plugin.dispose?.(); throw error;}
      return engine;
    },
    removePlugin(name) {const plugin = plugins.get(name); if (plugin) {graph.removeOwner(name); plugins.delete(name); plugin.dispose?.();}}};
  const view = context(gpu, {samples, shader, format: 'bgra8unorm'}), draws = []; let index = 0;
  const frame = (bindings = []) => {host = true; view.begin(index++); host = false; view.c.bindings.push(...bindings); view.c.draw = o => draws.push({...o, color: view.c.color, descriptor: view.c.descriptor}); graph.execute(view.c);};
  return {gpu, engine, view, plugins, draws, frame, live: () => resources.filter(r => !r.destroyed)};
}
const modules = log => log.filter(e => e[0] === 'module').map(e => e[2].code);
const ibl = wgsl.replace(/let linear=([^;]+);/, 'let margoAmbient=vec3f(0.5);let linear=$1+margoAmbient;') + '\nfn iblBrdfTerms(nv:f32,r:f32)->vec2f {return vec2f(1,0);}';

for (const samples of [4, 1]) test(`SSR replays core materials into its targets and composes the stack input (${samples}x)`, () => {
  const h = harness(samples), ssr = new SSR(), taa = {binding: 8, resource: {buffer: {}}}, env = {binding: 20, resource: {}};
  h.engine.use(new PostStack([ssr]));
  const log = h.gpu.record(() => h.frame([taa, env]));
  const replay = modules(log).find(code => code.includes('struct Input'));
  // The whole lit shader stays (every pass binding statically used); the fragment returns the three material targets.
  assert.match(replay, /->MargoSSR \{/);
  assert.match(replay, /if\(false\)\{let direct=[\s\S]*_=vec4f\(linear,1\);\}return margoSSR\(n,v,i\.color,i\.material\.y,i\.material\.x\);\s*\}/);
  assert.match(replay, /exp2\(-9\.28\*nv\)/, 'no IBL: analytic split-sum weight');
  assert.doesNotMatch(replay, /iblBrdfTerms\(nv,rough\)/);
  const replays = h.draws.filter(d => d.pipeline); assert.equal(replays.length, 1); const [draw] = replays;
  assert.deepEqual(draw.bindings.map(e => e.binding), [8, 20]); assert.equal(draw.colorAttachments.length, 2);
  // 1x: depth-equal against the scene depth; 4x: a 1x replay into SSR's own cleared depth (no multisampled targets).
  assert.equal(draw.descriptor.multisample.count, 1); assert.equal(draw.clear, samples === 4);
  const pipeline = log.find(e => e[0] === 'renderPipeline' && e[2].fragment?.targets?.length === 3)[2];
  assert.deepEqual(pipeline.fragment.targets.map(t => t.format), ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm']);
  assert.equal(pipeline.multisample.count, 1);
  assert.deepEqual([pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled], samples === 4 ? ['greater-equal', true] : ['equal', false]);
  assert.deepEqual(log.filter(e => e[0] === 'texture' && ['rgb10a2unorm', 'r32float'].includes(e[2].format)).map(e => e[2].sampleCount ?? 1), [1, 1, 1], 'no multisampled SSR targets');
  // Composite: one fullscreen pass into the frame target (SSR is the stack's last effect, so it tone maps).
  const composite = modules(log).find(code => code.includes('fn closest('));
  assert.match(composite, /c=c\/\(1\+c\);/);
  // Steady frames create no GPU objects.
  const steady = h.gpu.record(() => h.frame([taa, env]));
  assert.deepEqual(steady.filter(e => /^(texture|buffer|module|group|renderPipeline|computePipeline|view|sampler)$/.test(e[0])), []);
  // Resize releases sized targets; dispose releases everything.
  const before = h.live().length; h.view.state.width = 640; h.frame(); assert.equal(h.live().length, before);
  ssr.dispose(); h.engine.removePlugin('post:stack'); assert.deepEqual(h.live(), []);
});

test('SSR replaces the IBL specular from EnvironmentLighting (margoAmbient + its BRDF LUT)', () => {
  const h = harness(4, ibl); h.engine.use(new PostStack([new SSAO(), new SSR()]));
  const code = modules(h.gpu.record(() => h.frame())).filter(code => code.includes('margoSSR'));
  assert.equal(code.length, 1);
  assert.match(code[0], /let ab=iblBrdfTerms\(nv,rough\);let w=f0\*ab\.x\+ab\.y;let e=iblPrefiltered\(iblSpecular,iblSampler,iblParams,reflect\(-v,n\),rough\)\*w\*iblParams\.w;/);
});

test('SSR.attach runs alone in its own PostStack; options are validated', () => {
  const h = harness(4), ssr = SSR.attach(h.engine, {maxRoughness: 0.4});
  assert.ok(h.plugins.has('post:stack') && h.plugins.has('ssr'));
  h.frame(); ssr.dispose(); assert.ok(!h.plugins.has('post:stack') && !h.plugins.has('ssr')); assert.deepEqual(h.live(), []);
  assert.throws(() => h.engine.use(new SSR()), /PostStack/);
  for (const options of [{maxRoughness: 0}, {maxRoughness: 1.5}, {thickness: 0}, {maxDistance: Infinity}, {steps: 0}, {steps: 1.5}, {enabled: 1}]) assert.throws(() => new SSR(options), RangeError);
  const effect = new SSR(); effect.enabled = false; assert.equal(effect.enabled, false); assert.throws(() => {effect.enabled = 1;}, TypeError);
});

test('disabled SSR skips the replay, Hi-Z and blur and passes the input through', () => {
  const h = harness(4), ssr = new SSR({enabled: false}); h.engine.use(new PostStack([ssr])); h.frame();
  const log = h.gpu.record(() => h.frame());
  assert.equal(h.draws.filter(d => d.pipeline).length, 0);
  assert.equal(log.filter(e => e[0] === 'beginComputePass').length, 0);
  assert.equal(log.filter(e => e[0] === 'beginRenderPass').length, 1 + 3, 'composite plus the stack final depth copies and resolve');
});
