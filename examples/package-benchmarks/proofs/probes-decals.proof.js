// Proof that light probes (`@margoengine/environment/probes`) and decals (`@margoengine/post/decals`) cost nothing for apps
// that do not import them:
// 1. Every pre-existing entry of environment and post (and clustered, gltf-pro, materials, terrain, which the probes
//    reach) bundles (Vite, minified, bare imports external, src and packages/shared from the ref) to the same bytes at `ref`
//    and in the working tree, except the entries holding the SSR off-screen fallback (post's ssr.ts, gltf-pro's capture
//    hook), whose new text is emitted only next to LightProbes' `probeSpecular`; their GPU calls without probes are
//    proven identical by post-ssr.proof.js, post-ssr-models.proof.js, gltf-pro-lighting-hooks.proof.js and
//    oit-detached.proof.js run with the same ref. The other edit is `export` on environment's ShaderEffect.
// 2. GPU calls: a 6-frame story of EnvironmentLighting + Fog on core's shader and a gltf-pro model records identical calls
//    at `ref` and now, also with a LightProbes constructed but never attached; Decals with an empty list records nothing.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/probes-decals.proof.js [ref]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {isAbsolute, resolve} from 'node:path';
import {build} from 'vite';
import {versions} from './compare.js';
import {mockGPU, context, passes} from './gpu-recorder.js';
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';
import * as gltf from '../../../packages/gltf-pro/dist/index.js';
import {LightProbes} from '../../../packages/environment/dist/probes.js';
import {Decals} from '../../../packages/post/dist/decals.js';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';

