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
  const lanes = [0, 0];
  for (let i = 0; i < a.data.length; i += 4) {
    const distance =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (distance > 18) lanes[Number((i / 4) % a.width >= a.width / 2)]++;
  }
  return lanes;
}

try {
  const { cue, checkpoint, end, rate, releaseY, gravity, radius } = await page.evaluate(async () => {
    const { mountSamaraFilm } = await import('/packages/environment/tests/fixtures/samara-film.js');
    window.samaraFilm = await mountSamaraFilm();
    const { cue, checkpoint, end, rate, releaseY, gravity, radius } = window.samaraFilm;
    return { cue, checkpoint, end, rate, releaseY, gravity, radius };
  });
  async function sample(editFrame, action) {
    const { image, ...state } = await page.evaluate((input) => window.samaraFilm.sample(input), { editFrame, action });
    const png = Buffer.from(image, 'base64');
    const elapsed = state.frame / rate;
    const [, vacuum] = state.model;
    assert.deepEqual(
      vacuum.angularVelocity.map((v) => Math.abs(v)),
      [0, 0, 0],
    );
    assert.equal(Math.abs(vacuum.position[0]), 0);
    assert.equal(Math.abs(vacuum.position[2]), 0);
    // Independent analytic vacuum control: rest under uniform gravity, so RK4 has roundoff error only.
    const ballistic = releaseY - (gravity * elapsed * elapsed) / 2;
    const tolerance = 64 * Number.EPSILON * Math.max(1, state.frame);
    assert(Math.abs(vacuum.position[1] - ballistic) < tolerance);
    assert(Math.abs(vacuum.velocity[1] + gravity * elapsed) < tolerance);
    for (const tip of state.tips) {
      assert(Math.abs(Math.hypot(...tip) - radius) < 8 * Number.EPSILON * radius);
      assert(Math.abs(tip[1]) < 8 * Number.EPSILON * radius);
    }
    return { state, png, image: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const start = await sample(0);
  assert.deepEqual(start.state.tips[0], start.state.tips[1]);
  exact(await sample(cue - 1), start);
  const moving = await sample(cue + checkpoint, 'save');
  const advanced = await sample(cue + end);
  const [air, vacuum] = advanced.state.model;
  const heightGap = air.position[1] - vacuum.position[1];
  const tipTravel = Math.hypot(...advanced.state.tips[0].map((value, i) => value - advanced.state.tips[1][i]));
  assert.deepEqual(advanced.state.tips[1], start.state.tips[1]);
  assert(air.angularVelocity[1] > moving.state.model[0].angularVelocity[1]);
  assert(heightGap > 0.08 && vacuum.velocity[1] < 2 * air.velocity[1], JSON.stringify({ heightGap, air, vacuum }));
  // The air-driven radial tip has swung by at least 60 degrees. The identical vacuum tip stays put.
  assert(tipTravel > radius, `The turning blade tip travelled only ${tipTravel} m between the two controls.`);
  const lanes = changed(moving.image, advanced.image);
  assert(
    lanes.every((count) => count > 60),
    `The two drops must both be visible: ${lanes} changed pixels.`,
  );

  exact(await sample(cue + end + 24), advanced);
  exact(await sample(cue + checkpoint, 'restore'), moving);
  exact(await sample(cue + end), advanced);
  exact(await sample(0), start);
  exact(await sample(cue + end), advanced);
  assert.deepEqual(await page.evaluate(() => window.samaraFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SAMARA_FRAMES === '1') {
    const path = 'packages/environment/test-results/samara-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ start, moving, advanced }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} samara: ${(heightGap * 100).toFixed(2)} cm separation, ` +
      `${air.angularVelocity[1].toFixed(2)} rad/s in air vs 0 in vacuum, ` +
      `${lanes.join('/')} changed pixels, replay ${advanced.state.model.map(({ hash }) => hash).join('/')}.`,
  );
} finally {
  await close();
}
