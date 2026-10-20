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
// - projections: markers land where the panorama, equidistant/equisolid fisheye and Brown-Conrady formulas put them;
//   per-pixel first hits of each agree with raycast along rays computed in the page;
// - arealight: a panel's shadow area under a point sun, its front, back and see-through back radiance, and a dark
//   panel occluding a lit ceiling against view factors;
// - dispersion: a line's shift through a tilted slab per wavelength against Snell with Cauchy's index; colour order over
//   the spectrum; a dispersive white furnace per channel;
// - environment: the equirectangular map's orientation; determinism: equal seeds give identical images;
// - transparent: alpha is the camera rays' coverage, covered pixels match the opaque render, escapes add nothing;
// - convergence: error against a 4096-sample reference falls about as 1/sqrt(samples), both projections;
// - denoise: error with and without the wavelet denoiser, overall and at object edges, also on two caustic scenes;
// - lens: depth of field blurs out-of-focus edges only; motion blur spreads a moving cube along its path; camera motion
//   blur widens a line's profile to the box-convolution width;
// - viewport: disabled is bit-identical to raster, dispose restores raster, a device restore redraws the same image;
// - capture: PNG dimensions, cancellation; `--timing` adds GPU time per frame at 1920x1080 and upload costs.
// Results go to test-results/voxel-pathtracer-browser-check.json; `pictures` writes PNGs to test-results/voxel-pathtracer.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel-pathtracer/tests/browser-check.html',
  port = 5223,
  args = process.argv.slice(2),
  named = args.filter((a) => !a.startsWith('--')),
  wanted = (name) => (named.length ? named.includes(name) : name !== 'pictures' && name !== 'timing'),
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, date: new Date().toISOString(), results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
page.setDefaultTimeout(900000);
const run = async (name, ...params) => {
  const t0 = performance.now(),
    result = await page.evaluate(([n, p]) => window.check[n](...p), [name, params]);
  report.results[name] = { ...result, png: undefined };
  console.log(`${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  assert.deepEqual(result.errors ?? [], [], `${name}: WebGPU errors`);
  return result;
};
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.userAgent);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
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
      'contact transmission halves what the blend rests on',
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
      c['sunlit slab transparentShadows false'].mean,
      c['sunlit slab transparentShadows true'].mean,
      0.03 * c['sunlit slab transparentShadows true'].mean,
      'sunlit slab lit through its own cells',
    );
    // Fade scale = the ground's distance: the sky takes 1 - 1/e of the grey ground; from that distance on, none.
    near(c['ground fade'].mean, 1 - 0.5 / Math.E, 0.01, 'ground fade');
    near(c['ground fade start'].mean, 0.5, 0.01, 'ground fade start');
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
  if (wanted('denoise')) {
    const r = await run('denoise');
    for (const name of ['diffuse', 'opaque', 'materials', 'caustics']) {
      const d = r[name],
        // Error against the converged image: the reference's own noise removed in quadrature.
        clean = (e) => Math.sqrt(Math.max(e * e - d.refNoise * d.refNoise, 0));
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
      // Edges asserted on the diffuse scene.
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
      `  1500x1100 64 spp denoised PNG ${r.bytes} bytes in ${r.ms.toFixed(0)} ms; cancelled 2048^2 x 4096 after ${r.cancelledAfterMs.toFixed(0)} ms (${r.reason})`,
    );
    assert.deepEqual(r.size, [1500, 1100]);
    assert.equal(r.reason, 'AbortError');
    assert.ok(r.cancelledAfterMs < 5000, 'cancellation is prompt');
    await mkdir('test-results/voxel-pathtracer', { recursive: true });
    await writeFile('test-results/voxel-pathtracer/capture-1500x1100.png', Buffer.from(r.png, 'base64'));
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
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-pathtracer-browser-check.json', JSON.stringify(report, null, 1));
  console.log('voxel path tracer browser check passed');
} finally {
  await context.close();
}
