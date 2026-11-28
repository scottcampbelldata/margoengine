// The WebGL2 compatibility route's staged programs (src/compat-staged.ts), on the CPU: for the base tracer, every
// subclass and every composed feature, the programs the route compiles are valid WGSL, hold no one-pass loop (Direct3D's
// shader compiler gave up unrolling one in the vertex program and the context was lost at its first draw on ANGLE
// Direct3D 11, docs/known-bugs.md), the census marks finished paths in a stencil every loop program tests and counts
// those left with an occlusion query read back without a stall, and every vertex starts its light sum empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleHooks } from '../../../scripts/support/node-compat.mjs';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { VoxelPathTracer } from '../dist/index.js';
import { ResampledVoxelPathTracer, resampledEmitters } from '../dist/resampled.js';
import { GuidedVoxelPathTracer, causticGuiding } from '../dist/guiding.js';
import { MediaVoxelPathTracer, coloredMedia } from '../dist/media.js';
import { SpectralVoxelPathTracer, spectralTransport } from '../dist/spectral.js';
import { MeshPathTracer, triangleMeshes } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { meshPBR } from '../dist/mesh-pbr.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';
import { inlinedCopies } from '../../../scripts/support/wgsl-inline.mjs';

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

const meshPBRCase = [
  'mesh PBR',
  (e) =>
    ComposedVoxelPathTracer.create(e, {
      scene: {
        ...meshScene(),
        meshes: meshScene().meshes.map((m) => ({ ...m, uvs: new Float32Array([0, 0, 1, 0, 0, 1]) })),
        pbrMaterials: [
          {
            id: 1,
            metallicFactor: 0,
            roughnessFactor: 0.5,
            clearcoatFactor: 0.7,
            sheenColorFactor: [0.2, 0.4, 0.6],
            iridescenceFactor: 1,
            transmissionFactor: 0.5,
          },
        ],
      },
      features: [meshPBR()],
    }),
];

const cases = [
  ['base', (e) => VoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['resampled', (e) => ResampledVoxelPathTracer.attach(e, { scene: simpleScene() })],
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
        assert.doesNotThrow(
          () => checkWGSL(code),
          `${name}: ${code.slice(code.lastIndexOf('@fragment'), code.lastIndexOf('@fragment') + 40)}`,
        );
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
      assert.ok(
        h.device.querySets.some((q) => q.type === 'occlusion'),
        'a census query set',
      );
      assert.ok(
        h.device.buffers.some((b) => b.usage & 0x1),
        'a census read-back buffer',
      );
      assert.ok(
        h.device.buffers.some((b) => b.usage & 0x200),
        'a query resolve buffer',
      );
      assert.ok(!h.device.buffers.some((b) => b.usage & 0x100), 'no indirect argument buffer');
      // direct() starts its light sum at zero on every call; a staged program empties the state's copy before the
      // light kinds add to it (carried from vertex to vertex, it added each vertex's light again at every later one:
      // the materials scene came out 10.5 per cent too bright on ANGLE Vulkan).
      assert.ok(
        staged.some((code) => code.includes('dL=vec3f(0.0);')),
        'a program empties the light sum',
      );
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
  const code =
    'fn closest()->u32 {return 0u;}\nfn walk()->u32 {return closest();}\n' +
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
        for (const fn of reached)
          assert.deepEqual(constantLoops(fns.get(fn), walks), [], `${name}: ${entry} via ${fn}`);
      }
    } finally {
      tracer.dispose();
    }
  });

