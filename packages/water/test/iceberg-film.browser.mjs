import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function changed(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const distance =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (distance > 14) count++;
  }
  return count;
}

const roll = ({ orientation: [, , z, w] }) => 2 * Math.atan2(z, w);

// Independent submerged cuboid calculation for this pure-Z take: clip the four section vertices against Y=0,
// integrate the clipped polygon by shoelace and extrude through the constant length along Z.
function clippedVolume({ position, orientation, size }) {
  const [x, y] = position;
  const [a, b, c] = size;
  assert(Math.abs(orientation[0]) + Math.abs(orientation[1]) < 1e-14);
  const angle = roll({ orientation });
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  const corners = [
    [-a / 2, -b / 2],
    [a / 2, -b / 2],
    [a / 2, b / 2],
    [-a / 2, b / 2],
  ].map(([u, v]) => [x + cosine * u - sine * v, y + sine * u + cosine * v]);
  const clipped = [];
  for (const [i, here] of corners.entries()) {
    const there = corners[(i + 1) % corners.length];
    if (here[1] <= 0) clipped.push(here);
    if (here[1] <= 0 !== there[1] <= 0) {
      const fraction = here[1] / (here[1] - there[1]);
      clipped.push([here[0] + (there[0] - here[0]) * fraction, 0]);
    }
  }
  let area = 0;
  for (const [i, point] of clipped.entries()) {
    const next = clipped[(i + 1) % clipped.length];
    area += point[0] * next[1] - point[1] * next[0];
  }
  return (c * Math.abs(area)) / 2;
}

try {
  const { cue, checkpoint, over, end, heel, x0, density, waterDensity, N } = await page.evaluate(async () => {
    const { mountIcebergFilm } = await import('/packages/water/test/iceberg-film.fixture.js');
    window.icebergFilm = await mountIcebergFilm();
    const { cue, checkpoint, over, end, heel, x0, density, waterDensity, N } = window.icebergFilm;
    return { cue, checkpoint, over, end, heel, x0, density, waterDensity, N };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.icebergFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { body, budget, source, wave } = state;
    const volume = body.size.reduce((sum, length) => sum * length, 1);
    const geometryRoundoff = 256 * Number.EPSILON * volume;
    assert(
      Math.abs(body.displaced - clippedVolume(body)) <= geometryRoundoff,
      JSON.stringify({ body, clipped: clippedVolume(body), geometryRoundoff }),
    );
    assert.deepEqual(budget, { ice: volume, melted: 0, calved: 0, awaiting: 0 });
    const [x, z, r, p, near, farX, farZ, farR, farP, far] = source;
    assert(p === 0 && farP === 0 && near + far === 0 && far === body.waveVolume);
    if (far !== 0) {
      assert(x === farX && z === farZ && r > 0 && farR > r);
      assert.equal(x, body.position[0]);
      assert.equal(z, body.position[2]);
    }
    assert(Math.abs(wave.netVolume) <= 16 * N * Number.EPSILON * volume);
    if (options.query) {
      for (const [i, level] of wave.heights.entries()) {
        const draw = state.drawHeights[i];
        assert(draw !== null && Math.abs(draw - level) < 2e-6, JSON.stringify({ i, draw, level }));
      }
    }
    return { state, png, image: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const start = await sample(0, { query: true });
  const [breadth, tall] = start.state.body.size;
  const ratio = density / waterDensity;
  assert(breadth / tall < Math.sqrt(6 * ratio * (1 - ratio)), 'the authored cuboid is hydrostatically unstable');
  assert(Math.abs(roll(start.state.body) - heel) <= 8 * Number.EPSILON);
  assert.equal(start.state.body.position[0], x0);
  assert.deepEqual(start.state.wave, { low: 0, high: 0, netVolume: 0, heights: [0, 0, 0] });
  exact(await sample(cue - 1, { query: true }), start);
  const tipping = await sample(cue + checkpoint, { action: 'save' });
  assert(roll(tipping.state.body) > 2 * heel && tipping.state.body.spin[2] > 0);
  assert(tipping.state.body.waveVolume > 0 && tipping.state.source[4] < 0);
  const overtake = await sample(cue + over, { query: true });
  assert(roll(overtake.state.body) > Math.PI / 2);
  assert(overtake.state.body.waveVolume < 0 && overtake.state.source[4] > 0);
  assert(overtake.state.wave.low < -0.01 && overtake.state.wave.high > 0.01);
  assert(changed(start.image, overtake.image) > 2500);

  const radiated = await sample(cue + end, { query: true });
  const quiet = await sample(cue + end, { connected: false, query: true });
  assert.deepEqual(quiet.state.body, radiated.state.body);
  assert.deepEqual(quiet.state.source, radiated.state.source);
  assert.deepEqual(quiet.state.wave, start.state.wave);
  const farWave = radiated.state.wave.heights.at(-1);
  assert(farWave > 0.03 && Math.abs(tipping.state.wave.heights.at(-1)) < 0.001);
  const wakePixels = changed(radiated.image, quiet.image);
  assert(wakePixels > 700, `The same rolling ice produces only ${wakePixels} changed wave pixels.`);

  exact(await sample(cue + end + 18, { query: true }), radiated);
  exact(await sample(cue + checkpoint, { action: 'restore' }), tipping);
  exact(await sample(cue + over, { query: true }), overtake);
  exact(await sample(cue + end, { query: true }), radiated);
  exact(await sample(0, { query: true }), start);
  exact(await sample(cue + end, { query: true }), radiated);
  assert.deepEqual(await page.evaluate(() => window.icebergFilm.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);
  if (process.env.MARGO_KEEP_ICEBERG_FRAMES === '1') {
    const path = 'packages/water/test-results/iceberg-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({ start, tipping, overtake, radiated, quiet }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  console.log(
    `${backend} iceberg rolls ${((roll(overtake.state.body) * 180) / Math.PI).toFixed(1)}°, ` +
      `${(100 * farWave).toFixed(2)} cm gauge rise, ${wakePixels} coupled pixels, replay ${radiated.state.hash}.`,
  );
} finally {
  await close();
}
