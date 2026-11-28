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
  for (let i = 0; i < a.length; i += 4) {
    const difference = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (difference > 16) count++;
  }
  return count;
}

try {
  const { cue, duration, focus, crest, mass } = await page.evaluate(async () => {
    const { setupRogueFilm } = await import('/packages/water/test/rogue-film.fixture.js');
    window.rogueFilm = await setupRogueFilm();
    const { cue, duration, focus, crest, mass } = window.rogueFilm;
    return { cue, duration, focus, crest, mass };
  });
  assert.ok(mass > 3300 && mass < 4000);
  async function sample(shotFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.rogueFilm.sample(input), {
      shotFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { data } = await decodePNG(png);
    return { state, png, pixels: data };
  }
  const same = (now, reference) => {
    assert.deepEqual(now.state, reference.state);
    assert.deepEqual(now.pixels, reference.pixels);
  };

  const slate = await sample(0);
  assert.equal(slate.state.motion.time, 0);
  same(await sample(cue - 1), slate);
  const riseTick = cue + focus - 30;
  const peakTick = cue + focus;
  const endTick = cue + duration;
  const rising = await sample(riseTick, { action: 'save' });
  const focused = await sample(peakTick, { query: true });
  const outgoing = await sample(endTick);
  const plain = await sample(peakTick, { mode: 'plain', query: true });
  const plainPose = await sample(peakTick, { mode: 'plain-pose' });
  const heights = [rising.state.crest, focused.state.crest, outgoing.state.crest];
  assert.deepEqual([rising.state.motion.time, focused.state.motion.time, outgoing.state.motion.time], [3.5, 4, 4.4]);
  assert(Math.abs(focused.state.crest - crest) <= 1e-10, 'the prescribed crest arrives at the focus');
  assert(heights[1] > heights[0] + 0.5 && heights[1] > heights[2] + 0.3);
  assert(heights[1] > plain.state.crest + 1);
  assert(
    focused.state.slopes.every((s) => s < crest - 0.07),
    'the neighboring surface is below the focus',
  );
  for (const { state } of [focused, plain]) {
    assert(Math.abs(state.renderedCrest - state.crest) <= 4e-6, 'read the actual focused surface from Water');
  }
  assert(focused.state.motion.position[1] > plain.state.motion.position[1] + 0.25);
  assert(focused.state.motion.roll > plain.state.motion.roll + 10);
  assert(Math.abs(focused.state.verticalLoad - plain.state.verticalLoad) > 2000);
  assert.equal(plainPose.state.hash, focused.state.hash);
  assert.equal(plainPose.state.crest, focused.state.crest);
  const wavePixels = changed(focused.pixels, plain.pixels);
  const hullPixels = changed(focused.pixels, plainPose.pixels);
  assert(wavePixels > 1500 && hullPixels > 150, JSON.stringify({ wavePixels, hullPixels }));

  same(await sample(endTick + 20), outgoing);
  same(await sample(riseTick, { action: 'restore' }), rising);
  same(await sample(peakTick, { query: true }), focused);
  same(await sample(0), slate);
  same(await sample(peakTick, { query: true }), focused);
  assert.deepEqual(await page.evaluate(() => window.rogueFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_ROGUE_FILM_FRAMES === '1') {
    const path = 'packages/water/test-results/rogue-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ rising, focused, outgoing, plain })) {
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
    }
  }
  console.log(
    `${backend} prescribed focus ${focused.state.crest.toFixed(3)} m, control ${plain.state.crest.toFixed(3)} m, ` +
      `hull roll ${focused.state.motion.roll.toFixed(2)}° versus ${plain.state.motion.roll.toFixed(2)}°, ` +
      `${wavePixels} wave-and-hull pixels and ${hullPixels} pose-only pixels, ${focused.state.hash}.`,
  );
} finally {
  await close();
}