// Direct3D's shader compiler (fxc, under ANGLE's Direct3D 11 back end) inlines every call, and its time grows several
// times over for each loop nested around the voxel walk: the hit program took 35 s of CPU with the walk inside a loop
// over a leaf's instances inside the hierarchy walk, 13 s with the two loops as one (docs/known-bugs.md, KB-D3D11-NEST).
// So no layer-compiled program reaches march() or marchShadow() through more than one enclosing loop of its callers.
const LOOP_HEAD = /\b(?:loop\s*\{|for\s*\(|while\s*[(\s])/g;
// The loops that enclose position `at` of a function body.
function loopDepth(text, at) {
  let depth = 0;
  for (const m of text.matchAll(LOOP_HEAD)) {
    if (m.index >= at) break;
    const open = text.indexOf('{', m.index);
    let d = 0,
      close = open;
    for (; close < text.length; close++) {
      if (text[close] === '{') d++;
      else if (text[close] === '}' && --d === 0) break;
    }
    if (open < at && at < close) depth++;
  }
  return depth;
}
// The most loops of its callers that enclose a call reaching `walks` from function `name` (depth -1: it reaches none),
// with the call chain that has them (each caller's loops around the call in brackets).
function walkChain(fns, name, walks, memo = new Map(), stack = new Set()) {
  if (walks.has(name)) return { depth: 0, chain: [name] };
  if (memo.has(name)) return memo.get(name);
  const text = fns.get(name);
  if (text === undefined || stack.has(name)) return { depth: -1, chain: [] };
  stack.add(name);
  let worst = { depth: -1, chain: [] };
  for (const m of text.matchAll(/\b(\w+)\(/g)) {
    if (!fns.has(m[1]) || m[1] === name) continue;
    const below = walkChain(fns, m[1], walks, memo, stack),
      here = loopDepth(text, m.index);
    if (below.depth >= 0 && below.depth + here > worst.depth)
      worst = { depth: below.depth + here, chain: [`${name} [${here}]`, ...below.chain] };
  }
  stack.delete(name);
  memo.set(name, worst);
  return worst;
}
const walkNesting = (fns, name, walks) => walkChain(fns, name, walks).depth;

test('the loop-nesting check counts the loops around the voxel walk', () => {
  const nested = functions(
    'fn march()->u32 {return 0u;}\nfn inst()->u32 {return march();}\n' +
      'fn closest()->u32 {var n=0u;loop {for(var i=0u;i<n;i++){n+=inst();}if(n>4u){break;}}return n;}\n' +
      'fn flat()->u32 {var n=0u;var i=0u;loop {if(i<n){n+=inst();i++;continue;}if(n>4u){break;}}return n;}',
  );
  assert.equal(walkNesting(nested, 'closest', new Set(['march'])), 2);
  assert.equal(walkNesting(nested, 'flat', new Set(['march'])), 1);
});

for (const [name, attach] of cases)
  test(`compatibility route programs of ${name} walk the hierarchy and a leaf's instances in one loop`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const staged = h.modules.filter((code) => /@fragment fn stage\(/.test(code));
      assert.equal(staged.length, STAGES.length);
      let walks = 0;
      for (const code of staged) {
        const fns = functions(code);
        const at = code.slice(code.lastIndexOf('@fragment'), code.lastIndexOf('@fragment') + 60);
        for (const top of ['closest', 'shadow']) {
          if (!fns.has(top)) continue;
          const worst = walkChain(fns, top, new Set(['march', 'marchShadow']));
          assert.ok(worst.depth === 1, `${name}: ${worst.chain.join(' > ')} in ${at}`);
          walks++;
        }
      }
      assert.ok(walks >= 2, `${name}: closest() and shadow() are in the staged programs`);
    } finally {
      tracer.dispose();
    }
  });

// The voxel walk itself is one loop too: march() and marchShadow() visit the bricks and a brick's cells in one loop,
// in the order a cell loop inside the brick loop visits them. With the two loops nested, fxc took 15.1 s of CPU for the
// hit program and 10.0 s for the shadow program, 9.3 s and 5.4 s with one (docs/known-bugs.md, KB-D3D11-NEST).
// The most loops of its own that enclose a loop head of `text` (0: no loop inside another).
function ownNesting(text) {
  let worst = 0;
  for (const m of text.matchAll(LOOP_HEAD)) worst = Math.max(worst, loopDepth(text, m.index));
  return worst;
}

test('the own-loop nesting check counts a loop inside a loop', () => {
  const fns = functions(
    'fn twoLevel()->u32 {var n=0u;loop {loop {n++;if(n>2u){break;}}if(n>4u){break;}}return n;}\n' +
      'fn oneLevel()->u32 {var n=0u;var inner=false;loop {if(inner){n++;if(n>2u){inner=false;}continue;}if(n>4u){break;}inner=true;}return n;}',
  );
  assert.equal(ownNesting(fns.get('twoLevel')), 1);
  assert.equal(ownNesting(fns.get('oneLevel')), 0);
});

for (const [name, attach] of cases)
  test(`compatibility route programs of ${name} walk a model's bricks and cells in one loop`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const staged = h.modules.filter((code) => /@fragment fn stage\(/.test(code));
      let walks = 0;
      for (const code of staged) {
        const fns = functions(code);
        for (const walk of ['march', 'marchShadow']) {
          if (!fns.has(walk)) continue;
          assert.equal(ownNesting(fns.get(walk)), 0, `${name}: ${walk} has a loop inside its own loop`);
          walks++;
        }
      }
      assert.ok(walks >= 2, `${name}: march() and marchShadow() are in the staged programs`);
    } finally {
      tracer.dispose();
    }
  });

// Direct3D's compiler (fxc) inlines every call and unrolls every loop it can count, so each call site of the half-block
// walk (octWalk, its own loop) and of a texel read inside the voxel walk is another copy in the program. shapeCut ran
// three counted rounds of two walks and two reads: 8 walks and 8 reads in the hit program, 6 and 8 in the shadow one
// (fxc 7.4 s and 6.5 s, paired; docs/known-bugs.md, KB-L5a-10). With one walk and one read a step in a loop fxc keeps,
// and one walk call site in march(), the hit program holds 2 walks and 3 reads (5.6 s) and the shadow one 1 and 3 (5.1 s).
for (const [name, attach] of cases)
  test(`compatibility route programs of ${name} hold one half-block walk and one texel read per call site`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      let walks = 0;
      for (const code of h.modules.filter((m) => /@fragment fn stage\(/.test(m))) {
        const fns = functions(code);
        if (!fns.has('march') && !fns.has('marchShadow')) continue;
        const { copies } = inlinedCopies(code, 'stage');
        assert.ok((copies.get('octWalk') ?? 0) <= 2, `${name}: ${copies.get('octWalk')} octWalk copies`);
        assert.ok((copies.get('texelAt') ?? 0) <= 3, `${name}: ${copies.get('texelAt')} texelAt copies`);
        walks++;
      }
      assert.ok(walks >= 2, `${name}: the hit and shadow programs walk voxels`);
    } finally {
      tracer.dispose();
    }
  });

// localX's last case (a moving instance without a TRS packet) inverted worldX, which carries a TRS path of its own that
// case never reaches, so each localX call site was two copies of the motion rotation: 8 in the surface program for 3
// localX and 2 worldX call sites (fxc 5.0 s against 4.3 s with one, paired minimums; KB-L5a-10). Both now hold one.
for (const [name, attach] of cases)
  test(`compatibility route programs of ${name} hold one motion rotation per instance transform`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      let moving = 0;
      for (const code of h.modules.filter((m) => /@fragment fn stage\(/.test(m))) {
        const fns = functions(code);
        if (!fns.has('localX')) continue;
        for (const fn of ['localX', 'worldX']) {
          const n = inlinedCopies(code, fn).copies.get('motionRotation') ?? 0;
          assert.equal(n, 1, `${name}: ${fn} holds ${n} motion rotations`);
        }
        moving++;
      }
      assert.ok(moving >= 2, `${name}: staged programs transform instances`);
    } finally {
      tracer.dispose();
    }
  });

