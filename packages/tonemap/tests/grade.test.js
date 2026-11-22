import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { Grade, sampleCurve } from '../dist/grade.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

test('sampleCurve: a straight line without points, through every point, monotone, inside 0..1', () => {
  const line = sampleCurve(undefined);
  assert.equal(line.length, 33);
  line.forEach((v, i) => assert.equal(v, Math.fround(i / 32)));
  const points = [
    [0, 0],
    [0.25, 0.1],
    [0.5, 0.5],
    [0.75, 0.95],
    [1, 1],
  ];
  const s = sampleCurve(points);
  for (const [x, y] of points) assert.ok(Math.abs(s[x * 32] - y) < 1e-6, `passes through ${x}, ${y}`);
  for (let i = 1; i < 33; i++) assert.ok(s[i] >= s[i - 1], 'never falls between rising points');
  // A steep step that a plain cubic would overshoot stays inside the points' range.
  const step = sampleCurve([
    [0, 0],
    [0.45, 0],
    [0.55, 1],
    [1, 1],
  ]);
  assert.ok(step.every((v) => v >= 0 && v <= 1));
  assert.equal(step[8], 0, 'flat segments stay flat');
});

test('Grade patches the presentation shader before the LUT and binds its uniform at 5', () => {
  const grade = new Grade({
      shadows: [0, 0, 0.1],
      highlights: [0.1, 0, 0],
      curves: {
        master: [
          [0, 0.05],
          [1, 0.95],
        ],
      },
    }),
    h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { extensions: [grade] });
  h.frame();
  const code = h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;
  assert.ok(code.indexOf('color=gradeColor5(color);') < code.indexOf('if(p.grade.w==1.0){color=sampleLUT('));
  assert.ok(code.includes('@group(0) @binding(5) var<uniform> grading5:Grade5;'));
  assert.ok(h.groups.at(-1).entries.some((e) => e.binding === 5));
  const v = grade.values();
  assert.deepEqual([...v.subarray(0, 3)], [0, 0, Math.fround(0.1)], 'shadows');
  assert.deepEqual([...v.subarray(8, 11)], [Math.fround(0.1), 0, 0], 'highlights');
  assert.deepEqual([...v.subarray(12, 18)], [1, 1, 1, 1, 1, 1], 'hue multipliers default 1');
  assert.ok(Math.abs(v[20] - 0.05) < 1e-6 && Math.abs(v[20 + 4 * 32] - 0.95) < 1e-6, 'master curve ends');
  assert.equal(v[20 + 4 * 16 + 1], 0.5, 'red curve straight');
  // A steady frame compiles nothing; changing options needs no new pipeline.
  const pipelines = h.pipelines.length;
  grade.options.midtones = [0.05, 0.05, 0.05];
  h.frame();
  assert.equal(h.pipelines.length, pipelines);
  effect.dispose();
});

test('Grade and Tonemap check the options now and every frame', () => {
  for (const bad of [
    { shadows: [0, 0] },
    { midtones: [2, 0, 0] },
    { curves: { master: [[0, 0]] } },
    {
      curves: {
        red: [
          [0.5, 0],
          [0.4, 1],
        ],
      },
    },
    {
      curves: {
        blue: [
          [0, 0],
          [1, 1.5],
        ],
      },
    },
    { hueSaturation: [1, 1, 1, 1, 1] },
    { hueSaturation: [1, 1, 1, 1, 1, 5] },
  ])
    assert.throws(() => new Grade(bad), RangeError);
  assert.throws(() => new Tonemap({ extensions: [{}] }), RangeError);
  const grade = new Grade();
  grade.options.highlights = [0, 0, 3];
  assert.throws(() => grade.values(), RangeError);
});

