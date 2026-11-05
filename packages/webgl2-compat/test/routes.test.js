// Milestone M6 in Node: the packages' WebGL2 routes (their lazily loaded compat chunks, found in each package's dist)
// take the tier they were written for, and compute what their WebGPU route computes. The browser check
// (routes-browser.mjs) draws each one natively and on the layer and compares the pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planCompute, runComputeOnCPU } from '../dist/compute.js';
import { COMPAT_VENDOR as layerVendor } from '../dist/device.js';
import { COMPAT_VENDOR, compatTier, loadCompatRoute } from '../../shared/compat.js';
import { prefixDownShader, prefixLevels, prefixTopShader, prefixUpShader } from '../../shared/prefix.js';

const packages = fileURLToPath(new URL('../../', import.meta.url));
// The tests read shader texts from the packages' sources, which import each other as './name.js'.
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('.ts') && /^\.\.?\/.*\.js$/.test(specifier)) {
      const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(source)) return next(source.href, context);
    }
    return next(specifier, context);
  },
});
/**
 * The compat chunk the package's build split off for its `import('./compat.js')`: the one its root imports lazily (a
 * package with several entries may also get packages/shared/compat.js as a chunk of the same name stem). With several
 * entries the root can be a re-export of a shared chunk, so the root's code is the file plus what it imports statically.
 */
