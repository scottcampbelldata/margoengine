// Real-GPU check for clustered directional and area-light shadows (fixture tests/clustered-shadow-browser.ts).
// node scripts/gpu-lock.mjs run --owner=clustered-shadow -- node scripts/clustered-shadow-gpu-check.js [--baseline]
// --baseline records the shadow-off scenes (images, lit shader text, probe radiance) with the build in dist; a normal
// run requires them to be identical, then checks shadowed scenes against analytic occlusion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';

const folder = 'test-results/clustered-shadow',
  baseline = process.argv.includes('--baseline'),
  release = await acquire({ owner: 'clustered-shadow-gpu-check' });
const hash = (text) => createHash('sha256').update(text).digest('hex');
let browser;
try {
  await mkdir(folder, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/clustered-shadow.html', port: 5308 });
  const page = browser.page,
    pageErrors = [],
    checks = [],
    failures = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.clusteredShadowFixture);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const call = (name, ...args) =>
    page.evaluate(({ name, args }) => window.clusteredShadowFixture[name](...args), { name, args });
  function check(name, ok, detail) {
    checks.push({ name, ok, ...detail });
    if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
  }
  async function capture(label) {
    const file = `${folder}/${baseline ? 'baseline-' : ''}${label}.png`;
    await page.locator('canvas').screenshot({ path: file });
    return file;
  }
  // Floor and block-top points for the shadow-off scenes.
  const offPoints = [];
  for (let x = -3; x <= 3; x += 0.5) for (let z = -3; z <= 3; z += 1) offPoints.push([x, 0, z, 0, 1, 0]);
  for (let x = -0.4; x <= 0.4; x += 0.2) offPoints.push([x, 1.5, 0, 0, 1, 0]);
  const meshes = ['floor', 'block'],
    point = { position: [2, 3, 1], range: 12, intensity: 3 },
    sun = { direction: [0.3, -1, 0.2], intensity: 0.5 },
    area = { position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 0.6 };
  const offScenes = {
    'off-local': { meshes, points: [{ ...point, castShadow: true }], suns: [sun], areas: [area] },
    'off-none': { meshes, local: false, points: [point], suns: [sun], areas: [area] },
    'off-two-sided': {
      meshes,
      points: [{ ...point, castShadow: true }],
      suns: [sun, { direction: [0, -1, 0] }],
      areas: [area, { ...area, position: [0, 2, 2], direction: [0, 0, -1], twoSided: true }],
    },
  };
  const record = {};
  for (const [label, config] of Object.entries(offScenes)) {
    await call('scene', config);
    const { shader } = await call('render', 2);
    record[label] = {
      shader: hash(shader),
      probe: await call('probe', offPoints),
      image: await capture(label),
    };
  }
  if (baseline) {
    await writeFile(`${folder}/baseline.json`, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({ baseline: `${folder}/baseline.json`, scenes: Object.keys(record) }, null, 2));
  } else {
    const before = JSON.parse(await readFile(`${folder}/baseline.json`, 'utf8'));
    for (const [label, now] of Object.entries(record)) {
      const old = before[label];
      check(`${label}: lit shader text unchanged with the new shadows off`, now.shader === old.shader, {
        before: old.shader,
        after: now.shader,
      });
      let max = 0;
      now.probe.forEach((rgb, i) => rgb.forEach((v, c) => (max = Math.max(max, Math.abs(v - old.probe[i][c])))));
      check(`${label}: clusterLighting radiance at ${offPoints.length} points unchanged`, max === 0, {
        maxDifference: max,
      });
      const a = await decodePNG(await readFile(old.image)),
        b = await decodePNG(await readFile(now.image));
      let changed = 0;
      for (let i = 0; i < a.data.length; i++) changed += +(a.data[i] !== b.data[i]);
      check(
        `${label}: rendered image identical to the pre-change build`,
        changed === 0 && a.data.length === b.data.length,
        {
          changedBytes: changed,
        },
      );
    }
    // Shadow factor = radiance with the shadow / radiance of the same light with castShadow false.
    async function visibility(config, points) {
      const off = structuredClone(config);
      for (const light of [...(off.suns ?? []), ...(off.areas ?? [])]) light.castShadow = false;
      await call('scene', off);
      await call('render', 1);
      const open = await call('probe', points);
      await call('scene', config);
      // The first frame's stats count the layers drawn; the second is the cached one probed.
      const rendered = await call('render', 1);
      await call('render', 1);
      const shadowed = await call('probe', points);
      return {
        rendered,
        values: points.map((_, i) => {
          const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
            unshadowed = lum(open[i]);
          return unshadowed > 1e-6 ? lum(shadowed[i]) / unshadowed : NaN;
        }),
      };
    }
    // `expected` gives 0 (occluded), 1 (lit) or undefined (not checked) per point; both kinds must occur unless lit only.
    function expect(name, points, values, expected, litOnly = false) {
      let worst = 0,
        at,
        occluded = 0,
        lit = 0;
      points.forEach((p, i) => {
        const want = expected(p);
        if (want === undefined) return;
        if (want === 0) occluded++;
        else lit++;
        const error = Math.abs(values[i] - want);
        if (!(error <= worst)) {
          worst = error;
          at = { point: p.slice(0, 3), visibility: values[i], expected: want };
        }
      });
      check(name, worst <= 0.05 && lit > 0 && (litOnly || occluded > 0), {
        occluded,
        lit,
        worstError: worst,
        at,
        tolerance: 0.05,
      });
    }
    // Directional: a 1 x 0.5 x 1 block (y 1 to 1.5) above the floor (y 0).
    const line = (z, y = 0, normal = [0, 1, 0], from = -2, to = 2, step = 0.05) => {
      const out = [];
      for (let x = from; x <= to + 1e-9; x += step) out.push([+x.toFixed(4), y, z, ...normal]);
      return out;
    };
    const floor = [...line(0), ...line(0.25), ...line(-0.8)];
    const inside = (lo, hi, margin) => (v) => v > lo + margin && v < hi - margin,
      outside = (lo, hi, margin) => (v) => v < lo - margin || v > hi + margin;
    const shadowExpectation = (x0, x1, margin) => (p) =>
      inside(x0, x1, margin)(p[0]) && inside(-0.5, 0.5, margin)(p[2])
        ? 0
        : outside(x0, x1, margin)(p[0]) || outside(-0.5, 0.5, margin)(p[2])
          ? 1
          : undefined;
    const bounds = { min: [-3, -0.2, -3], max: [3, 2, 3] };
    for (const [label, direction, x0, x1, shadow, margin] of [
      ['directional bounds, straight down', [0, -1, 0], -0.5, 0.5, { bounds }, 0.06],
      ['directional bounds, slanted', [1, -2, 0], 0, 1.25, { bounds }, 0.06],
      ['directional camera-fitted cascades, slanted', [1, -2, 0], 0, 1.25, { cascades: 3, distance: 30 }, 0.3],
    ]) {
      const config = { meshes, suns: [{ direction, intensity: 3, castShadow: true, shadow }] },
        { values, rendered } = await visibility(config, floor);
      expect(`${label}: occluded floor points 0, lit points 1`, floor, values, shadowExpectation(x0, x1, margin));
      const top = line(0, 1.5, [0, 1, 0], -0.4, 0.4, 0.1),
        topValues = (await visibility(config, top)).values;
      expect(`${label}: the lit block top casts no acne on itself`, top, topValues, () => 1, true);
      await capture(label.replace(/[^a-z]+/g, '-'));
      const again = await call('render', 1);
      check(`${label}: a static frame re-renders no shadow layer`, again.stats.layers === 0, {
        layersFirstFrame: rendered.stats.layers,
        layersAgain: again.stats.layers,
      });
      if (!shadow.bounds) {
        await call('camera', [1, 8, 8]);
        const moved = await call('render', 1);
        check(`${label}: a camera move re-fits and re-renders the cascades`, moved.stats.layers === 3, {
          layers: moved.stats.layers,
        });
        await call('camera', [0, 8, 8]);
      }
      const compiled = await call('compile');
      check(
        `${label}: WGSL compiles without errors or warnings`,
        !compiled.core.length && !compiled.probe.length,
        compiled,
      );
    }
    // Area: a W-wide light at y 3 facing down, a bar 1 wide (x -0.5 to 0.5) at y 1.5, the floor at y 0. Each floor
    // point x sees the light through |x + xL| >= 2B (B = 0.5): umbra |x| < 2B - W/2, fully lit |x| > 2B + W/2, and a
    // penumbra of width W (W (d_receiver - d_blocker) / d_blocker with d 3 and 1.5) between.
    const ramp = line(0, 0, [0, 1, 0], 0, 2.4, 0.02),
      widths = {};
    for (const W of [0.4, 1.2]) {
      const config = {
          meshes: ['floor', 'bar'],
          areas: [
            {
              position: [0, 3, 0],
              direction: [0, -1, 0],
              width: W,
              height: 0.4,
              intensity: 5,
              castShadow: true,
              shadow: { far: 20 },
            },
          ],
        },
        { values, rendered } = await visibility(config, ramp),
        umbra = 1 - W / 2,
        lit = 1 + W / 2;
      expect(`area ${W} wide: umbra floor points 0, fully lit points 1`, ramp, values, (p) =>
        p[0] < umbra - 0.1 ? 0 : p[0] > lit + 0.1 ? 1 : undefined,
      );
      const cross = (level) => ramp.find((p, i) => values[i] >= level)?.[0];
      widths[W] = { from10: cross(0.1), to90: cross(0.9), analytic: [umbra, lit] };
      widths[W].measured = widths[W].to90 - widths[W].from10;
      await capture(`area-${W}`);
      const again = await call('render', 1);
      check(`area ${W} wide: a static frame re-renders no shadow layer`, again.stats.layers === 0, {
        layersFirstFrame: rendered.stats.layers,
        layersAgain: again.stats.layers,
      });
      check(`area ${W} wide: one-sided lights render five cube faces`, rendered.stats.layers === 5, rendered.stats);
      const compiled = await call('compile');
      check(
        `area ${W} wide: WGSL compiles without errors or warnings`,
        !compiled.core.length && !compiled.probe.length,
        compiled,
      );
    }
    // The 10-90% rise of a disk-filtered edge spans 1.37 R = 0.69 W, of the exact (uniform) light 0.8 W.
    check(
      'area penumbra widens with the light: 1.2 wide vs 0.4 wide',
      widths[1.2].measured > 2 * widths[0.4].measured,
      {
        widths,
      },
    );
    for (const W of [0.4, 1.2]) {
      const ratio = widths[W].measured / (0.8 * W);
      check(`area ${W} wide: 10-90% penumbra within 0.5-1.5x of the analytic 0.8 W`, ratio > 0.5 && ratio < 1.5, {
        measured: widths[W].measured,
        analytic: 0.8 * W,
        ratio,
      });
    }
    // twoSided: the back face shadows the ceiling (y 6) through a bar at y 4.5, as the front face shadows the floor.
    const twoSided = {
        meshes: ['floor', 'bar', 'ceiling', 'topBar'],
        areas: [
          {
            position: [0, 3, 0],
            direction: [0, -1, 0],
            width: 0.4,
            height: 0.4,
            intensity: 5,
            twoSided: true,
            castShadow: true,
            shadow: { far: 20 },
          },
        ],
      },
      both = [...line(0, 0, [0, 1, 0], 0, 2.4, 0.1), ...line(0, 6, [0, -1, 0], 0, 2.4, 0.1)],
      { values: bothValues, rendered: bothRendered } = await visibility(twoSided, both);
    expect('two-sided area light: umbra 0 and lit 1 on the floor and on the ceiling', both, bothValues, (p) =>
      p[0] < 0.7 ? 0 : p[0] > 1.3 ? 1 : undefined,
    );
    check('two-sided area light renders six cube faces', bothRendered.stats.layers === 6, bothRendered.stats);
    await capture('area-two-sided');
    // Everything at once: two shadowed directional lights, two shadowed area lights and a shadowed point light.
    await call('scene', {
      meshes: ['floor', 'block'],
      points: [{ ...point, castShadow: true }],
      suns: [
        { direction: [1, -2, 0], intensity: 2, castShadow: true, shadow: { bounds } },
        {
          direction: [-0.5, -2, 0.3],
          intensity: 1,
          castShadow: true,
          shadow: { cascades: 2, distance: 20, resolution: 256 },
        },
      ],
      areas: [
        { ...area, castShadow: true, shadow: { far: 20 } },
        {
          ...area,
          position: [0, 2, 2],
          direction: [0, 0, -1],
          twoSided: true,
          castShadow: true,
          shadow: { far: 20, resolution: [256, 128] },
        },
      ],
    });
    const all = await call('render', 1),
      compiled = await call('compile');
    await call('render', 1);
    // 6 point faces + 1 bounds map + 2 cascades + 5 + 6 area faces.
    check(
      'all shadow kinds together compile and render without validation errors',
      !compiled.core.length && !compiled.probe.length && all.stats.layers === 20,
      { ...compiled, stats: all.stats },
    );
    await capture('all-kinds');
  }
  check('no page errors', pageErrors.length === 0, { pageErrors });
  const fixtureErrors = await page.evaluate(() => window.clusteredShadowFixture.errors);
  check('no GPU validation or engine errors', fixtureErrors.length === 0, { fixtureErrors });
  if (!baseline) {
    await writeFile(
      `${folder}/gpu.json`,
      JSON.stringify({ hardware: browser.hardware, checks, failures }, null, 2) + '\n',
    );
    console.log(
      JSON.stringify(
        {
          hardware: browser.hardware.webgpu,
          checks: checks.length,
          passed: checks.filter((c) => c.ok).length,
          failures,
          report: `${folder}/gpu.json`,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(failures, [], 'Clustered shadow GPU checks failed');
  } else assert.deepEqual(failures, [], 'Baseline run failed');
} finally {
  await browser?.page.evaluate(() => window.clusteredShadowFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
