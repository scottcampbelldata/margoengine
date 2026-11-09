// Real-GPU checks of @margoengine/voxel-pathtracer (run from the repository root after building packages, one GPU job
// at a time: node scripts/gpu-lock.mjs run --owner=voxel-pathtracer -- node packages/voxel-pathtracer/tests/browser-check.mjs).
// - compile: the trace, denoise and display WGSL compile with no diagnostics and no WebGPU validation errors;
// - traversal: per-pixel first hits on the GPU (instance, palette index, distance) equal VoxelPathTracer.raycast on
//   the CPU for rotated, scaled, sheared and mirrored instances, perspective and orthographic;
// - analytic: furnaces (diffuse, metal, plastic, glass, media, blend, constant environment map), direct emission,
//   Beer-Lambert media, emissive media, a tinted absorbing glass slab, sun irradiance (point and disk), two emissive
//   planes (emitter sampling with MIS) and a large area light, each against its closed-form value;
// - energy: white furnaces of metal and glass planes at roughness 0.2/0.5/0.8/1 and 20/60/80 degrees equal 1 (multiple-
//   scattering compensation), gold equals Kulla-Conty's expectation from numerically integrated albedos;
// - microfacet: the GGX plastic coat's albedo against numerical integration of the same model;
// - glasslight: sunlight through glass slabs and off a mirror wall against closed forms (point and disk sun), and light
//   sampling through a floating glass cube against path sampling of the same light;
// - sky: the physical sky's zenith luminance and chromaticity, luminance ratios and a floor's irradiance against
//   Preetham's formulas;
// - projections: markers land where the panorama (fitted to the width or the height), equidistant/equisolid/stereographic
//   fisheye and Brown-Conrady formulas put them;
//   per-pixel first hits of each agree with raycast along rays computed in the page;
// - arealight: a panel's shadow area under a point sun, its front, back and see-through back radiance, and a dark
//   panel occluding a lit ceiling against view factors;
// - dispersion: a line's shift through a tilted slab per wavelength against Snell with Cauchy's index; colour order over
//   the spectrum; a dispersive white furnace per channel;
// - environment: the equirectangular map's orientation; determinism: equal seeds give identical images;
// - textures: every pixel's albedo is the texel the CPU finds through the same face tiling, on a rotated block;
// - cutout: rays and shadows pass texels cut away by alpha (a leaf wall, a leaf slab over a floor under a high sun);
// - shapes: half-block shapes: per-pixel first hits on a random shaped model against raycast, a cut-out layer of
//   slabs passing sunlight through its cut stripes only, and ceilings of emissive slabs (quarter and mid-cell emitter
//   faces) lighting a floor to 2/3 as the analytic emissive planes do;
// - transparent: alpha is the camera rays' coverage, covered pixels match the opaque render, escapes add nothing;
// - convergence: error against a 4096-sample reference falls about as 1/sqrt(samples), both projections;
// - denoise: error with and without the wavelet denoiser, overall and at object edges, also on two caustic scenes;
// - denoisepeak: a lamp-lit stretch of wall keeps its level and loses error through the denoiser (16, 64 samples);
// - denoisehistory: the viewport's denoiser while the camera moves, against the converged image and a still camera;
// - lens: depth of field blurs out-of-focus edges only; motion blur spreads a moving cube along its path; camera motion
//   blur widens a line's profile to the box-convolution width;
// - viewport: disabled is bit-identical to raster, dispose restores raster, a device restore redraws the same image;
// - capture: PNG dimensions, cancellation, whenIdle after it; `--timing` adds GPU time per frame at 1920x1080 and upload
//   costs;
// - materialtables: model material tables render as one shared table does (bit for bit); 300 models with 300 colours;
// - largemodels: a 400-cell glass bar has no interface where 200-cell tiles would meet; a 2048 x 64 x 2048 sparse world;
// - native4k: a 3840 x 2160 viewport traced at its native size with the default limits, raw and denoised (moving camera).
// Results go to test-results/voxel-pathtracer-browser-check.json (or -<name>.json, see `--report`); `pictures` writes PNGs to test-results/voxel-pathtracer.
// `denoise` runs its four scenes as four cases; `denoise-diffuse`, `denoise-opaque`, `denoise-materials` and
// `denoise-caustics` name one each. With no case named every case but `pictures` and `timing` runs; the package's
// check runs them as five scripts (test:gpu, test:gpu:denoise, test:gpu:denoise-materials, test:gpu:denoise-caustics,
// test:gpu:viewport), each within its time limit on an Intel Arc 140V (tests/voxel-pathtracer-gpu-split.test.js
// checks they name every case once). `--report=<name>` writes the results to
// test-results/voxel-pathtracer-browser-check-<name>.json. An unknown case name fails the run.
// A case in which no GPU work finishes for MARGO_GPU_STALL_S (120 s) fails at once, naming the case, its last progress
// step and its render (tests/progress.mjs); each case's time and longest wait for the GPU are printed and kept in the
// JSON (`timings`). `--stall-in-render=<k>` makes every GPU wait hang once the k-th renderImage has started (the
// stand-in tests/stall-check.mjs uses).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { installProgress, stallLimitMs, watched } from './progress.mjs';

