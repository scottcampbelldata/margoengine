// AROcclusion on the GPU: both XR routes ('separate' and 'engine'), on WebGPU and on the WebGL2 layer, with a stand-in
// AR session (packages/webgl2-compat/test/xr.html) whose depth sensor sees a real wall at `wall` metres over the left
// half of each view and no depth (0, invalid) over the right half. The cubes sit 5 to 8 m away, so with the wall at
// 2 m every pixel of the left half must be cleared to transparent black and the right half must equal the frame drawn
// without occlusion byte for byte; with the wall at 20 m nothing is hidden. CPU depth comes as float32 and as
// unsigned-short; on WebGPU the GPU-optimized route (an r32float texture from the binding) must match the CPU route.
// A sensor posed apart from the eyes (moved 1 m to the right, seeing the wall over its left half) checks the
// reprojection: the hidden region moves with it. The column either side of the seam is not counted: a pixel there with
// colour but no depth sample takes its neighbours' verdict.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const fixture = (await readFile('packages/webgl2-compat/test/xr.html', 'utf8')).split(String.fromCharCode(13)).join('');
const replace = (s, from, to) => {
  assert.ok(s.includes(from), from);
  return s.replace(from, to);
};
const DW = 32,
  DH = 16;
function documentFor(params) {
  const usage = params.get('usage') ?? 'cpu-optimized',
    format = params.get('format') ?? 'float32';
  let s = fixture;
  s = replace(
    s,
    "import { XR, createXREngine } from '/packages/xr/dist/index.js';",
    `import { XR, createXREngine } from '/packages/xr/dist/index.js';
import { AROcclusion } from '/packages/xr/dist/occlusion.js';
const query = new URLSearchParams(location.search);
const wall = Number(query.get('wall') ?? 2), occlude = query.get('occlude') !== '0', shift = Number(query.get('shift') ?? 0);
const DW = ${DW}, DH = ${DH};
// The wall covers the left half of the depth buffer; the right half has no depth.
function depthValues(scale) {
  const values = ${format === 'float32' ? 'new Float32Array(DW * DH)' : 'new Uint16Array(DW * DH)'};
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW / 2; x++) values[y * DW + x] = wall * scale;
  return values;
}
const RAW = ${format === 'float32' ? '1' : '0.001'};
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function sensorGeometry(view) {
  if (!shift) return {};
  const m = view.transform.matrix, x = m[12] + shift, y = m[13], z = m[14];
  return {
    projectionMatrix: view.projectionMatrix,
    transform: {
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]),
      inverse: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1]) },
    },
  };
}
function cpuDepth(view) {
  const values = depthValues(1 / RAW);
  return {
    width: DW, height: DH, rawValueToMeters: RAW, data: values.buffer,
    normDepthBufferFromNormView: { matrix: identity },
    getDepthInMeters() { return wall; },
    ...sensorGeometry(view),
  };
}
let gpuDepthTexture = null;`,
  );
  s = replace(
    s,
    '  inputSources = [];',
    `  inputSources = [];
  depthUsage = '${usage}';
  depthDataFormat = '${format}';`,
  );
  s = replace(
    s,
    'fn(performance.now(), { session: this, getViewerPose: () => ({ views: EYES.map(eyeView) }), getPose: () => null });',
    'fn(performance.now(), { session: this, getViewerPose: () => ({ views: EYES.map(eyeView) }), getPose: () => null, getDepthInformation: (view) => cpuDepth(view) });',
  );
  s = replace(
    s,
    '  getViewSubImage(layer, view) {',
    `  getDepthInformation(view) {
    const device = this.device;
    gpuDepthTexture ??= device.createTexture({ size: [DW, DH], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: gpuDepthTexture }, depthValues(1 / RAW), { bytesPerRow: DW * 4 }, [DW, DH]);
    return { width: DW, height: DH, rawValueToMeters: RAW, texture: gpuDepthTexture, normDepthBufferFromNormView: { matrix: identity }, ...sensorGeometry(view) };
  }
  getViewSubImage(layer, view) {`,
  );
  s = replace(
    s,
    "  await xr.requestSession('immersive-vr');\n  while (session.frames < 3) await new Promise((r) => setTimeout(r, 5));",
    `  await xr.requestSession('immersive-ar');
  const occlusion = occlude ? AROcclusion.create(xr) : null;
  const start = session.frames;
  while (session.frames < start + 3) await new Promise((r) => setTimeout(r, 5));`,
  );
  // Content that writes no depth has nothing to compare and is kept (README); the fixture's line writes depth here.
  s = replace(s, 'width: 6 }))', 'width: 6, depthWrite: true }))');
  s = replace(s, '  await xr.end();', '  occlusion?.dispose();\n  await xr.end();');
  return s;
}
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free', compat: false });
const origin = new URL(browser.page.url()).origin,
  results = new Map();
