// The WebGL2 compatibility route's staged programs (src/compat-staged.ts), on the CPU: for the base tracer, every
// subclass and every composed feature, the programs the route compiles are valid WGSL, hold no one-pass loop (Direct3D's
// shader compiler gave up unrolling one in the vertex program and the context was lost at its first draw on ANGLE
// Direct3D 11, docs/known-bugs.md), the census marks finished paths in a stencil every loop program tests and counts
// those left with an occlusion query read back without a stall, and every vertex starts its light sum empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { VoxelPathTracer } from '../dist/index.js';
import { ResampledVoxelPathTracer, resampledEmitters } from '../dist/restir.js';
import { GuidedVoxelPathTracer, causticGuiding } from '../dist/guiding.js';
import { MediaVoxelPathTracer, coloredMedia } from '../dist/media.js';
import { SpectralVoxelPathTracer, spectralTransport } from '../dist/spectral.js';
import { MeshPathTracer, triangleMeshes } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';

const STAGES = ['start', 'hit', 'vertex', 'surface', 'sample', 'shadow', 'gather', 'post', 'finish'];

// A fake device of the WebGL2 layer: the tracer takes its compatibility route there.
function harness() {
  const device = fakeDevice(),
    modules = [],
    pipelines = [],
    create = device.createShaderModule,
    render = device.createRenderPipelineAsync;
  device.adapterInfo = { vendor: 'margo-webgl2', architecture: 'webgl2', device: 'test', description: 'test' };
  device.createShaderModule = (d) => {
    modules.push(d.code);
    return create(d);
  };
  device.createRenderPipelineAsync = (d) => {
    pipelines.push(d);
    return render(d);
  };
  return { ...fakeEngine(device), modules, pipelines };
}

const meshScene = () => ({
  ...simpleScene(),
  meshes: [
    {
      id: 'panel',
      material: 1,
      positions: new Float32Array([-2, 0, -2, 2, 0, -2, 0, 0, 2]),
      indices: new Uint32Array([0, 2, 1]),
    },
  ],
});