// The surface program read its hit's instance transform three times: for the normal, and again in faceTexel and in
// edgeBand, which each turned the world point into the model point. fxc inlines every call site, so each was another
// copy of localX and its motion rotation: 3 in the surface program, 7 with triangle meshes, whose triangle-only normals
// (offset, glass side test, geometric normal, shading normal) went through hitNormal's voxel branch (KB-L5a-10). The
// stage now turns the hit point into the model point once and the triangle paths call the triangle normals directly.
for (const [name, attach] of [...cases, meshPBRCase])
  test(`the surface program of ${name} transforms its hit into model space once`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const code = h.pipelines.find((x) => x.label === 'voxel-pathtracer surface').fragment.module.code;
      const { copies } = inlinedCopies(code, 'stage');
      assert.equal(copies.get('localX'), 1, `${name}: ${copies.get('localX')} localX copies`);
      assert.equal(copies.get('motionRotation'), 3, `${name}: ${copies.get('motionRotation')} motion rotations`);
    } finally {
      tracer.dispose();
    }
  });

// meshClosest walked a lone mesh's triangles from one meshBlas call site and each instance's from another, so every
// program with a triangle traversal held two copies of the triangle walk (6 triangle edge tests, 12 edge products in
// the hit and shadow programs, and gather with every feature). A lone mesh is now one pass of the instance loop with
// the world ray.
for (const [name, attach] of [...cases.filter(([n]) => n === 'mesh' || n.startsWith('compose')), meshPBRCase])
  test(`compatibility route programs of ${name} hold one triangle walk`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      let walks = 0;
      for (const code of h.modules.filter((m) => /@fragment fn stage\(/.test(m))) {
        const { copies } = inlinedCopies(code, 'stage');
        if (!copies.has('meshClosest')) continue;
        assert.equal(
          copies.get('meshBlas'),
          copies.get('meshClosest'),
          `${name}: ${copies.get('meshBlas')} meshBlas copies`,
        );
        walks++;
      }
      assert.ok(walks >= 2, `${name}: the hit and shadow programs walk triangles`);
    } finally {
      tracer.dispose();
    }
  });

