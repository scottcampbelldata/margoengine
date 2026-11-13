// Builds examples/orrery with Vite and checks it in a real browser: the page loads without console errors, renders a
// picture that is not blank, puts each planet's arm and wheel where ephemeris.ts and gears.ts say for a date, flies to
// a planet, plays time forward, honours reduced motion, lays out on a phone and reports a missing model.
// `npm run test:orrery` (WebGPU); `npm run test:orrery -- --compat` runs it on the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { PLANETS, julianDay, planetPosition } from '../examples/orrery/ephemeris.ts';
import { designTrains, driveAngle, wheelAngles } from '../examples/orrery/gears.ts';

const compat = process.argv.includes('--compat');
const output = await build({
  configFile: false,
  logLevel: 'silent',
  build: { write: false, target: 'es2022', rollupOptions: { input: 'examples/orrery/index.html' } },
});
const chunks = output.output ?? output[0].output;
assert.ok(
  chunks.some((chunk) => chunk.type === 'chunk' && chunk.isEntry),
  'Orrery build failed',
);
assert.ok(
  chunks.some((chunk) => chunk.type === 'asset' && chunk.fileName.endsWith('.glb')),
  'the build left out orrery.glb',
);

const port = 5194;
const url = `http://127.0.0.1:${port}/examples/orrery/index.html`;
const { page, close } = await openBrowser({ startPath: '/examples/orrery/index.html', port });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const ready = () => page.waitForSelector('#viewport[data-ready="true"]', { timeout: 180000 });
const TAU = Math.PI * 2;
const turn = (a) => ((a % TAU) + TAU) % TAU;
const near = (a, b, tolerance) => Math.min(turn(a - b), TAU - turn(a - b)) <= tolerance;
try {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${url}?date=2026-11-13`);
  await ready();

  // Not blank: the frame has light and contrast.
  const shot = await decodePNG(await page.locator('canvas').screenshot());
  let sum = 0,
    squares = 0;
  const count = shot.width * shot.height;
  for (let i = 0; i < shot.data.length; i += 4) {
    const y = 0.2126 * shot.data[i] + 0.7152 * shot.data[i + 1] + 0.0722 * shot.data[i + 2];
    sum += y;
    squares += y * y;
  }
  const mean = sum / count,
    spread = Math.sqrt(squares / count - mean * mean);
  assert.ok(mean > 12 && spread > 15, `the frame looks blank: mean ${mean.toFixed(1)}, spread ${spread.toFixed(1)}`);
  await page.screenshot({ path: `test-results/orrery${compat ? '-compat' : ''}.png` });

  // Arms at the ephemeris longitudes and wheels at the train angles for J2000 and for 1969-07-20.
  const trains = designTrains();
  for (const date of [Date.UTC(2000, 0, 1, 12), Date.UTC(1969, 6, 20, 20, 17)]) {
    const jd = julianDay(date);
    const read = await page.evaluate((jd) => {
      const { setDay, model } = window.orrery;
      setDay(jd);
      window.orrery.engine.render();
      const yaw = (name) => {
        const m = model.nodes.find((n) => n.name === name).matrix;
        return Math.atan2(-m[2], m[0]);
      };
      const at = (name) => {
        const m = model.nodes.find((n) => n.name === name).matrix;
        return [m[12], m[13], m[14]];
      };
      const names = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
      return {
        jd: window.orrery.jd,
        drive: yaw('drive'),
        planets: Object.fromEntries(
          names.map((n) => [n, { planet: at(`planet_${n}`), sleeve: yaw(`sleeve_${n}`), tube: yaw(`tube_${n}`) }]),
        ),
      };
    }, jd);
    assert.ok(Math.abs(read.jd - jd) < 1e-6, 'the page did not take the date');
    const drive = driveAngle(jd);
    assert.ok(near(read.drive, drive, 1e-4), `drive arbor at ${read.drive}, wanted ${turn(drive)}`);
    for (const name of PLANETS) {
      const [x, , z] = read.planets[name].planet;
      const longitude = Math.atan2(-z, x);
      const wanted = (planetPosition(name, jd).longitude * Math.PI) / 180;
      assert.ok(
        near(longitude, wanted, 2e-4),
        `${name} at ${(longitude * 180) / Math.PI}, wanted ${planetPosition(name, jd).longitude}`,
      );
      const w = wheelAngles(trains[name], drive);
      assert.ok(near(read.planets[name].sleeve, w.b, 1e-4), `${name} sleeve`);
      assert.ok(near(read.planets[name].tube, w.d, 1e-4), `${name} tube`);
    }
  }

  // Fly to Mars: it is selected, the dome lifts and the camera ends near it.
  const flight = await page.evaluate(async () => {
    const o = window.orrery;
    await o.select('mars');
    const m = o.model.nodes.find((n) => n.name === 'planet_mars').matrix;
    const c = o.engine.camera.position;
    return { selected: o.selected, distance: Math.hypot(c[0] - m[12], c[1] - m[13], c[2] - m[14]) };
  });
  assert.equal(flight.selected, 'mars');
  assert.ok(flight.distance < 0.3, `camera ${flight.distance} m from Mars`);
  await page.waitForFunction(() => window.orrery.dome > 0.4, null, { timeout: 30000 });
  await page.click('#xray');
  await page.click('#names');
  await page.click('#reset');
  await page.waitForFunction(() => window.orrery.selected === null);

  // Play a year a second: time moves forward.
  const before = await page.evaluate(() => window.orrery.jd);
  await page.selectOption('#speed', '365.2425');
  await page.click('#play');
  await page.waitForFunction((before) => window.orrery.jd > before + 30, before, { timeout: 30000 });
  await page.click('#play');
  await page.click('#today');
  const today = await page.evaluate(() => window.orrery.jd);
  assert.ok(Math.abs(today - julianDay(Date.now())) < 1, 'Today did not jump to today');

  // Reduced motion: Play does not run time.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await ready();
  const still = await page.evaluate(() => window.orrery.jd);
  await page.click('#play');
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.orrery.jd), still, 'time ran under reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Phone: the scene stays visible and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await ready();
  const layout = await page.evaluate(() => {
    const r = document.querySelector('#viewport').getBoundingClientRect();
    return { height: r.height, overflowX: document.documentElement.scrollWidth > innerWidth };
  });
  assert.ok(layout.height >= 300 && !layout.overflowX, 'phone layout hides the orrery: ' + JSON.stringify(layout));
  await page.setViewportSize({ width: 1280, height: 800 });

  assert.deepEqual(errors, [], 'console errors:\n' + errors.join('\n'));

  // A missing model: a visible error, not a blank page (the 404 itself logs console errors, expected here).
  await page.route('**/orrery.glb', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#status').textContent === 'Unable to wind the orrery',
    null,
    {
      timeout: 60000,
    },
  );
  assert.ok((await page.textContent('#error')).length > 0, 'load failure not reported');
} finally {
  await close();
}
console.log(`Orrery browser check passed${compat ? ' on the WebGL2 compatibility layer' : ''}`);