const ref = process.argv[2] ?? 'ecdcb31', root = resolve(import.meta.dirname, '../../..'), slash = v => v.replaceAll('\\', '/');
const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {cwd: root, encoding: 'utf8'}).trim();
const show = file => {try {return execFileSync('git', ['show', `${commit}:${file}`], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26});} catch {return undefined;}};
const bare = id => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id) && !id.startsWith('\0');
async function bundle(name, entry, fromRef) {
  const sources = [slash(resolve(root, 'packages', name, 'src')) + '/', slash(resolve(root, 'packages/shared')) + '/'];
  const plugins = fromRef ? [{name: 'git-source', enforce: 'pre', load(id) {const file = slash(id.split('?')[0]); if (sources.some(s => file.startsWith(s))) return show(file.slice(slash(root).length + 1));}}] : [];
  const out = await build({root: resolve(root, 'packages', name), configFile: false, publicDir: false, logLevel: 'silent', plugins,
    build: {write: false, minify: true, target: 'es2022', lib: {entry: resolve(root, 'packages', name, entry), formats: ['es']}, rollupOptions: {external: bare}}});
  return out[0].output.filter(item => item.type === 'chunk').map(chunk => chunk.code).join('\n');
}
// Existing sources edited: environment's lighting.ts (`export`), and the SSR off-screen fallback: post's ssr.ts and
// gltf-pro's capture hook (shader.ts) emit new text only when the shader holds LightProbes' `probeSpecular`.
const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=M', commit, '--', ...['environment', 'post', 'clustered', 'gltf-pro', 'materials', 'terrain', 'shared'].map(n => `packages/${n}/src`), 'packages/shared'], {cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean);
assert.deepEqual(changed, ['packages/environment/src/lighting.ts', 'packages/gltf-pro/src/shader.ts', 'packages/post/src/ssr.ts'], 'unexpected edits to existing sources');
let entries = 0;const differ = [];
for (const name of ['environment', 'post', 'clustered', 'gltf-pro', 'materials', 'terrain']) {
  const manifest = JSON.parse(show(`packages/${name}/package.json`));
  for (const [path, target] of Object.entries(manifest.exports)) {
    const entry = target.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts');
    const now = await bundle(name, entry, false);
    if (now === await bundle(name, entry, true)) entries++; else {differ.push(name + path.slice(1)); assert.ok(now.includes('margoPosition'), `${name}${path.slice(1)} changed for another reason`);}
  }
}
// Those entries' GPU calls without probes: post-ssr.proof.js, post-ssr-models.proof.js, gltf-pro-lighting-hooks.proof.js
// and oit-detached.proof.js with this ref (identical, recorded in HANDOFF 5l.e).
assert.ok(differ.includes('post/ssr') && differ.includes('gltf-pro'), 'the SSR wiring is in the bundles');
// GPU calls of the scene effects the probes share code with (environment root), before and after.
const {baseline, candidate} = await versions('environment', commit);
async function story(environment, withProbes) {
  const gpu = mockGPU(), store = await TransformStore.create(32), canvas = {width: 128, height: 96, clientWidth: 128, clientHeight: 96};
  const renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine(canvas, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const fixture = animatedTriangle(); delete fixture.doc.skins; delete fixture.doc.animations;
  const env = {device: gpu.device, disposed: false, version: 0, specularView: gpu.device.createTexture({size: [4, 4, 6], format: 'rgba16float'}).createView(), sampler: gpu.device.createSampler(), brdfLut: gpu.device.createBuffer({size: 64}), shBuffer: gpu.device.createBuffer({size: 144}), paramsBuffer: gpu.device.createBuffer({size: 16}), restore: () => Promise.resolve()};
  const log = gpu.record(() => {
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers); engine.camera.update(4 / 3, true); store.tick(false);
    const lighting = new environment.EnvironmentLighting(env), fog = new environment.Fog({color: '#808080', near: 2, far: 30});
    lighting.setup(engine); fog.setup(engine); lighting.add(model); fog.add(model);
    if (withProbes) new LightProbes({volume: {min: [-1, -1, -1], max: [1, 1, 1], counts: [2, 2, 2]}});
    for (const samples of [1, 4]) {
      const view = context(gpu, {samples, shader: wgsl}), run = [passes(lighting), passes(fog)];
      for (let frame = 0; frame < 3; frame++) {if (frame === 1) fog.density = 0.05; view.begin(frame); for (const r of run) r(view.c); view.end(); gpu.note('draw', frame); model.draw(view.c, 'beauty', view.c.color, view.c.depth);}
    }
    model.dispose(); lighting.dispose(); fog.dispose();
  });
  engine.dispose();
  return log;
}
const expected = await story(baseline, false);
assert.ok(expected.some(e => e[0] === 'module' && /margoAmbient/.test(e[2].code)) && expected.some(e => e[0] === 'context' && /fogAmount/.test(e[1])), 'story must light and fog the model and core');
assert.deepEqual(await story(candidate, false), expected, 'environment GPU calls differ');
assert.deepEqual(await story(candidate, true), expected, 'an unattached LightProbes changed GPU calls');
// An attached Decals without decals records no GPU work in its pass (a frame's calls are the same with and without it).
const gpu = mockGPU(), decals = new Decals(); decals.setup({gpu: gpu.device, removePlugin() {}});
const view = context(gpu, {samples: 4, shader: 'lit'}); view.begin(0);
assert.deepEqual(gpu.record(() => {view.begin(1); passes(decals)(view.c);}), [], 'an empty Decals recorded GPU calls');
// 3. The SSR fallback wiring without probes: PostStack [SSR] and [SSAO, SSR, Bloom, FXAA] over core's plain and IBL-patched
//    shaders, with a gltf-pro model reflecting through SSR's capture hook, 1x/4x, 12 frames (resize, option edits, toggle,
//    restore): post and gltf-pro at `ref` and now record identical GPU calls. With LightProbes' shader the replay and the
//    capture record the pixel position and remove probeSpecular.
const post = await versions('post', commit), pro = await versions('gltf-pro', commit);
const ibl = wgsl.replace(/let linear=([^;]+);/, 'let margoAmbient=vec3f(0.5);let linear=$1+margoAmbient;') + '\nfn iblBrdfTerms(nv:f32,r:f32)->vec2f {return vec2f(1,0);}';
async function ssrStory(m, g, make, samples, shader) {
  const gpu = mockGPU(), passList = [{order: 0, execute: c => c.draw()}], plugins = new Map(), store = await TransformStore.create(32);
  const core = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}}, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const engine = {gpu: gpu.device, hasPlugin: name => plugins.has(name), use(plugin) {plugin.setup(engine); plugin.registerPasses?.({add: pass => passList.push(pass)}); plugins.set(plugin.name, plugin); passList.sort((a, b) => a.order - b.order);},
    removePlugin(name) {const plugin = plugins.get(name); plugins.delete(name); plugin?.dispose?.();}};
  const view = context(gpu, {samples, shader, format: 'bgra8unorm'}), fixture = animatedTriangle(); delete fixture.doc.skins; delete fixture.doc.animations;
  const log = gpu.record(() => {
    const model = g.parseGLTF(core, fixture.doc, fixture.buffers); core.camera.update(4 / 3, true); store.tick(false);
    const effects = make(m), stack = new m.PostStack(effects); engine.use(stack); const ssr = effects.find(e => e instanceof m.SSR); ssr.add(model);
    for (let i = 0; i < 12; i++) {
      if (i === 3) {view.state.width = 640; view.state.height = 360;}
      if (i === 5) ssr.options.steps = 16; if (i === 6) ssr.enabled = false; if (i === 7) ssr.enabled = true;
      if (i === 9) for (const plugin of plugins.values()) plugin.onDeviceRestored?.(engine);
      view.begin(i); try {for (const pass of passList) pass.execute(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);} view.end();
    }
    stack.dispose(); model.dispose();
  });
  core.dispose();
  return log;
}
const lists = {'SSR': m => [new m.SSR()], 'SSAO, SSR, Bloom, FXAA': m => [new m.SSAO(), new m.SSR({maxRoughness: 0.8}), new m.Bloom({strength: 0.6}), new m.FXAA()]};
let ssrCalls = 0;
for (const make of Object.values(lists)) for (const samples of [1, 4]) for (const shader of [wgsl, ibl]) {
  const expected = await ssrStory(post.baseline, pro.baseline, make, samples, shader);
  assert.ok(expected.some(e => e[0] === 'module' && /fn capture\(/.test(e[2].code)), 'the model must reflect through the capture hook');
  assert.deepEqual(await ssrStory(post.candidate, pro.candidate, make, samples, shader), expected, `SSR GPU calls differ at ${samples}x`); ssrCalls += expected.length;
}
{
  const probes = new LightProbes({volume: {min: [-1, -1, -1], max: [1, 1, 1], counts: [2, 2, 2]}}), gpu = mockGPU(); probes.setup({backend: 'webgpu', gpu: gpu.device});
  const lit = await ssrStory(post.candidate, pro.candidate, lists.SSR, 4, probes.shader(wgsl, 0)), code = lit.filter(e => e[0] === 'module').map(e => e[2].code);
  assert.ok(code.some(c => /margoPosition=i\.position;return margoSSR\(/.test(c) && /let e=probeSpecular\(margoPosition,n,v,rough\)\*w;/.test(c)), 'core replay removes the probes\' specular');
}
console.log(JSON.stringify({packages: ['environment', 'post', 'clustered', 'gltf-pro', 'materials', 'terrain'], baseline: ref, identicalEntryBundles: entries, changedEntries: differ, identicalCalls: expected.length, unattachedLightProbes: 'identical', emptyDecals: 'no GPU calls', ssrIdenticalCalls: ssrCalls}));