const cases = [
  ['base', (e) => VoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['restir', (e) => ResampledVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['guiding', (e) => GuidedVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['media', (e) => MediaVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['spectral', (e) => SpectralVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['mesh', (e) => MeshPathTracer.create(e, { scene: meshScene() })],
  [
    'compose (every feature)',
    (e) =>
      ComposedVoxelPathTracer.create(e, {
        scene: meshScene(),
        features: [resampledEmitters(), triangleMeshes(), coloredMedia(), causticGuiding(), spectralTransport()],
      }),
  ],
];

for (const [name, attach] of cases)
  test(`compatibility route programs of ${name} are valid WGSL with no one-pass loop`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const staged = h.modules.filter((code) => /@fragment fn (stage|census)\(/.test(code));
      assert.equal(staged.length, STAGES.length + 1, 'nine stage programs and the census');
      for (const code of staged) {
        assert.doesNotThrow(() => checkWGSL(code), `${name}: ${code.slice(code.lastIndexOf('@fragment'), code.lastIndexOf('@fragment') + 40)}`);
        assert.doesNotMatch(code, /z_once/, `${name}: a one-pass loop is left`);
      }
      const labels = h.pipelines.map((p) => p.label);
      for (const stage of [...STAGES, 'census']) assert.ok(labels.includes(`voxel-pathtracer ${stage}`), stage);
      // The census: no colour target; its mark writes stencil bit 1 where a path finished an iteration before, every
      // program of the loop draws only where it is 0 (start, which comes before any mark, and finish draw everywhere),
      // and its count draws where it is 0 under an occlusion query, resolved and read back through a MAP_READ buffer
      // (no indirect draws: a GPU-written argument the layer must check is a synchronous read, a stall, every time).
      const census = h.pipelines.find((p) => p.label === 'voxel-pathtracer census'),
        count = h.pipelines.find((p) => p.label === 'voxel-pathtracer census count');
      assert.deepEqual(census.fragment.targets, []);
      assert.equal(census.depthStencil.format, 'stencil8');
      assert.deepEqual(census.depthStencil.stencilFront, { compare: 'always', passOp: 'replace' });
      assert.equal(census.depthStencil.stencilWriteMask, 1);
      assert.equal(count.fragment, undefined);
      assert.deepEqual(count.depthStencil.stencilFront, { compare: 'equal' });
      assert.equal(count.depthStencil.stencilWriteMask, 0);
      for (const stage of STAGES) {
        const p = h.pipelines.find((x) => x.label === `voxel-pathtracer ${stage}`);
        if (stage === 'start' || stage === 'finish') assert.equal(p.depthStencil, undefined, stage);
        else assert.deepEqual(p.depthStencil?.stencilFront, { compare: 'equal' }, stage);
      }
      assert.ok(h.device.querySets.some((q) => q.type === 'occlusion'), 'a census query set');
      assert.ok(h.device.buffers.some((b) => b.usage & 0x1), 'a census read-back buffer');
      assert.ok(h.device.buffers.some((b) => b.usage & 0x200), 'a query resolve buffer');
      assert.ok(!h.device.buffers.some((b) => b.usage & 0x100), 'no indirect argument buffer');
      // direct() starts its light sum at zero on every call; a staged program empties the state's copy before the
      // light kinds add to it (carried from vertex to vertex, it added each vertex's light again at every later one:
      // the materials scene came out 10.5 per cent too bright on ANGLE Vulkan).
      assert.ok(staged.some((code) => code.includes('dL=vec3f(0.0);')), 'a program empties the light sum');
    } finally {
      tracer.dispose();
    }
  });


// The trace module's other compute kernels (ids, coverage) reach ANGLE Direct3D 11 through the layer as they are. A loop
// with a constant bound around a traversal is one fxc unrolls and inlines: the coverage kernel's 64 camera rays around
// closest() compiled for more than 15 minutes there and stalled every transparent capture (docs/known-bugs.md). Their
// loops around a traversal take bounds the compiler cannot see (the frame uniform).
const body = (code, at) => {
  let depth = 0;
  for (let i = code.indexOf('{', at); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(code.indexOf('{', at) + 1, i);
  }
  throw new Error('unbalanced braces');
};
const functions = (code) => new Map([...code.matchAll(/\bfn (\w+)\(/g)].map((m) => [m[1], body(code, m.index)]));
// The names a piece of WGSL calls.
const callees = (text) => new Set([...text.matchAll(/\b(\w+)\(/g)].map((m) => m[1]));
// The functions that walk the scene: closest() and shadow(), and everything that calls one of them.
function traversals(fns) {
  const set = new Set(['closest', 'shadow']);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, text] of fns)
      if (!set.has(name) && [...callees(text)].some((t) => set.has(t))) set.add(name), (grew = true);
  }
  return set;
}
// Loops with a literal bound (`for(var s=0u;s<64u;s++)`) whose body calls a traversal, in `text`.
function constantLoops(text, walks) {
  const out = [];
  for (const m of text.matchAll(/for\s*\(\s*var\s+(\w+)\s*=[^;]*;\s*\1\s*<=?\s*\d+u?\s*;[^)]*\)/g)) {
    const inner = body(text, m.index);
    const called = [...callees(inner)].find((t) => walks.has(t));
    if (called) out.push(`${m[0]} around ${called}()`);
  }
  return out;
}

test('the constant-loop check finds the unrollable shape it guards against', () => {
  const code = 'fn closest()->u32 {return 0u;}\nfn walk()->u32 {return closest();}\n' +
    'fn k() {var n=0u;for(var s=0u;s<64u;s++){n+=walk();}for(var s=0u;s<f.tile.w;s++){n+=walk();}for(var s=0u;s<8u;s++){n+=1u;}}';
  const fns = functions(code);
  assert.deepEqual(constantLoops(fns.get('k'), traversals(fns)), ['for(var s=0u;s<64u;s++) around walk()']);
});

for (const [name, attach] of cases)
  test(`the trace module's layer-compiled kernels of ${name} hold no constant-bound loop around a traversal`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const trace = h.modules.find((code) => /@compute @workgroup_size\(8,8\) fn coverage\(/.test(code));
      assert.ok(trace, 'the trace module');
      const fns = functions(trace),
        walks = traversals(fns),
        entries = [...trace.matchAll(/@compute[^\n]*?\bfn (\w+)\(/g)].map((m) => m[1]).filter((e) => e !== 'trace');
      assert.ok(entries.includes('coverage') && entries.includes('ids'), `entries ${entries}`);
      for (const entry of entries) {
        // The entry and every function it reaches.
        const reached = new Set([entry]);
        for (const fn of reached) for (const c of callees(fns.get(fn))) if (fns.has(c)) reached.add(c);
        for (const fn of reached) assert.deepEqual(constantLoops(fns.get(fn), walks), [], `${name}: ${entry} via ${fn}`);
      }
    } finally {
      tracer.dispose();
    }
  });
