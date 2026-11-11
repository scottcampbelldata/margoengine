import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, planRings } from '../dist/index.js';
import { planWindows, splitTerrainColor } from '../dist/rvt.js';
import { TerrainQuery } from '../dist/query.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig(options = {}) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      sceneOf: () => undefined,
    };
  const terrain = new Terrain({
    resolution: 8,
    levels: 3,
    size: [32, 32],
    layers: Array.from({ length: 4 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
    textures: (device) => {
      const texture = (format, layers = 1) =>
        device.createTexture({ size: [4, 4, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING });
      return { heightmap: texture('r32float'), layers: texture('rgba8unorm', 4) };
    },
    ...options,
  });
  gpu.record(() => terrain.setup(engine));
  const passes = [];
  terrain.registerPasses({ add: (p) => passes.push(p) });
  passes.sort((a, b) => a.order - b.order);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', shader: '' });
  return { gpu, engine, terrain, view, prepare: passes[0] };
}

test('a still camera does not redraw the shadow maps when the ring spacing is not exact in float32', () => {
  // cellSize 0.1: the snapped ring corner 3 * 0.1 = 0.30000000000000004 is not a float32, so comparing the uniform's
  // float32 with it read as a ring move on every frame and invalidated Shadows and LocalShadows every frame.
  const { gpu, terrain, view, prepare } = rig({ cellSize: 0.1 });
  const frame = () =>
    gpu.record(() => {
      view.begin(0);
      view.c.camera.position[0] = 0.35;
      view.c.camera.position[2] = 0.35;
      prepare.execute(view.c);
    });
  frame();
  const after = terrain.shadowVersion;
  frame();
  frame();
  assert.equal(terrain.shadowVersion, after);
});

// Floating origin. Offsets near 1e5 and 1e7 m that are whole multiples of every lattice the tests use (ring spacing up
// to 32 m, cache periods up to 2048 m), so the scene moved by them lands on the same lattice points.
const OFFSETS = [0, 49 * 2048, 4883 * 2048];
const bits = (a) => Buffer.from(new Float64Array(a).buffer).toString('hex');
const bits32 = (a) => Buffer.from(new Float32Array(a).buffer).toString('hex');
/** A FloatingOrigin's duck shape: `origin` and `onRebase`; `rebase(at)` moves it as the real one does. */
function floating(at) {
  const listeners = new Set(),
    o = {
      origin: [...at],
      onRebase(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      rebase(next) {
        const shift = next.map((v, i) => v - o.origin[i]);
        o.origin = [...next];
        for (const l of listeners) l(shift, o.origin);
      },
      listeners,
    };
  return o;
}

test('planRings: the scene moved with its camera plans bit-identical local rings at 0, 1e5 and 1e7', () => {
  for (const [cell, levels] of [
    [1, 6],
    [0.5, 4],
  ]) {
    const reference = bits(planRings([37.3, 12, -91.7], [0, 0, 0], cell, levels));
    for (const d of OFFSETS)
      assert.equal(bits(planRings([37.3 + d, 12, -91.7 + d], [d, 0, d], cell, levels)), reference, `${cell} ${d}`);
  }
  // Without a floating origin the camera and a zero shift give what the old code gave, -0 included.
  const plain = planRings([-0.25, 0, -0], [0, 0, 0], 1, 2);
  assert.deepEqual(
    [...plain].map((v) => Object.is(v, -0)),
    [false, true, false, true],
  );
});

test('planWindows: cache windows, local bake bases and the reader wrap match the zero case at any offset', () => {
  const texel = 0.0625,
    size = 1024,
    levels = 6,
    eye = [12.34, 5, -7.89],
    windows0 = new Float64Array(levels * 2),
    bases0 = new Float64Array(levels * 2);
  assert.deepEqual(planWindows(eye, [0, 0, 0], texel, size, levels, windows0, bases0), [0, 0]);
  for (const d of OFFSETS) {
    const windows = new Float64Array(levels * 2),
      bases = new Float64Array(levels * 2),
      wrap = planWindows([eye[0] + d, eye[1], eye[2] + d], [d, 0, d], texel, size, levels, windows, bases);
    assert.deepEqual(wrap, [0, 0], 'the offset is a whole number of the coarsest period');
    assert.equal(bits(bases), bits(bases0), `${d}: local bake bases`);
    for (let k = 0; k < levels; k++)
      assert.deepEqual(
        [windows[k * 2] - d / (texel * 2 ** k), windows[k * 2 + 1] - d / (texel * 2 ** k)],
        [windows0[k * 2], windows0[k * 2 + 1]],
        `${d}: level ${k}`,
      );
  }
  // A general shift: the wrap is the shift modulo the coarsest period, and each base is the window corner less it.
  const shift = [10000017.3, 3, -9999990.7],
    period = texel * size * 2 ** (levels - 1),
    windows = new Float64Array(levels * 2),
    bases = new Float64Array(levels * 2),
    wrap = planWindows([shift[0] + 3, 0, shift[2] - 4], shift, texel, size, levels, windows, bases);
  for (const [w, s] of [
    [wrap[0], shift[0]],
    [wrap[1], shift[2]],
  ]) {
    assert.ok(w >= 0 && w < period);
    assert.ok(Math.abs((s - w) / period - Math.round((s - w) / period)) < 1e-9);
  }
  assert.equal(bases[0], windows[0] * texel - shift[0]);
});

function originRig(d, extra = {}) {
  const at = floating([d, 0, d]);
  return {
    at,
    ...rig({
      origin: [-16 + d, -16 + d],
      floatingOrigin: at,
      layers: [
        { height: [-10, 10], slope: [0, 1], scale: 1, bump: 0.3, macro: 0.4 },
        { height: [-10, 4], slope: [0, 0.4], scale: 0.37 },
        { height: [-10, 10], slope: [0.3, 1], scale: 0.25 },
        { height: [2, 10], slope: [0, 1], scale: 2.5 },
      ],
      ...extra,
    }),
  };
}
const frameOf = (r) =>
  r.gpu.record(() => {
    r.view.begin(3);
    r.prepare.execute(r.view.c);
  });

test('ring uniforms and layer rules are bit-identical at 0, 1e5 and 1e7 when the scene moves with the origin', () => {
  const reference = originRig(0);
  frameOf(reference);
  const ringsOf = (r) => r.terrain.rings.map((ring) => bits32(ring.values)).join(),
    rules = bits32(reference.terrain.ruleData());
  assert.equal(reference.terrain.rings[0].values.length, 48);
  for (const d of OFFSETS.slice(1)) {
    const r = originRig(d);
    frameOf(r);
    assert.equal(ringsOf(r), ringsOf(reference), `${d}: ring uniforms`);
    assert.equal(bits32(r.terrain.ruleData()), rules, `${d}: layer rules`);
  }
});

test('the layer wrap and tone are whole macro repeats of the terrain-relative shift', () => {
  const r = originRig(0),
    shift = [1234567.891, 87.5, -7654321.123];
  r.at.rebase(shift);
  const data = r.terrain.ruleData(),
    stride = 20; // 8 rule floats, 4 for bump and macro, 8 for wrap and tone.
  r.terrain.options.layers.forEach((layer, i) => {
    const scale = Math.fround(layer.scale),
      relative = [shift[0] + 16, shift[1], shift[2] + 16];
    for (let a = 0; a < 3; a++) {
      const wrap = data[i * stride + 12 + a],
        tone = data[i * stride + 16 + a],
        k = Math.floor((relative[a] * scale) / 24),
        exact = k * Math.fround(0.302);
      assert.ok(wrap >= 0 && wrap <= 24 / scale + 1e-3, `layer ${i} axis ${a}: wrap ${wrap}`);
      // The float32 of the float64 wrap: within half an ulp of a value below 24 / scale.
      assert.ok(Math.abs(wrap - (relative[a] - (k * 24) / scale)) <= 24 / scale / 2 ** 24, `layer ${i} axis ${a}`);
      assert.equal(tone, Math.fround(exact - Math.floor(exact)), `layer ${i} axis ${a}: tone`);
    }
    // The height bounds are local: world less the shift's Y.
    assert.equal(data[i * stride], Math.fround(layer.height[0] - shift[1]));
  });
});

test('a rebase rewrites the rules once and redraws the shadow maps once, a still frame after it nothing', () => {
  const d = 4883 * 2048,
    r = originRig(d);
  frameOf(r);
  frameOf(r);
  const version = r.terrain.shadowVersion,
    next = [d + 40.5, 12.25, d - 3.75];
  r.at.rebase(next);
  const log = frameOf(r);
  assert.equal(r.terrain.shadowVersion, version + 1);
  const rules = log.filter((e) => e[0] === 'writeBuffer' && e[3].length === r.terrain.ruleData().byteLength * 2);
  assert.equal(rules.length, 1, 'rules rewritten');
  const still = frameOf(r);
  assert.equal(r.terrain.shadowVersion, version + 1);
  assert.equal(still.filter((e) => e[0] === 'writeBuffer').length, 0, 'nothing uploaded on a still frame');
  assert.deepEqual([...r.terrain.shift], next);
  r.terrain.dispose();
  assert.equal(r.at.listeners.size, 0, 'dispose unsubscribes from the origin');
});

test('the origin shader edits every layer sample and keeps the anchors other entries patch', () => {
  const variants = [
    originRig(0),
    originRig(0, { layers: Array.from({ length: 4 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })) }),
  ];
  for (const r of variants) {
    const code = r.terrain.colorSource().code;
    assert.ok(code.includes('heights:vec4f,anchor:vec4f}'));
    assert.match(code, /struct Layer \{heightSlope:vec4f,params:vec4f(,surface:vec4f)?,wrap:vec4f,tone:vec4f\}/);
    assert.ok(!code.includes('position*scale;') && !code.includes('let p=position*m;'), 'no unwrapped sample left');
    assert.equal(code.split('wrap:vec4f').length, 2, 'the layer struct grows once');
    // The virtual texture's split and the materials' anchors still find their text.
    assert.ok(splitTerrainColor(code).includes('fn terrainColorAt('));
    assert.ok(code.includes('let weight=smoothstep(') && code.includes('total+=weight;'));
  }
  assert.ok(variants[0].terrain.colorSource().code.includes('let q=p*0.302+layerRules[layer].tone.xyz;'));
});

test('without a floating origin the shader text and uniforms are what they were', () => {
  const r = rig();
  frameOf(r);
  assert.equal(r.terrain.rings[0].values.length, 44);
  assert.ok(!r.terrain.colorSource().code.includes('wrap:vec4f'));
  assert.equal(r.terrain.anchor, undefined);
  assert.deepEqual([...r.terrain.shift], [0, 0, 0]);
});

test('floatingOrigin is checked', () => {
  const base = {
    size: [32, 32],
    layers: Array.from({ length: 4 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
    textures: () => ({}),
  };
  for (const floatingOrigin of [{}, { origin: [0, 0, 0] }, { origin: [0, 0], onRebase: () => () => {} }, 5])
    assert.throws(() => new Terrain({ ...base, floatingOrigin }), TypeError, JSON.stringify(floatingOrigin));
  assert.throws(
    () => new Terrain({ ...base, floatingOrigin: { origin: [NaN, 0, 0], onRebase: () => () => {} } }),
    TypeError,
  );
});

test('TerrainQuery answers in world coordinates: a heightmap moved by 1e5 or 1e7 gives the same heights and hits', () => {
  const columns = 33,
    heights = Float32Array.from({ length: columns * columns }, (_, i) => Math.sin(i * 0.37) * 0.3 + 0.5),
    at = (d) => new TerrainQuery(heights, columns, columns, { origin: [-16 + d, -16 + d], size: [32, 32] }),
    zero = at(0);
  for (const d of OFFSETS.slice(1)) {
    const q = at(d);
    for (const [x, z] of [
      // Points exact in float64 at 1e7 too (multiples of 2^-6), so world - origin is the same number at every offset.
      [0.296875, -4.703125],
      [11.25, 9.5],
      [-15.875, 15.875],
    ]) {
      assert.ok(Math.abs(q.height(x + d, z + d) - zero.height(x, z)) <= 1e-9, `${d} height`);
      const n = q.normal(x + d, z + d),
        n0 = zero.normal(x, z);
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(n[a] - n0[a]) <= 1e-9, `${d} normal`);
    }
    const hit = q.raycast([2 + d, 120, -3 + d], [0.02, -1, 0.01]),
      hit0 = zero.raycast([2, 120, -3], [0.02, -1, 0.01]);
    assert.ok(hit && hit0);
    // A ray walks cell boxes in world coordinates (float64, one ulp 1.9e-9 m at 1e7), so its answer may carry a few ulps
    // of the offset: allowed 64 (1.2e-7 m at 1e7 m, 1.4e-9 m at 1e5 m).
    const ulps = 64 * 2 ** -52 * d;
    assert.ok(Math.abs(hit.distance - hit0.distance) <= ulps, `${d} ray distance`);
    assert.ok(Math.abs(hit.position[0] - d - hit0.position[0]) <= ulps, `${d} hit x`);
    assert.ok(Math.abs(hit.position[1] - hit0.position[1]) <= ulps, `${d} hit y`);
  }
});
