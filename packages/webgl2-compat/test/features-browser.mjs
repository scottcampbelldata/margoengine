// Milestone M3 feature check (run by `npm run test:gpu`, part of check:merge): each case of features.html runs on the
// browser's own WebGPU and on the WebGL2 layer in the same page, on the same GPU, and the two must return the same
// numbers. mipFiltering uses native textureLoad plus f32 interpolation for explicit requests. Hardware implicit
// LOD has finite fraction precision, so implicit requests use the real native sampler and must match it exactly.
// WebGPU 7.1.1 does not guarantee exact hardware-filter weights (see features.html); explicit assertions stay exact.
// Integers and bytes must be equal; floats equal within 1e-6 (both paths read the same stored values, so
// in practice they are bit-identical). Neither side may report a validation error, throw, or (the layer) a GL error.
// The cases: sRGB views of a unorm texture, 2D views of array layers, cube views of 6- and 12-layer textures and an
// array view of a cube, copyTextureToBuffer of depth, stencil, packed and snorm formats, occlusion queries, render
// bundles, textureGather in every address mode and textureGatherCompare, an external texture from a VideoFrame, and
// two regressions (an upload on the wrong texture unit; depth writes after a multisample resolve), and a depth texture
// sampled by the pass it is attached to read-only, and 3D texture slices drawn beside a depth attachment (ANGLE's
// Direct3D 11 back end drops such draws; the layer draws them in a 2D stand-in).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/features.html', port: 'free', compat: false });
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

const lines = [];
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
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
    const diff = differences(native.result, compat.result);
    assert.deepEqual(diff, [], `${name}: compat differs from native`);
    lines.push(`${name}: same as native${name === 'mipFiltering' ? ' unfiltered interpolation oracle' : ''}`);
    // Each case must test something: a few known values, so an empty or all-zero result on both sides fails.
    const r = compat.result;
    if (name === 'mipArguments') {
      for (const filter of ['nearest', 'linear'])
        for (const mode of ['implicit', 'bias', 'level', 'grad', 'lazyAnd', 'lazyOr', 'discard'])
          assert.deepEqual(r[`${filter}/${mode}`], [1, mode.startsWith('lazy') ? 0 : mode === 'implicit' ? 1 : mode === 'grad' ? 1101 : 11, 0, 1], `${filter}/${mode}: each argument evaluated once`);
    }
    if (name === 'volumeSliceDepth') {
      // Rows top first: the wedge covers one texel of the top row and two of the bottom; slice 1 is only cleared.
      const [G, Bl, Y] = [[0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];
      const drawn = [Bl, G, G, G, Bl, Bl, G, G].flat();
      assert.deepEqual(r, [drawn, Array(8).fill(Y).flat(), drawn], 'volumeSliceDepth: draws reach 3D slices with depth');
    }
    if (name === 'mipFiltering') {
      for (const filter of ['nearest', 'linear'])
        for (const mode of ['level', 'bias'])
          assert.deepEqual(r[`${filter}/${mode}`], Array.from({ length: 72 }, (_, i) => 1 - (Math.floor(i / 4) % 9) * 0.125), `${filter}/${mode}: exact linear mip weights`);
      for (const filter of ['nearest', 'linear'])
        assert.ok(r[`${filter}/grad`].every((x, i) => Math.abs(x - (1 - (Math.floor(i / 4) % 9) * 0.125)) < 1e-6), 'explicit gradients, float arithmetic');
      assert.deepEqual(r['linear/implicit'], native.result['linear/implicit'], 'implicit hardware footprint matches native exactly');
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
