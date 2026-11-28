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
    const value =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (value > 18) count++;
  }
  return count;
}

function samples(state) {
  const bytes = Buffer.from(state.pcm, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

try {
  const setup = await page.evaluate(async () => {
    const { mountModalSoundFilm } = await import('/packages/physics/tests/modal-sound-film.fixture.js');
    window.modalSoundFilm = await mountModalSoundFilm();
    const {
      cue,
      rate,
      sampleRate,
      checkpoint,
      end,
      seed,
      radius,
      barTop,
      bridgeTop,
      gravityDrop,
      mass,
      drop,
      mode,
      cell,
    } = window.modalSoundFilm;
    return {
      cue,
      rate,
      sampleRate,
      checkpoint,
      end,
      seed,
      radius,
      barTop,
      bridgeTop,
      gravityDrop,
      mass,
      drop,
      mode,
      cell,
    };
  });
  const {
    cue,
    rate,
    sampleRate,
    checkpoint,
    end,
    seed,
    radius,
    barTop,
    bridgeTop,
    gravityDrop,
    mass,
    drop,
    mode,
    cell,
  } = setup;
  const block = sampleRate / rate;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.modalSoundFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    for (const take of state.states) {
      assert.equal(samples(take).length, state.frame * block);
      assert.deepEqual(take.published, cell);
      assert.deepEqual(take.accepted, cell);
    }
    return { state, png, pixels: await decodePNG(png) };
  }

  function exact(a, b) {
    assert.deepEqual(a.state, b.state); // The PCM value is a byte-preserving base64 encoding of the full track.
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const initial = await sample(0);
  exact(await sample(cue), initial);
  const ready = await sample(cue + checkpoint, { action: 'save' });
  assert(ready.state.states[0].position[1] < initial.state.states[0].position[1]);
  assert.equal(ready.state.states[0].position[1], ready.state.states[1].position[1]);
  for (const take of ready.state.states) {
    assert.deepEqual(take.contacts, []);
    assert(samples(take).every((value) => value === 0));
  }

  const ring = await sample(cue + 19, { action: 'save' });
  const after = await sample(cue + end);
  const silent = await sample(cue + end, { showTrace: false });
  const [strike, caught] = after.state.states;
  const pcm = samples(strike);
  assert.equal(strike.contacts.length, 1, JSON.stringify(strike.contacts));
  assert.deepEqual(caught.contacts, []);
  assert(
    samples(caught).every((value) => value === 0),
    'The catch prevents any accepted strike on the muted steel.',
  );
  const [{ frame, impulse }] = strike.contacts;
  // A one-tick discrete contact time differs from the continuous gravity solution by at most a tick.
  assert(Math.abs(frame / rate - gravityDrop) < 1 / rate, JSON.stringify({ frame, gravityDrop }));
  const momentum = (mass * 2 * drop) / gravityDrop;
  assert(Math.abs(impulse - momentum) < (mass * 9.81 * 2) / rate, JSON.stringify({ impulse, momentum }));
  // The rigid resting contact has a finite penetration tolerance. The visible gap is 43 mm.
  assert(Math.abs(strike.position[1] - radius - barTop) < 0.006);
  assert(Math.abs(caught.position[1] - radius - bridgeTop) < 0.006);

  // FoleyAutomatic Eq. 1 (van den Doel, Kry and Pai, SIGGRAPH 2001). Drive it with the accepted
  // rigid contact impulse, and compare every emitted sample against the closed-form single-mode response:
  // https://www.cs.ubc.ca/labs/lci/papers/docs2001/van-foleyautomatic.pdf
  const first = (frame - 1) * block;
  assert.equal(
    pcm.findIndex((value) => value !== 0),
    first + 1,
  );
  let peak = 0;
  let absoluteError = 0;
  for (let i = 0; i < pcm.length; i++) {
    const t = (i - first) / sampleRate;
    const expected =
      t < 0 ? 0 : impulse * mode.gain * Math.exp(-mode.decay * t) * Math.sin(2 * Math.PI * mode.frequency * t);
    peak = Math.max(peak, Math.abs(pcm[i]));
    absoluteError = Math.max(absoluteError, Math.abs(pcm[i] - expected));
  }
  assert(peak > 0.31 && peak < 0.43, `normalized PCM peak ${peak}`);
  // Half an output f32 ulp at this peak plus the f64 recurrence roundoff.
  assert(absoluteError < 2 ** -26 + 1e-11, `absolute PCM error ${absoluteError}`);
  assert.deepEqual(after.state, silent.state);
  const visible = changed(after.pixels, silent.pixels);
  const movement = changed(ready.pixels, silent.pixels);
  assert(visible > 300 && movement > 500, JSON.stringify({ visible, movement }));

  exact(await sample(cue + end + 36), after);
  exact(await sample(cue + 19, { action: 'restore' }), ring);
  exact(await sample(cue + end), after);
  exact(await sample(cue + checkpoint, { action: 'restore' }), ready);
  exact(await sample(cue + 19), ring);
  exact(await sample(cue + end), after);
  exact(await sample(0), initial);
  exact(await sample(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.modalSoundFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_MODAL_SOUND_FILM_FRAMES === '1') {
    const path = 'packages/physics/test-results/modal-sound-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({ initial, ready, ring, after, silent }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  console.log(
    `${backend} modal contact: frame ${frame}, ${impulse.toFixed(4)} N·s, ${mode.frequency.toFixed(2)} Hz, ` +
      `PCM peak ${peak.toFixed(4)}, error ${absoluteError.toExponential(2)}, ` +
      `${visible}/${movement} trace/trajectory pixels, seed ${seed}, replay ${strike.hash}/${caught.hash}.`,
  );
} finally {
  await close();
}