async function route(name) {
  const dist = `${packages}${name}/dist`,
    entry = readFileSync(`${dist}/index.js`, 'utf8'),
    root = [
      entry,
      ...[...entry.matchAll(/from\s*["'`]\.\/([\w.-]+\.js)["'`]/g)].map((m) => readFileSync(`${dist}/${m[1]}`, 'utf8')),
    ].join('\n'),
    file = readdirSync(dist).find(
      (f) =>
        /^compat-[\w-]+\.js$/.test(f) &&
        new RegExp(`import\\(\\s*["'\`]\\./${f.replace('.', '\\.')}["'\`]\\s*\\)`).test(root),
    );
  assert.ok(file, `${name} builds its route into its own chunk`);
  return import(`../../${name}/dist/${file}`);
}

test('compatTier and loadCompatRoute: the layer by its vendor, nothing loaded on native WebGPU', async () => {
  assert.equal(COMPAT_VENDOR, layerVendor, 'shared and the layer agree on the vendor');
  assert.equal(compatTier({ adapterInfo: { vendor: COMPAT_VENDOR } }), 'webgl2');
  assert.equal(compatTier({ adapterInfo: { vendor: 'nvidia' } }), 'native');
  assert.equal(compatTier({}), 'native', 'a device without adapterInfo is native');
  assert.equal(compatTier(undefined), 'native');
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(loadCompatRoute({ adapterInfo: { vendor: 'nvidia' } }, load), undefined);
  assert.equal(await loadCompatRoute({ adapterInfo: { vendor: COMPAT_VENDOR } }, load), 1);
  assert.equal(loads, 1);
});

test('DOF: the CoC, tile and bokeh kernels without workgroup memory run as fragment draws', async () => {
  const dof = await route('dof'),
    shaders = await import('../../dof/src/shaders.ts'),
    coc = dof.cocPixelShader(shaders),
    bokeh = dof.bokehAloneShader(shaders);
  for (const [name, source] of Object.entries({ coc, tiles: dof.tilesShader, bokeh }))
    assert.equal(planCompute({ source, entryPoint: 'main' }).tier, 'fragment', name);
  assert.doesNotMatch(coc + bokeh, /var<workgroup>|groupMax|workgroupBarrier/);
  assert.throws(() => dof.cocPixelShader({ ...shaders, cocShader: shaders.cocShader.replace('tiles', 'maxima') }), {
    code: 'unsupported',
    message: /DOF on WebGL2 needs the shader its compatibility route was written for/,
  });
});

test('Shadows: the nearest-depth reduction without workgroup memory or atomics runs on the GPU', async () => {
  const shadows = await route('shadows');
  assert.equal(planCompute({ source: shadows.blockShader, entryPoint: 'main' }).tier, 'fragment', 'map blocks');
  assert.equal(planCompute({ source: shadows.levelShader, entryPoint: 'main' }).tier, 'fragment', 'level blocks');
  assert.equal(planCompute({ source: shadows.wordShader, entryPoint: 'main' }).tier, 'scatter', 'one word per layer');
  assert.doesNotMatch(shadows.blockShader + shadows.levelShader + shadows.wordShader, /var<workgroup>|atomic/);
  // The kernel the route replaces is on the CPU tier, which made every soft-shadow frame with a moving caster read
  // the whole map back (about 0.5 s a frame for 2048 x 2048).
  const { nearestDepth } = await import('../../shadows/src/shader.ts');
  assert.equal(planCompute({ source: nearestDepth, entryPoint: 'main' }).tier, 'cpu');
});

test('Sky: the light projection runs on the GPU and adds the same terms in the same order', async () => {
  const { projectRoute } = await route('sky'),
    { project } = await import('../../sky/src/project.ts');
  assert.equal(planCompute({ source: projectRoute, entryPoint: 'main' }).tier, 'scatter');
  assert.doesNotMatch(projectRoute, /var<workgroup>|workgroupBarrier|atomic/);
  // The kernel it replaces is on the CPU tier, whose read of the light map waits for the frame's GPU work.
  assert.equal(planCompute({ source: project, entryPoint: 'main' }).tier, 'cpu');
  const data = new Float32Array(32 * 16 * 4);
  let seed = 11;
  for (let i = 0; i < data.length; i++) data[i] = (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 31;
  // The CPU runner takes buffers only: the light map becomes one, read at the same texels.
  const light = (source) => {
    const words = new Float32Array(40).fill(7),
      read = source
        .replace('var level:texture_2d<f32>', 'var<storage,read> level:array<vec4f>')
        .replace('textureLoad(level,vec2i(i32(x),i32(y)),0)', 'level[y*32u+x]');
    runComputeOnCPU({
      source: read,
      workgroups: [1],
      buffers: new Map([
        ['0:0', data],
        ['0:1', words],
      ]),
    });
    return [...words];
  };
  assert.deepEqual(light(projectRoute), light(project), 'nine coefficients word for word, the tenth left alone');
});

test('splats: one CPU invocation sorts the projected keys in the order of the 8-pass GPU radix sort', async () => {
  const { cpuSort } = await route('splats');
  assert.equal(planCompute({ source: cpuSort, entryPoint: 'main' }).tier, 'cpu');
  // Keys as the projection writes them (inverted depth bits, splat index), with ties, culled splats (0xffffffff)
  // and every byte of the key in use.
  const n = 5000,
    keys = new Uint32Array(n * 2);
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < n; i++) {
    const r = next();
    keys[i * 2] = r % 5 === 0 ? 0xffffffff : r % 7 === 0 ? 0x80000000 : r;
    keys[i * 2 + 1] = i;
  }
  // The GPU route: LSD radix sort on the key, 4 bits a pass, stable.
  const expected = [...Array(n).keys()]
    .map((i) => [keys[i * 2], keys[i * 2 + 1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .flat();
  const spare = new Uint32Array(n * 2);
  runComputeOnCPU({
    source: cpuSort,
    workgroups: [1],
    buffers: new Map([
      ['0:0', Uint32Array.of(n, 0, 0, 0)],
      ['0:1', keys],
      ['0:2', spare],
    ]),
  });
  assert.deepEqual([...keys], expected, 'sorted by key, ties in index order, in the keys buffer');
});

const run = (source, buffers, workgroups) =>
  runComputeOnCPU({
    source,
    workgroups: [workgroups],
    buffers: new Map(Object.entries(buffers).map(([binding, view]) => [`0:${binding}`, view])),
  });
const groupsOf = (invocations) => Math.ceil(invocations / 256);
/** The kernels of shared/prefix.js on the CPU tier, in PrefixCount's order: the exclusive prefix, the total last. */
function prefixOf(flags) {
  const lengths = prefixLevels(flags.length),
    length = (n) => Uint32Array.of(n, 0, 0, 0),
    sums = [flags];
  for (let k = 1; k < lengths.length; k++) {
    sums[k] = new Uint32Array(lengths[k]);
    run(prefixUpShader, { 0: length(lengths[k - 1]), 1: sums[k - 1], 2: sums[k] }, groupsOf(lengths[k]));
  }
  const last = lengths.length - 1;
  let counts = new Uint32Array(lengths[last] + 1);
  run(prefixTopShader, { 0: length(lengths[last]), 1: sums[last], 2: counts }, 1);
  for (let k = last - 1; k >= 0; k--) {
    const next = new Uint32Array(lengths[k] + 1);
    run(prefixDownShader, { 0: length(lengths[k]), 1: sums[k], 2: next, 3: counts }, groupsOf(lengths[k] + 1));
    counts = next;
  }
  return counts;
}

test('prefix count: every kernel is a point draw, and it equals a JavaScript prefix over random lanes', () => {
  for (const source of [prefixUpShader, prefixTopShader, prefixDownShader]) {
    const plan = planCompute({ source, entryPoint: 'main' });
    assert.equal(plan.tier, 'scatter', plan.reason);
    assert.ok(plan.targets.every((t) => t.stores === 1));
    assert.doesNotMatch(source, /atomic|var<workgroup>/);
  }
  assert.deepEqual(prefixLevels(1), [1]);
  assert.deepEqual(prefixLevels(16), [16]);
  assert.deepEqual(prefixLevels(17), [17, 2]);
  assert.deepEqual(prefixLevels(1_000_000), [1_000_000, 62_500, 3_907, 245, 16]);
  let seed = 11;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (const [n, lanes] of [
    [1, 1],
    [15, 1],
    [16, 1],
    [17, 1],
    [256, 1],
    [257, 1],
    [1000, 3],
    [4097, 2],
    [700, 12],
  ]) {
    const flags = Uint32Array.from({ length: n * lanes }, () => +(next() % 3 === 0)),
      counts = prefixOf(flags);
    let sum = 0;
    for (let i = 0; i < flags.length; i++) {
      assert.equal(counts[i], sum, `${n} x ${lanes}, index ${i}`);
      sum += flags[i];
    }
    assert.equal(counts[flags.length], sum, 'the last word is the total');
  }
  // Both ends: no flag set, and every flag set.
  assert.deepEqual([...prefixOf(new Uint32Array(40))], Array(41).fill(0));
  assert.deepEqual(
    [...prefixOf(new Uint32Array(40).fill(1))],
    Array.from({ length: 41 }, (_, i) => i),
  );
});

test('VFX: the route kernels are point draws, and frames of them equal the WebGPU kernels word for word', async () => {
  const vfx = await route('vfx'),
    { simulationShader, billboardShader, multisampled, foggedBillboard } = await import('../../vfx/src/shader.ts'),
    code = vfx.routeShaders(simulationShader);
  for (const [name, source] of Object.entries(code)) {
    const plan = planCompute({ source, entryPoint: 'main' });
    assert.equal(plan.tier, 'scatter', `${name}: ${plan.reason}`);
    assert.doesNotMatch(source, /atomic|var<workgroup>|workgroupBarrier/, name);
  }
  for (const source of [vfx.compactShader, vfx.totalsShader(1, 2)])
    assert.equal(planCompute({ source, entryPoint: 'main' }).tier, 'scatter');
  // The kernels the route replaces are on the CPU tier, which cost 2.3 s a frame at a million particles.
  for (const entryPoint of ['main', 'deaths', 'scan'])
    assert.equal(planCompute({ source: simulationShader, entryPoint }).tier, 'cpu', entryPoint);

  const capacity = 1000,
    groups = groupsOf(capacity),
    frame = new Float32Array(56),
    control = new Uint32Array(frame.buffer, 208, 4);
  frame.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // clip = world: particles past |x| = 1 are off screen
  frame.set([0, 0, 0, 0.016], 24);
  frame.set([0, 0.5, 0, 0], 28);
  frame.set([0.2, 0.1, 0, 1], 32);
  frame.set([1, 0.5, 0.1, 1], 36);
  frame.set([0.02, 0.02, 0.08, -5], 40);
  frame.set([0.5, 1, 0.3, 0], 44);
  frame.set([1.5, 0.2, 0, 1], 48);
  const state = () => ({
    particles: new Float32Array(capacity * 8),
    alive: new Uint32Array(capacity),
    indirect: Uint32Array.of(3, 0, 0, 0, 0),
    visible: Uint32Array.of(3, 0, 0, 0, 0),
  });
  const webgpu = state(),
    onLayer = state(),
    groupWords = new Uint32Array(groups),
    drawnWords = new Uint32Array(groups),
    listed = new Uint32Array(groups * 256),
    spare = new Uint32Array(5);
  let tickets = new Uint32Array(capacity + 1);
  const size = Uint32Array.of(capacity, 0, 0, 0),
    entry = (entryPoint, buffers, count) =>
      runComputeOnCPU({
        source: simulationShader,
        entryPoint,
        workgroups: [count],
        buffers: new Map(Object.entries(buffers).map(([binding, view]) => [`0:${binding}`, view])),
      });
  let drawnEver = 0,
    offScreenEver = 0;
  for (let n = 0; n < 12; n++) {
    const budget = n === 0 ? capacity : n % 3 === 2 ? 0 : 120;
    control.set([capacity, budget, n, 0]);
    // The WebGPU route (base.ts `simulate`).
    {
      const { particles, alive, indirect, visible } = webgpu;
      indirect[1] = 0;
      if (budget) {
        entry('deaths', { 0: frame, 1: particles, 2: groupWords }, groups);
        entry('scan', { 0: frame, 2: groupWords, 10: spare }, 1);
      }
      entry('main', { 0: frame, 1: particles, 2: drawnWords, 4: indirect, 5: groupWords, 9: listed }, groups);
      entry('scan', { 0: frame, 2: drawnWords, 10: visible }, 1);
      entry('compact', { 0: frame, 2: drawnWords, 3: alive, 9: listed, 10: visible }, groups);
    }
    // The route (`SimulationRoute.encode`).
    {
      const { particles, alive, indirect, visible } = onLayer,
        living = new Uint32Array(capacity),
        shown = new Uint32Array(capacity);
      if (budget) {
        const flags = new Uint32Array(capacity);
        run(code.flags, { 0: frame, 1: particles, 2: flags }, groups);
        tickets = prefixOf(flags);
      }
      run(code.update, { 0: frame, 1: particles, 5: tickets }, groups);
      run(code.marks, { 0: frame, 1: particles, 2: living, 3: shown }, groups);
      const places = prefixOf(shown);
      run(vfx.compactShader, { 0: size, 1: shown, 2: places, 3: alive }, groups);
      const liveTotal = Uint32Array.of(prefixOf(living)[capacity]),
        shownTotal = Uint32Array.of(places[capacity]);
      run(vfx.totalsShader(0, 0), { 0: liveTotal, 1: shownTotal, 2: indirect, 3: visible }, 1);
    }
    assert.deepEqual(onLayer.particles, webgpu.particles, `frame ${n}: the particles`);
    assert.equal(onLayer.indirect[1], webgpu.indirect[1], `frame ${n}: live count`);
    assert.equal(onLayer.visible[1], webgpu.visible[1], `frame ${n}: drawn count`);
    assert.deepEqual(
      onLayer.alive.subarray(0, webgpu.visible[1]),
      webgpu.alive.subarray(0, webgpu.visible[1]),
      `frame ${n}: the draw list and its order`,
    );
    drawnEver = Math.max(drawnEver, webgpu.visible[1]);
    offScreenEver = Math.max(offScreenEver, webgpu.indirect[1] - webgpu.visible[1]);
  }
  assert.ok(drawnEver > 100 && offScreenEver > 10, `the scene exercises both lists (${drawnEver}, ${offScreenEver})`);

  // A route edit that no longer matches its text says so, for the simulation and for the billboard.
  assert.throws(() => vfx.routeShaders(simulationShader.replace('atomicAdd(&indirect.instanceCount,1u);', '')), {
    code: 'unsupported',
    message: /VFX on WebGL2 needs the shader/,
  });
  assert.throws(() => vfx.countedBillboard('@vertex fn other()'), { code: 'unsupported' });
  const counted = vfx.countedBillboard(billboardShader);
  assert.match(counted, /if\(instance>=drawn\[1\]\)/);
  assert.doesNotThrow(() => vfx.countedBillboard(foggedBillboard(billboardShader)));
  assert.doesNotThrow(() => multisampled(counted));
  // Every feature's patch keeps the anchors, and its update stays a point draw.
  const features = {
    wrap: (await import('../../vfx/src/wrap.ts')).wrap.patch(simulationShader),
    obstacles: (await import('../../vfx/src/obstacles.ts')).obstacles.patch(simulationShader),
  };
  for (const [name, text] of Object.entries(features)) {
    const plan = planCompute({ source: vfx.routeShaders(text).update, entryPoint: 'main' });
    assert.equal(plan.tier, 'scatter', `${name}: ${plan.reason}`);
  }
});

test('Scatter: the route kernels are point draws for every option, and a stale cull text says so', async () => {
  const scatter = await route('scatter'),
    { scatterCullShader } = await import('../../scatter/dist/index.js');
  const rect = [-10, -10, 10, 10],
    variants = [
      {},
      { bounds: rect },
      { bounds: rect, densityMap: () => undefined },
      { follow: true },
      { inner: 2, innerFade: 1 },
      { follow: true, bounds: rect, densityMap: () => undefined, inner: 2 },
    ];
  for (const options of variants) {
    const cull = scatterCullShader(options),
      plan = planCompute({ source: scatter.candidateShader(cull), entryPoint: 'main' });
    assert.equal(plan.tier, 'scatter', `${JSON.stringify(Object.keys(options))}: ${plan.reason}`);
    assert.doesNotMatch(scatter.candidateShader(cull), /atomic|var<workgroup>|\bemit\(/);
    // The kernel the route replaces is on the CPU tier: 50 to 90 ms a frame for 110,000 blades, plus a read-back.
    assert.equal(planCompute({ source: cull, entryPoint: 'main' }).tier, 'cpu');
  }
  for (const source of [
    scatter.compactShader(0),
    scatter.compactShader(2),
    scatter.totalsShader(0, 3),
    scatter.totalsShader(3, 12),
    scatter.shadowMarksShader,
    scatter.shadowCompactShader,
  ]) {
    const plan = planCompute({ source, entryPoint: 'main' });
    assert.equal(plan.tier, 'scatter', plan.reason);
    assert.doesNotMatch(source, /atomic|var<workgroup>/);
  }
  assert.throws(() => scatter.candidateShader(scatterCullShader({}).replace('emit(ring,instance);', '')), {
    code: 'unsupported',
    message: /Scatter culls in order only with the distribute shader/,
  });
  assert.throws(() => scatter.countedVertex('@vertex fn v()', 'let data=instances[index];', 0, 3, ''), {
    code: 'unsupported',
  });
  const vertex = scatter.countedVertex(
    '@vertex fn v(){let data=instances[index];}',
    'let data=instances[index];',
    1,
    2,
    'x',
  );
  assert.match(vertex, /@group\(1\) @binding\(2\) var<storage,read> drawnCount/);
  assert.match(vertex, /if\(index>=drawnCount\[0\]\)\{x\}let data/);
});

test('Scatter: slots and fade bands follow the flags, ring by ring', async () => {
  const { compactShader, totalsShader } = await route('scatter');
  // Six candidates, rings as flags: near, band near/middle, none, far, band middle/far, middle.
  const n = 6,
    rings = [
      [1, 1, 0, 0, 0, 0],
      [0, 1, 0, 0, 1, 1],
      [0, 0, 0, 1, 1, 0],
    ],
    marks = Uint32Array.from(rings.flat()),
    slots = prefixOf(marks),
    candidates = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) candidates.set([i, 0, 0, 1, 0, 0, 0, i === 1 ? 1 : i === 4 ? 2 : 0], i * 8);
  // Candidates, then each ring's capacity: room for every candidate.
  const size = Uint32Array.of(n, n, n, n),
    lists = [0, 1, 2].map((ring) => {
      const out = new Float32Array(n * 8);
      run(compactShader(ring), { 0: size, 1: candidates, 2: marks, 3: slots, 4: out }, 1);
      return out;
    });
  const read = (out, count) => Array.from({ length: count }, (_, k) => [out[k * 8], out[k * 8 + 7]]);
  assert.deepEqual(read(lists[0], 2), [
    [0, 0],
    [1, 1],
  ]);
  assert.deepEqual(read(lists[1], 3), [
    [1, 2],
    [4, 1],
    [5, 0],
  ]);
  assert.deepEqual(read(lists[2], 2), [
    [3, 0],
    [4, 2],
  ]);
  const commands = new Uint32Array(15),
    counts = new Uint32Array(3 * 64);
  run(totalsShader(0, 3), { 0: size, 1: slots, 2: commands, 3: counts }, 1);
  assert.deepEqual([commands[1], commands[6], commands[11]], [2, 3, 2]);
  assert.deepEqual([counts[0], counts[64], counts[128]], [2, 3, 2]);
});

test('culling: the CPU route keeps exactly the parts the kernels keep, in order', async () => {
  const { cullParts, cullMeshes } = await route('culling');
  // Parts with a local sphere of radius 1 along x from -20 to 20; a frustum slab |x| <= 5.
  const count = 41,
    records = new Float32Array(count * 24);
  for (let i = 0; i < count; i++) {
    records.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i - 20, 0, 0, 1], i * 24);
    records[i * 24 + 16] = i;
  }
  const planes = new Float32Array(24);
  planes.set([1, 0, 0, 5, -1, 0, 0, 5, 0, 1, 0, 1e3, 0, -1, 0, 1e3, 0, 0, 1, 1e3, 0, 0, -1, 1e3]);
  const hidden = new Uint32Array(count);
  hidden[20] = 1;
  const lists = {
    records,
    hidden,
    bounds: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1),
    batchOf: Uint32Array.from({ length: count }, (_, i) => +(i >= 30)),
    starts: [0, 30],
    count,
  };
  const drawn = new Float32Array(count * 24),
    args = new Uint32Array(10),
    kept = new Uint32Array(2);
  cullParts(lists, planes, true, drawn, args, kept);
  // Centres -6 to 6 touch the slab (radius 1); 0 (index 20) is hidden.
  const ids = (start, n) => Array.from({ length: n }, (_, k) => drawn[(start + k) * 24 + 16]);
  assert.deepEqual(ids(0, kept[0]), [14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26]);
  assert.deepEqual([kept[1], args[1], args[6]], [0, 12, 0]);
  cullParts(lists, planes, false, drawn, args, kept);
  assert.deepEqual([args[1], args[6]], [29, 11], "'none' keeps every part that is not hidden");
  // CulledMeshes: same slab, a screen-size threshold off (0), one batch of core instance records.
  const frame = new Float32Array(44);
  frame.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  frame.set(planes, 16);
  const packed = new Float32Array(count * 24),
    n = cullMeshes(records, count, [0, 0, 0, 1], frame, packed);
  assert.deepEqual(
    Array.from({ length: n }, (_, k) => packed[k * 24 + 16]),
    [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
  );
});