// The light program (`sample`) and the bounce program (`post`) took an instance's world and model transforms with worldX
// and localX side by side (sampleEmitter, the resampled feature's directionalEmitter, guideBox): two motion rotations a
// call site, as fxc copies every call site. guidedSurface built its sampled guide box and then every box again through
// guidePdf, two guideBox copies. instX now gives both transforms from one rotation and guidedSurface builds the boxes in
// one loop, the sampled box first (KB-L5a-10): every feature composed, sample 7 to 4 motion rotations, post 4 to 1.
for (const [name, attach] of cases)
  test(`the sample and post programs of ${name} take each instance's two transforms from one rotation`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const copies = (label) =>
        inlinedCopies(h.pipelines.find((x) => x.label === `voxel-pathtracer ${label}`).fragment.module.code, 'stage')
          .copies;
      for (const label of ['sample', 'post']) {
        const c = copies(label);
        assert.equal(c.get('worldX') ?? 0, 0, `${name} ${label}: ${c.get('worldX')} worldX copies`);
        assert.ok((c.get('guideBox') ?? 0) <= 1, `${name} ${label}: ${c.get('guideBox')} guideBox copies`);
      }
      if (name.startsWith('compose')) {
        // Each triangle walk holds one more: meshClosest builds its moving instance's model transform once (FG-17 4a),
        // and so does the mesh emitter proposal for a moving light point (FG-17-EMITTERS).
        const sample = copies('sample');
        assert.equal(sample.get('meshClosest'), 1, `${name} sample: ${sample.get('meshClosest')} triangle walks`);
        assert.equal(
          sample.get('sampleMeshEmitter'),
          1,
          `${name} sample: ${sample.get('sampleMeshEmitter')} emitter proposals`,
        );
        assert.equal(sample.get('motionRotation'), 4 + sample.get('meshClosest') + sample.get('sampleMeshEmitter'));
        assert.equal(copies('post').get('motionRotation'), 1);
      }
    } finally {
      tracer.dispose();
    }
  });

