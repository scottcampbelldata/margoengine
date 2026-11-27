// Milestone M3 feature check (run by `npm run test:gpu`, part of check:merge): each case of features.html runs on the
// browser's own WebGPU and on the WebGL2 layer in the same page, on the same GPU, and the two must return the same
// numbers. mipFiltering uses native textureLoad plus f32 interpolation for explicit levels. Hardware footprint
// LOD has finite fraction precision, so implicit, biased and gradient requests use the real native sampler and must
// match it exactly. Exception (Scott's ruling, 2026-11-10; docs/known-bugs.md, "AMD D3D11 compressed mip blend"):
// when a raw WebGL2 probe shows the driver compresses the blend between two mip levels (AMD under ANGLE D3D11), the
// linear-mip rows of implicitFootprint and the footprint rows of mipFiltering must instead pick the same LOD as
// native (equal nearest-mip sweeps) and equal, bit for bit, the driver's own blend at that LOD (test/blend-check.mjs).
// A driver whose raw WebGL2 blend equals native's at every probed LOD (Metal on Apple silicon, docs/known-bugs.md,
// "Metal mip blend") has nothing to excuse and keeps the exact comparison.
// A deliberately wrong LOD on the layer must fail either way.
// WebGPU 7.1.1 does not guarantee exact hardware-filter weights (see features.html); explicit assertions stay exact.
// Integers and bytes must be equal; floats equal within 1e-6 (both paths read the same stored values, so
// in practice they are bit-identical). Neither side may report a validation error, throw, or (the layer) a GL error.
// The cases: sRGB views of a unorm texture, 2D views of array layers, cube views of 6- and 12-layer textures and an
// array view of a cube, copyTextureToBuffer of depth, stencil, packed and snorm formats, occlusion queries, render
// bundles, textureGather in every address mode and textureGatherCompare, an external texture from a VideoFrame, and
// two regressions (an upload on the wrong texture unit; depth writes after a multisample resolve), sampling nested in
// another sampling call's coordinates (ANGLE D3D11 read the inner texture for both, KB5289b), and a depth texture
// sampled by the pass it is attached to read-only, and 3D texture slices drawn beside a depth attachment (ANGLE's
// Direct3D 11 back end drops such draws; the layer draws them in a 2D stand-in), and derivatives used only inside a
// later per-pixel branch (ANGLE Direct3D 11 moved them into it and read 0; the layer pins them into its outputs).
// In that last case the layer must return the exact differences (derivative-check.mjs) on every GPU, and native is
// reported, since an AMD driver's native answer is wrong for the helper-function form (KB-AMD-HELPERDERIV1).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { classifyBlend, compressedFailures } from './blend-check.mjs';
import { derivativeExpected } from './derivative-check.mjs';

const context = await openBrowser({
  startPath: '/packages/webgl2-compat/test/features.html',
  port: 'free',
  compat: false,
});
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/** Paths where `a` and `b` differ (numbers within 1e-6), at most 8. */
function differences(a, b, path = '', out = []) {
  if (out.length >= 8) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    const same = Number.isInteger(a) && Number.isInteger(b) ? a === b : Math.abs(a - b) <= 1e-6 || (a !== a && b !== b);
    if (!same) out.push(`${path}: native ${a}, compat ${b}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    else a.forEach((x, i) => differences(x, b[i], `${path}[${i}]`, out));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${path}: native ${JSON.stringify(a)}, compat ${JSON.stringify(b)}`);
  return out;
}

/** Bits of the binary16 below (toward zero) and above a finite value inside the half range, exact in doubles. */
function halfNeighbours(v) {
  const a = Math.abs(v),
    sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0,
    e = Math.max(Math.floor(Math.log2(a || 2 ** -24)), -14),
    step = 2 ** (e - 10),
    k = Math.floor(a / step);
  // n steps above zero: a subnormal half below 2^-14, else exponent e (e + 1 when n reaches 2048).
  const encode = (n) => (n * step < 2 ** -14 ? sign | n : sign | (((e + 15) << 10) + (n - 1024)));
  return k * step === a ? [encode(k)] : [encode(k), encode(k + 1)];
}

