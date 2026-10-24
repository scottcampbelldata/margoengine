// Screen-space transmission WGSL (extension and pass hook), run on the CPU against KHR_materials_transmission /
// _volume / _dispersion behaviour computed independently here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transmission, Transmission } from '../dist/transmission.js';
import { wgslModule } from './support/wgsl-subset.js';

const W = 200,
  H = 100,
  eye = [0, 0, 3];
// WebGPU-style perspective (90 degree vertical field, aspect W/H) looking down -Z from `eye`; columns.
const a = 1 / (W / H),
  b = 1;
const camera = [
  [a, 0, 0, 0],
  [0, b, 0, 0],
  [0, 0, -1, -1],
  [-a * eye[0], -b * eye[1], eye[2] - 0.1, eye[2]],
];
const project = (p) => {
  const w = eye[2] - p[2];
  return [(((a * (p[0] - eye[0])) / w) * 0.5 + 0.5) * W, ((-(b * (p[1] - eye[1])) / w) * 0.5 + 0.5) * H];
};
const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const sub = (p, q) => p.map((x, i) => x - q[i]),
  add = (p, q) => p.map((x, i) => x + q[i]),
  scale = (p, s) => p.map((x) => x * s),
  dot3 = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2],
  unit = (p) => scale(p, 1 / Math.hypot(...p));

// The opaque snapshot: each texel's colour encodes where it is, so a read tells which pixel was looked up.
const texel = ([x, y]) => [0.1 + (0.8 * x) / W, 0.1 + (0.8 * y) / H, 0.5, 1];

function extension(options, settings = 1) {
  const value = transmission({ opaqueColor: {}, ...options }),
    reads = [],
    rows = [];
  for (let k = 0; k < value.factors.length; k += 4) rows.push([...value.factors.slice(k, k + 4)]);
  const frame = {
    eye: [...eye, 1],
    camera,
    model: options.model ?? identity,
    coordsB: [0, 1, 0, 0],
    settings: [0, 0, 0, settings],
  };
  const shader = wgslModule(value.declarations, {
    f: frame,
    materialFactors: rows,
    materialTexture0: 'snapshot',
    textureDimensions: () => [W, H],
    textureLoad: (_t, at) => {
      reads.push(at);
      return texel(at);
    },
  });
  /** Shades a fragment at world point `p` with normal `n`; returns the colour and the pixels read. */
  const shade = (p, n = [0, 0, 1], { base = [1, 1, 1], metal = 0, color = [0, 0, 0], front = true } = {}) => {
    reads.length = 0;
    const [x, y] = project(p),
      i = { position: p, clip: [Math.floor(x) + 0.5, Math.floor(y) + 0.5, 0.5, 1], normal: n },
      s = { n, base: [...base, 1], metal, tr: rows[0][0] };
    const out = shader.call(
      'materialTransmission',
      i,
      s,
      color,
      front,
      s.tr,
      rows[0][1],
      Math.max(rows[0][2], 0),
      rows[1].slice(0, 3),
      rows[0][3],
      rows[1][3],
    );
    return { out, reads: reads.map((r) => [...r]), pixel: [Math.floor(x), Math.floor(y)] };
  };
  return { value, shader, shade, rows };
}
// Dielectric F0 from the IOR (KHR_materials_ior): 0 at IOR 1, 0.04 at 1.5.
const dielectric = (ior) => ((ior - 1) / (ior + 1)) ** 2;
const close = (actual, expected, tolerance, message) =>
  assert.ok(
    actual.length === expected.length && actual.every((x, i) => Math.abs(x - expected[i]) <= tolerance),
    `${message}: ${actual} vs ${expected}`,
  );

