import test from 'node:test';
import assert from 'node:assert/strict';
import { HueGrade } from '../dist/hue.js';
import { Grade } from '../dist/grade.js';
import { Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

test('HueGrade retains Grade controls and adds live circular points without recompiling', () => {
  const g = new HueGrade({
    shadows: [0.1, 0, 0],
    hueShift: -60,
    hueHue: [
      [30, 90],
      [300, -20],
    ],
  });
  assert.ok(g instanceof Grade);
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { extensions: [new Grade()] });
  h.frame();
  const basePipelines = h.pipelines.length;
  effect.options.extensions = [g];
  h.frame();
  assert.ok(h.pipelines.length > basePipelines, 'switching from Grade compiles the hue shader and uniform layout');
  const code = h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;
  assert.ok(code.includes('return shiftGradeHue(c)+extra;'));
  assert.ok(code.includes('huePoints:array<vec4f,64>'));
  const v = g.values();
  assert.equal(v[0], Math.fround(0.1));
  assert.deepEqual([...v.slice(152, 162)], [-60, 2, 0, 0, 30, 90, 0, 0, 300, -20]);
  const count = h.pipelines.length;
  g.options.hueShift = 180;
  h.frame();
  assert.equal(h.pipelines.length, count);
  assert.equal(g.values(), v);
  effect.dispose();
});

test('HueGrade validates global and circular controls on construction and every frame', () => {
  for (const options of [
    { hueShift: NaN },
    { hueShift: Infinity },
    { hueShift: 361 },
    { hueHue: [] },
    { hueHue: [[360, 0]] },
    { hueHue: [[0, NaN]] },
    {
      hueHue: [
        [0, 0],
        [0, 1],
      ],
    },
    { hueHue: Array.from({ length: 65 }, (_, i) => [i, 0]) },
  ])
    assert.throws(() => new HueGrade(options), RangeError);
  const g = new HueGrade();
  g.options.hueHue = [[120, 400]];
  assert.throws(() => g.values(), RangeError);
});
