// Grade's tonal ranges: compiled only while one changes something, the uniform, the bounds and the bake against a CPU
// oracle written from the README's formula. The real-GPU check is in tests/grade-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap, parseCube } from '../dist/index.js';
import { Grade } from '../dist/grade.js';
import { HueGrade } from '../dist/hue.js';
import { exportCube } from '../dist/export-cube.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';
import { rangesOracle } from './support/ranges-oracle.mjs';

const RANGES = {
  global: { hue: 120, density: 0.2, saturation: 1.1, exposure: 0.25 },
  shadows: { hue: 240, density: 0.7, exposure: 0.5 },
  midtones: { saturation: 0.4 },
  highlights: { hue: 30, density: 0.5, saturation: 1.5, exposure: -0.75 },
};
const shader = (grade) => {
  const h = gpuHarness();
  Tonemap.attach(h.engine, { extensions: [grade] });
  h.frame();
  return h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;
};

test('unused ranges keep the program and the data; a range that changes something compiles them in', () => {
  const plain = new Grade(),
    idle = new Grade({ ranges: { global: {}, shadows: { hue: 200 }, highlights: { density: 0, saturation: 1 } } });
  assert.equal(idle.key, 'grade');
  assert.deepEqual(idle.values(), plain.values());
  assert.equal(shader(idle), shader(plain));
  assert.ok(!shader(plain).includes('gradeRanges'));
  idle.options.ranges = { midtones: { exposure: 1 } };
  assert.equal(idle.key, 'grade:ranges', 'read live');
  const code = shader(idle);
  assert.ok(code.includes('fn gradeRanges5(') && code.includes('c=gradeRanges5(c);'));
  assert.ok(code.includes(',ranges:array<vec4f,3>}'));
});

test('the uniform holds gain and saturation per range, the global one multiplied in', () => {
  const v = new Grade({ ranges: { global: { exposure: 1, saturation: 0.5 }, shadows: { exposure: -1 } } }).values();
  assert.equal(v.length, 164);
  assert.deepEqual([...v.subarray(152)], [1, 1, 1, 0.5, 2, 2, 2, 0.5, 2, 2, 2, 0.5]);
  const tint = new Grade({ ranges: { highlights: { hue: 240, density: 1 } } }).values().subarray(160, 163);
  assert.ok(Math.abs(0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2] - 1) < 1e-6, 'a grey keeps its luma');
  assert.ok(tint[2] > 1.9 && tint[0] < 1 && tint[1] < 1);
  const all = new Grade({ saturation: 0.8, ranges: RANGES });
  assert.equal(all.key, 'grade:tone:ranges');
  assert.equal(all.values().length, 176);
  assert.equal(all.values().buffer, all.values().buffer, 'the same buffer every frame');
  const hue = new HueGrade({ ranges: RANGES });
  assert.equal(hue.key, 'grade-hue:ranges');
  assert.equal(hue.values().length, 164 + 260);
  assert.ok(shader(hue).includes(',ranges:array<vec4f,3>,hueControl:vec4f'));
});

test('the bake follows the formula, with and without the primaries and a hue shift', () => {
  const n = 9;
  for (const grade of [
    new Grade({ ranges: RANGES }),
    new Grade({ saturation: 1, gain: [1, 1, 1.0000001], ranges: RANGES }),
    new HueGrade({ ranges: RANGES, hueShift: 360 }),
  ]) {
    const { data } = parseCube(exportCube(grade, { size: n }));
    for (let i = 0; i < n ** 3; i++) {
      const input = [i % n, Math.floor(i / n) % n, Math.floor(i / n ** 2)].map((x) => x / (n - 1)),
        want = rangesOracle(input, RANGES);
      for (let k = 0; k < 3; k++)
        assert.ok(
          Math.abs(data[4 * i + k] - want[k]) < 1e-5,
          `${grade.key} at ${input}: ${data[4 * i + k]} ${want[k]}`,
        );
    }
  }
});

test('ranges out of bounds throw, at construction and on a later frame', () => {
  for (const ranges of [
    null,
    5,
    { global: null },
    { global: { hue: -1 } },
    { shadows: { hue: 361 } },
    { shadows: { density: 1.1 } },
    { midtones: { saturation: -0.1 } },
    { midtones: { saturation: 4.1 } },
    { highlights: { exposure: 9 } },
    { highlights: { exposure: Number.NaN } },
    { highlights: { density: '1' } },
  ])
    assert.throws(() => new Grade({ ranges }), RangeError, JSON.stringify(ranges));
  const grade = new Grade({ ranges: RANGES });
  grade.options.ranges = { global: { density: 2 } };
  assert.throws(() => grade.values(), RangeError);
});