const started = performance.now(),
  path = '/packages/voxel-pathtracer/tests/browser-check.html',
  // A free port, never a fixed one: the `spec-math` run (5 s) sat 265 s behind another helper's 7-minute run of this
  // suite on port 5223 until the harness killed it as hung (bug 38).
  port = 'free',
  args = process.argv.slice(2),
  named = args.filter((a) => !a.startsWith('--')),
  asked = new Set(['denoise']),
  wanted = (name) => (asked.add(name), named.length ? named.includes(name) : name !== 'pictures' && name !== 'timing'),
  // Each package script names its cases and its own results file (`--report=<name>`), so the split scripts do not
  // overwrite one another's results.
  reportName = args.find((a) => a.startsWith('--report='))?.slice(9),
  stallInRender = Number(args.find((a) => a.startsWith('--stall-in-render='))?.slice(18) ?? 0),
  stallMs = stallLimitMs(),
  // On the layer, ANGLE's Vulkan backend on Windows: its Direct3D backend takes minutes on the tracer's kernels (limits.md).
  context = await openBrowser({
    startPath: path + (args.includes('--spectral') ? '?spectral=1' : ''),
    port,
    ...(args.includes('--compat') && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  }),
  { page, hardware } = context,
  pageErrors = [],
  timings = {},
  report = { hardware, date: new Date().toISOString(), results: {}, timings };
// A slow check says where it is, so a slow run reads differently from a hung one: the page logs `progress ...` lines,
// shown with the time since the start, and a line is printed at least every 30 s (the last progress line again).
let lastProgress = 'starting',
  lastPrinted = performance.now();
const say = (text) => {
  lastPrinted = performance.now();
  console.log(`  [${((lastPrinted - started) / 1000).toFixed(0)} s] ${text}`);
};
const heartbeat = setInterval(() => {
  if (performance.now() - lastPrinted >= 30000) say(`still running, last step: ${lastProgress}`);
}, 5000);
heartbeat.unref();
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
  else if (m.text().startsWith('progress ')) say((lastProgress = m.text()));
});
page.setDefaultTimeout(900000);
// `label` names the case in the output (`run` uses the page function's name); the page's GPU progress is watched.
const runAs = async (label, name, ...params) => {
  lastProgress = label;
  const t0 = performance.now(),
    gaps = {},
    result = await watched(
      page,
      label,
      page.evaluate(([n, p]) => window.check[n](...p), [name, params]),
      { stallMs, step: () => lastProgress, gaps },
    ),
    seconds = (performance.now() - t0) / 1000;
  timings[label] = { seconds: Math.round(seconds * 10) / 10, longestGpuWait: Math.round(gaps.longestMs / 1000) };
  if (label === name) report.results[name] = { ...result, png: undefined };
  console.log(`${label} (${seconds.toFixed(1)} s; longest wait for the GPU ${timings[label].longestGpuWait} s)`);
  assert.deepEqual(result.errors ?? [], [], `${label}: WebGPU errors`);
  return result;
};
const run = (name, ...params) => runAs(name, name, ...params);
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.userAgent);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  await installProgress(page, { stallInRender });
  if (wanted('agx')) {
    const r = await run('agx');
    console.log(JSON.stringify(r));
    assert.equal(
      r.combinedHDR.converged,
      true,
      `combinedHDR: no traced image on the HDR target after ${r.combinedHDR.frames} frames`,
    );
    for (const mode of [
      'capture',
      'viewport',
      'restored',
      'combinedHDR',
      'tonemap',
      'imagePost',
      ...[-4, 0, 3].flatMap((ev) => ['tonemapEV' + ev, 'imagePostEV' + ev]),
    ]) {
      assert.ok(r[mode].max <= 2, `${mode}: maximum error <=2 sRGB levels`);
      assert.ok(r[mode].within1 >= 0.99, `${mode}: >=99% of pixels within one sRGB level of the CPU agx()`);
    }
    assert.equal(r.restored.replaced, true, 'AgX still matches on a replacement device');
    near(r.alpha[3], 128, 1, 'AgX preserves half coverage');
    r.alpha.slice(0, 3).forEach((x) => near(x, 118, 1, 'straight-alpha 18% grey stays 0.18'));
  }
  if (wanted('groundprecision')) {
    const r = await run('groundprecision');
    console.log(JSON.stringify(r));
    assert.ok(r.control.dim > 1000, 'old ground-point control reproduces the ellipse');
    assert.ok(r.sun.dark > 5 && r.sun.lit > 1000, 'the corrected ground still receives a separate sun shadow');
    for (const mode of ['raw', 'denoised']) {
      assert.equal(r[mode].badGuide, 0, `${mode}: all first-hit guides describe the ground plane`);
      assert.equal(r[mode].dim, 0, `${mode}: no ground self-shadow ellipse`);
      assert.ok(r[mode].worst < 0.00001, `${mode}: Lambert ground under unit sky equals its albedo`);
    }
  }
  if (wanted('denoiseholdout')) {
    const r = await run('denoiseholdout');
    console.log(JSON.stringify(r));
    assert.ok(r.analyticDetail.raw.max < 0.00001, 'analytic stripe raw equals its known albedo');
    assert.ok(r.analyticDetail.denoised.max < 0.00001, 'denoising preserves exact one-cell palette detail');
    for (const samples of [4, 16, 64]) {
      const group = r.glassFireflyEdges[samples];
      const mean = (mode, key) => group[mode].reduce((sum, s) => sum + s[key], 0) / group[mode].length;
      assert.ok(mean('denoised', 'rmse') < mean('raw', 'rmse'), `heldout ${samples}: overall error improves`);
      assert.ok(mean('denoised', 'edgeRMSE') < mean('raw', 'edgeRMSE'), `heldout ${samples}: edge error improves`);
    }
  }
  if (wanted('compat')) {
    const c = await run('compat');
    near(c['rough metal compensation true'].mean, 1, 0.01, 'compensated rough metal');
    assert.ok(c['rough metal compensation false'].mean < 0.985, 'uncompensated rough metal loses energy');
    near(c['metalColor 0.5'].mean, 0.53, 0.04, 'metalColor');
    const gain = c['coat additive'].mean - c['coat layered'].mean;
    assert.ok(gain > 0.01 && gain < 0.06, `additive coat adds the base's share of the Fresnel: ${gain}`);
    near(c['untinted glass'].mean, 1, 0.02, 'untinted glass is clear');
    near(c['voxelwise blend'].mean, 1, 0.03, 'voxelwise blend keeps its energy');
    c.background.forEach((v, k) => near(v, [0.2, 0.4, 0.6][k], 1e-6, 'background'));
    near(c.grid[0], 0.36, 0.01, 'grid lines cover 0.36 of the ground');
    near(c.grid[0] + c.grid[2], 1, 0.01, 'grid: lines and ground share the pixels');
    near(c.edges[0], 0.1211, 0.006, 'edge bands cover 0.1211 of the plate');
    near(
      c['contact transmission true'].mean / c['contact transmission false'].mean,
      0.5,
      0.02,
      'contact transmission halves what is seen through the blend',
    );
    near(c['camera emission 0.5'].mean, 0.5, 0.005, 'camera emission');
    near(c['diffuse cap 1'].mean, 0.5, 0.01, 'diffuse cap 1');
    near(c['diffuse cap 2'].mean, 0.5, 0.01, 'diffuse cap 2');
    near(c['diffuse cap 3'].mean, 0.625, 0.012, 'diffuse cap 3');
    near(c['diffuse sunSpecular true'].mean, 0.5, 0.01, 'diffuse floor, sun on every lobe');
    near(c['diffuse sunSpecular false'].mean, 0.5, 0.01, 'diffuse floor, sun on diffuse lobes only');
    assert.ok(c['rough metal sunSpecular true'].mean > 0.05, 'rough metal shows the sun');
    near(c['rough metal sunSpecular false'].mean, 0, 1e-6, 'no sun on the metal lobe');
    near(c['floor under glass transparentShadows false'].mean, 0, 1e-6, 'glass blocks the sun');
    assert.ok(c['floor under glass transparentShadows true'].mean > 0.3, 'light through glass');
    assert.ok(c['cloud sunInMedia true'].mean > 0.05, 'sun-lit cloud');
    near(c['cloud sunInMedia false'].mean, 0, 1e-6, 'no sun in media');
    near(
      c['sunlit cloud sunInMedia false'].mean,
      c['cloud sunInMedia true'].mean,
      0.15 * c['cloud sunInMedia true'].mean,
      'sunlit medium',
    );
    near(
      c['sunlit cloud scatter cap 1'].mean,
      c['sunlit cloud sunInMedia false'].mean,
      0.05 * c['sunlit cloud sunInMedia false'].mean,
      'sunlit medium ignores the scatter cap',
    );
    near(
      c['sunlit slab transparentShadows false'].mean,
      c['sunlit slab transparentShadows true'].mean,
      0.03 * c['sunlit slab transparentShadows true'].mean,
      'sunlit slab lit through its own volume',
    );
    // Fade scale = the ground's distance: the sky takes 1 - 1/e of the grey ground; from that distance on, none.
    near(c['ground fade'].mean, 1 - 0.5 / Math.E, 0.01, 'ground fade');
    near(c['ground fade start'].mean, 0.5, 0.01, 'ground fade start');
    near(c['model fade true'].mean, 1 - 0.5 / Math.E, 0.01, 'fadeModels fades a model');
    near(c['model fade false'].mean, 0.5, 0.01, 'models keep their colour without fadeModels');
    near(c['fog floor'].mean, 0.25 * Math.exp(-0.5) + 0.5 * (1 - Math.exp(-0.5)), 0.008, 'fog floor');
    near(c['fog sky 0.5'].mean, 0.5, 0.002, 'fog glow');
    assert.equal(c['aces gamma byte'].byte, 175, 'ACES and gamma 2.2');
  }
  if (wanted('compile')) {
    const r = await run('compile');
    assert.deepEqual(r.messages, [], 'shader compilation messages');
    assert.equal(r.status, 'ready');
    assert.ok(r.stats.samples > 0, JSON.stringify(r.stats));
    console.log(`  ok: shaders compile with no messages; ${r.stats.samples} viewport samples`);
  }
  if (wanted('preview')) {
    const r = await run('preview');
    console.log(
      `  lit preview frames at ${Math.round(r.litWhileCompiling)} ms; full tracer ready at ${Math.round(r.readyAt)} ms`,
    );
    // (After another check on the same device the compile is cached and ready at once: nothing to preview then.)
    if (r.readyAt > 500)
      assert.ok(
        r.litWhileCompiling >= 0 && r.litWhileCompiling < r.readyAt,
        'the preview shows the scene before the tracer is ready',
      );
  }
  if (wanted('traversal')) {
    const r = await run('traversal');
    for (const name of ['perspective', 'orthographic']) {
      const t = r[name];
      console.log(
        `  ${name}: ${t.same}/${t.pixels} pixels agree (${t.hits} hit voxels), depth within ${t.maxRelativeDepth.toExponential(2)}`,
        t.mismatch.length ? JSON.stringify(t.mismatch) : '',
      );
      assert.ok(t.hits > t.pixels / 4, `${name}: the view shows voxels`);
      assert.ok(
        t.same >= t.pixels - Math.ceil(t.pixels * 0.002),
        `${name}: GPU and CPU first hits differ: ${JSON.stringify(t.mismatch)}`,
      );
      assert.ok(t.maxRelativeDepth < 1e-4, `${name}: depth`);
    }
  }
  if (wanted('analytic')) {
    const r = await run('analytic'),
      expect = {
        'diffuse 0.5': [0.5, 0.005],
        'diffuse 1': [1, 0.01],
        'smooth metal 1': [1, 0.002],
        'smooth plastic 1': [1, 0.01],
        'clear glass': [1, 0.02],
        'white media': [1, 0.02],
        'diffuse 0.5 env map': [0.5, 0.005],
        'emission 3': [3, 0.001],
        'rough metal 1': [1, 0.02],
        'rough glass': [1, 0.02],
        'beer-lambert exp(-1)': [Math.exp(-1), 0.01],
        'tinted glass slab': [0.04 + (0.96 * 0.96 * 0.5 * 0.6185) / (1 - 0.04 * 0.6185), 0.01],
        'sun 0': [0.5, 0.005],
        'sun 0.2': [0.5, 0.005],
        'emissive ceiling 2/3': [2 / 3, 0.01],
        'area light 1': [1, 0.01],
        'media shadow': [0.5 * Math.exp(-1), 0.002],
      };
    for (const [name, s] of Object.entries(r)) {
      if (name === 'errors') continue;
      console.log(`  ${name}: mean ${s.mean.toFixed(4)} over ${s.pixels} px (sd ${s.sd.toFixed(4)})`);
      assert.ok(s.pixels > 100, `${name}: the object fills the view`);
      if (expect[name]) near(s.mean, expect[name][0], expect[name][1], name);
      if (s.expected !== undefined)
        near(s.mean, s.expected, s.expected * 0.01, `${name} (integrated ${s.expected.toFixed(4)})`);
    }
    // Single-scattering GGX loses some energy at high roughness (no multiple-scattering compensation): bounded.
    // The plastic coat (and the coat inside blend) is single scattering: bounded, not exact.
    for (const name of ['rough plastic 1', 'white blend', 'white subsurface'])
      assert.ok(r[name].mean > 0.85 && r[name].mean < 1.005, `${name}: ${r[name].mean}`);
  }
  if (wanted('glasslight')) {
    const r = await run('glasslight');
    for (const [name, s] of Object.entries(r)) {
      if (name === 'errors') continue;
      console.log(
        `  ${name}: ${s.mean.toFixed(4)} expected ${s.expected.toFixed(4)} (${((s.mean / s.expected - 1) * 100).toFixed(2)}%, sd ${s.sd.toFixed(4)}, ${s.pixels} px)`,
      );
      assert.ok(s.pixels > 300, `${name}: the floor fills the view`);
      near(s.mean, s.expected, s.expected * 0.01, name);
    }
  }
  if (wanted('sky')) {
    const r = await run('sky');
    for (const [name, s] of Object.entries(r)) {
      if (name === 'errors') continue;
      if (name.endsWith('zenith')) {
        console.log(
          `  ${name}: luminance ${s.luminance.toFixed(5)} expected ${s.expected.toFixed(5)}, xy ${s.x.toFixed(4)} ${s.y.toFixed(4)} expected ${s.xz.toFixed(4)} ${s.yz.toFixed(4)}`,
        );
        near(s.luminance, s.expected, s.expected * 0.005, `${name} luminance`);
        near(s.x, s.xz, 0.002, `${name} x`);
        near(s.y, s.yz, 0.002, `${name} y`);
      } else if (name.endsWith('floor')) {
        console.log(`  ${name}: ${s.luminance.toFixed(5)} expected ${s.expected.toFixed(5)} (0.5 / pi x irradiance)`);
        near(s.luminance, s.expected, s.expected * 0.01, name);
      } else {
        console.log(`  ${name}: ratio to zenith ${s.ratio.toFixed(4)} expected ${s.expected.toFixed(4)}`);
        near(s.ratio, s.expected, s.expected * 0.01, name);
      }
    }
  }
  if (wanted('projections')) {
    const r = await run('projections');
    for (const [name, s] of Object.entries(r)) {
      if (name === 'errors' || name.startsWith('traversal')) continue;
      console.log(
        `  ${name}: (${s.measured.map((v) => v.toFixed(2)).join(', ')}) expected (${s.expected.map((v) => v.toFixed(2)).join(', ')}), ${s.error.toFixed(3)} px`,
      );
      assert.ok(s.error < 0.25, `${name}: marker ${s.error} px from its projection`);
    }
    for (const name of ['traversal panorama', 'traversal fisheye', 'traversal distorted']) {
      const t = r[name];
      console.log(
        `  ${name}: ${t.same}/${t.pixels} pixels agree with raycast (${t.hits} hit voxels), depth within ${t.maxRelativeDepth.toExponential(2)}`,
        t.mismatch.length ? JSON.stringify(t.mismatch) : '',
      );
      assert.ok(t.hits > 300, `${name}: the view shows voxels`);
      assert.ok(t.same >= t.pixels - Math.ceil(t.pixels * 0.002), `${name}: GPU and CPU first hits differ`);
      assert.ok(t.maxRelativeDepth < 1e-4, `${name}: depth`);
    }
  }
  if (wanted('arealight')) {
    const r = await run('arealight');
    console.log(
      `  4 x 4 panel's shadow under a point sun: ${r['shadow area'].area.toFixed(3)} units^2 (expected 16); opaque false ${r['shadow area, opaque false'].area.toFixed(3)} (0)`,
    );
    near(r['shadow area'].area, 16, 0.32, 'panel shadow area');
    assert.equal(r['shadow area, opaque false'].area, 0, 'a see-through panel casts no shadow');
    console.log(
      `  seen: front ${r.front.radiance.toFixed(4)} (3), back ${r.back.radiance.toFixed(4)} (0), back with opaque false ${r['back, opaque false'].radiance.toFixed(4)} (sky 0.25)`,
    );
    near(r.front.radiance, 3, 0.001, 'panel front radiance');
    near(r.back.radiance, 0, 0.001, 'one-sided panel back');
    near(r['back, opaque false'].radiance, 0.25, 0.001, 'see-through panel back');
    for (const name of ['occluded ceiling', 'occluded ceiling, opaque false']) {
      const s = r[name];
      console.log(
        `  ${name}: floor ${s.mean.toFixed(4)} expected ${s.expected.toFixed(4)} (${((s.mean / s.expected - 1) * 100).toFixed(2)}%, view factors)`,
      );
      near(s.mean, s.expected, s.expected * 0.01, name);
    }
  }
  if (wanted('dispersion')) {
    const r = await run('dispersion');
    console.log(`  line at ${r.calibration.line.toFixed(3)} px, ${r.calibration.pixelsPerUnit.toFixed(3)} px per unit`);
    for (const [name, s] of Object.entries(r)) {
      if (!name.startsWith('abbe')) continue;
      console.log(
        `  ${name}: slab shift ${s.measured.toFixed(4)} expected ${s.expected.toFixed(4)} (n ${s.n.toFixed(4)}, Snell)`,
      );
      near(s.measured, s.expected, 0.005, name);
    }
    const spread = r['abbe 20 450 nm'].measured - r['abbe 20 650 nm'].measured,
      expected = r['abbe 20 450 nm'].expected - r['abbe 20 650 nm'].expected;
    console.log(`  450 - 650 nm: ${spread.toFixed(4)} expected ${expected.toFixed(4)}`);
    near(spread, expected, expected * 0.02, 'dispersion between 450 and 650 nm');
    const { red, green, blue } = r.spectrum;
    console.log(
      `  whole spectrum, per channel: red ${red.toFixed(4)} green ${green.toFixed(4)} blue ${blue.toFixed(4)}`,
    );
    assert.ok(red < green && green < blue, 'blue refracts more than red');
    console.log(`  white furnace: ${r.furnace.mean.map((v) => v.toFixed(4)).join(' ')} (${r.furnace.pixels} px)`);
    for (const v of r.furnace.mean) near(v, 1, 0.01, 'dispersive glass white furnace');
  }
  if (wanted('microfacet')) {
    const r = await run('microfacet');
    for (const [name, m] of Object.entries(r)) {
      if (name === 'errors') continue;
      console.log(
        `  ${name}: traced ${m.measured.toFixed(4)} (sd ${m.sd.toFixed(4)}, ${m.pixels} px), integrated ${m.integrated.toFixed(4)}`,
      );
      near(m.measured, m.integrated, 0.006, name);
    }
  }
  if (wanted('energy')) {
    const r = await run('energy');
    let worst = 0;
    for (const [name, m] of Object.entries(r)) {
      if (name === 'errors') continue;
      const expected = m.expected ?? [1, 1, 1],
        error = Math.max(...m.rgb.map((v, c) => Math.abs(v - expected[c]) / expected[c]));
      console.log(
        `  ${name}: ${m.rgb.map((v) => v.toFixed(4)).join(' ')} expected ${expected.map((v) => v.toFixed(4)).join(' ')} (${(error * 100).toFixed(2)}%, ${m.pixels} px)`,
      );
      assert.ok(m.pixels > 400, `${name}: the surface fills the view`);
      worst = Math.max(worst, error);
      assert.ok(error < 0.02, `${name}: ${(error * 100).toFixed(2)}% from the expected albedo`);
    }
    report.results.energy.worst = worst;
    console.log(`  worst relative error ${(worst * 100).toFixed(2)}%`);
  }
  if (wanted('environment')) {
    const r = await run('environment');
    console.log('  ', JSON.stringify(r));
    assert.deepEqual(r['-z'], [0, 0, 1]);
    assert.deepEqual(r['+x'], [1, 1, 0]);
    assert.deepEqual(r['-x'], [0, 1, 0]);
    assert.deepEqual(r['+z'], [1, 0, 0]);
  }
  if (wanted('textures')) {
    const r = await run('textures');
    console.log(
      `  ${r.same}/${r.hits} pixels' albedo equal the CPU's texel, faces ${r.faces.join(' ')}`,
      JSON.stringify(r.bad),
    );
    assert.deepEqual(r.errors, []);
    assert.ok(r.faces.length >= 3, 'three faces in view');
    assert.ok(r.same >= 0.995 * r.hits, 'texels as the CPU tiles them (texel and face borders may differ by rounding)');
  }
  if (wanted('cutout')) {
    const r = await run('cutout');
    console.log(' ', JSON.stringify(r));
    assert.deepEqual(r.errors, []);
    assert.ok(
      r.wall.checked > 1000 && r.wall.right === r.wall.checked,
      'the wall shows the block behind exactly through its cut texels',
    );
    assert.ok(
      Math.abs(r.shadow.lit - r.shadow.expected) < 0.03 * r.shadow.expected,
      'sunlight through the cut stripes',
    );
    assert.ok(r.shadow.dark < 0.01, 'shadow under the solid stripes');
  }
  if (wanted('shapes')) {
    const r = await run('shapes'),
      t = r.traversal;
    console.log(
      `  shapes traversal: ${t.same}/${t.pixels} pixels agree (${t.hits} hit voxels), depth within ${t.maxRelativeDepth.toExponential(2)}`,
      t.mismatch.length ? JSON.stringify(t.mismatch) : '',
    );
    console.log(
      ' ',
      JSON.stringify({
        cutout: r.cutout,
        lower: r['emissive lower slabs 2/3'],
        upper: r['emissive upper slabs 2/3'],
        whole: r['emissive whole slabs 2/3'],
      }),
    );
    assert.ok(t.hits > t.pixels / 6, 'the view shows shaped voxels');
    assert.ok(t.same >= t.pixels - Math.ceil(t.pixels * 0.002), 'GPU first hits equal raycast on shaped cells');
    assert.ok(t.maxRelativeDepth < 1e-3, 'GPU and CPU hit distances agree');
    assert.ok(
      Math.abs(r.cutout.lit - r.cutout.expected) < 0.03 * r.cutout.expected,
      'sunlight through the cut stripes',
    );
    assert.ok(r.cutout.dark < 0.01, 'shadow under the solid stripes');
    near(r['emissive lower slabs 2/3'].mean, 2 / 3, 0.01, 'floor under a ceiling of emissive lower slabs');
    near(r['emissive upper slabs 2/3'].mean, 2 / 3, 0.01, 'floor under a ceiling of emissive upper slabs');
    // Light-sampled like whole cells: no more noise than under a whole-cell ceiling.
    for (const name of ['lower', 'upper'])
      assert.ok(
        r[`emissive ${name} slabs 2/3`].sd <= 1.1 * r['emissive whole slabs 2/3'].sd,
        `${name} slabs light-sampled: sd ${r[`emissive ${name} slabs 2/3`].sd} vs ${r['emissive whole slabs 2/3'].sd}`,
      );
  }
  if (wanted('transparent')) {
    const r = await run('transparent');
    console.log(' ', JSON.stringify(r));
    assert.deepEqual(r.errors, []);
    assert.equal(r.centre.alpha, 1);
    assert.deepEqual(r.centre.color, r.centre.opaque, 'covered pixels: the opaque render exactly');
    assert.equal(r.corner.alpha, 0);
    assert.deepEqual(r.corner.color, [0, 0, 0], 'escaping camera rays add nothing');
    assert.ok(r.corner.opaque[2] > 0.5, 'the opaque render shows the sky there');
    assert.ok(r.partial > 20, 'the outline is partly covered');
    assert.deepEqual([r.denoised.centre, r.denoised.corner], [1, 0]);
    assert.deepEqual(r.denoised.cornerColor, [0, 0, 0]);
  }
  if (wanted('determinism')) {
    const r = await run('determinism');
    console.log(
      `  ${r.identical}/${r.values} values identical with the same seed; ${r.differentWithOtherSeed} differ with another`,
    );
    assert.equal(r.identical, r.values);
    assert.ok(r.differentWithOtherSeed > r.values / 2);
  }
  if (wanted('convergence')) {
    const r = await run('convergence');
    for (const name of ['perspective', 'orthographic', 'glossy perspective']) {
      const e = r[name];
      console.log(
        `  ${name}: RMSE (tone-mapped) ${[16, 64, 256, 1024].map((n) => `${n}: ${e[n].rmse.toFixed(5)}`).join(', ')}`,
      );
      if (name.startsWith('glossy')) continue;
      for (const [a, b] of [
        [16, 64],
        [64, 256],
        [256, 1024],
      ]) {
        const ratio = e[b].rmse / e[a].rmse;
        assert.ok(ratio > 0.38 && ratio < 0.62, `${name} ${a}->${b} spp: RMSE ratio ${ratio} (1/sqrt(4) = 0.5)`);
      }
    }
  }
  // One case per scene (`denoise` names all four): as one case they took 196 s on an RTX A6000 (diffuse 14, opaque 15,
  // materials 82, caustics 85) and did not finish in the 728 s left of the test's 900 s on an Intel Arc 140V, with no
  // line between them. The Arc ran convergence 4.7 times slower than the A6000, about 915 s for all four.
  for (const [name, asked] of [
    ['diffuse', wanted('denoise-diffuse')],
    ['opaque', wanted('denoise-opaque')],
    ['materials', wanted('denoise-materials')],
    ['caustics', wanted('denoise-caustics')],
  ]) {
    if (!asked && !named.includes('denoise')) continue;
    const d = (await runAs(`denoise-${name}`, 'denoise', name))[name],
      // Error against the converged image: the reference's own noise removed in quadrature.
      clean = (e) => Math.sqrt(Math.max(e * e - d.refNoise * d.refNoise, 0));
    report.results.denoise = { ...report.results.denoise, [name]: d };
    for (const n of [4, 16, 64, 1024])
      console.log(
        `  ${name} ${n} spp: RMSE raw ${d[n].raw.toFixed(5)} denoised ${d[n].denoised.toFixed(5)} (x${(d[n].raw / d[n].denoised).toFixed(2)}, x${(clean(d[n].raw) / clean(d[n].denoised)).toFixed(2)} without the reference's noise ${d.refNoise.toFixed(5)}); edges raw ${d[n].rawEdges.toFixed(5)} denoised ${d[n].denoisedEdges.toFixed(5)} (${d.edgePixels} px)`,
      );
    // The glass scenes (caustics through glass, by mirrors and glossy metal): denoising at least halves the error
    // on the materials scene and nearly so on the caustics scene (README, "Denoiser").
    if (name === 'materials' || name === 'caustics')
      for (const n of [4, 16, 64])
        assert.ok(
          clean(d[n].denoised) * (name === 'materials' ? 2 : 1.6) <= clean(d[n].raw),
          `${name} ${n} spp: denoising reduces error enough`,
        );
    // Edges: from 16 samples on the denoised image is no worse than the raw one at object edges (where filtering
    // blurred detail the samples already resolve, it gives way to the raw mean), within 2% at 1024.
    for (const n of [16, 64]) assert.ok(d[n].denoisedEdges <= d[n].rawEdges, `${name} ${n} spp: edges are not blurred`);
    assert.ok(d[1024].denoisedEdges <= d[1024].rawEdges * 1.02, `${name} 1024 spp: edges are not blurred`);
    // More asserted on the diffuse scene.
    if (name !== 'diffuse') continue;
    for (const n of [4, 16]) assert.ok(d[n].denoised < d[n].raw * 0.6, `${name} ${n} spp: denoising reduces error`);
    assert.ok(d[64].denoised < d[64].raw * 0.75, `${name} 64 spp: denoising reduces error`);
    assert.ok(
      d[1024].denoised < d[1024].raw * 1.5 + 0.002,
      `${name}: denoising at high sample counts stays near the converged image`,
    );
    for (const n of [4, 16, 64, 1024])
      assert.ok(d[n].denoisedEdges < d[n].rawEdges * 1.25, `${name} ${n} spp: edges are not blurred`);
  }
  if (wanted('denoisepeak')) {
    const r = await run('denoisepeak');
    for (const n of [16, 64])
      console.log(
        `  lamp-lit wall (${r.pixels} px) ${n} spp: level ${r[n].level.toFixed(3)} of the reference; RMSE raw ${r[n].raw.toFixed(5)} denoised ${r[n].denoised.toFixed(5)}`,
      );
    // Before the wide levels' ratio stop the wall's peak lost 12% of its level at 16 samples and came out worse than the
    // raw frames at 64 (RMSE 0.0569 against 0.0514).
    assert.ok(r[16].level >= 0.9, 'lamp-lit wall, 16 spp: the peak keeps its level');
    assert.ok(r[16].denoised <= r[16].raw * 0.6, 'lamp-lit wall, 16 spp: denoising reduces error');
    assert.ok(r[64].denoised <= r[64].raw * 0.8, 'lamp-lit wall, 64 spp: denoising reduces error');
  }
  if (wanted('denoisehistory')) {
    const r = await run('denoisehistory');
    console.log(
      `  moving camera, 1 sample a frame for 30 frames: RMS ${r.moving.toFixed(2)} (raw frames ${r.raw.toFixed(2)}, still camera ${r.still.toFixed(2)})`,
    );
    assert.deepEqual(r.errors, []);
    assert.ok(r.moving <= r.raw / 2.5, 'moving camera: the denoised history stays well below one raw sample');
    assert.ok(r.moving <= r.still * 2.5, 'moving camera: within reach of the still camera (no ghosting)');
  }
  if (wanted('motion')) {
    const r = await run('motion');
    console.log('  ', JSON.stringify(r));
    assert.deepEqual(r.errors, []);
    assert.equal(r.cases.length, 3);
    for (const result of r.cases) {
      assert.equal(result.nonfinite, 0, result.name + ': finite raw image');
      assert.ok(result.rms < 0.02, result.name + ': raw coverage agrees with independent time-integrated slabs');
      assert.ok(result.maximum < 0.12, result.name + ': bounded 1024-sample per-pixel coverage error');
      near(result.energyRatio, 1, 0.05, result.name + ': integrated silhouette energy');
      if (result.name !== 'quarter-turn') {
        assert.ok(result.arcPixels > 50, result.name + ': independent oracle tests pixels outside endpoint bounds');
        near(result.arcRatio, 1, 0.1, result.name + ': swept arc remains visible outside endpoint bounds');
      }
    }
  }
  if (wanted('lens')) {
    const r = await run('lens');
    console.log('  ', JSON.stringify({ sharp: r.sharp, focused: r.focused, still: r.still, blurred: r.blurred }));
    assert.ok(r.sharp.near <= 4 && r.sharp.far <= 4, 'pinhole: both bars sharp');
    assert.ok(r.focused.far <= 4, 'aperture: the bar at the focus distance stays sharp');
    assert.ok(r.focused.near >= 6, 'aperture: the near bar blurs');
    assert.ok(r.blurred.lit > 3 * r.still.lit, 'motion blur spreads the cube along its path');
    assert.equal(r.blurred.full, 0, 'no pixel sees the moving cube all the time');
    assert.ok(r.still.full >= r.still.lit - 4, 'without a shutter the cube is solid');
    const c = r.camera,
      width = Math.sqrt(5 / 12);
    console.log(
      `  camera motion (2 units, shutter 1): line centroid moved ${c.shift.toFixed(4)} (1), profile width ${c.width.toFixed(4)} (${width.toFixed(4)}; sharp ${c.sharpWidth.toFixed(4)})`,
    );
    near(c.shift, 1, 0.01, 'camera motion: centroid shift');
    near(c.width, width, width * 0.01, 'camera motion: blur width');
  }
  if (wanted('viewport')) {
    const r = await run('viewport');
    console.log(
      '  ',
      JSON.stringify({ ...r, statsBefore: undefined, statsAfter: undefined }),
      JSON.stringify(r.statsAfter),
    );
    assert.deepEqual(r.messages, []);
    assert.equal(r.disabled.differing, 0, 'disabled: the raster frame bit for bit');
    assert.ok(r.traced.differing > 1000, 'enabled: the traced image replaces it');
    assert.ok(r.newDevice);
    assert.equal(r.restored.differing, 0, 'device restore: the same converged image');
    assert.equal(r.afterDispose.differing, 0, 'disposed: the raster frame again');
    assert.equal(r.resized.width, 400);
    assert.equal(r.resized.samples, 4, 'resize restarts accumulation');
  }
  if (wanted('bloom')) {
    const r = await run('bloom');
    console.log(`  with Bloom: ${r.difference.differing} pixels differ (max ${r.difference.max})`);
    assert.deepEqual(r.messages, []);
    assert.ok(r.difference.differing > 1000, 'Bloom post-processes the traced HDR image');
  }
  if (wanted('capture')) {
    const r = await run('capture');
    console.log(
      `  1500x1100 64 spp denoised PNG ${r.bytes} bytes in ${r.ms.toFixed(0)} ms; cancelled 2048^2 x 4096 after ${r.cancelledAfterMs.toFixed(0)} ms (${r.reason}); whenIdle drained in ${r.drainMs.toFixed(1)} ms`,
    );
    assert.deepEqual(r.size, [1500, 1100]);
    assert.equal(r.reason, 'AbortError');
    assert.ok(r.cancelledAfterMs < 5000, 'cancellation is prompt');
    assert.equal(r.renders, 0, 'no render left after whenIdle');
    assert.equal(r.gpuBytesAtRejection, r.gpuBytesAfter, 'the aborted capture released its buffers before rejecting');
    assert.deepEqual(r.errors, []);
    await mkdir('test-results/voxel-pathtracer', { recursive: true });
    await writeFile('test-results/voxel-pathtracer/capture-1500x1100.png', Buffer.from(r.png, 'base64'));
  }
  if (wanted('materialtables')) {
    const r = await run('materialtables');
    console.log(
      `  own tables vs one table: ${r.identical.differ} of ${r.identical.values} values differ (max ${r.identical.max}); ${r.wall.models} models with their own colour: ${r.wall.seen} seen, worst albedo error ${r.wall.worst.toExponential(2)}, palettes ${r.wall.palettes}`,
    );
    assert.equal(r.identical.differ, 0, 'model tables render as one shared table does');
    assert.ok(r.wall.seen >= 290, 'the wall of 300 models is in view');
    assert.ok(r.wall.worst < 1e-5, "every model shows its own table's colour");
    assert.deepEqual(r.wall.palettes, [1], 'picks report palette indices');
    assert.deepEqual(r.errors, []);
  }
  if (wanted('largemodels')) {
    const r = await run('largemodels');
    console.log(
      `  400-cell glass bar against a 200-cell one stretched 2x: RMS ${r.glass.one.band.toFixed(5)} at the middle (${r.glass.one.all.toFixed(5)} overall); two 200-cell tiles ${r.glass.tiles.band.toFixed(5)} (${r.glass.tiles.all.toFixed(5)})`,
    );
    console.log(
      `  2048 x 64 x 2048 sparse world (lamp past cell 255) against a 64^3 model at the same place: relative RMS ${r.world.relativeRms.toExponential(2)}, max ${r.world.max.toExponential(2)} (mean ${r.world.mean.toFixed(4)}); attach ${r.world.packMs.toFixed(0)} ms`,
    );
    assert.ok(r.glass.one.band < r.glass.tiles.band / 2, 'one model has no interface where tiles meet');
    assert.ok(r.world.relativeRms < 1e-3, 'emitters past cell 255 light as in a small model');
    assert.deepEqual(r.errors, []);
  }
  if (wanted('native4k')) {
    // Bug 25: the 4K viewport traced all 8.3 million pixels in one dispatch (200 ms here, past a GPU watchdog on a
    // slower GPU). Every trace and preview dispatch now covers at most 2^20 pixels (src/dispatch.ts).
    await page.evaluate(() => {
      const log = (window.__traceDispatches = { count: 0, max: 0 }),
        proto = GPUComputePassEncoder.prototype,
        { setPipeline, dispatchWorkgroups } = proto,
        current = new WeakMap();
      log.restore = () => Object.assign(proto, { setPipeline, dispatchWorkgroups });
      proto.setPipeline = function (pipeline) {
        current.set(this, pipeline.label);
        return setPipeline.call(this, pipeline);
      };
      proto.dispatchWorkgroups = function (x, y = 1, z = 1) {
        if (/^voxel-pathtracer (trace|preview)$/.test(current.get(this) ?? '')) {
          log.count++;
          log.max = Math.max(log.max, x * y * z * 64);
        }
        return dispatchWorkgroups.call(this, x, y, z);
      };
    });
    const r = await run('native4k');
    const dispatches = await page.evaluate(() => {
      const { count, max, restore } = window.__traceDispatches;
      restore();
      return { count, max };
    });
    console.log(`  trace dispatches: ${dispatches.count}, the largest ${dispatches.max} pixels`);
    assert.ok(dispatches.count > 40, 'the 4K frames were traced');
    assert.ok(dispatches.max <= 1 << 20, `a trace dispatch of ${dispatches.max} pixels (budget 2^20)`);
    for (const [name, v] of Object.entries(r.results))
      console.log(
        `  ${name} 3840x2160: traced ${v.traced.join('x')} (requested ${v.requested.join('x')}${v.limitedBy ? `, limited by ${v.limitedBy}` : ''}), GPU ${v.gpuMs.toFixed(2)} ms/frame, ${(v.gpuBytes / 2 ** 20).toFixed(1)} MiB; binding limit ${v.limits.binding}, texture ${v.limits.texture}`,
      );
    for (const [name, v] of Object.entries(r.results)) {
      assert.deepEqual(v.canvas, [3840, 2160], `${name}: the canvas is 4K`);
      assert.deepEqual(v.traced, [3840, 2160], `${name}: traced at the native size`);
      assert.equal(v.limitedBy, null);
    }
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.messages, []);
  }
  if (wanted('pictures')) {
    await mkdir('test-results/voxel-pathtracer', { recursive: true });
    for (const [name, camera, options, samples, label] of [
      [
        'materials',
        [
          [18, 14, 26],
          [-3, 3, -2],
        ],
        {},
        1024,
        'materials',
      ],
      [
        'materials',
        [
          [18, 14, 26],
          [-3, 3, -2],
        ],
        { aperture: 0.8, focusDistance: 27, lensBlades: 6 },
        1024,
        'materials-dof',
      ],
      [
        'opaque',
        [
          [18, 14, 26],
          [-3, 3, -2],
        ],
        {},
        16,
        'opaque-16',
      ],
      [
        'opaque',
        [
          [18, 14, 26],
          [-3, 3, -2],
        ],
        {},
        4096,
        'opaque-4096',
      ],
      [
        'opaque',
        [
          [18, 14, 26],
          [-3, 3, -2],
        ],
        { denoise: true },
        16,
        'opaque-16-denoised',
      ],
    ]) {
      const r = await run('picture', name, 960, 600, samples, camera, options),
        file = `test-results/voxel-pathtracer/${label}.png`;
      await writeFile(file, Buffer.from(r.png, 'base64'));
      console.log(`  ${file}: 960x600 ${samples} spp in ${r.ms.toFixed(0)} ms`);
    }
  }
  if (wanted('timing')) {
    const r = await run('timing');
    for (const [name, t] of Object.entries(r.results))
      console.log(
        `  ${name} ${t.size.join('x')}: GPU ${t.gpuMs.toFixed(2)} ms/frame (min ${t.gpuMinMs.toFixed(2)}), CPU encode ${t.cpuEncodeMs.toFixed(2)} ms, attach ${t.attachMs.toFixed(1)} ms, setScene (same revision) ${t.setSceneSameRevisionMs.toFixed(1)} ms, GPU memory ${(t.gpuBytes / 2 ** 20).toFixed(1)} MiB`,
      );
    console.log(
      `  dense 256^3 model: ${r.dense.occupied} voxels; attach + pack ${r.dense.attachAndPackMs.toFixed(0)} ms; repack (new revision) ${r.dense.repackMs.toFixed(0)} ms`,
    );
  }
  // A case name no check above knows (a typo in a package script) would otherwise run nothing and pass.
  assert.deepEqual(
    named.filter((n) => !asked.has(n)),
    [],
    'unknown case name(s); use the names in the wanted() checks of this file',
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    `case times, slowest first (s, longest GPU wait): ${Object.entries(timings)
      .sort((a, b) => b[1].seconds - a[1].seconds)
      .map(([name, t]) => `${name} ${t.seconds.toFixed(1)} (${t.longestGpuWait})`)
      .join(', ')}`,
  );
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/voxel-pathtracer-browser-check${reportName ? `-${reportName}` : ''}.json`,
    JSON.stringify(report, null, 1),
  );
  console.log('voxel path tracer browser check passed');
} finally {
  await context.close();
}