// SHA-256 of key, patched shader and values of Grade and HueGrade as they were before lift, gamma, gain and saturation
// existed (recorded from 3050f3bcc6, 2026-11-16): without the primaries both send the GPU the same program and data.
const BEFORE_PRIMARIES = {
  'Grade:default': '140a31e463d55786d218a9a3359b8dc73f29d8e2034667839b9a7b9c5ffb587b',
  'HueGrade:default': '858a2d1c5311d368c357b04424c8dfd2aa9f916fed5cec407f691a047708f191',
  'Grade:wheels': 'd3eb7dc3b02dd95ee5dba533a1cdf8851f836ef67ed21033027b2cd26803e686',
  'HueGrade:wheels': 'f3c5279e75491d64d6a105f21b7e3ba4d612ba0797674919325815a8949c91d7',
  'Grade:curves': '9875f78568d1d228d77f1ba40d0fcca59c8c41ecfd3bd98cfb71133351092a8a',
  'HueGrade:curves': 'e5c6bfc4d9beb1fde8b930300916cc43fa08bb664fd705e401e4452614caeb86',
};
test('Grade and HueGrade without lift, gamma, gain or saturation are byte for byte what they were', async () => {
  const { createHash } = await import('node:crypto'),
    { HueGrade } = await import('../dist/hue.js'),
    { tonemapShader } = await import('../src/shaders.ts'),
    configs = {
      default: {},
      wheels: { shadows: [0.05, 0, -0.05], midtones: [0, 0.02, 0], highlights: [-0.03, 0, 0.04] },
      curves: {
        curves: {
          master: [
            [0, 0],
            [0.5, 0.6],
            [1, 1],
          ],
          blue: [
            [0, 0.05],
            [1, 0.95],
          ],
        },
        hueSaturation: [1.2, 1, 0.8, 1, 1.4, 1],
      },
    };
  for (const [name, options] of Object.entries(configs))
    for (const [label, Type] of [
      ['Grade', Grade],
      ['HueGrade', HueGrade],
    ]) {
      // At their defaults, given explicitly, the primaries change nothing either.
      for (const o of [options, { ...options, lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], saturation: 1 }]) {
        const g = new Type(o),
          h = createHash('sha256'),
          v = g.values();
        h.update(g.key + '|' + g.patch(tonemapShader, 5, 16) + '|');
        h.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        assert.equal(h.digest('hex'), BEFORE_PRIMARIES[`${label}:${name}`], `${label} ${name}`);
      }
    }
});

