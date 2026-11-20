// White point, toe and shoulder (tonemap options whitePoint, toe, shoulder; rows tonemap.whitePoint, tonemap.toe,
// tonemap.shoulder). The defaults leave the shaders and the uniform bytes exactly as they were: the shader texts are
// pinned by hash to the commit before the controls (and every variant the old code built), and a Tonemap with the options
// at their defaults compiles the same program and writes the same uniform. The spline is monotone with the slopes set; the
// shader and `shapeCurve` agree on the constants; the real-GPU proof (white point lands on 1, frames change, defaults
// frame exact, native and WebGL2 layer) is tests/shape-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Tonemap, shapeCurve } from '../dist/index.js';
import { classicShader, outputShader, shapeShader, sizedLUTShader, tonemapShader } from '../src/shaders.ts';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const program = (options) => {
  const h = gpuHarness();
  const effect = Tonemap.attach(h.engine, options);
  h.frame();
  const code = h.pipelines.at(-1).fragment.module.code;
  const uniform = Array.from(h.groups.at(-1).entries[0].resource.buffer.written ?? []);
  effect.dispose();
  return { code, uniform, h };
};

test('the default shaders are byte-identical to the ones before the controls existed', () => {
  assert.equal(hash(tonemapShader), 'a2d836edccced9671def05e04e3a5ec2cdc92ee6947e49ee92759a84545d1377');
  assert.equal(hash(outputShader), 'e95f396e590fecf3ace598410441ddd022c20368722c69b40258cc8e155a0686');
  assert.equal(hash(classicShader(tonemapShader)), '45b19c9385034edddc517d1d05c124883990eff86b11aa929263c29b9f4125be');
  assert.equal(hash(sizedLUTShader(tonemapShader)), '5790220cb4277b0137b591a7aae969fa693b9c47c929e909b0b7b8f81452a5fe');
});

test('options at their defaults compile the same program and write the same uniform as no options', () => {
  const plain = program({});
  for (const options of [{ whitePoint: 0, toe: 1, shoulder: 1 }, { whitePoint: 0 }, { toe: 1 }]) {
    const set = program(options);
    assert.equal(set.code, plain.code);
    assert.equal(hash(set.code), hash(tonemapShader));
    assert.deepEqual(Array.from(set.h.writes.slice(0, 16)), Array.from(plain.h.writes.slice(0, 16)));
  }
  assert.deepEqual([7, 11, 15].map((i) => plain.h.writes[i]), [0, 0, 0], 'the slots that were unused stay 0');
  for (const options of [{ whitePoint: 4 }, { toe: 0.5 }, { shoulder: 0.5 }]) {
    const set = program(options);
    assert.notEqual(set.code, plain.code);
    assert.match(set.code, /fn margoShape/);
    assert.equal(set.code.replace(/fn margoCurveAt[\s\S]*?\n}\nfn margoShape[\s\S]*?\n}\n/, '').replace('color=margoShape(color);\n  ', ''), plain.code);
  }
  const set = program({ whitePoint: 4, toe: 0.5, shoulder: 0.25 });
  assert.deepEqual([7, 11, 15].map((i) => set.h.writes[i]), [4, -0.5, -0.75]);
});

test('the spline is monotone, hits black and white, and has the slopes set', () => {
  const slopes = [0, 0.25, 0.5, 1, 1.5, 2, 3];
  for (const toe of slopes)
    for (const shoulder of slopes) {
      assert.equal(shapeCurve(0, toe, shoulder), 0);
      assert.ok(Math.abs(shapeCurve(1, toe, shoulder) - 1) < 1e-12);
      let last = 0;
      for (let i = 1; i <= 2000; i++) {
        const y = shapeCurve(i / 2000, toe, shoulder);
        assert.ok(y >= last - 1e-12, `monotone at ${i / 2000} for toe ${toe}, shoulder ${shoulder}`);
        last = y;
      }
      const e = 1e-6;
      assert.ok(Math.abs(shapeCurve(e, toe, shoulder) / e - toe) < 1e-4, `slope at black ${toe}`);
      assert.ok(Math.abs((1 - shapeCurve(1 - e, toe, shoulder)) / e - shoulder) < 1e-4, `slope at white ${shoulder}`);
    }
  for (let i = 0; i <= 10; i++) assert.ok(Math.abs(shapeCurve(i / 10) - i / 10) < 1e-15, 'toe 1 and shoulder 1 is the identity');
  assert.ok(shapeCurve(0.1, 0.5, 1) < 0.1 && shapeCurve(0.9, 1, 0.5) > 0.9 - 1e-12, 'a soft toe darkens the shadows, a soft shoulder holds the highlights');
});

