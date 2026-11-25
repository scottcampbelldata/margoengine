// Builds examples/storm-light with Vite and checks it in a real browser: the page loads without console errors, its
// first frame is a lit night scene (not blank, the lamp the brightest thing, the sea darker than the sky), the Storm
// slider names the weather, reduced motion holds the beams still, it lays out on a phone and reports a missing model.
// `npm run test:storm-light` (WebGPU). The first frame is written to test-results/storm-light.png.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';

const output = await build({
  configFile: false,
  logLevel: 'silent',
  build: { write: false, target: 'es2022', rollupOptions: { input: 'examples/storm-light/index.html' } },
});
const chunks = output.output ?? output[0].output;
assert.ok(
  chunks.some((chunk) => chunk.type === 'chunk' && chunk.isEntry),
  'Storm Light build failed',
);
// scene.json is small enough for Vite to inline.
for (const asset of ['storm-light.glb', 'boat.glb', 'headland-height.bin'])
  assert.ok(
    chunks.some((chunk) => chunk.type === 'asset' && chunk.fileName.includes(asset.split('.')[0])),
    `the build left out ${asset}`,
  );

const port = 5195;
const url = `http://127.0.0.1:${port}/examples/storm-light/index.html`;
const { page, close } = await openBrowser({ startPath: '/examples/storm-light/index.html', port });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const ready = () => page.waitForSelector('#viewport[data-ready="true"]', { timeout: 180000 });
// Counted animation frames, not milliseconds: the temporal passes settle per frame, and a slow GPU draws fewer per second.
const frames = (count) =>
  page.evaluate(
    (count) =>
      new Promise((done) => {
        let n = 0;
        const tick = () => (++n >= count ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );
const luma = (image, x0, y0, x1, y1) => {
  let sum = 0,
    n = 0,
    peak = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4,
        v = 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
      sum += v;
      n++;
      peak = Math.max(peak, v);
    }
  return { mean: sum / n, peak };
};
try {
  // The hero still: the beams held at one bearing, the camera where the page opens.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${url}?tour=0&beam=0.6&storm=0.78`);
  await ready();
  // 240 frames: 4 s at 60 Hz, what the hero still was given to settle.
  await frames(240);
  await page.addStyleTag({ content: 'form,h1,#hint{visibility:hidden!important}' });
  const shot = await decodePNG(await page.locator('canvas').screenshot({ path: 'test-results/storm-light.png' }));
  const all = luma(shot, 0, 0, shot.width, shot.height),
    sky = luma(shot, 0, 0, shot.width, Math.round(shot.height * 0.2)),
    sea = luma(shot, 0, Math.round(shot.height * 0.85), Math.round(shot.width * 0.3), shot.height);
  assert.ok(all.mean > 8 && all.mean < 120, `the frame is not a night scene: mean ${all.mean.toFixed(1)}`);
  assert.ok(all.peak > 240, `no lamp: the brightest pixel is ${all.peak.toFixed(1)}`);
  assert.ok(sea.mean < sky.mean, `the near sea (${sea.mean.toFixed(1)}) outshines the sky (${sky.mean.toFixed(1)})`);

  // The opening strike: every visit flashes once 1.6 s in (the page has run longer than that by now).
  const opening = await page.evaluate(() => window.stormLight.opening());
  assert.ok(
    opening && opening.time >= 1.5 && opening.time < 2,
    'no opening lightning strike: ' + JSON.stringify(opening),
  );
  // A click strikes toward where the camera looks: Weather's azimuth is 0 toward +Z and pi/2 toward +X, so the heading
  // is atan2(dx, dz) (the page used atan2(dz, dx), which sent the strike off to one side).
  await page.mouse.click(640, 200);
  const clicked = await page.evaluate(() => {
    const { engine, strike } = window.stormLight,
      [x, , z] = engine.camera.position,
      [tx, , tz] = engine.camera.target;
    return { azimuth: strike().azimuth, heading: Math.atan2(tx - x, tz - z) };
  });
  const turn = Math.abs(
    Math.atan2(Math.sin(clicked.azimuth - clicked.heading), Math.cos(clicked.azimuth - clicked.heading)),
  );
  assert.ok(turn < 0.1, 'a click struck away from the view: ' + JSON.stringify(clicked));

  // The slider names the weather.
  const name = (value) =>
    page.evaluate((value) => {
      const slider = document.querySelector('#storm');
      slider.value = value;
      slider.dispatchEvent(new Event('input'));
      return document.querySelector('#force').textContent;
    }, value);
  assert.equal(await name('0'), 'Calm');
  assert.equal(await name('1'), 'Storm');

  // Reduced motion: no tour, no turning beam and no lightning.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await ready();
  const pose = () =>
    page.evaluate(() => {
      const { engine, beam, weather } = window.stormLight;
      return { camera: [...engine.camera.position], beam: beam(), rate: weather.options.lightning.rate };
    });
  const first = await pose();
  // 90 frames: each would have moved the camera, the beams or the lightning if reduced motion did not hold them.
  await frames(90);
  const later = await pose();
  assert.deepEqual(later, first, 'the camera or the beams moved under reduced motion');
  assert.equal(first.rate, 0, 'lightning under reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Phone: the scene stays visible and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}?tour=0`);
  await ready();
  const layout = await page.evaluate(() => {
    const r = document.querySelector('#viewport').getBoundingClientRect();
    return { height: r.height, overflowX: document.documentElement.scrollWidth > innerWidth };
  });
  assert.ok(layout.height >= 300 && !layout.overflowX, 'phone layout hides the scene: ' + JSON.stringify(layout));
  await page.setViewportSize({ width: 1280, height: 720 });

  assert.deepEqual(errors, [], 'console errors:\n' + errors.join('\n'));

  // A missing model: a visible error, not a blank page (the 404 itself logs console errors, expected here).
  await page.route('**/storm-light.glb', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#error').textContent.length > 0, null, { timeout: 60000 });
} finally {
  await close();
}
console.log('Storm Light browser check passed');
