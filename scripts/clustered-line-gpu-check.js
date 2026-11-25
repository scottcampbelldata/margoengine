// Real-GPU check of lineLights (@margoengine/clustered/line): the Gauss-Legendre points of a flame line cast one soft
// shadow, not separate hard copies of it. Fixture tests/clustered-shadow-browser.ts (LocalShadows, production
// clusterLighting probed at world points). A 0.62 m line (the Cabin Hearth flames) 3 high, crossing the edge of a bar
// 1.5 high over the floor: blocker ratio (receiver - blocker) / blocker 1, so each point's copy of the bar's edge falls
// at x = 1 - x_i on the floor, 0.358 m apart. The PCSS taps turn per pixel (fine noise whose local mean is the disc
// light's penumbra), so the shadow factor (lit side 1) is averaged over 41 floor rows along the bar, each point at its
// own pixel; the step is the largest change of that mean between points 0.02 m apart across both copies. Two hard points
// read about 0.5 (the A6000's Cabin Hearth floor read 0.42 of the lit side), the default radius must stay at or below
// 0.07, and the mean must follow the analytic shadow of two disc lights.
// node scripts/run-with-timeout.mjs -- node scripts/clustered-line-gpu-check.js (MARGO_COMPAT=1: WebGL2 layer)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { compatRun } from './support/compat-shim.js';
import { lineLights } from '../packages/clustered/dist/line.js';

const folder = 'test-results/clustered-line',
  STEP = 0.07,
  SPACING = 0.02,
  H = 3,
  flame = 0.62;
let browser;
try {
  await mkdir(folder, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/clustered-shadow.html', port: 5319 });
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
  // Floor points across both copies of the bar's x = 0.5 edge, on 41 rows from z -1 to 1 (the bar runs along z).
  const xs = [];
  for (let x = 0.3; x <= 1.7 + 1e-9; x += 0.01) xs.push(+x.toFixed(4));
  const rows = Array.from({ length: 41 }, (_, i) => -1 + i * 0.05),
    points = rows.flatMap((z) => xs.map((x) => [x, 0, z, 0, 1, 0]));
  /** The shadow factor at each x, averaged over the rows. */
  const mean = (values) => xs.map((_, i) => rows.reduce((s, _, r) => s + values[r * xs.length + i], 0) / rows.length);
  /** Shadow factor per point: luminance with the shadows over luminance of the same lights unshadowed. */
  async function visibility(lights) {
    const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
      open = lights.map(({ castShadow, shadow, ...light }) => light);
    await call('scene', { meshes: ['floor', 'bar'], local: { resolution: 1024 }, points: open });
    await call('render', 1);
    const free = await call('probe', points);
    await call('scene', { meshes: ['floor', 'bar'], local: { resolution: 1024 }, points: lights });
    const rendered = await call('render', 1);
    await call('render', 1);
    const shadowed = await call('probe', points);
    return { rendered, values: points.map((_, i) => lum(shadowed[i]) / lum(free[i])) };
  }
  /** Largest |v(x + SPACING) - v(x)| along a profile over `xs`. */
  function largestStep(row) {
    const k = Math.round(SPACING / 0.01);
    let worst = 0,
      at;
    for (let i = 0; i + k < row.length; i++) {
      const step = Math.abs(row[i + k] - row[i]);
      if (step > worst) [worst, at] = [step, xs[i]];
    }
    return { step: worst, at };
  }
  // Two disc lights of radius R at the nodes, half the light each: the lit share of a disc past offset t (in radii) of
  // its edge is 1 - (acos(t) - t sqrt(1 - t^2)) / pi.
  const disc = (t) => (t <= -1 ? 0 : t >= 1 ? 1 : 1 - (Math.acos(t) - t * Math.sqrt(1 - t * t)) / Math.PI);
  const line = (radius) =>
    lineLights({
      start: [-flame / 2, H, 0],
      end: [flame / 2, H, 0],
      range: 20,
      intensity: 10,
      ...(radius === undefined ? {} : { radius }),
      shadow: { far: 20 },
    });
  const results = {};
  for (const [label, radius] of [
    ['default radius', undefined],
    ['hard points', 0],
  ]) {
    const lights = line(radius),
      R = lights[0].shadow.radius,
      { rendered, values } = await visibility(lights),
      profile = mean(values),
      measured = largestStep(profile),
      // Blocker depth H - 1.5, receiver H: ratio 1, so copy i's edge is at 1 - x_i and its penumbra R wide each side.
      analytic = xs.map((x) =>
        lights.reduce((v, l) => v + 0.5 * disc(R ? (x - (1 - l.position[0])) / R : x > 1 - l.position[0] ? 1 : -1), 0),
      ),
      expected = largestStep(analytic);
    // The per-pixel noise around the mean, for the record.
    let spread = 0;
    values.forEach((v, i) => (spread = Math.max(spread, Math.abs(v - profile[i % xs.length]))));
    results[label] = { radius: R, measured, analytic: expected, noise: spread };
    check(`${label}: each point renders its six cube faces`, rendered.stats.layers === 12, rendered.stats);
    check(`${label}: under the bar dark, past both copies lit`, profile[0] < 0.05 && profile[xs.length - 1] > 0.95, {
      first: profile[0],
      last: profile[xs.length - 1],
    });
    if (radius === undefined) {
      check(
        `${label}: largest shadow step ${measured.step.toFixed(3)} <= ${STEP}`,
        measured.step <= STEP,
        results[label],
      );
      let worst = 0;
      profile.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - analytic[i]))));
      check(`${label}: mean within 0.05 of two disc lights' analytic shadow everywhere`, worst <= 0.05, { worst });
    } else
      check(
        `${label}: the step the merged shadow removes (${measured.step.toFixed(3)} > 0.3)`,
        measured.step > 0.3,
        results[label],
      );
  }
  const compiled = await call('compile');
  check('WGSL compiles without errors or warnings', !compiled.core.length && !compiled.probe.length, compiled);
  check('no page errors', pageErrors.length === 0, { pageErrors });
  const fixtureErrors = await page.evaluate(() => window.clusteredShadowFixture.errors);
  check('no GPU validation or engine errors', fixtureErrors.length === 0, { fixtureErrors });
  const report = `${folder}/gpu${compatRun() ? '-compat' : ''}.json`;
  await writeFile(report, JSON.stringify({ hardware: browser.hardware, results, checks, failures }, null, 2) + '\n');
  console.log(JSON.stringify({ hardware: browser.hardware.webgpu, results, failures, report }, null, 2));
  assert.deepEqual(failures, [], 'Clustered line light GPU checks failed');
} finally {
  await browser?.page.evaluate(() => window.clusteredShadowFixture?.dispose()).catch(() => {});
  await browser?.close();
}
