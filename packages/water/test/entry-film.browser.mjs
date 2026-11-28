import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = process.env.MARGO_KEEP_ENTRY_FILM_FRAMES === '1' ? 'packages/water/test-results/entry-film' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function changedWater(wet, clear, [sx, sy]) {
  let bright = 0;
  let local = 0;
  let air = 0;
  let top = Infinity;
  for (let i = 0; i < wet.width * wet.height; i++) {
    const at = 4 * i;
    const difference =
      wet.data[at] + wet.data[at + 1] + wet.data[at + 2] - clear.data[at] - clear.data[at + 1] - clear.data[at + 2];
    if (difference < 30) continue;
    bright++;
    const x = i % wet.width;
    const y = Math.floor(i / wet.width);
    if (Math.abs(x - sx) > 125 || y > sy + 45) continue;
    local++;
    if (y < sy - 12) air++;
    top = Math.min(top, y);
  }
  return { bright, local, air, rise: sy - top };
}

try {
  const config = await page.evaluate(async () => {
    const { setupEntryFilm } = await import('/packages/water/test/entry-film.fixture.js');
    window.entryFilm = await setupEntryFilm();
    const { cue, duration, rate, gravity, initialY, downSpeed, radius } = window.entryFilm;
    return { cue, duration, rate, gravity, initialY, downSpeed, radius };
  });
  const { cue, duration, rate, gravity, initialY, downSpeed, radius } = config;
  const show = (frame, on = true, action) =>
    page.evaluate(([f, b, a]) => window.entryFilm.at(f, b, a), [frame, on, action]);

  const before = await show(0);
  const beforeImage = await capture('before');
  assert.deepEqual(await show(cue - 1), before);
  assert.deepEqual((await capture('before-held')).data, beforeImage.data);
  assert.equal(before.phase.phase, 'air');
  assert.deepEqual(before.drawn, []);

  const falling = await show(cue + 10, true, 'save');
  const fallingImage = await capture('falling');
  const touchTime = (Math.sqrt(downSpeed ** 2 + 2 * gravity * (initialY - radius)) - downSpeed) / gravity;
  assert(falling.position[1] < before.position[1] && falling.position[1] > radius);
  assert(
    Math.abs(falling.velocity[1] + downSpeed + gravity * falling.time) < 1e-4,
    'The early interval must be ballistic',
  );
  assert.equal(falling.phase.phase, 'air');

  const crownFrame = cue + 31;
  const columnFrame = cue + 57;
  const strike = await show(cue + 18);
  assert.equal(strike.phase.cavity, true);
  assert.equal(strike.phase.phase, 'through');
  const crown = await show(crownFrame);
  const crownImage = await capture('crown');
  const input = crown.events.find((event) => event.kind === 'entry');
  assert(input?.cavity && Math.abs(input.time - touchTime) < 2 / rate, JSON.stringify({ input, touchTime }));
  assert(crown.phase.cavity && crown.phase.phase === 'under');
  assert(
    crown.velocity[1] > -downSpeed - gravity * crown.time + 1,
    'The accepted water load must slow the water entry',
  );
  assert.equal(crown.drawn[0]?.crownHeight, input.crownHeight);
  assert.equal(crown.source.length, 2);
  assert.equal(crown.source[0].volume + crown.source[1].volume, 0);

  const jet = await show(columnFrame);
  const jetImage = await capture('column');
  const seal = jet.events.find((event) => event.kind === 'seal');
  assert(seal && seal.time > input.time && seal.columnHeight > input.crownHeight);
  assert.equal(jet.phase.cavity, false);
  assert(jet.drawn.some((event) => event.columnHeight === seal.columnHeight));
  assert.deepEqual(seal.position, input.position, 'The closing cavity jet must rise from the entry mouth');
  assert(crown.rings.length > 0 && jet.rings.length > 0);
  const end = await show(cue + duration);
  const endImage = await capture('end');
  assert.deepEqual(await show(cue + duration + 9), end);
  assert.deepEqual((await capture('end-held')).data, endImage.data);

  const clearCrown = await show(crownFrame, false);
  const clearCrownImage = await capture('crown-control');
  const clearJet = await show(columnFrame, false);
  const clearJetImage = await capture('column-control');
  assert.equal(clearCrown.hash, crown.hash);
  assert.equal(clearJet.hash, jet.hash);
  assert.equal(crown.surface, 0);
  assert.equal(clearCrown.surface, crown.surface);
  assert.equal(clearJet.surface, jet.surface);
  assert.deepEqual(clearCrown.drawn, []);
  assert.deepEqual(clearJet.rings, []);
  const crownPixels = changedWater(crownImage, clearCrownImage, crown.screen);
  const columnPixels = changedWater(jetImage, clearJetImage, jet.screen);
  assert(crownPixels.local > 80 && crownPixels.air > 15, JSON.stringify(crownPixels));
  assert(
    columnPixels.air > 90 && columnPixels.rise > crownPixels.rise + 20,
    JSON.stringify({ crownPixels, columnPixels }),
  );
  assert(
    crownPixels.local > 0.8 * crownPixels.bright && columnPixels.local > 0.8 * columnPixels.bright,
    JSON.stringify({ crownPixels, columnPixels }),
  );

  assert.deepEqual(await show(cue + 10, true, 'restore'), falling);
  assert.deepEqual((await capture('restored')).data, fallingImage.data);
  assert.deepEqual(await show(crownFrame), crown);
  assert.deepEqual((await capture('replayed-crown')).data, crownImage.data);
  assert.deepEqual(await show(columnFrame), jet);
  assert.deepEqual((await capture('replayed-column')).data, jetImage.data);
  assert.deepEqual(await show(0), before);
  assert.deepEqual((await capture('rewound')).data, beforeImage.data);
  assert.deepEqual(await page.evaluate(() => window.entryFilm.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);
  console.log(
    backend,
    'Coated sphere entry film',
    JSON.stringify({
      impactSeconds: input.time,
      sealSeconds: seal.time,
      crownHeightM: input.crownHeight,
      columnHeightM: seal.columnHeight,
      crownPixels,
      columnPixels,
      state: jet.hash,
    }),
  );
} finally {
  await close();
}
