// ShaderMaterial's own motion vectors on the GPU (test/glsl-velocity-check.html): after 12 frames of a square that
// slides by a uniform, turns and moves by its matrix under a moving camera, TAA's velocity (rg16float) and previous
// depth (r32float) from the GLSL vertex stage with `velocity` equal those of the same move written in WGSL with
// `velocityEntry`, texel for texel: velocity within one half-float step of its size, depth within 1e-6. The same GLSL
// without `velocity` differs (TAA sees the camera's motion only), so the check sees the shape's own motion. Run
// natively and with --compat (the WebGL2 layer).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

const W = 64,
  H = 64,
  FRAMES = 12;
const context = await openBrowser({ startPath: '/packages/shader/test/glsl-velocity-check.html', port: 'free' }),
  { page } = context,
  errors = [],
  compat = compatRun();
page.on('pageerror', (e) => errors.push(e.message));
// IEEE 754 binary16 to a number.
const half = (lo, hi) => {
  const h = lo | (hi << 8),
    s = h & 0x8000 ? -1 : 1,
    e = (h >> 10) & 31,
    m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
};
// One step of binary16 at the size of v.
const step = (v) => (Math.abs(v) < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(Math.abs(v))) - 10));
const pixels = (bytes) => {
  const v = [],
    d = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * 256 + x * 4;
      v.push([half(bytes.velocity[i], bytes.velocity[i + 1]), half(bytes.velocity[i + 2], bytes.velocity[i + 3])]);
      d.push(new Float32Array(new Uint8Array(bytes.depth.slice(i, i + 4)).buffer)[0]);
    }
  return { v, d };
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const result = await page.evaluate((n) => window.check.run(n), FRAMES);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pending, [0, 0, 0], 'every pipeline compiled');
  const wgsl = pixels(result.out.wgsl),
    glsl = pixels(result.out.glsl),
    plain = pixels(result.out.plain);
  let worstVelocity = 0,
    worstDepth = 0,
    moving = 0,
    history = 0,
    unlike = 0;
  for (let i = 0; i < W * H; i++) {
    const [a, b] = [wgsl.v[i], glsl.v[i]];
    for (let c = 0; c < 2; c++) {
      const off = Math.abs(a[c] - b[c]) / step(Math.max(Math.abs(a[c]), Math.abs(b[c])));
      worstVelocity = Math.max(worstVelocity, off);
      assert.ok(off <= 1, `velocity at x ${i % W}, y ${Math.floor(i / W)} channel ${c}: WGSL ${a[c]}, GLSL ${b[c]}`);
    }
    assert.equal(
      Math.sign(wgsl.d[i]) < 0,
      Math.sign(glsl.d[i]) < 0,
      `history at x ${i % W}, y ${Math.floor(i / W)} in both or neither`,
    );
    if (wgsl.d[i] >= 0) {
      history++;
      worstDepth = Math.max(worstDepth, Math.abs(wgsl.d[i] - glsl.d[i]));
      assert.ok(
        Math.abs(wgsl.d[i] - glsl.d[i]) <= 1e-6,
        `previous depth at x ${i % W}, y ${Math.floor(i / W)}: WGSL ${wgsl.d[i]}, GLSL ${glsl.d[i]}`,
      );
      if (Math.hypot(...wgsl.v[i]) > 1e-3) moving++;
      if (Math.hypot(wgsl.v[i][0] - plain.v[i][0], wgsl.v[i][1] - plain.v[i][1]) > 1e-3) unlike++;
    }
  }
  console.log(
    `GLSL velocity against WGSL velocityEntry, ${compat ? 'WebGL2 layer' : 'native WebGPU'}: ${history} texels with a previous depth, ${moving} moving; worst velocity ${worstVelocity.toFixed(2)} half-float steps, worst previous depth ${worstDepth.toExponential(2)}; the square's own motion (against the same GLSL without velocity) on ${unlike} texels`,
  );
  assert.ok(history > 200 && moving > 200, `enough texels have history and move (${history}, ${moving})`);
  assert.ok(unlike > 200, `without velocity the GLSL square's own motion is missing (${unlike} texels differ)`);
  assert.deepEqual(await page.evaluate(() => window.check.close()), []);
  assert.deepEqual(errors, []);
  console.log('GLSL velocity check passed');
} finally {
  await context.close();
}