test('output assigns color only behind a positive factor and the weight expression is the factor row', () => {
  const { value } = extension({ factor: 0.75 });
  assert.equal(value.transmission, 'materialFactors[0].x');
  assert.match(value.output, /^if\(s\.tr>0\.0\)\{color=materialTransmission\(i,s,color,front,s\.tr,/);
  assert.doesNotMatch(value.output, /return/);
  assert.ok(value.declarations.includes('return color+materialTransmissionWeight(s,v,n,factor)*transmitted;'));
  assert.ok(value.declarations.includes('fn materialTransmission(i:Out,s:Surface,color:vec3f,front:bool,'));
});

test('only the surface-hook factor map samples with implicit derivatives', () => {
  const map = { view: {}, sampler: {}, texCoord: 1 };
  const { value } = extension({
    factor: 1,
    transmissionTexture: map,
    volume: { thicknessFactor: 1, thicknessTexture: map },
  });
  assert.equal(value.transmission, 'materialTransmissionMap(i)');
  const implicit = value.declarations.split('\n').filter((line) => line.includes('textureSample('));
  assert.equal(implicit.length, 1);
  assert.match(implicit[0], /^fn materialTransmissionMap\(i:Out\)/);
  assert.match(
    value.declarations,
    /fn materialTransmissionDepth\(i:Out\)->f32 \{return materialFactors\[0\]\.z\*textureSampleLevel\(materialTexture2,materialSampler2,uv\(i,1\.0\),0\.0\)\.g;\}/,
  );
  assert.match(value.output, /max\(materialTransmissionDepth\(i\),0\.0\)/);
});

test('thin glass keeps its sightline at any IOR: its own pixel, no conversion, weight 1 - F0 at normal incidence', () => {
  for (const ior of [1, 1.5, 2.4]) {
    const { shade } = extension({ factor: 1, ior }),
      p = [0.3, -0.2, 0],
      { out, reads, pixel } = shade(p);
    assert.deepEqual(reads, [pixel]);
    close(
      out,
      texel(pixel)
        .slice(0, 3)
        .map((c) => c * (1 - dielectric(ior))),
      1e-6,
      'thin ' + ior,
    );
  }
  // Display-encoded capture with a white base: the value as read, bit for bit.
  const { shade } = extension({ factor: 1, ior: 1.5 }, 0),
    { out, pixel } = shade([0.1, 0.1, 0], [0, 0, 1], { metal: 0 });
  const expected = texel(pixel)
    .slice(0, 3)
    .map((c) => Math.fround(Math.fround(c) * Math.fround(1 - dielectric(1.5))));
  close(out, expected, 1e-7, 'display thin');
});

test('F0 comes from the IOR: IOR 1 transmits everything at normal incidence, metal still mixes toward the base', () => {
  const p = [0.1, -0.1, 0];
  for (const ior of [1, 1.33, 1.5, 2.4]) {
    const { out, pixel } = extension({ factor: 1, ior }).shade(p);
    const expected = texel(pixel)
      .slice(0, 3)
      .map((c) => c * (1 - dielectric(ior)));
    if (ior === 1) assert.deepEqual(out, expected.map(Math.fround), 'IOR 1: weight exactly 1, bit for bit');
    else close(out, expected, 1e-6, 'IOR ' + ior);
  }
  assert.ok(Math.abs(dielectric(1.5) - 0.04) < 1e-12);
  const base = [1, 0.5, 0.25],
    { out, pixel } = extension({ factor: 1, ior: 1 }).shade(p, [0, 0, 1], { base, metal: 0.5 });
  close(
    out,
    base.map((b, k) => 0.5 * (1 - 0.5 * b) * b * texel(pixel)[k]),
    1e-6,
    'F0 = mix(dielectric, base, metal)',
  );
});

test('the weight is factor x (1 - metal) x (1 - Schlick Fresnel) and adds to the lit colour', () => {
  const { shade } = extension({ factor: 0.5, ior: 1 });
  const lit = [0.2, 0.1, 0.05];
  const n = unit([0, 0.6, 0.8]),
    p = [0, 0, 0],
    v = unit(sub(eye, p)),
    q = 1 - dot3(n, v),
    fresnel = q ** 5;
  const { out, pixel } = shade(p, n, { color: lit });
  close(
    out,
    lit.map((c, k) => c + 0.5 * (1 - fresnel) * texel(pixel)[k]),
    1e-6,
    'weight',
  );
  assert.deepEqual(shade(p, [0, 0, 1], { metal: 1, color: lit }).out.map(Math.fround), lit.map(Math.fround));
});

test('Beer-Lambert: attenuationColor^(path/distance) along the ray, path from mesh-space thickness', () => {
  const options = {
    factor: 1,
    ior: 1,
    volume: { thicknessFactor: 1, attenuationColor: [0.2, 0.5, 1], attenuationDistance: 1 },
  };
  const plain = extension(options).shade([0, 0, 0]);
  assert.deepEqual(plain.reads, [plain.pixel], 'IOR 1 reads its own pixel');
  close(
    plain.out,
    [0.2, 0.5, 1].map((t, k) => t * texel(plain.pixel)[k]),
    1e-6,
    'unit path',
  );
  assert.equal(Math.fround(plain.out[2]), Math.fround(texel(plain.pixel)[2]));
  // Non-uniform scale along the normal doubles the world path; rotation keeps it with the normal.
  const stretched = extension({
    ...options,
    model: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 2, 0],
      [0, 0, 0, 1],
    ],
  }).shade([0, 0, 0]);
  close(
    stretched.out,
    [0.04, 0.25, 1].map((t, k) => t * texel(stretched.pixel)[k]),
    1e-6,
    'scaled',
  );
  // Mesh +X scaled 2 and turned onto world +Z (90 degrees about Y): the mesh normal +X is world +Z.
  const turned = extension({
    ...options,
    model: [
      [0, 0, -2, 0],
      [0, 1, 0, 0],
      [1, 0, 0, 0],
      [0, 0, 0, 1],
    ],
  }).shade([0, 0, 0]);
  close(
    turned.out,
    [0.04, 0.25, 1].map((t, k) => t * texel(turned.pixel)[k]),
    1e-6,
    'rotated',
  );
  // Scale across the normal does not change the depth crossed at normal incidence.
  const wide = extension({
    ...options,
    model: [
      [3, 0, 0, 0],
      [0, 3, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
  }).shade([0, 0, 0]);
  close(wide.out, plain.out, 1e-6, 'lateral scale');
  // Oblique view: the straight ray crosses the unit slab after 1/cos.
  const p = [0.9, 0.4, 0],
    oblique = extension(options).shade(p),
    cos = unit(sub(eye, p))[2],
    weight = 1 - (1 - cos) ** 5;
  close(
    oblique.out,
    [0.2, 0.5, 1].map((t, k) => weight * t ** (1 / cos) * texel(oblique.pixel)[k]),
    1e-6,
    'oblique path',
  );
});

test('white attenuation stays exactly 1 and nothing becomes NaN when the exponent overflows', () => {
  const { shade, rows } = extension({
    factor: 1,
    ior: 1,
    volume: { thicknessFactor: 1e30, attenuationColor: [1, 0.5, 0], attenuationDistance: 1e-30 },
  });
  assert.ok(rows[0][3] > 1e29);
  const { out, pixel } = shade([0, 0, 0]);
  assert.ok(out.every(Number.isFinite), String(out));
  assert.equal(Math.fround(out[0]), Math.fround(texel(pixel)[0]));
  assert.deepEqual([out[1], out[2]], [0, 0]);
  const beer = extension({ factor: 1 }).shader;
  assert.deepEqual(beer.call('materialTransmissionBeer', [0, 0.5, 1], 0, 0), [1, 1, 1], 'no 0^0: zero path');
  assert.deepEqual(beer.call('materialTransmissionBeer', [0, 0.5, 1], 1, 0), [1, 1, 1], 'infinite distance');
});

test('a volume refracts by Snell: only the bending moves the lookup, matching an independent trace', () => {
  const ior = 1.5,
    thickness = 2,
    { shade } = extension({ factor: 1, ior, volume: { thicknessFactor: thickness } });
  for (const [p, n] of [
    [
      [0.8, 0.3, 0],
      [0, 0, 1],
    ],
    [[-0.5, 0.6, 0], unit([0.3, -0.2, 1])],
    [[0.2, -0.7, 0.5], unit([-0.4, 0, 1])],
  ]) {
    const { reads, pixel } = shade(p, n);
    // Snell in vector form, entering (eta = 1/IOR), with the slab depth measured along the normal.
    const d = unit(sub(p, eye)),
      eta = 1 / ior,
      c = -dot3(n, d),
      k = 1 - eta * eta * (1 - c * c),
      r = add(scale(d, eta), scale(n, eta * c - Math.sqrt(k))),
      path = thickness / Math.abs(dot3(r, n)),
      shift = sub(project(add(p, scale(r, path))), project(add(p, scale(d, path)))),
      expected = [Math.floor(pixel[0] + 0.5 + shift[0]), Math.floor(pixel[1] + 0.5 + shift[1])];
    assert.equal(reads.length, 1);
    assert.ok(
      Math.abs(reads[0][0] - expected[0]) <= 1 && Math.abs(reads[0][1] - expected[1]) <= 1,
      `${reads[0]} vs ${expected}`,
    );
    assert.notDeepEqual(reads[0], pixel, 'the oblique ray bends');
  }
  // Lookups stay inside the snapshot.
  const far = extension({ factor: 1, ior: 2.4, volume: { thicknessFactor: 50 } }).shade(
    [1.4, 0.65, 0],
    unit([1, 0.5, 0.2]),
  );
  for (const [x, y] of far.reads) assert.ok(x >= 0 && x < W && y >= 0 && y < H);
});

test('total internal reflection leaving the volume leaves the colour unchanged', () => {
  const { shade } = extension({ factor: 1, ior: 1.5, volume: { thicknessFactor: 1 } });
  const lit = [0.3, 0.2, 0.1],
    p = [2.5, 0, 0],
    // A back face seen from inside at a grazing angle: sin > 1/1.5.
    n = unit([0.2, 0, 1]),
    { out, reads } = shade(p, n, { color: lit, front: false });
  assert.deepEqual(reads, []);
  assert.deepEqual(out, lit.map(Math.fround));
});

test('dispersion reads red and blue on their own rays with IOR -/+ (IOR - 1) x 0.025 x dispersion', () => {
  const ior = 1.5,
    dispersion = 20,
    spread = (ior - 1) * 0.025 * dispersion,
    options = { factor: 1, ior, volume: { thicknessFactor: 3 } },
    p = [1.2, 0.5, 0],
    n = [0, 0, 1];
  const plain = extension(options).shade(p, n),
    split = extension({ ...options, dispersion }).shade(p, n),
    single = (value) => extension({ ...options, ior: value }).shade(p, n);
  assert.equal(plain.reads.length, 1);
  assert.equal(split.reads.length, 3);
  close([split.out[1]], [plain.out[1]], 0, 'green on the base IOR');
  // Red and blue follow the rays of their own IORs; the surface Fresnel keeps the material IOR.
  const r0 = dielectric(ior),
    q = 1 - dot3(n, unit(sub(eye, p))),
    weight = 1 - (r0 + (1 - r0) * q ** 5);
  assert.deepEqual(split.reads[1], single(ior - spread).reads[0], 'red ray');
  assert.deepEqual(split.reads[2], single(ior + spread).reads[0], 'blue ray');
  close([split.out[0]], [weight * texel(split.reads[1])[0]], 1e-6, 'red');
  close([split.out[2]], [weight * texel(split.reads[2])[2]], 1e-6, 'blue');
  assert.notDeepEqual(split.reads[1], split.reads[2], 'red and blue bend differently');
  // Thin walls do not disperse.
  assert.equal(extension({ factor: 1, ior, dispersion }).shade(p, n).reads.length, 1);
});

test('display-encoded captures tint and attenuate in linear light (IEC 61966-2-1)', () => {
  const toLinear = (c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92),
    toDisplay = (c) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : c * 12.92);
  const { shade } = extension({ factor: 1, ior: 1 }, 0),
    base = [0.5, 1, 0.25],
    { out, pixel } = shade([0.2, 0.2, 0], [0, 0, 1], { base });
  const f0 = 0,
    expected = texel(pixel)
      .slice(0, 3)
      .map((c, k) => (1 - f0) * (base[k] === 1 ? c : toDisplay(toLinear(c) * base[k])));
  close(out, expected, 2e-6, 'linear tint');
});

const pass = new Transmission().declarations(2);
function hook(frame, volume) {
  const samples = [];
  const shader = wgslModule(pass, {
    f: { eye: [...eye, 1], camera, model: identity, ...frame },
    margoVolume: volume,
    margoScene: 'scene',
    margoSceneSampler: 'sampler',
    textureDimensions: () => [256, 128],
    textureNumLevels: () => 9,
    textureSampleLevel: (_t, _s, uv, level) => {
      samples.push({ uv, level });
      return [uv[0], uv[1], 0.5, 1];
    },
  });
  return { shader, samples };
}
const surface = (overrides = {}) => ({
  n: [0, 0, 1],
  base: [1, 1, 1, 1],
  metal: 0,
  roughness: 0,
  tr: 1,
  th: 1,
  f0: [0, 0, 0],
  ...overrides,
});

test('pass hook: binding declarations, straight read with no path and no blur at IOR 1', () => {
  assert.ok(pass.includes('@group(2) @binding(124) var margoScene:texture_2d<f32>;'));
  assert.ok(pass.includes('@group(2) @binding(125) var margoSceneSampler:sampler;'));
  assert.ok(pass.includes('fn margoTransmission(s:Surface,v:vec3f,i:Out)->vec3f'));
  const p = [0.4, -0.3, 0],
    v = unit(sub(eye, p)),
    own = project(p).map((x, k) => x / [W, H][k]);
  for (const roughness of [0, 0.5, 1]) {
    const { shader, samples } = hook({ ext: [0, 1, 0, 0] }, [1, 1, 1, 1]);
    const out = shader.call('margoTransmission', surface({ roughness }), v, { position: p });
    assert.equal(samples[0].level, 0, 'IOR 1 never blurs');
    close(samples[0].uv, own, 1e-6, 'straight behind');
    close(out, [own[0], own[1], 0.5], 1e-6, 'F0 0 at IOR 1: everything behind');
  }
  const flat = hook({ ext: [0, 1.5, 0, 0] }, [0, 1, 1, 1]);
  flat.shader.call('margoTransmission', surface({ th: 0 }), v, { position: p });
  close(flat.samples[0].uv, own, 1e-6, 'zero path is the fragment itself');
});

test('pass hook: blur grows with roughness, Beer uses margoVolume per world unit, dispersion splits channels', () => {
  const p = [0.4, -0.3, 0],
    v = unit(sub(eye, p)),
    levels = [0, 0.2, 0.5, 1].map((roughness) => {
      const { shader, samples } = hook({ ext: [0, 1.5, 0, 0] }, [1, 1, 1, 1]);
      shader.call('margoTransmission', surface({ roughness }), v, { position: p });
      return samples[0].level;
    });
  assert.ok(
    levels.every((l, k) => k === 0 || l > levels[k - 1]),
    String(levels),
  );
  assert.ok(levels[3] <= 8);
  // Thickness 0.5 x map 1 x mean axis length 2: path 1 world unit.
  const doubled = [
    [2, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ];
  const { shader } = hook({ ext: [0, 1, 0, 0], model: doubled }, [0.5, 0.25, 1, 0]);
  const out = shader.call('margoTransmission', surface(), v, { position: p });
  const { shader: clear } = hook({ ext: [0, 1, 0, 0], model: doubled }, [0.5, 1, 1, 1]);
  const reference = clear.call('margoTransmission', surface(), v, { position: p });
  close(out, [reference[0] * 0.25, reference[1], 0], 1e-6, 'Beer');
  // Dispersion: three reads, green on the base IOR.
  const spread = hook({ ext: [0, 1.5, 0, 3] }, [0.5, 1, 1, 1]);
  spread.shader.call('margoTransmission', surface(), v, { position: p });
  assert.equal(spread.samples.length, 3);
  const plain = hook({ ext: [0, 1.5, 0, 0] }, [0.5, 1, 1, 1]);
  plain.shader.call('margoTransmission', surface(), v, { position: p });
  close(spread.samples[0].uv, plain.samples[0].uv, 0, 'green ray');
});

test('mip chain: level0 copies texel for texel, reduce averages each 2x2 block', () => {
  const source = readFileSync(new URL('../src/transmission-pass.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
    copy = /const copy = \/\* wgsl \*\/ `([\s\S]*?)`;/.exec(source)[1];
  assert.ok(
    /@vertex fn vertex\(/.test(copy) && /@fragment fn level0\(/.test(copy) && /@fragment fn reduce\(/.test(copy),
  );
  const level0 = /fn level0[\s\S]*?\n\}/.exec(copy)[0];
  assert.ok(!level0.includes('sourceSampler'), 'level0 binds only the source texture');
  const value = ([x, y]) => [x, y, x * y, 1];
  const shader = wgslModule(copy.replace(/@vertex fn vertex[\s\S]*?\n\}\n/, ''), {
    source: 'level',
    sourceSampler: 'sampler',
    textureDimensions: () => [5, 4],
    textureLoad: (_t, at) => value(at),
  });
  assert.deepEqual(shader.call('level0', [3.5, 2.5, 0, 1]), [3, 2, 6, 1]);
  const mean = (...points) =>
    points.map(value).reduce((s, c) => s.map((x, i) => x + c[i] / points.length), [0, 0, 0, 0]);
  close(shader.call('reduce', [1.5, 0.5, 0, 1]), mean([2, 0], [3, 0], [2, 1], [3, 1]), 1e-6, 'inner block');
  close(shader.call('reduce', [2.5, 1.5, 0, 1]), mean([4, 2], [4, 2], [4, 3], [4, 3]), 1e-6, 'odd edge repeats');
});