const SIZE = 256;
try {
  await browser.page.route('**/packages/webgl2-compat/test/xr.html*', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: documentFor(new URL(route.request().url()).searchParams),
    }),
  );
  const variants = {
    off: 'occlude=0',
    near: 'wall=2',
    far: 'wall=20',
    short: 'wall=2&format=unsigned-short',
    shifted: 'wall=2&shift=1',
    gpu: 'wall=2&usage=gpu-optimized',
  };
  for (const backend of ['native', 'compat'])
    for (const route of ['separate', 'engine'])
      for (const [variant, query] of Object.entries(variants)) {
        if (variant === 'gpu' && backend === 'compat') continue;
        const key = `${backend}/${route}/${variant}`;
        await browser.page.goto(
          `${origin}/packages/webgl2-compat/test/xr.html?mode=${backend}&route=${route}&${query}`,
        );
        await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
        const result = await browser.page.evaluate(() => window.check);
        assert.deepEqual(result.errors, [], key);
        assert.equal(result.gl, 0, key);
        results.set(
          key,
          result.eyes.map((eye) => Buffer.from(eye, 'base64')),
        );
      }
  const report = [];
  /** Pixels of `a` in columns [x0, x1) that differ from `b`, or that are not transparent black when `b` is null. */
  const count = (a, b, x0, x1) => {
    let n = 0;
    for (let y = 0; y < SIZE; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * SIZE + x) * 4;
        if (b ? a.compare(b, i, i + 4, i, i + 4) !== 0 : a[i] | a[i + 1] | a[i + 2] | a[i + 3]) n++;
      }
    return n;
  };
  for (const backend of ['native', 'compat'])
    for (const route of ['separate', 'engine'])
      for (let eye = 0; eye < 2; eye++) {
        const get = (v) => results.get(`${backend}/${route}/${v}`)?.[eye];
        const off = get('off'),
          half = SIZE / 2,
          row = { backend, route, eye, drawnLeft: count(off, null, 0, half) };
        assert.ok(row.drawnLeft > 1000, `the scene draws in the left half: ${JSON.stringify(row)}`);
        for (const v of ['near', 'short', 'gpu']) {
          const on = get(v);
          if (!on) continue;
          row[`${v}Left`] = count(on, null, 0, half - 1);
          row[`${v}Right`] = count(on, off, half + 1, SIZE);
          assert.equal(row[`${v}Left`], 0, `${v}: the wall hides the left half: ${JSON.stringify(row)}`);
          assert.equal(row[`${v}Right`], 0, `${v}: no depth leaves the right half: ${JSON.stringify(row)}`);
        }
        row.far = count(get('far'), off, 0, SIZE);
        assert.equal(row.far, 0, `far wall hides nothing: ${JSON.stringify(row)}`);
        // The sensor 1 m to the right sees the wall over its left half: from the eye the hidden region keeps the
        // pixels whose surface point lands left of the sensor's centre, so it reaches past the eye's centre line.
        const shifted = get('shifted');
        row.shiftedHidden = count(off, null, 0, SIZE) - count(shifted, null, 0, SIZE);
        row.nearHidden = count(off, null, 0, SIZE) - count(get('near'), null, 0, SIZE);
        assert.ok(row.shiftedHidden > row.nearHidden, `the shifted sensor hides more: ${JSON.stringify(row)}`);
        assert.ok(
          count(shifted, null, 0, half - 1) === 0,
          `shifted: the left half stays hidden: ${JSON.stringify(row)}`,
        );
        report.push(row);
      }
  console.log(JSON.stringify(report));
  console.log('xr occlusion: ok');
} finally {
  await browser.close();
}