// The WGSL of gradeTone, in double precision: out = clamp((gain (x + lift (1 - x)))^(1 / gamma)), then saturation.
const primaries = (x, { lift = [0, 0, 0], gamma = [1, 1, 1], gain = [1, 1, 1], saturation = 1 }) => {
  const c = x.map((v, i) => Math.min(1, Math.max(0, Math.max(0, gain[i] * (v + lift[i] * (1 - v))) ** (1 / gamma[i])))),
    y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map((v) => Math.min(1, Math.max(0, y + (v - y) * saturation)));
};
test('lift, gamma and gain each hold one end of the range; saturation moves colour about luma', () => {
  const grey = [0.5, 0.5, 0.5];
  // Lift raises black and keeps white; gain scales white and keeps black; gamma keeps both and moves the middle.
  assert.deepEqual(primaries([0, 0, 0], { lift: [0.2, 0.2, 0.2] }), [0.2, 0.2, 0.2]);
  assert.deepEqual(primaries([1, 1, 1], { lift: [0.2, 0.2, 0.2] }), [1, 1, 1]);
  assert.deepEqual(primaries([0, 0, 0], { gain: [0.5, 0.5, 0.5] }), [0, 0, 0]);
  assert.deepEqual(primaries([1, 1, 1], { gain: [0.5, 0.5, 0.5] }), [0.5, 0.5, 0.5]);
  assert.ok(primaries(grey, { gamma: [2, 2, 2] })[0] > 0.7, 'gamma 2 brightens the midtones');
  assert.deepEqual(primaries([1, 1, 1], { gamma: [2, 2, 2] }), [1, 1, 1]);
  const red = [0.6, 0.3, 0.2],
    flat = primaries(red, { saturation: 0 });
  assert.ok(
    flat.every((v) => Math.abs(v - flat[0]) < 1e-12),
    'saturation 0 is grey',
  );
  assert.ok(primaries(red, { saturation: 2 })[0] - primaries(red, { saturation: 2 })[2] > red[0] - red[2]);
  // The shader is the same formula, with the values where it reads them.
  const grade = new Grade({ lift: [0.1, 0, -0.1], gamma: [1.2, 1, 0.8], gain: [1.1, 1, 0.9], saturation: 1.5 }),
    code = grade.patch('if(p.grade.w==1.0){color=sampleLUT(', 5),
    v = grade.values(),
    at = 20 + 4 * 33;
  assert.equal(grade.key, 'grade:tone');
  assert.equal(v.length, 32 + 4 * 33);
  assert.match(code, /struct Grade5 \{.*curve:array<vec4f,33>,lift:vec4f,gamma:vec4f,gain:vec4f\}/);
  assert.match(code, /let extra=input-c;c=gradeTone5\(c\);/);
  assert.match(code, /grading5\.gain\.rgb\*\(input\+grading5\.lift\.rgb\*\(1\.0-input\)\)/);
  assert.match(code, /pow\(max\(lifted,vec3f\(0\)\),1\.0\/grading5\.gamma\.rgb\)/);
  assert.match(code, /y\+\(c-y\)\*grading5\.lift\.w/);
  assert.deepEqual([...v.subarray(at, at + 12)], [0.1, 0, -0.1, 1.5, 1.2, 1, 0.8, 0, 1.1, 1, 0.9, 0].map(Math.fround));
  // Back at their defaults the extension is its old self again: key, code and values.
  Object.assign(grade.options, { lift: undefined, gamma: undefined, gain: undefined, saturation: undefined });
  assert.equal(grade.key, 'grade');
  assert.equal(grade.values().length, 20 + 4 * 33);
  assert.doesNotMatch(grade.patch('if(p.grade.w==1.0){color=sampleLUT(', 5), /gradeTone/);
});
test('Tonemap recompiles once when a primary is set and once when it is cleared, sizing the uniform to match', () => {
  const grade = new Grade(),
    h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { extensions: [grade] });
  h.frame();
  const before = h.pipelines.length,
    size = () => h.resources.filter((r) => r.size !== undefined && !r.destroyed).map((r) => r.size);
  assert.ok(size().includes(4 * (20 + 4 * 33)));
  grade.options.saturation = 0.5;
  h.frame();
  h.frame();
  assert.equal(h.pipelines.length, before + 1, 'one new pipeline for the primaries');
  assert.ok(size().includes(4 * (32 + 4 * 33)), 'the uniform holds the primaries');
  grade.options.saturation = 0.8;
  h.frame();
  assert.equal(h.pipelines.length, before + 1, 'a new value needs no new pipeline');
  grade.options.saturation = 1;
  h.frame();
  assert.equal(h.pipelines.length, before + 2);
  assert.ok(size().includes(4 * (20 + 4 * 33)));
  for (const bad of [
    { lift: [0, 2, 0] },
    { gamma: [0, 1, 1] },
    { gain: [1, 5, 1] },
    { saturation: -1 },
    { gain: [1, 1] },
  ])
    assert.throws(() => new Grade(bad), /lift is three numbers -1 to 1, gamma three from 0.1 to 10/);
  effect.dispose();
});
test('a LUT baked from a Grade or HueGrade with primaries holds them, the hue controls after them', async () => {
  const { bakeGrade } = await import('../dist/bake.js').catch(() => ({})),
    { exportCube } = await import('../dist/export-cube.js'),
    { HueGrade } = await import('../dist/hue.js'),
    options = { lift: [0.1, 0, 0.05], gamma: [1.3, 1, 0.8], gain: [0.9, 1, 1.1], saturation: 1.4 },
    rows = (text) =>
      text
        .trim()
        .split('\n')
        .filter((l) => /^[\d.e-]+ [\d.e-]+ [\d.e-]+$/.test(l))
        .map((l) => l.split(' ').map(Number));
  assert.equal(bakeGrade, undefined, 'the bake stays internal');
  const cube = rows(exportCube(new Grade(options), { size: 3 }));
  for (let b = 0, i = 0; b < 3; b++)
    for (let g = 0; g < 3; g++)
      for (let r = 0; r < 3; r++, i++) {
        const want = primaries([r / 2, g / 2, b / 2], options);
        cube[i].forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 1e-5, `${[r, g, b]}: ${cube[i]} against ${want}`));
      }
  // HueGrade's hue shift reads its controls after the primaries: a 120 degree turn of pure red lifted to [0.1+...].
  const turned = rows(exportCube(new HueGrade({ ...options, hueShift: 120 }), { size: 2 })),
    plain = rows(exportCube(new Grade(options), { size: 2 }));
  assert.ok(turned[1][1] > turned[1][0], `red turns toward green: ${turned[1]} from ${plain[1]}`);
});