// ANGLE's Vulkan back end (NVIDIA RTX A6000, driver 617.42) writes other words through fragment output location 7 for
// about 0.3 s at a time, which darkened 1 to 4 of every 64 guided images (KB-VPT-GUIDE-COMPAT): no staged program and no
// route pipeline uses location 7: a loop program writes the 7 layers of a page.
for (const [name, attach] of cases)
  test(`compatibility route programs of ${name} never write fragment output location 7`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const staged = h.modules.filter((code) => /@fragment fn (stage|census)\(/.test(code));
      assert.ok(staged.length > 0);
      for (const code of staged) assert.doesNotMatch(code, /@location\(7\)/, `${name}: a program writes location 7`);
      for (const stage of STAGES.filter((s) => s !== 'finish')) {
        const p = h.pipelines.find((x) => x.label === `voxel-pathtracer ${stage}`);
        assert.equal(p.fragment.targets.length, 7, `${name}: ${stage} writes ${p.fragment.targets.length} layers`);
      }
    } finally {
      tracer.dispose();
    }
  });

// KB-L5a-3 (and KB5451, the cold mesh-pbr-lobes compile): the staged programs reach fxc too. The resampled kernel's proposal loop had a literal bound (8 by default)
// around directionalEmitter() and shadow(); on ANGLE Direct3D 11 one cold compile of its surface program ran past 9
// minutes with the GPU idle, so the hang timeout ended every MARGO_COMPAT=1 run of test:gpu:resampled. The staged
// programs' loops around a traversal take bounds the compiler cannot see, and the frame carries the proposal count.
for (const [name, attach] of [...cases, meshPBRCase])
  test(`the staged programs of ${name} hold no constant-bound loop around a traversal`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const staged = h.modules.filter((code) => /@fragment fn (stage|census)\(/.test(code));
      assert.ok(staged.length > 0, 'staged programs');
      for (const code of staged) {
        const fns = functions(code),
          walks = traversals(fns),
          entry = code.match(/@fragment fn (\w+)\(/)[1],
          reached = new Set([entry]);
        for (const fn of reached) for (const c of callees(fns.get(fn))) if (fns.has(c)) reached.add(c);
        for (const fn of reached)
          assert.deepEqual(constantLoops(fns.get(fn), walks), [], `${name}: ${entry} via ${fn}`);
      }
    } finally {
      tracer.dispose();
    }
  });

// KB-L5a-3: a loop of resampled proposals inside one pass of the light kinds held closest() (the directional proposal)
// and shadow() in the staged `sample` program; on ANGLE Direct3D 11 fxc took 254 s to link it and 356 s more at its
// first draw, so the hang timeout ended every MARGO_COMPAT=1 run of test:gpu:resampled. Now each proposal is a pass of
// light kind 1 (`sample`, `shadow`, `gather`), and no staged program reaches more than one traversal call.
function walkSites(fns, fn, seen = new Set()) {
  let n = 0;
  for (const m of fns.get(fn).matchAll(/\b(\w+)\(/g))
    if (m[1] === 'closest' || m[1] === 'shadow') n++;
    else if (fns.has(m[1]) && !seen.has(m[1])) n += walkSites(fns, m[1], new Set([...seen, fn]));
  return n;
}
for (const [name, attach] of cases)
  test(`no staged program of ${name} reaches more than one traversal call`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const staged = h.modules.filter((code) => /@fragment fn stage\(/.test(code));
      assert.equal(staged.length, STAGES.length);
      for (const code of staged) {
        const fns = functions(code);
        assert.ok(walkSites(fns, 'stage') <= 1, `${name}: ${walkSites(fns, 'stage')} traversal calls in one program`);
      }
    } finally {
      tracer.dispose();
    }
  });

