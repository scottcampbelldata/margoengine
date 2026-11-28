import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const folder =
  process.env.MARGO_KEEP_OUTDOOR_FILM_FRAMES === '1' ? 'packages/audio/test-results/outdoor-film' : undefined;
if (folder) await mkdir(folder, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(folder ? { path: folder + '/' + backend + '-' + name + '.png' } : {}),
  );

function pathPixels(image) {
  // Strip the static headings and keys from the optical cue count.
  const mask = [0, 0];
  for (let y = 99; y < image.height - 55; y++)
    for (let x = 0; x < image.width; x++) {
      const i = 4 * (y * image.width + x);
      const [r, g, b] = image.data.subarray(i, i + 3);
      if (g > 172 && b > 172 && r < 128) mask[0]++;
      if (r > 201 && g > 118 && g < 222 && b < 139) mask[1]++;
    }
  return mask;
}

try {
  const settings = await page.evaluate(async () => {
    const { setupOutdoorFilm } = await import('/packages/audio/tests/fixtures/outdoor-film.js');
    window.outdoorFilm = await setupOutdoorFilm();
    const { cue, duration, sampleRate, strikeSample, source, receivers, crest } = window.outdoorFilm;
    return { cue, duration, sampleRate, strikeSample, source, receivers, crest };
  });
  const show = (frame, action) => page.evaluate(([f, a]) => window.outdoorFilm.at(f, a), [frame, action]);
  const still = await show(0);
  const stillImage = await capture('before-strike');
  assert.deepEqual(await show(settings.cue), still);
  assert.deepEqual((await capture('held-before-strike')).data, stillImage.data);
  assert.deepEqual(
    still.cues.map((path) => path.blocked),
    [false, true],
  );

  const speed = Math.sqrt(1.4 * 287.05 * 293.15);
  const straight = 50;
  const diffracted = 2 * Math.hypot(straight / 2, settings.crest[1] - settings.source[1]);
  const between = settings.cue + 90;
  const halfway = await show(settings.cue + 36);
  const halfwayImage = await capture('in-transit');
  assert.deepEqual(
    halfway.cues.map((path) => path.arrived),
    [false, false],
  );
  const caught = await show(between, 'save');
  const caughtImage = await capture('open-arrival');
  assert.deepEqual(
    caught.cues.map((path) => path.arrived),
    [true, false],
  );
  assert.deepEqual(caught.cues[0].point, settings.receivers[0]);
  assert(caught.cues[1].point[0] > 22 && caught.cues[1].point[0] < 25);
  const done = await show(settings.cue + settings.duration);
  const doneImage = await capture('ridge-arrival');
  assert.deepEqual(
    done.cues.map((path) => path.arrived),
    [true, true],
  );
  assert.deepEqual(
    done.cues.map((path) => path.point),
    settings.receivers,
  );

  assert(Math.abs(caught.cues[0].delay - straight / speed) < 2e-13);
  assert(Math.abs(caught.cues[1].delay - diffracted / speed) < 2e-13);
  assert(caught.cues[1].diffraction[1] - caught.cues[1].diffraction[0] > 7);
  const expectedSamples = ((diffracted - straight) * settings.sampleRate) / speed;
  const [open, ridge] = caught.audio;
  assert(open.finite && ridge.finite && open.first > settings.strikeSample, JSON.stringify(caught.audio));
  const arrivalSamples = ridge.first - open.first;
  assert(Math.abs(arrivalSamples - expectedSamples) < 2, JSON.stringify({ arrivalSamples, expectedSamples }));
  const darkening = open.trebleToBassDb - ridge.trebleToBassDb;
  assert(darkening > 5, 'The diffracted bell must lose high frequencies in the actual audio: ' + darkening);

  const quiet = pathPixels(stillImage);
  const enroute = pathPixels(halfwayImage);
  const arrival = pathPixels(caughtImage);
  assert(
    enroute.every((pixels, i) => pixels - quiet[i] > 70),
    JSON.stringify({ quiet, enroute }),
  );
  assert(
    arrival.every((pixels, i) => pixels - enroute[i] > 120),
    JSON.stringify({ arrival, enroute }),
  );
  assert.deepEqual(await show(settings.cue + settings.duration + 7), done);
  assert.deepEqual((await capture('held-ridge-arrival')).data, doneImage.data);
  assert.deepEqual(await show(between, 'restore'), caught);
  assert.deepEqual((await capture('restored')).data, caughtImage.data);
  assert.deepEqual(await show(0), still);
  assert.deepEqual((await capture('rewound')).data, stillImage.data);
  assert.deepEqual(await show(between, 'audio'), caught);
  assert.deepEqual((await capture('replayed')).data, caughtImage.data);
  assert.deepEqual(await page.evaluate(() => window.outdoorFilm.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);
  console.log(
    backend,
    'Outdoor bell path',
    JSON.stringify({
      openDelayMs: caught.cues[0].delay * 1000,
      ridgeDelayMs: caught.cues[1].delay * 1000,
      arrivalSamples,
      addedDelayMs: (1000 * arrivalSamples) / settings.sampleRate,
      trebleReductionDb: darkening,
      pathPixels: arrival,
      state: caught.hash,
    }),
  );
} finally {
  await close();
}
