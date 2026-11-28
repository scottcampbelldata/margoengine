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
const output =
  process.env.MARGO_KEEP_SEAKEEPING_FILM_FRAMES === '1' ? 'packages/water/test-results/seakeeping-film' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function changed(a, b, threshold) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const sum =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (sum > threshold) count++;
  }
  return count;
}

const trim = (pose) => pose.marks[0][1] - pose.marks[1][1];
const tilt = (pose) => pose.marks[2][1] - pose.marks[3][1];

try {
  const config = await page.evaluate(async () => {
    const { setupSeakeepingFilm } = await import('/packages/water/test/seakeeping-film.fixture.js');
    window.freighter = await setupSeakeepingFilm();
    const { cue, duration, waveAmplitude, wavePeriod, courseSpeed, mass, wakeBackend } = window.freighter;
    return { cue, duration, waveAmplitude, wavePeriod, courseSpeed, mass, wakeBackend };
  });
  const { cue, duration, waveAmplitude, wavePeriod, courseSpeed, mass, wakeBackend } = config;
  assert.equal(wakeBackend, 'wasm-simd');
  assert(mass > 55000 && mass < 70000, 'The 16.8 m ship balances in freshwater at working draft');
  const show = (frame, mode = 'active', action) =>
    page.evaluate(([f, m, a]) => window.freighter.at(f, m, a), [frame, mode, action]);

  const before = await show(0);
  const beforeImage = await capture('before');
  assert.equal(before.wakePeak, 0);
  assert.deepEqual(await show(cue - 1), before);
  assert.deepEqual((await capture('before-held')).data, beforeImage.data);
  const rise = await show(cue + 75, 'active', 'save');
  const riseImage = await capture('crest');
  const roll = await show(cue + 180);
  const rollImage = await capture('roll');
  const trough = await show(cue + duration);
  const troughImage = await capture('trough');

  assert(Math.abs(rise.time - 1.25) < 1e-12);
  assert(Math.abs(roll.time - 3) < 1e-12);
  assert(
    rise.position[1] > waveAmplitude * 0.4 && trough.position[1] < -waveAmplitude * 0.45,
    JSON.stringify({ rise, trough }),
  );
  assert(rise.pitch > 0.7 && trough.pitch < -0.75, JSON.stringify({ rise, trough }));
  assert(roll.roll > 4 && rise.roll < -1, JSON.stringify({ rise, roll }));
  assert(roll.position[0] - before.position[0] > 0.65 * courseSpeed * roll.time);
  assert(rise.wakePeak > 0.05 && roll.wakePeak > 0.05);
  assert.deepEqual(await show(cue + duration + 18), trough);
  assert.deepEqual((await capture('trough-held')).data, troughImage.data);

  const calm = await page.evaluate(() => window.freighter.flatReference(180));
  assert(
    Math.abs(calm.position[1]) < 0.24 * waveAmplitude && Math.abs(calm.pitch) < 0.52 && Math.abs(calm.roll) < 0.6,
    JSON.stringify({ calm, roll }),
  );
  const levelRise = await show(cue + 75, 'level');
  const levelRiseImage = await capture('crest-level-control');
  const levelRoll = await show(cue + 180, 'level');
  const levelRollImage = await capture('roll-level-control');
  assert.equal(rise.hash, levelRise.hash);
  assert.equal(roll.hash, levelRoll.hash);
  assert.deepEqual(rise.surface, levelRise.surface);
  assert.deepEqual(roll.surface, levelRoll.surface);
  const pitchPixels = Math.abs(trim(rise) - trim(levelRise));
  const rollPixels = Math.abs(tilt(roll) - tilt(levelRoll));
  const crestBeautyPixels = changed(riseImage, levelRiseImage, 35);
  const rollBeautyPixels = changed(rollImage, levelRollImage, 35);
  assert(pitchPixels > 4 && rollPixels > 3, JSON.stringify({ pitchPixels, rollPixels }));
  assert(crestBeautyPixels > 350 && rollBeautyPixels > 350, JSON.stringify({ crestBeautyPixels, rollBeautyPixels }));

  assert.deepEqual(await show(cue + 75, 'active', 'restore'), rise);
  assert.deepEqual((await capture('restored')).data, riseImage.data);
  assert.deepEqual(await show(cue + 180), roll);
  assert.deepEqual((await capture('replayed-roll')).data, rollImage.data);
  assert.deepEqual(await show(0), before);
  assert.deepEqual((await capture('rewound')).data, beforeImage.data);
  assert.deepEqual(await show(cue + 180), roll);
  assert.deepEqual((await capture('rewound-replay')).data, rollImage.data);
  await page.evaluate(() => window.freighter.detachWake());
  const wakeBeautyPixels = changed(rollImage, await capture('wake-detached'), 20);
  assert(wakeBeautyPixels > 300, JSON.stringify({ wakeBeautyPixels }));
  assert.deepEqual(await page.evaluate(() => window.freighter.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);
  console.log(
    backend,
    'Procedural lake freighter in an oblique wave',
    JSON.stringify({
      waveHeightM: 2 * waveAmplitude,
      wavePeriodS: wavePeriod,
      displacementKg: mass,
      heaveM: [rise.position[1], trough.position[1]],
      pitchDeg: [rise.pitch, trough.pitch],
      rollDeg: [rise.roll, roll.roll],
      calmRollDeg: calm.roll,
      pitchPixels,
      rollPixels,
      crestBeautyPixels,
      rollBeautyPixels,
      wakeBeautyPixels,
      wakePeakM: roll.wakePeak,
      state: roll.hash,
    }),
  );
} finally {
  await close();
}