test('the cubic is monotone for every slope pair in the square 0..3 by 0..3 (the derivative never goes below 0)', () => {
  // p'(x) = toe (3x^2 - 4x + 1) + (6x - 6x^2) + shoulder (3x^2 - 2x), the Hermite cubic through (0,0) and (1,1).
  for (let a = 0; a <= 3.0001; a += 0.05)
    for (let b = 0; b <= 3.0001; b += 0.05) {
      let lowest = Infinity;
      for (let i = 0; i <= 400; i++) {
        const x = i / 400;
        lowest = Math.min(lowest, a * (3 * x * x - 4 * x + 1) + (6 * x - 6 * x * x) + b * (3 * x * x - 2 * x));
      }
      assert.ok(lowest > -1e-9, `derivative ${lowest} for toe ${a}, shoulder ${b}`);
    }
  // Just outside the square, at the corner direction, it stops being monotone: (3, 3.6) dips below 0.
  let dips = Infinity;
  for (let i = 0; i <= 400; i++) {
    const x = i / 400;
    dips = Math.min(dips, 3 * (3 * x * x - 4 * x + 1) + (6 * x - 6 * x * x) + 3.6 * (3 * x * x - 2 * x));
  }
  assert.ok(dips < 0, 'the square is where monotone is promised: beyond it the derivative can go negative');
});

test('the Reinhard curve takes the paper white point (Eq. 4), the others divide by their value at W', () => {
  const code = shapeShader(tonemapShader);
  assert.match(code, /if\(p\.grade\.z==3\.0\)\{let w=max\(white,0\.01\);x=x\*\(1\.0\+x\/\(max\(vec3f\(1\)-x,vec3f\(0\.000001\)\)\*w\*w\)\);\}/);
  // Eq. 4 on the output c = L / (1 + L): c (1 + c / ((1 - c) W^2)) is L (1 + L / W^2) / (1 + L), and W lands on 1.
  const eq4 = (L, W) => (L * (1 + L / (W * W))) / (1 + L),
    onC = (L, W) => ((L / (1 + L)) * (1 + L / (1 + L) / ((1 - L / (1 + L)) * W * W)));
  for (const W of [1.5, 4, 11.2])
    for (const L of [0.1, 0.5, 1, 3, W]) assert.ok(Math.abs(eq4(L, W) - onC(L, W)) < 1e-12);
  assert.ok(Math.abs(eq4(4, 4) - 1) < 1e-12);
  assert.ok(Math.abs(eq4(2, 4) - 0.75) < 1e-12 && Math.abs((2 / 3) / (4 / 5) - 0.75) > 0.05, 'dividing x / (1 + x) by its value at W is a different curve');
});

test('the shader holds the same cubic and the white point division', () => {
  const code = shapeShader(tonemapShader);
  assert.match(code, /x=\(x3-2\.0\*x2\+x\)\*a\+\(3\.0\*x2-2\.0\*x3\)\+\(x3-x2\)\*b;/);
  assert.match(code, /x=x\/max\(margoCurveAt\(vec3f\(max\(white,0\.01\)\)\),vec3f\(0\.000001\)\);/);
  assert.ok(code.includes('color=margoShape(color);\n  color=clamp(margoContrast(color,p.grade.y),vec3f(0),vec3f(1));'));
  assert.ok(shapeShader(outputShader).includes('color=margoShape(color);\n  color=clamp(margoContrast(color,p.grade.y),vec3f(0),vec3f(white));'));
  assert.throws(() => shapeShader('fn nothing(){}'), /no contrast step/);
});

test('out of range controls are refused when the frame draws', () => {
  for (const options of [{ whitePoint: -1 }, { whitePoint: 65 }, { toe: -0.1 }, { toe: 3.1 }, { shoulder: NaN }, { shoulder: 4 }])
    assert.throws(() => program(options), RangeError, JSON.stringify(options));
});
