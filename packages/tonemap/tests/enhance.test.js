// ColorEnhance: where its code goes in both Tonemap shaders, the uniform, the bounds, and the properties the README
// claims of its formulas (on the CPU oracle). The real-GPU check against that oracle is tests/enhance-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { ColorEnhance } from '../dist/enhance.js';
import { LocalExposure } from '../dist/local.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';
import { enhanceOracle } from './support/enhance-oracle.mjs';

const fragment = (h) =>
  h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0];

test('the uniform holds the identity by default and every option, in one buffer read live', () => {
  const enhance = new ColorEnhance(),
    values = enhance.values();
  assert.deepEqual([...values], IDENTITY);
  Object.assign(enhance.options, {
    mixer: { red: [0, 1, -2], blue: [2, 0, 0.5] },
    shadows: -3,
    midtones: 1,
    highlights: 3,
    hazeColor: [0.5, 2, 16],
    dehaze: -1,
    vibrance: 1,
  });
  assert.equal(enhance.values(), values, 'the same buffer every frame');
  assert.deepEqual([...values], [0, 1, -2, -3, 0, 1, 0, 1, 2, 0, 0.5, 3, 0.5, 2, 16, -1, 1, 0, 0, 0]);
  assert.equal(enhance.key, 'enhance', 'no option rebuilds the pipeline');
});

test('the call goes right before the display curve, after local exposure, and the rest of the shader is untouched', () => {
  for (const hdr of [false, true]) {
    const build = (options) => {
      const h = gpuHarness();
      if (hdr)
        h.context[Symbol.for('margoengine.color-output')] = { peak: 2, p3: true, excess: () => ({ excess: true }) };
      const effect = Tonemap.attach(h.engine, options);
      h.frame();
      return { h, effect, code: fragment(h) };
    };
    const plain = build({}),
      one = build({ extensions: [new ColorEnhance()] }),
      call = hdr ? 'hdr=colorEnhance5(hdr);' : 'hdr=max(colorEnhance5(hdr),vec3f(0));',
      anchor = hdr ? 'if(p.settings.z==1.0){' : 'var color:vec3f;';
    assert.ok(one.code.includes(`${call}\n  ${anchor}`), call);
    assert.ok(one.code.includes('@group(0) @binding(5) var<uniform> enhancing5:ColorEnhance5;'));
    assert.equal(one.code.replace(`${call}\n  `, '').slice(0, plain.code.length), plain.code, 'the rest is untouched');
    assert.ok(!plain.code.includes('colorEnhance'));
    assert.ok(one.h.groups.at(-1).entries.some((e) => e.binding === 5));
    // Listed first or last, local exposure runs before it; two ColorEnhance run in list order.
    for (const extensions of [
      [new ColorEnhance(), new LocalExposure()],
      [new LocalExposure(), new ColorEnhance()],
    ]) {
      const { code, effect } = build({ extensions });
      assert.ok(code.indexOf('hdr*=exp2(localStops(') < code.search(/hdr=(max\()?colorEnhance\d\(hdr\)/));
      effect.dispose();
    }
    const two = build({ extensions: [new ColorEnhance(), new ColorEnhance()] });
    assert.ok(two.code.indexOf('colorEnhance5(hdr)') < two.code.indexOf('colorEnhance6(hdr)'));
    assert.ok(two.code.indexOf('colorEnhance6(hdr)') < two.code.indexOf(anchor));
    const before = { ...one.h.counts };
    one.h.frame();
    assert.equal(one.h.counts.textures, before.textures);
    assert.equal(one.h.counts.groups, before.groups);
    for (const built of [one, two, plain]) built.effect.dispose();
    assert.ok(
      one.h.resources.every((r) => r.destroyed),
      'every texture and buffer is freed',
    );
  }
});

test('a shader without a display curve is refused', () => {
  assert.throws(() => new ColorEnhance().patch('fn x(){}', 5), /display curve.*errors#arguments/);
});

test('options out of range or of the wrong shape throw with a help link, at construction and on a later frame', () => {
  for (const [options, type] of [
    [{ shadows: -3.01 }, RangeError],
    [{ shadows: 3.01 }, RangeError],
    [{ highlights: NaN }, RangeError],
    [{ highlights: '1' }, RangeError],
    [{ midtones: 1.01 }, RangeError],
    [{ vibrance: -1.01 }, RangeError],
    [{ dehaze: Infinity }, RangeError],
    [{ hazeColor: [0, 1, 1] }, RangeError],
    [{ hazeColor: [1, 17, 1] }, RangeError],
    [{ hazeColor: [1, 1] }, TypeError],
    [{ mixer: { red: [2.01, 0, 0] } }, RangeError],
    [{ mixer: { green: [0, -2.01, 0] } }, RangeError],
    [{ mixer: { blue: [0, 0] } }, TypeError],
    [{ mixer: { blue: 1 } }, TypeError],
    [{ mixer: 1 }, TypeError],
    [{ mixer: null }, TypeError],
    [null, TypeError],
  ]) {
    assert.throws(
      () => new ColorEnhance(options),
      (error) => error instanceof type && /ColorEnhance .*errors#arguments$/.test(error.message),
      JSON.stringify(options),
    );
  }
  const h = gpuHarness(),
    enhance = new ColorEnhance(),
    effect = Tonemap.attach(h.engine, { extensions: [enhance] });
  h.frame();
  enhance.options.vibrance = 2;
  assert.throws(() => h.frame(), /ColorEnhance vibrance/);
  effect.dispose();
});

const COLORS = [
  [0, 0, 0],
  [0.001, 0.002, 0.004],
  [0.18, 0.18, 0.18],
  [0.5, 0.1, 0.05],
  [0.9, 0.95, 1],
  [6, 2, 0.5],
  [200, 200, 200],
];
const close = (a, b, why) =>
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= 1e-9 * (1 + Math.abs(b[i])), `${why}: ${a} vs ${b}`));
const grey = (x) => [x, x, x];
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('formulas: defaults change nothing; no tone setting reverses two tones; middle grey moves by midtones', () => {
  for (const c of COLORS) close(enhanceOracle(c), c, 'identity');
  for (const shadows of [-3, 0, 3])
    for (const midtones of [-1, 0, 1])
      for (const highlights of [-3, 0, 3]) {
        const o = { shadows, midtones, highlights },
          at = (stops) => enhanceOracle(grey(0.18 * 2 ** stops), o);
        let last = 0;
        for (let e = -16; e <= 16; e += 1 / 64) {
          const y = at(e)[0];
          assert.ok(y > last, `${JSON.stringify(o)} reverses tones at ${e} stops`);
          last = y;
        }
        close(at(0), grey(0.18 * 2 ** midtones), 'grey');
        close(at(-8), grey(0.18 * 2 ** (-8 + shadows)), 'deep shadow');
        close(at(8), grey(0.18 * 2 ** (8 + highlights)), 'top');
      }
});

