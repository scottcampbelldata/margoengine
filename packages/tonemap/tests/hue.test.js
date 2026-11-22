import test from 'node:test';
import assert from 'node:assert/strict';
import { HueGrade } from '../dist/hue.js';
import { Grade } from '../dist/grade.js';
import { Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';
import { translateWGSL } from '../../webgl2-compat/dist/glsl.js';

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
  assert.ok(code.includes('return shiftGradeHue5(c)+extra;'));
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

// KB-OWN-TONE2: HueGrade extends Grade, and both declared struct Grade, var grading and their functions under one
// name, so a Grade and a HueGrade in one Tonemap built WGSL a device rejects ("redeclaration of 'Grade'"). Each now
// names its code by its binding, and they apply in the order given, like every other extension list.
test('Grade and HueGrade together build valid WGSL and apply in order', () => {
  for (const extensions of [
    [new Grade({ shadows: [0.1, 0, 0] }), new HueGrade({ hueShift: 30 })],
    [new HueGrade({ hueShift: 30 }), new Grade()],
    [new Grade(), new Grade({ midtones: [0, 0.1, 0] })],
  ]) {
    const h = gpuHarness(),
      effect = Tonemap.attach(h.engine, { extensions });
    h.frame();
    const code = h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment
      .module.code;
    // The WebGL2 layer's WGSL checker rejects a name declared twice at module scope, as a device does.
    const glsl = translateWGSL({ vertex: { source: code }, fragment: { source: code } });
    assert.deepEqual(
      glsl.fragment.uniforms.map((u) => u.binding).filter((b) => b >= 5),
      [5, 6],
      'both grades read their own uniform',
    );
    const first = code.indexOf('color=gradeColor5(color);'),
      second = code.indexOf('color=gradeColor6(color);');
    assert.ok(first > 0 && second > first, 'the first extension grades first');
    assert.ok(second < code.indexOf('if(p.grade.w==1.0){color=sampleLUT('), 'both before the LUT');
    for (const [i, e] of extensions.entries())
      assert.equal(code.includes(`return shiftGradeHue${5 + i}(c)+extra;`), e instanceof HueGrade);
    assert.deepEqual(
      h.groups
        .at(-1)
        .entries.map((e) => e.binding)
        .filter((b) => b >= 5),
      [5, 6],
    );
    effect.dispose();
  }
});
