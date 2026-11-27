// KB-SKY-HAZEBELOW1 on a real GPU (run from the repository root after building packages; MARGO_COMPAT=1 for the WebGL2
// layer):
//   node scripts/run-with-timeout.mjs -- node packages/sky/test/fog-below-check.mjs
// A wide ground 1 km under the eye, hidden fully by thick haze in the sky's colour. Without fog.lightDecay every ground
// pixel down a column took the horizon's radiance, so a fully hazed far ground drew as one flat colour (the ridge-smoke
// shot's far ground past the world edge, 2026-11-27). With it each pixel takes that colour times the CPU mirror
// fogBelowLight of its own ray, here 1 / (1 + k sin(down)) since the haze is fully opaque, so the ground darkens with
// the angle it is seen at. The sky above the horizon is unchanged.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { fogBelowLight } from '../dist/index.js';
const port = 5236,
  context = await openBrowser({ startPath: '/packages/sky/test/fog-below-check.html', port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const sub = (a, b) => a.map((v, i) => v - b[i]),
  norm = (a) => a.map((v) => v / Math.hypot(...a)),
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.goto(`http://127.0.0.1:${port}/packages/sky/test/fog-below-check.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const decay = [0.3, 0.45, 0.7],
    r = await page.evaluate((d) => window.check.run(d), decay);
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  const { width, height, flat, lit, camera } = r,
    forward = norm(sub(camera.target, camera.eye)),
    right = norm(cross(forward, [0, 1, 0])),
    up = cross(right, forward),
    t = Math.tan((camera.fov * Math.PI) / 360);
  let ground = 0,
    sky = 0,
    worst = 0,
    columnSpread = 0;
  const lowest = new Float64Array(width).fill(Infinity),
    highest = new Float64Array(width).fill(-Infinity);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const nx = ((x + 0.5) / width) * 2 - 1,
        ny = 1 - ((y + 0.5) / height) * 2,
        ray = norm([0, 1, 2].map((i) => forward[i] + right[i] * nx * t * camera.aspect + up[i] * ny * t)),
        p = (y * width + x) * 4;
      if (ray[1] >= 0) {
        // Above the horizon: the sky, unchanged by the decay.
        for (let c = 0; c < 3; c++) assert.equal(lit[p + c], flat[p + c], `sky pixel ${x},${y} changed`);
        sky++;
        continue;
      }
      // Where the ray meets the ground (y = 0); skip pixels within 2 rows of its far edge, where MSAA mixes in the sky.
      const s = camera.eye[1] / -ray[1],
        hz = camera.eye[2] + ray[2] * s,
        hx = camera.eye[0] + ray[0] * s;
      if (!(hz > -54000 && Math.abs(hx) < 29000) || Math.abs(ray[1]) < 0.03) continue;
      const want = fogBelowLight(decay, ray[1], 0.02 * s);
      for (let c = 0; c < 3; c++) {
        const ratio = lit[p + c] / flat[p + c];
        worst = Math.max(worst, Math.abs(ratio - want[c]) / want[c]);
      }
      const l = flat[p + 1];
      lowest[x] = Math.min(lowest[x], l);
      highest[x] = Math.max(highest[x], l);
      ground++;
    }
  // A pitched camera's columns turn in azimuth as they go down, except the middle one: compare that one alone.
  for (const x of [width / 2 - 1, width / 2])
    if (highest[x] > lowest[x]) columnSpread = Math.max(columnSpread, (highest[x] - lowest[x]) / highest[x]);
  console.log(
    `ground ${ground} sky ${sky} pixels; worst ratio error ${worst.toExponential(2)}; flat column spread ${columnSpread.toExponential(2)}`,
  );
  assert.ok(ground > width * height * 0.2, `too little hazed ground: ${ground}`);
  assert.ok(sky > width * 4, `too little sky: ${sky}`);
  // Without the decay the hazed ground is the horizon's colour all the way down the middle column (the flat the shot saw).
  assert.ok(columnSpread < 2e-3, `the flat haze varies down the middle column: ${columnSpread}`);
  // With it each pixel takes its own ray's share, to the precision of the half-float capture.
  assert.ok(worst < 4e-3, `haze below the horizon off the CPU mirror by ${worst}`);
  assert.deepEqual(pageErrors, []);
  console.log('sky fog below the horizon check passed');
} finally {
  await context.close();
}