test('formulas: vibrance moves dull colours most, dehaze keeps the haze colour, the mixer swaps channels', () => {
  const chroma = (c) => Math.max(...c) - Math.min(...c),
    dull = [0.5, 0.4, 0.4],
    vivid = [0.5, 0.05, 0.05];
  const gain = (c) => chroma(enhanceOracle(c, { vibrance: 1 })) / chroma(c);
  assert.ok(gain(dull) > 1.7 && gain(vivid) < 1.2 && gain(vivid) > 1);
  close(enhanceOracle([1, 0, 0], { vibrance: 1 }), [1, 0, 0], 'a pure colour stays');
  assert.ok(chroma(enhanceOracle(dull, { vibrance: -1 })) < 0.3 * chroma(dull));
  close([luma(enhanceOracle(dull, { vibrance: 0.5 }))], [luma(dull)], 'vibrance keeps luma');
  const air = [0.8, 0.9, 1];
  for (const dehaze of [-1, 1]) close(enhanceOracle(air, { dehaze, hazeColor: air }), air, 'haze colour');
  assert.ok(enhanceOracle(grey(0.5), { dehaze: 1 })[0] < 0.4);
  close(enhanceOracle(grey(0.5), { dehaze: -1 }), grey(0.75), 'half way to the haze');
  close(enhanceOracle([4, 3, 2], { dehaze: 1 }), [4, 3, 2], 'brighter than the haze: left');
  let last = -1;
  for (let x = 0; x <= 2; x += 1 / 256) {
    const y = enhanceOracle(grey(x), { dehaze: 1 })[0];
    assert.ok(y >= last);
    last = y;
  }
  close(
    enhanceOracle([0.1, 0.2, 0.3], { mixer: { red: [0, 0, 1], blue: [1, 0, 0] } }),
    [0.3, 0.2, 0.1],
    'swap red and blue',
  );
});
