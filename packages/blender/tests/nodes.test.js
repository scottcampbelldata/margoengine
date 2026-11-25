import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargo } from '../dist/index.js';
import { MargoNodeMaterial, parseMargoNodes, loadMargoNodes } from '../dist/nodes.js';
const bytes = await readFile(new URL('./fixtures/nodes.margo', import.meta.url));
const asset = decodeMargo(bytes),
  graph = asset.document.materials[0].extras['margo:nodes'];
export const fixtureGraph = graph;
test('every tanh the node WGSL emits takes a bounded argument (KB-BLENDER-TANH1)', () => {
  // A GPU's tanh(x) is NaN once sinh and cosh overflow f32 (|x| over about 88.7); f32 tanh is already +-1 at 9.01.
  const g = {
    version: 1,
    bounds: graph.bounds,
    parameters: { a: { value: [100] }, b: { value: [0] }, c: { value: [0] } },
    surface: {},
    nodes: [
      {
        name: 'T',
        op: 'math',
        operation: 'TANH',
        type: 'float',
        inputs: ['a', 'b', 'c'].map((parameter) => ({ parameter })),
      },
    ],
  };
  const wgsl = new MargoNodeMaterial(g).extension.wgsl,
    tanhs = [...wgsl.matchAll(/(?<![\w.])tanh\(/g)];
  assert.ok(tanhs.length > 0, 'the TANH node emits tanh');
  for (const m of tanhs)
    assert.ok(
      wgsl.slice(m.index + 5).startsWith('clamp('),
      `bare tanh in emitted WGSL: ${wgsl.slice(m.index, m.index + 40)}`,
    );
});
test('Blender exports a connected live graph without texture sections or baked images', () => {
  assert.equal(asset.images.length, 0);
  for (const op of ['mix', 'ramp', 'noise', 'math'])
    assert.ok(
      graph.nodes.some((n) => n.op === op),
      op,
    );
  const live = new MargoNodeMaterial(graph),
    source = live.extension.wgsl;
  assert.match(source, /s\.base=/);
  assert.match(source, /s\.roughness=/);
  assert.match(source, /s\.emissive\*=/);
  assert.match(live.extension.declarations, /bnTexture4/);
  assert.match(live.extension.declarations, /bnRamp/);
});
test('exported socket animation seeks, clamps, rewinds and allows stable runtime overrides', () => {
  const live = new MargoNodeMaterial(graph),
    key = 'Amount/outputs/0',
    factors = live.extension.factors,
    code = live.extension.wgsl;
  for (const [seconds, expected] of [
    [-1, 0.25],
    [0, 0.25],
    [0.25, 0.375],
    [0.5, 0.5],
    [1, 0.75],
    [100, 0.75],
    [0, 0.25],
  ]) {
    live.seek(seconds);
    assert.equal(live.get(key)[0], expected);
  }
  live.set(key, 0.9).seek(0.5);
  assert.ok(Math.abs(live.get(key)[0] - 0.9) < 1e-6);
  live.reset(key).seek(0.5);
  assert.equal(live.get(key)[0], 0.5);
  assert.equal(live.extension.factors, factors);
  assert.equal(live.extension.wgsl, code);
  assert.throws(() => live.set(key, [1, 2, 3]), /socket value/);
  assert.throws(() => live.set(key, NaN), /socket value/);
  assert.throws(() => live.get('missing'), /unknown socket/);
  assert.throws(() => live.seek(Infinity), /seek time/);
});
test('untrusted graph bounds, cycles, injected enums, parameter values and animation samples reject', () => {
  const mutate = (fn) => {
    const g = structuredClone(graph);
    fn(g);
    assert.throws(
      () => new MargoNodeMaterial(g),
      (e) => e.code === 'unsupported' && /re-export/.test(e.message),
    );
  };
  mutate((g) => (g.version = 2));
  mutate((g) => (g.nodes[0].inputs = [{ link: 0 }]));
  mutate((g) => (g.nodes.find((n) => n.op === 'math').operation = 'ADD);discard;'));
  mutate((g) => (g.parameters['Amount/outputs/0'].value = [NaN]));
  mutate((g) => (g.parameters['Amount/outputs/0'].samples = [[0]]));
  mutate((g) => (g.times = [0, 0]));
  mutate(
    (g) =>
      (g.bounds = [
        [1, 1, 1],
        [0, 0, 0],
      ]),
  );
  mutate((g) => (g.nodes.find((n) => n.op === 'noise').dimensions = '3);discard;'));
  mutate((g) => (g.nodes.find((n) => n.op === 'ramp').stops[0][0] = { link: 0 }));
  // Names inherited from Object.prototype are not operations either (KB-P3c): they once crashed with a TypeError.
  mutate((g) => (g.nodes.find((n) => n.op === 'math').operation = 'constructor'));
  mutate((g) => (g.nodes.find((n) => n.op === 'math').operation = 'toString'));
  mutate((g) => {
    const m = g.nodes.find((n) => n.op === 'mix' && n.mode === 'RGBA');
    assert.ok(m, 'the fixture has a colour mix');
    m.blend = 'hasOwnProperty';
  });
});
test('caller mutation cannot change shader structure or retained animation data', () => {
  const g = structuredClone(graph),
    live = new MargoNodeMaterial(g);
  g.parameters['Amount/outputs/0'].samples[0][0] = 999;
  live.seek(0);
  assert.equal(live.get('Amount/outputs/0')[0], 0.25);
});
test('loaders reject abort and local URLs before resources are created', async () => {
  const signal = AbortSignal.abort(new Error('cancel live nodes'));
  await assert.rejects(parseMargoNodes({}, bytes, { signal }), /cancel live nodes/);
  await assert.rejects(loadMargoNodes({}, 'https://example.invalid/nodes', { signal }), /cancel live nodes/);
  await assert.rejects(loadMargoNodes({}, 'file:///nodes.margo'), /HTTP\(S\)/);
});
test("KB5339b: exported socket F-curves give Blender's own values between frames, every exact span and both extrapolations", async () => {
  // Truth: Blender 5.3 evaluating each socket at eighth-frame steps (tools/blender-addon/tests/blender_node_curves.py).
  const { graph: curved, truth } = JSON.parse(
    await readFile(new URL('./fixtures/node-curves.json', import.meta.url), 'utf8'),
  );
  const live = new MargoNodeMaterial(curved);
  for (const { seconds, values } of truth) {
    live.seek(seconds);
    // Blender solves a Bezier span's cubic in single precision: on the span whose free handles pass its end, its answer
    // sits 7.4e-6 from the exact root; every other span and both extrapolations agree within 2e-7.
    for (const [key, expected] of Object.entries(values))
      live
        .get(key)
        .forEach((v, i) =>
          assert.ok(Math.abs(v - expected[i]) < 1e-5, `${key}[${i}] at ${seconds}s: ${v} against ${expected[i]}`),
        );
  }
  const mutate = (fn, key = 'Amount') => {
    const g = structuredClone(curved);
    fn(g.parameters[`${key}/outputs/0`].curves[0]);
    assert.throws(() => new MargoNodeMaterial(g), new RegExp(`curves of ${key}`));
  };
  mutate((c) => (c.extrapolation = 'CYCLIC'));
  mutate((c) => (c.keys[1].t = c.keys[0].t));
  mutate((c) => (c.keys[0].i = 'ELASTIC'));
  mutate((c) => (c.keys[0].l = [0, NaN]));
  mutate((c) => delete c.keys[0].a, 'Spring');
  mutate((c) => (c.keys[1].a = -1), 'Spring');
  mutate((c) => (c.keys[2].p = Infinity), 'Spring');
});
test('KB5339c: Elastic spans match Blender, pinned on 135 black-box probes', async () => {
  // Truth: Blender 5.3 fcurve.evaluate on two-key Elastic spans, 65 or 401 sub-frame samples each
  // (tools/blender-addon/tests/blender_elastic.py): every easing, amplitude below, at and above the change, default,
  // short and negative periods, equal keys and a half-frame span. Each span is moved onto 0.1..1.5 s of the curve
  // fixture's scene; the period scales with it, as Blender's curve depends only on time over span and period over span.
  const { graph: curved } = JSON.parse(await readFile(new URL('./fixtures/node-curves.json', import.meta.url), 'utf8'));
  const cases = JSON.parse(await readFile(new URL('./fixtures/elastic-probe.json', import.meta.url), 'utf8'));
  assert.equal(cases.length, 135);
  let worst = 0;
  for (const {
    easing,
    amp,
    per,
    k: [f0, v0, f1, v1],
    s,
  } of cases) {
    const g = structuredClone(curved),
      scale = 1.4 / (f1 - f0),
      key = (t, v) => ({ t, v, l: [t, v], r: [t, v], i: 'ELASTIC', e: easing, b: 0, a: amp, p: per * scale });
    g.parameters['Spring/outputs/0'].curves = [{ extrapolation: 'CONSTANT', keys: [key(0.1, v0), key(1.5, v1)] }];
    const live = new MargoNodeMaterial(g);
    for (const [f, v] of s) {
      live.seek(0.1 + (f - f0) * scale);
      // Blender evaluates in single precision, so its rounding scales with the value and with the swing: the amplitude
      // times the decay envelope 2^(10(x - 1)) at x, the distance in span from the start (ease in) or end (ease out)
      // key, doubled for in-out. The worst miss is under 2e-5 of that scale, on the steepest samples.
      const x = (f - f0) / (f1 - f0),
        from = easing === 'EASE_IN' ? x : easing === 'EASE_IN_OUT' ? (x < 0.5 ? 2 * x : 2 - 2 * x) : 1 - x;
      const miss =
        Math.abs(live.get('Spring/outputs/0')[0] - v) / Math.max(1, Math.abs(v), amp * 2 ** (10 * (from - 1)));
      worst = Math.max(worst, miss);
      assert.ok(
        miss < 2e-5,
        `${miss} ${easing} amplitude ${amp} period ${per} keys ${[f0, v0, f1, v1]} at frame ${f}: ${live.get('Spring/outputs/0')[0]} against ${v}`,
      );
    }
  }
  assert.ok(worst > 0 && worst < 2e-5);
});
test("KB5339d: Noise-modified F-curves play Blender's sampled values back within single-precision rounding", async () => {
  // Truth: Blender 5.3 at eighth-frame steps (tools/blender-addon/tests/blender_node_noise.py). The add-on samples each
  // F-curve that carries a Noise modifier with fcurve.evaluate at a power-of-two subframe step of an eighth of a frame or
  // finer, and writes LINEAR keys; the reader plays them and has no noise model. Every eighth frame is a sampled step.
  const {
    graph: noisy,
    truth,
    between,
  } = JSON.parse(await readFile(new URL('./fixtures/node-noise.json', import.meta.url), 'utf8'));
  const f = new Float32Array(1),
    u = new Uint32Array(f.buffer);
  const ulp = (v) => {
    f[0] = Math.abs(v);
    const a = f[0];
    u[0]++;
    return f[0] - a;
  };
  const noise = ['Amount/outputs/0', 'Grain/outputs/0', 'Glow/outputs/0'];
  for (const key of noise)
    assert.ok(
      noisy.parameters[key].curves[0].keys.every((k) => k.i === 'LINEAR'),
      key,
    );
  assert.equal(noisy.parameters['Tint/outputs/0'].curves[0].keys[0].i, 'LINEAR');
  assert.equal(noisy.parameters['Tint/outputs/0'].curves[2], null);
  // The linear ramp outside Grain's restricted noise range reduces: 385 samples at 1/16 frame become 207 keys.
  assert.equal(noisy.parameters['Grain/outputs/0'].curves[0].keys.length, 207);
  const miss = (g, set) => {
    const live = new MargoNodeMaterial(g),
      worst = {};
    for (const { seconds, values } of set) {
      live.seek(seconds);
      for (const [key, expected] of Object.entries(values))
        live.get(key).forEach((v, i) => {
          const m = Math.abs(Math.fround(v) - expected[i]);
          worst[`${key}[${i}]`] = Math.max(worst[`${key}[${i}]`] ?? 0, m);
          // Noise components: the sample or a float32 neighbour; Tint green is a plain Bezier curve (KB5339b bound).
          if (set === truth && g === noisy)
            assert.ok(
              m <= (key === 'Tint/outputs/0' && i === 1 ? 1e-5 : ulp(expected[i])),
              `${key}[${i}] at ${seconds}s: ${v} against ${expected[i]}`,
            );
        });
    }
    return worst;
  };
  miss(noisy, truth);
  // Off the sampled steps the reader interpolates linearly: under 6e-4 on this fixture (measured 5.9e-4 on red Tint).
  const off = miss(noisy, between);
  for (const key of ['Amount/outputs/0[0]', 'Grain/outputs/0[0]', 'Glow/outputs/0[0]', 'Tint/outputs/0[0]'])
    assert.ok(off[key] > 0 && off[key] < 6e-4, `${key}: ${off[key]}`);
  // The old export (frame samples alone, interpolated linearly) misses Blender's noise between frames by 0.03 to 0.08.
  const old = structuredClone(noisy);
  for (const p of Object.values(old.parameters)) delete p.curves;
  const before = miss(old, truth);
  for (const key of ['Amount/outputs/0[0]', 'Grain/outputs/0[0]', 'Glow/outputs/0[0]', 'Tint/outputs/0[0]'])
    assert.ok(before[key] > 0.03, `${key}: ${before[key]}`);
});
test("KB-P3d: a colour wired into a float socket gives Blender's luminance, not the mean of R, G and B", async () => {
  // Truth: Blender 5.3 baking RGB -> Math Add 0 -> Emission in Cycles (tools/blender-addon/tests/blender_node_probes.py).
  const {
    graph: probed,
    cycles,
    geometry,
  } = JSON.parse(await readFile(new URL('./fixtures/node-probes.json', import.meta.url), 'utf8'));
  const source = new MargoNodeMaterial(probed).extension.wgsl;
  const conversions = [...source.matchAll(/dot\((\w+)\.rgb,vec3f\(([^)]*)\)\)/g)];
  assert.equal(conversions.length, 1, source);
  const weights = conversions[0][2].split(',').map(Number);
  assert.equal(weights.length, 3, conversions[0][0]);
  for (const { color, value } of cycles) {
    const gray = color.reduce((sum, c, i) => sum + Math.fround(c) * weights[i], 0);
    assert.ok(Math.abs(gray - value) < 1e-6, `Cycles grey of ${color}: ${gray} against ${value}`);
  }
  // Geometry Nodes rounds the same weights to four places (0.2126, 0.7152, 0.0722).
  for (const { color, value } of geometry) {
    const gray = color.reduce((sum, c, i) => sum + Math.fround(c) * weights[i], 0);
    assert.ok(Math.abs(gray - value) < 1e-4, `Geometry Nodes grey of ${color}: ${gray} against ${value}`);
  }
});
test("KB-P3d: LINEAR extrapolation follows each end key's own interpolation (CONSTANT flat, LINEAR neighbour, others handle)", async () => {
  // Truth: Blender 5.3 fcurve.evaluate past both ends of each exported curve (tools/blender-addon/tests/blender_node_probes.py).
  const { graph: probed, truth } = JSON.parse(
    await readFile(new URL('./fixtures/node-probes.json', import.meta.url), 'utf8'),
  );
  const live = new MargoNodeMaterial(probed);
  for (const { seconds, values } of truth) {
    live.seek(seconds);
    for (const [key, expected] of Object.entries(values))
      assert.ok(
        Math.abs(live.get(key)[0] - expected[0]) < 1e-6,
        `${key} at ${seconds}s: ${live.get(key)[0]} against ${expected[0]}`,
      );
  }
});
