// The XR route check (run by `npm run test:gpu`): `XR` from @margoengine/xr draws one scene in stereo natively and on the
// layer through installXR(), on the same GPU and browser, with stand-ins for navigator.xr and the browser's XR layers
// (test/xr.html says what is real). Each eye must match the native eye by the roadmap's measure (decision 4: at most
// 0.1% of pixels with d > 2, mean d at most 0.25), the two eyes must differ, and the layer must report no GL error.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;
const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/xr.html', port: 'free' });
const { page } = context;
const origin = new URL(page.url()).origin;

async function run(mode, route = 'separate') {
  await page.goto(`${origin}/packages/webgl2-compat/test/xr.html?mode=${mode}&route=${route}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const check = await page.evaluate(() => window.check);
  assert.deepEqual(check.errors, [], `${mode}: page errors`);
  assert.equal(check.gl, 0, `${mode}: WebGL2 reported a GL error`);
  return { ...check, eyes: check.eyes.map((eye) => Buffer.from(eye, 'base64')) };
}

function compare(a, b) {
  let over = 0,
    sum = 0,
    max = 0,
    lit = 0;
  const n = a.length / 4;
  for (let i = 0; i < n; i++) {
    const o = i * 4,
      d = Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]));
    if (d > 2) over++;
    sum += d;
    max = Math.max(max, d);
    if (b[o] + b[o + 1] + b[o + 2] > 60) lit++;
  }
  return { share: over / n, mean: sum / n, max, lit };
}

try {
  const native = await run('native'),
    compat = await run('compat');
  assert.equal(compat.vendor, 'margo-webgl2', 'the XR device is the layer');
  assert.notEqual(native.vendor, 'margo-webgl2', 'the native run has its own WebGPU');
  assert.ok(native.features.includes('webgpu'), 'a WebGPU session asks for webgpu');
  assert.ok(!compat.features.includes('webgpu'), 'a WebGL session must not ask for webgpu');
  assert.ok(compat.baseLayer, 'the layer session shows an XRWebGLLayer');
  assert.equal(compat.init.framebufferScaleFactor, 0.5, 'framebufferScale reaches the XRWebGLLayer');
  assert.ok(compare(native.eyes[0], native.eyes[1]).share > 0.01, 'the eyes must see different things');
  for (const [i, eye] of ['left', 'right'].entries()) {
    const m = compare(native.eyes[i], compat.eyes[i]);
    console.log(`${eye} eye: ${(m.share * 100).toFixed(3)}% over 2, mean ${m.mean.toFixed(3)}, max ${m.max}`);
    assert.ok(m.lit > 3000, `${eye}: only ${m.lit} lit pixels; the scene must not be empty`);
    assert.ok(m.share <= MAX_SHARE && m.mean <= MAX_MEAN, `${eye}: the layer's pixels differ from native WebGPU`);
  }
  // The engine route (createXREngine): each eye is a view of the engine's frame graph, so a package pass (a line from
  // @margoengine/lines) is drawn, on the layer as natively.
  const nativeEngine = await run('native', 'engine'),
    compatEngine = await run('compat', 'engine');
  assert.equal(nativeEngine.route, 'engine', 'createXREngine shares its device with XR natively');
  assert.equal(compatEngine.route, 'engine', 'createXREngine shares its device with XR on the layer');
  assert.equal(compatEngine.vendor, 'margo-webgl2', 'the engine route runs on the layer');
  assert.ok(!compatEngine.features.includes('webgpu'), 'a WebGL session must not ask for webgpu');
  for (const [i, eye] of ['left', 'right'].entries()) {
    const m = compare(nativeEngine.eyes[i], compatEngine.eyes[i]),
      green = (pixels) => {
        let n = 0;
        for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 1] > 180 && pixels[p] < 90 && pixels[p + 2] < 90) n++;
        return n;
      };
    console.log(
      `engine route ${eye} eye: ${(m.share * 100).toFixed(3)}% over 2, mean ${m.mean.toFixed(3)}, max ${m.max}`,
    );
    assert.ok(m.lit > 3000, `engine route ${eye}: only ${m.lit} lit pixels; the scene must not be empty`);
    assert.ok(
      green(nativeEngine.eyes[i]) > 100 && green(compatEngine.eyes[i]) > 100,
      `engine route ${eye}: the line is missing`,
    );
    assert.ok(
      m.share <= MAX_SHARE && m.mean <= MAX_MEAN,
      `engine route ${eye}: the layer's pixels differ from native WebGPU`,
    );
  }
  console.log('XR route check passed');
} finally {
  await context.close();
}
