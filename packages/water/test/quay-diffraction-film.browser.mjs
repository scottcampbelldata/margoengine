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

function project([x, y, z], m, image) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (0.5 + (0.5 * (m[0] * x + m[4] * y + m[8] * z + m[12])) / w) * image.width,
    (0.5 - (0.5 * (m[1] * x + m[5] * y + m[9] * z + m[13])) / w) * image.height,
  ];
}

function changed(a, b, probes) {
  const visited = new Set();
  const radius = 18;
  for (const [cx, cy] of probes) {
    for (let y = Math.max(0, Math.floor(cy) - radius); y <= Math.min(a.height - 1, Math.floor(cy) + radius); y++) {
      for (let x = Math.max(0, Math.floor(cx) - radius); x <= Math.min(a.width - 1, Math.floor(cx) + radius); x++) {
        const i = 4 * (x + y * a.width);
        if (
          Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]) >
          16
        )
          visited.add(i);
      }
    }
  }
  return visited.size;
}

try {
  const {
    cue,
    incident,
    shelter,
    reflected,
    end,
    cell,
    gauges,
    fps,
    gravity,
    depth,
    waveLength,
    amplitude,
    packetCentre,
    faces,
  } = await page.evaluate(async () => {
    const { mountQuayFilm } = await import('/packages/water/test/quay-diffraction-film.fixture.js');
    const film = await mountQuayFilm();
    window.quayFilm = film;
    const { sample, dispose, ...settings } = film;
    return settings;
  });

  const [closed, open] = faces;
  assert.equal(closed.length, 18);
  assert(closed[0] & 4 && closed.at(-1) & 4);
  assert(closed.slice(1, -1).every((v) => (v & 4) === 0 && (v & 1) === 1));
  assert(open.every((v) => (v & 4) !== 0));

  async function get(editFrame, action, measure = false, showWall = true) {
    const { states, ...camera } = await page.evaluate((input) => window.quayFilm.sample(input), {
      editFrame,
      action,
      measure,
      showWall,
    });
    const shots = await Promise.all(
      states.map(async ({ image, agreement, ...state }) => {
        assert.deepEqual(state.cell, cell);
        assert(state.energy > 0 && state.absorbed >= 0);
        // There is no forcing or scale conversion after release. The closed linear wave Hamiltonian plus the independently
        // accounted sponge work gives the total, within the iterative midpoint solve's established relative precision.
        assert(
          Math.abs(state.energy + state.absorbed - state.initialEnergy) <= 1e-9 * state.initialEnergy,
          JSON.stringify(state),
        );
        if (measure) {
          assert(agreement.count > 3500);
          assert(agreement.heights < 2e-6 && agreement.normals < 3e-6, JSON.stringify(agreement));
        }
        const png = Buffer.from(image, 'base64');
        return { state, agreement, png, pixels: await decodePNG(png) };
      }),
    );
    return { ...camera, shots };
  }

  function exact(a, b) {
    assert.equal(a.frame, b.frame);
    assert.deepEqual(a.matrix, b.matrix);
    for (const [i, { state, pixels }] of a.shots.entries()) {
      assert.deepEqual(state, b.shots[i].state);
      assert.deepEqual(pixels.data, b.shots[i].pixels.data);
    }
  }

  const first = await get(0);
  exact(await get(cue), first);
  assert(first.shots.every(({ state }) => state.gauges[2] === 0));
  const moving = await get(cue + incident, 'save');
  const aroundTip = await get(cue + shelter, 'save', true);
  const echo = await get(cue + reflected, 'save', true);
  const terminal = await get(cue + end);

  // Penney & Price (1952), https://doi.org/10.1098/rsta.1952.0003, shows a head wave turning into the lee and a
  // return wave leaving the incident face. For the open tank use the independent finite-depth dispersion derivative.
  const k = (2 * Math.PI) / waveLength;
  const omega = Math.sqrt(gravity * k * Math.tanh(k * depth));
  const groupSpeed = (gravity * (Math.tanh(k * depth) + (k * depth) / Math.cosh(k * depth) ** 2)) / (2 * omega);
  const distance = gauges[2][1] - packetCentre;
  const groupArrival = distance / groupSpeed;
  assert(shelter / fps < groupArrival && reflected / fps > groupArrival);
  const incidentPhase = (frame) => Math.cos(k * distance - (omega * frame) / fps);
  const [tip, sheltered, midLee] = aroundTip.shots[0].state.gauges;
  const openLee = aroundTip.shots[1].state.gauges[2];
  const echoLee = echo.shots[1].state.gauges[2];
  assert.equal(Math.sign(openLee), Math.sign(incidentPhase(shelter)));
  assert.equal(Math.sign(echoLee), Math.sign(incidentPhase(reflected)));
  assert(Math.abs(openLee) > amplitude / 2);
  assert(Math.abs(tip) > Math.abs(sheltered) && Math.abs(sheltered) > Math.abs(midLee));
  assert(midLee > 0 && midLee < Math.abs(openLee) / 2);
  const wallReturn = echo.shots[0].state.gauges[4];
  assert(wallReturn > Math.abs(echo.shots[1].state.gauges[4]) + amplitude / 2);

  const waterOnly = await get(cue + reflected, undefined, false, false);
  assert.deepEqual(waterOnly.shots[0].state, echo.shots[0].state);
  const [blocked, free] = waterOnly.shots;
  const pixels = changed(
    blocked.pixels,
    free.pixels,
    [2, 4, 5].map((i) => {
      const [x, z] = gauges[i];
      return project([x, blocked.state.gauges[i], z], waterOnly.matrix, blocked.pixels);
    }),
  );
  assert(pixels > 150, JSON.stringify({ pixels, wallReturn, midLee }));

  exact(await get(cue + end + 20), terminal);
  exact(await get(cue + reflected, 'restore'), echo);
  exact(await get(cue + end), terminal);
  exact(await get(cue + shelter, 'restore'), aroundTip);
  exact(await get(cue + reflected), echo);
  exact(await get(cue + end), terminal);
  exact(await get(cue + incident, 'restore'), moving);
  exact(await get(cue + end), terminal);
  exact(await get(0), first);
  exact(await get(cue + end), terminal);
  assert.deepEqual(await page.evaluate(() => window.quayFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_QUAY_DIFFRACTION_FRAMES === '1') {
    const dir = 'packages/water/test-results/quay-diffraction-film';
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${backend}-water-blocked.png`, blocked.png);
    await writeFile(`${dir}/${backend}-water-free.png`, free.png);
    for (const [name, frame] of Object.entries({ first, moving, aroundTip, echo, terminal })) {
      await writeFile(`${dir}/${backend}-${name}-finite.png`, frame.shots[0].png);
      if (name === 'echo') await writeFile(`${dir}/${backend}-${name}-open.png`, frame.shots[1].png);
    }
  }
  const agreement = Math.max(...[...aroundTip.shots, ...echo.shots].map(({ agreement }) => agreement.heights));
  const worstEnergy = Math.max(
    ...[...moving.shots, ...aroundTip.shots, ...echo.shots, ...terminal.shots].map(
      ({ state }) => Math.abs(state.energy + state.absorbed - state.initialEnergy) / state.initialEnergy,
    ),
  );
  console.log(
    `${backend} finite quay: ${(100 * wallReturn).toFixed(2)} cm reflected crest, ${(100 * midLee).toFixed(2)} vs ${(100 * openLee).toFixed(2)} cm lee, ` +
      `${agreement.toExponential(2)} m GPU elevation residual, ${worstEnergy.toExponential(2)} relative wave energy closure, ` +
      `${pixels} changed water pixels, exact replay ${terminal.shots.map(({ state }) => state.hash).join('/')}.`,
  );
} finally {
  await close();
}