/** Bits of the nearest binary16 of a finite value inside the half range, ties to even. */
function nearestHalf(v) {
  const [below, above] = halfNeighbours(v);
  if (above === undefined) return below;
  const value = (h) => {
    const e = (h >> 10) & 31,
      m = h & 1023;
    return e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24;
  };
  const a = Math.abs(v),
    down = a - value(below),
    up = value(above) - a;
  return down < up || (down === up && !(below & 1)) ? below : above;
}

/** The compressed-blend scope of each footprint case: linear-mip rows (with their probe) and nearest-mip sweeps. */
const SCOPE = {
  implicitFootprint: (keys) => ({
    rows: Object.fromEntries(keys.filter((k) => k.startsWith('linear/')).map((k) => [k, 'footprint'])),
    sweeps: ['sweep/oblique', 'sweep/near'],
  }),
  mipFiltering: () => ({
    rows: Object.fromEntries(
      ['nearest', 'linear'].flatMap((f) => ['grad', 'bias', 'implicit'].map((m) => [`${f}/${m}`, `mip-${f}`])),
    ),
    sweeps: ['sweep/bias', 'sweep/grad'],
    floats: true,
  }),
};

const lines = [];
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const probe = (bytes, filter) => page.evaluate(([b, f]) => window.check.blendProbe(b, f), [bytes, filter]);
  const whiteBlack = await probe([255, 0, 255, 0, 255], 'linear');
  const { blend, worst } = classifyBlend(whiteBlack.gl, whiteBlack.native);
  const compressed = blend === 'compressed';
  lines.push(
    `mip blend: WebGL2 ${blend === 'native' ? 'equal to native' : blend} (largest weight error ${worst.error.toFixed(5)} at LOD ${worst.k}/256)`,
  );
  const probes = compressed
    ? {
        footprint: await probe([0, 255, 64, 0, 255], 'linear'),
        'mip-nearest': await probe([255, 255, 255, 0, 0], 'nearest'),
        'mip-linear': await probe([255, 255, 255, 0, 0], 'linear'),
      }
    : {};
  const scopeOf = (name, result) => compressed && SCOPE[name] && { ...SCOPE[name](Object.keys(result)), probes };
  let footprintNative;
  const names = await page.evaluate(() => window.check.names());
  for (const name of names) {
    const { native, compat } = await page.evaluate((n) => window.check.run(n), name);
    for (const [side, r] of [
      ['native', native],
      ['compat', compat],
    ]) {
      assert.equal(r.thrown, null, `${name} (${side}) threw`);
      assert.deepEqual(r.errors, [], `${name} (${side}) validation errors`);
      assert.equal(r.gl, 0, `${name} (${side}) GL error`);
    }
    if (name === 'implicitFootprint') footprintNative = native.result;
    const scope = scopeOf(name, native.result);
    if (scope) {
      const rest = (o) =>
        Object.fromEntries(Object.entries(o).filter(([k]) => !scope.rows[k] && !scope.sweeps.includes(k)));
      assert.deepEqual(
        differences(rest(native.result), rest(compat.result)),
        [],
        `${name}: compat differs from native`,
      );
      assert.deepEqual(
        compressedFailures(native.result, compat.result, scope),
        [],
        `${name}: compressed mip blend: not native's LOD through the driver's blend`,
      );
      lines.push(
        `${name}: same LOD as native (nearest-mip sweeps), each blended texel the driver's own blend at it, the rest same as native`,
      );
    } else if (name === 'inverseTrig') {
      // The layer's acos, asin, atan2 and atan within 1e-5 of float64 over the whole domain on every GPU (Scott's ruling,
      // 2026-11-11: the layer emits its own where the driver's miss it, as on ANGLE D3D11). Native is reported.
      // The largest error and where: sweep, index in it, and the pixel (input or inputs, results).
      const worst = (r) => {
        let max = 0,
          at = null;
        for (let p = 0; p < r.length; p += 4) {
          const row = Math.floor(p / 4 / 4096); // the sweep
          const errors =
            row < 3
              ? [r[p + 1] - Math.acos(r[p]), r[p + 2] - Math.asin(r[p])]
              : row === 3
                ? [r[p + 2] - Math.atan2(r[p], r[p + 1])]
                : [r[p + 1] - Math.atan(r[p])];
          for (const e of errors) {
            const size = Number.isNaN(e) ? Infinity : Math.abs(e);
            if (size > max) {
              max = size;
              at = { sweep: row, index: (p / 4) % 4096, pixel: [...r.slice(p, p + 4)] };
            }
          }
        }
        return { max, at };
      };
      assert.equal(compat.result.length, 2048 * 10 * 4, 'inverseTrig values');
      const layer = worst(compat.result);
      assert.ok(
        layer.max <= 1e-5,
        `inverseTrig: the layer's acos, asin, atan2 or atan is ${layer.max} off at ${JSON.stringify(layer.at)}`,
      );
      lines.push(
        `${name}: the layer within ${layer.max.toExponential(2)} of float64 over the whole domain, native ${worst(native.result).max.toExponential(2)}`,
      );
    } else if (name === 'halfExport') {
      // WGSL leaves an inexact narrowing to either neighbour, so native may store either half; the layer stores what
      // native stores on the same GPU. The Radeon 680M truncates under native Direct3D 12 and ANGLE Direct3D 11 alike,
      // so the layer's former rounding to the nearest half (3adffdee0) stored a half native never does (dof compat-check).
      const { values } = compat.result;
      assert.equal(values.length, 32, 'halfExport values');
      native.result.halves.forEach((h, i) =>
        assert.ok(halfNeighbours(values[i]).includes(h), `halfExport native ${values[i]}: ${h} is neither neighbour`),
      );
      assert.deepEqual(
        compat.result.halves,
        native.result.halves,
        'halfExport: the layer stores the halves native stores',
      );
      const nearest = values.filter((v, i) => native.result.halves[i] === nearestHalf(v)).length;
      lines.push(`${name}: the layer stores native's half of each value (native: ${nearest} of 32 the nearest)`);
    } else if (name === 'derivativeBranch') {
      const exact = derivativeExpected(),
        { sample, bias, ...polynomial } = compat.result;
      assert.deepEqual(differences(exact, polynomial), [], `${name}: the layer's derivatives are not the differences`);
      // The two texture cases have no closed form here: the layer reads what native reads.
      assert.deepEqual(
        differences({ sample: native.result.sample, bias: native.result.bias }, { sample, bias }),
        [],
        `${name}: compat differs from native`,
      );
      const wrong = Object.keys(exact).filter((k) => differences(exact[k], native.result[k]).length);
      lines.push(
        `${name}: the layer returns the exact differences and native's samples; native ${wrong.length ? `is wrong in ${wrong.join(', ')}` : 'agrees'}`,
      );
    } else {
      const diff = differences(native.result, compat.result);
      assert.deepEqual(diff, [], `${name}: compat differs from native`);
      lines.push(`${name}: same as native${name === 'mipFiltering' ? ' unfiltered interpolation oracle' : ''}`);
    }
    // Each case must test something: a few known values, so an empty or all-zero result on both sides fails.
    const r = compat.result;
    if (name === 'mipArguments') {
      for (const filter of ['nearest', 'linear'])
        for (const mode of ['implicit', 'bias', 'level', 'grad', 'lazyAnd', 'lazyOr', 'discard'])
          assert.deepEqual(
            r[`${filter}/${mode}`],
            [1, mode.startsWith('lazy') ? 0 : mode === 'implicit' ? 1 : mode === 'grad' ? 1101 : 11, 0, 1],
            `${filter}/${mode}: each argument evaluated once`,
          );
    }
    if (name === 'freshClears')
      for (const kind of ['cube', 'array'])
        for (const [round, want] of [
          [0, 0, 0, 255],
          [0, 0, 255, 255],
        ].entries())
          assert.deepEqual(
            r[`${kind} round ${round} 2/4`],
            want,
            `freshClears: ${kind} level 2 layer 4 keeps its round ${round} clear`,
          );
    if (name === 'foldedExports') {
      assert.deepEqual(r.counts, Array(12).fill(256 * 256 * 4), 'foldedExports: twelve whole targets read');
      assert.ok(
        r.first.every((h) => h > 0 && h < 0x3c01),
        'foldedExports: each target holds the products',
      );
    }
    if (name === 'msaaAspects')
      assert.deepEqual(
        r.map((v, i) => (i % 4 === 1 || i % 4 === 2 ? v : Math.abs(v - 0.5) < 1e-6)),
        Array(4).fill([true, 77, 77, true]).flat(),
        'msaaAspects: depth and stencil, each through its own binding',
      );
    if (name === 'compressedViews' && !r.missing) {
      // Each view reads the blocks: face 0's top-left texel is colour 0 (red), and every layer or face differs.
      assert.deepEqual(r.cubeArray0.slice(0, 4), [1, 0, 0, 1], 'compressedViews: texel (0, 0) of face 0 is colour 0');
      const faces = [0, 1, 2, 3, 4, 5].map((n) => r.cubeArray0.slice(n * 256, n * 256 + 256).join());
      assert.equal(new Set(faces).size, 6, 'compressedViews: the six faces differ');
      assert.deepEqual(
        r.cubeFace3,
        r.cubeArray0.slice(3 * 256, 4 * 256),
        'compressedViews: the 2d view of face 3 is layer 3',
      );
      assert.deepEqual(
        r.stackCube.slice(0, 6 * 256),
        r.cubeArray0,
        'compressedViews: a cube view of array storage reads its layers',
      );
      assert.notDeepEqual(r.cubeArrayAfter, r.cubeArray0, 'compressedViews: a later write reaches the 2d-array view');
      assert.notDeepEqual(
        r.flatArrayAfter,
        r.flatArray,
        'compressedViews: a later write reaches a 1-layer 2d-array view',
      );
      assert.notDeepEqual(r.stackCubeAfter, r.stackCube, 'compressedViews: a later write reaches the cube view');
    }
    if (name === 'compressedCopies' && !r.missing) {
      // Block bytes read back as written: layer 1's second block (texel row 0, x 4) at the padded row and image pitch.
      const second = (layer) => [
        (0xf800 | (layer << 6) | 1) & 255,
        (0xf800 | (layer << 6) | 1) >> 8,
        (0x001f | (1 << 11)) & 255,
        (0x001f | (1 << 11)) >> 8,
        0xe5,
        0xe5 ^ 0x5a,
        0xe5,
        0xe5 ^ 0xa5,
      ];
      assert.deepEqual(
        r.srcLevel0.slice(256 * 3 + 8, 256 * 3 + 16),
        second(1),
        'compressedCopies: copyTextureToBuffer writes the blocks at bytesPerRow and rowsPerImage',
      );
      assert.deepEqual(
        r.srcLevel0.slice(16, 256),
        Array(240).fill(0xcd),
        'compressedCopies: the row padding keeps the buffer',
      );
      assert.deepEqual(
        r.srcLevel2.slice(0, 2),
        [0x1f, 0x00],
        'compressedCopies: a level smaller than one block reads as its one block',
      );
      // Face 2's bottom-left block is layer 1's top-right block; faces 0, 1 and the rest of 2 stay zero.
      assert.deepEqual(
        r.dstLevel0.slice(2 * 512 + 256, 2 * 512 + 264),
        second(1),
        'compressedCopies: copyTextureToTexture moves the block',
      );
      assert.deepEqual(
        r.dstLevel0.slice(2 * 512, 2 * 512 + 16),
        Array(16).fill(0),
        'compressedCopies: untouched blocks stay zero',
      );
      assert.deepEqual(
        [3, 4, 5].flatMap((face) => r.dstLevel1.slice(face * 256, face * 256 + 8)),
        [0, 1, 2].flatMap((layer) => [
          (0x07e0 | (layer << 1)) & 255,
          (0x07e0 | (layer << 1)) >> 8,
          0x10,
          0,
          0x1b,
          0x1b ^ 0x5a,
          0x1b,
          0x1b ^ 0xa5,
        ]),
        'compressedCopies: a whole level copies into three faces',
      );
      assert.notDeepEqual(
        r.dstSampled0.slice(2 * 256 + 128, 2 * 256 + 144),
        Array(16).fill(0),
        'compressedCopies: the copied block samples',
      );
      assert.equal(r.unaligned, 'validation error', 'compressedCopies: an encoder copy with bytesPerRow 8 is invalid');
    }
    if (name === 'compressedSrgbView' && !r.missing) {
      assert.notDeepEqual(r.srgb, r.unorm, 'compressedSrgbView: the sRGB view decodes');
      assert.notDeepEqual(r.srgbAfter, r.srgb, 'compressedSrgbView: a later write reaches the sRGB view');
    }
    if (name === 'nestedSampling') {
      // Every form reads texture a (255, 0, 0, 64), never b (white), whatever samples inside its coordinates.
      for (const form of ['throughFunction', 'direct', 'afterSibling', 'load', 'twoDeep'])
        assert.deepEqual(
          r[form].map((v) => Math.round(v * 255)),
          [255, 0, 0, 64],
          `nestedSampling ${form}: the outer call reads its own texture`,
        );
    }
    if (name === 'volumeSliceDepth') {
      // Rows top first: the wedge covers one texel of the top row and two of the bottom; slice 1 is only cleared.
      const [G, Bl, Y] = [
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
      ];
      const drawn = [Bl, G, G, G, Bl, Bl, G, G].flat();
      assert.deepEqual(
        r,
        [drawn, Array(8).fill(Y).flat(), drawn],
        'volumeSliceDepth: draws reach 3D slices with depth',
      );
    }
    if (name === 'mipFiltering') {
      for (const filter of ['nearest', 'linear'])
        for (const mode of ['level'])
          assert.deepEqual(
            r[`${filter}/${mode}`],
            Array.from({ length: 72 }, (_, i) => 1 - (Math.floor(i / 4) % 9) * 0.125),
            `${filter}/${mode}: exact linear mip weights`,
          );
      if (!scope) {
        for (const filter of ['nearest', 'linear'])
          assert.deepEqual(
            r[`${filter}/grad`],
            native.result[`${filter}/grad`],
            'explicit-gradient hardware footprint matches native exactly',
          );
        assert.deepEqual(
          r['linear/implicit'],
          native.result['linear/implicit'],
          'implicit hardware footprint matches native exactly',
        );
        for (const filter of ['nearest', 'linear'])
          assert.deepEqual(
            r[`${filter}/bias`],
            native.result[`${filter}/bias`],
            'biased hardware footprint matches native exactly',
          );
      }
    }
    if (name === 'implicitFootprint') {
      if (!scope) assert.deepEqual(r, native.result, 'implicit and biased hardware sampling matches native bits');
      for (const filter of ['nearest', 'linear'])
        for (const offset of [false, true]) {
          assert.deepEqual(
            r[`${filter}/0/${offset}`],
            r[`${filter}/implicit/${offset}`],
            'zero bias matches textureSample bits',
          );
          assert.notDeepEqual(
            r[`${filter}/-1.25/${offset}`],
            r[`${filter}/1.25/${offset}`],
            'nonzero bias changes selected mips',
          );
          assert.ok(
            r[`${filter}/0/${offset}`].some((value) => value > 0),
            'footprint probe produces data',
          );
          for (const map of ['oblique', 'near'])
            assert.deepEqual(
              r[`${filter}/${map}-grad/${offset}`],
              r[`${filter}/${map}-implicit/${offset}`],
              `${filter}/${map}: dpdx and dpdy gradients match textureSample bits`,
            );
        }
    }
    // Bug 66: these sanity values are near, not equal to, the ideal bytes: GPUs round a half differently (an Intel Arc
    // 140V gives 192 and 128 where this NVIDIA GPU gives 191 and 127, natively and on the layer alike). The exact
    // check is the comparison with native WebGPU on the same adapter above.
    const near = (got, want, what) =>
      assert.ok(
        got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= 2),
        `${what}: ${JSON.stringify(got)}, about ${JSON.stringify(want)}`,
      );
    if (name === 'blendSplit') {
      const [added, red] = r.targets;
      near(added, [191, 191, 191, 191], 'target 0 blends additively in every channel');
      assert.ok(
        added.every((v) => v === added[0]),
        'target 0 treats every channel alike',
      );
      near(red, [127, 64, 64, 64], 'target 1 writes red only');
      assert.deepEqual(red.slice(1), [red[1], red[1], red[1]], 'target 1 keeps green, blue and alpha');
      assert.ok(red[0] > red[1] + 32, 'target 1 replaced red');
    }
    if (name === 'bitmapCopies') {
      // KB0477: every transform of every bitmap kind is compared with native above; these show the matrix ran and
      // kept straight RGB at alpha 0 (source texel 0, RGB 11, 200, 7, written at 1, 2 of an 8-wide texture).
      assert.equal(Object.keys(r).length, 56, 'bitmapCopies: 48 bitmap cases, 6 format cases, 2 canvas cases');
      const at = (key) => r[key].slice((2 * 8 + 1) * 4, (2 * 8 + 1) * 4 + 4);
      assert.deepEqual(at('none/1/whole/up/straight'), [11, 200, 7, 0], 'straight RGB survives alpha 0');
      assert.deepEqual(at('none/1/whole/up/premultiplied'), [0, 0, 0, 0], 'premultiplied alpha 0 is black');
    }
    if (name === 'compressed' && !r.missing)
      assert.deepEqual(r.pixels.slice(0, 4), [1, 0, 0, 1], 'BC1 colour 0 is red');
    if (name === 'mipViews')
      assert.equal(r.pixels[0], 8 * 1000 + 8 * 100 + 4 * 10 + 4, 'sizes of views of later mip levels');
    if (name === 'canvasRead')
      assert.deepEqual(
        r.frames,
        [
          [255, 0, 0, 255],
          [0, 0, 255, 255],
          [0, 255, 0, 255],
        ],
        'each frame is seen in its own task',
      );
    if (name === 'srgbView') near(r.back.slice(0, 4), [188, 137, 255, 255], 'linear 0.5 through the sRGB view');
    if (name === 'layerView') assert.notDeepEqual(r.after, r.before, 'the render into the layer is seen');
    if (name === 'storage') {
      assert.notDeepEqual(r.written, r.first, 'writeBuffer between submits is seen');
      assert.deepEqual(r.copied, r.written, 'a GPU copy into a storage buffer is seen');
    }
    if (name === 'occlusion')
      assert.deepEqual(r.results, [
        [1, 0, 0],
        [0, 1, 0],
      ]);
    if (name === 'readbacks') {
      assert.equal(r['depth32float depth'][0], 0.25, 'the triangle wrote z 0.25');
      assert.equal(r['stencil8 stencil'][0], 0xa7, 'two increments over 0xa5');
      assert.deepEqual(r.rgb10a2unorm, [0x3ff, 0, 0x155, 0x2aa, 0x40000001, 0xc00ffc00, 0x12345678, 0x87654321]);
    }
    if (name === 'readOnlyDepth') {
      // Red is the sampled depth, green marks a pixel that passed the depth test against the attachment (z 0.5, greater).
      assert.deepEqual(
        [r.split[0], r.split[1], r.split[8], r.split[9]],
        [0.25, 1, 0, 0],
        'the left half is drawn with the depth it samples, the right half fails the depth test',
      );
      assert.deepEqual(r.low.slice(0, 2), [0.125, 1], 'the next round samples the depth written since');
    }
    if (name === 'regressions') {
      assert.deepEqual(r.upload.slice(0, 8), [1, 0, 0, 1, 0, 1, 0, 1], 'the upload reached the texture it named');
      assert.ok(
        r.depthAfter.every((d) => d === 1),
        'a draw with depth writes off left depth untouched',
      );
      assert.deepEqual(r.both.slice(4, 8), [1, 0, 0, 1], 'a copy made for one binding left the other units alone');
    }
  }
  // Self-test: the layer with every footprint coordinate scaled by 1.01 (LOD 0.0144, about 3.7/256, too high) must
  // fail, on a compressed backend through the nearest-mip sweeps (the blend alone cannot see it where it clamps).
  const wrong = await page.evaluate(() => window.check.runCompat('implicitFootprint', { lodScale: 1.01 }));
  assert.equal(wrong.thrown, null, 'wrong-LOD self-test threw');
  const scope = scopeOf('implicitFootprint', footprintNative);
  const caught = scope
    ? compressedFailures(footprintNative, wrong.result, scope)
    : differences(footprintNative, wrong.result);
  assert.ok(
    scope ? caught.some((line) => line.startsWith('sweep/')) : caught.length > 0,
    `a wrong LOD on the layer passes: ${caught.join('; ')}`,
  );
  lines.push(`self-test: a LOD 3.7/256 too high on the layer fails (${caught[0]})`);
  const refusal = await page.evaluate(() => window.check.blendRefusal());
  assert.match(
    refusal,
    /^MargoError unsupported: .*different blend states/,
    'per-target states with depth writes are refused, coded',
  );
  assert.deepEqual(pageErrors, []);
  console.log(`webgl2-compat features (WebGL2 layer vs native WebGPU, same GPU):\n  ${lines.join('\n  ')}`);
} finally {
  await context.close();
}
