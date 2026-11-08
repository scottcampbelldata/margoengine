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
  assert.ok(code.indexOf('color=gradeColor(color);') < code.indexOf('if(p.grade.w==1.0){color=sampleLUT('));
  assert.ok(code.includes('@group(0) @binding(5) var<uniform> grading:Grade;'));
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