test('the route runs one pass of light kind 1 per resampled proposal, in the order the kernel does', async () => {
  // The stager is internal to the route's chunk: load its source (Node strips the types; `./x.js` imports are `x.ts`).
  await moduleHooks([{ source: new URL('../src/', import.meta.url).href }]);
  const { stagedTrace } = await import('../src/compat-staged.ts');
  for (const [attach, steps] of [
    [(e) => VoxelPathTracer.attach(e, { scene: simpleScene() }), [0, 1, 2, 3, 4]],
    [(e) => ResampledVoxelPathTracer.attach(e, { scene: simpleScene(), candidates: 5 }), [0, 1, 1, 1, 1, 1, 2, 3, 4]],
    [(e) => ResampledVoxelPathTracer.attach(e, { scene: simpleScene(), candidates: 1 }), [0, 1, 2, 3, 4]],
    [
      // Kinds 0 to 6: the mesh feature's bound is at most 7 (kind 7 drew passes that did nothing before 2026-11-15,
      // tests/route-work.test.js).
      (e) =>
        ComposedVoxelPathTracer.create(e, {
          scene: meshScene(),
          features: [resampledEmitters({ candidates: 3 }), triangleMeshes()],
        }),
      [0, 1, 1, 1, 2, 3, 4, 5, 6],
    ],
  ]) {
    const device = fakeDevice(),
      sources = [],
      create = device.createShaderModule;
    device.createShaderModule = (d) => {
      sources.push(d.code);
      return create(d);
    };
    const tracer = await attach(fakeEngine(device).engine);
    try {
      await tracer.ready;
      const trace = sources.find((c) => c.includes('fn radiance(') && c.includes('fn trace('));
      assert.deepEqual(
        stagedTrace(trace).steps,
        steps,
        String(sources.filter((c) => c.includes('fn radiance(')).length),
      );
    } finally {
      tracer.dispose();
    }
  }
});

// The camera ray took the sine and cosine of its angles in six calls, each a copy of the precise argument reduction
// once fxc had inlined them, the biggest share of the start program's compile over ANGLE Direct3D 11, whose draw-time
// recompile helps WebKit's Windows build past its 15 s wait (KB-COMPAT-LOSTWHY1). Each angle now takes one
// preciseSinCos, two in all.
for (const [name, attach] of cases)
  test(`the programs of ${name} that make camera rays reduce each projection angle once`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      let rays = 0;
      for (const code of h.modules.filter((m) => /@fragment fn stage\(/.test(m))) {
        if (!functions(code).has('wideRay')) continue;
        const copies = inlinedCopies(code, 'wideRay').copies;
        assert.equal(
          copies.get('pmReduceTrig'),
          2,
          `${name}: ${copies.get('pmReduceTrig')} trig reductions in wideRay`,
        );
        assert.equal(copies.get('preciseSin') ?? 0, 0);
        assert.equal(copies.get('preciseCos') ?? 0, 0);
        rays++;
      }
      assert.ok(rays >= 1, `${name}: a staged program makes the camera ray`);
    } finally {
      tracer.dispose();
    }
  });

// march returned found(...) at each of its ten exits; fxc inlines each, and the ten copies inside the walk's loop were
// half the hit program's compile time over ANGLE Direct3D 11 (KB-COMPAT-LOSTWHY1). Every exit now leaves the loop with
// its values for one found() after it.
for (const [name, attach] of cases)
  test(`the voxel walk of ${name} records its hit in one place`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      let walks = 0;
      for (const code of h.modules.filter((m) => /@fragment fn stage\(/.test(m))) {
        if (!functions(code).has('march')) continue;
        const n = inlinedCopies(code, 'march').copies.get('found');
        assert.equal(n, 1, `${name}: march holds ${n} copies of found()`);
        walks++;
      }
      assert.ok(walks >= 1, `${name}: a staged program walks voxels`);
    } finally {
      tracer.dispose();
    }
  });
