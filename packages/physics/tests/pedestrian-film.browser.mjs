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

const horizontal = (point) => [point[0], point[2]];
const minus = (a, b) => a.map((value, i) => value - b[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const closeValue = (actual, expected) =>
  assert(Math.abs(actual - expected) <= 2e-12 * Math.max(1, Math.abs(expected)), JSON.stringify({ actual, expected }));

function shoulderProjection({ heading: [x, z] }, [nx, nz], width, depth) {
  return Math.hypot(width * (z * nx - x * nz), depth * (x * nx + z * nz)) / 2;
}

function expectedAvoidance([a, b], { gain, decay, reaction, shoulder, depth }) {
  const separation = minus(horizontal(a.position), horizontal(b.position));
  const relative = minus(horizontal(a.velocity), horizontal(b.velocity));
  const initialNormal = separation.map((value) => value / Math.hypot(...separation));
  const projectedRadius =
    shoulderProjection(a, initialNormal, shoulder, depth) + shoulderProjection(b, initialNormal, shoulder, depth);
  const closest = -dot(separation, relative) / dot(relative, relative);
  const miss = separation.map((value, i) => value + relative[i] * closest);
  // Move back from the geometric closest approach to the first intersection of the projected shoulders.
  const entry = closest - Math.sqrt(projectedRadius ** 2 - dot(miss, miss)) / Math.hypot(...relative);
  assert(entry > 0);
  const hit = separation.map((value, i) => value + entry * relative[i]);
  // Karamouzas, Skinner & Guy (2014), Eq. 2–3, https://doi.org/10.1103/PhysRevLett.113.238701.
  // The authored reaction-time shift is stated separately. Differentiate the paper's energy and use the
  // implicit derivative of |r + vτ|² = radius² with the initial projected radius held fixed.
  const exposure = entry + reaction;
  const energy = (gain * Math.exp(-exposure / decay)) / (exposure * exposure);
  const sensitivity = -dot(hit, relative);
  return { entry, force: hit.map((value) => (value * energy * (1 / decay + 2 / exposure)) / sensitivity) };
}

function project([x, y, z], m, image) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const u = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const v = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  return [(0.5 + 0.5 * u) * image.width, (0.5 - 0.5 * v) * image.height];
}

function torsoChanges(a, b, points) {
  const visited = new Set();
  for (const [cx, cy] of points) {
    for (let y = Math.max(0, Math.floor(cy) - 18); y <= Math.min(a.height - 1, Math.floor(cy) + 18); y++) {
      for (let x = Math.max(0, Math.floor(cx) - 18); x <= Math.min(a.width - 1, Math.floor(cx) + 18); x++) {
        const i = 4 * (x + a.width * y);
        const difference = [0, 1, 2].reduce((sum, axis) => sum + Math.abs(a.data[i + axis] - b.data[i + axis]), 0);
        if (difference > 18) visited.add(i);
      }
    }
  }
  return visited.size;
}

try {
  const settings = await page.evaluate(async () => {
    const { mountPedestrianFilm } = await import('/packages/physics/tests/pedestrian-film.fixture.js');
    const stage = await mountPedestrianFilm();
    window.pedestrianFilm = stage;
    const { sample, scan, dispose, ...settings } = stage;
    return settings;
  });
  const { cue, approach, passage, end, cell, stride, grade, shoulder, depth, paths } = settings;
  assert(paths.every((path) => path.length >= 2));
  async function get(editFrame, action, empty = false) {
    const { states, ...camera } = await page.evaluate((input) => window.pedestrianFilm.sample(input), {
      editFrame,
      action,
      empty,
    });
    const shots = await Promise.all(
      states.map(async ({ image, ...state }) => {
        assert.deepEqual(state.cells, [cell, cell]);
        for (const [i, walker] of state.people.entries()) {
          closeValue(walker.position[1], grade * walker.position[0]);
          closeValue(state.pose[i].heading, Math.atan2(...walker.heading));
          closeValue(state.pose[i].phase, 2 * Math.PI * (walker.distanceTravelled / stride + 0.33 * i));
          if (camera.frame > 0) closeValue(walker.velocity[1], grade * walker.velocity[0]);
        }
        const png = Buffer.from(image, 'base64');
        return { state, png, pixels: await decodePNG(png) };
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

  const before = await get(0);
  exact(await get(cue), before);
  assert.deepEqual(before.shots[0].state.people, before.shots[1].state.people);
  const anticipated = await get(cue + 1);
  const { entry, force } = expectedAvoidance(before.shots[0].state.people, settings);
  const pair = anticipated.shots[0].state.people;
  pair.forEach(({ normalLoad, anticipationForce }, i) => {
    assert.equal(normalLoad, 0);
    for (const j of [0, 1]) closeValue(anticipationForce[j], force[j] * (i === 0 ? 1 : -1));
  });
  assert(
    anticipated.shots[1].state.people.every(
      ({ anticipationForce, normalLoad }) => normalLoad === 0 && Math.hypot(...anticipationForce) === 0,
    ),
  );

  const approaching = await get(cue + approach, 'save');
  assert(approaching.shots[0].state.people.every(({ normalLoad }) => normalLoad === 0));
  assert(approaching.shots[0].state.people.some(({ anticipationForce }) => Math.hypot(...anticipationForce) > 0));
  const crossing = await get(cue + passage, 'save');
  const withoutActors = await get(cue + passage, undefined, true);
  const torsoPixels = crossing.shots.map(({ state, pixels }) =>
    state.people.map(({ position: [x, y, z] }) => project([x, y + 1.24, z], crossing.matrix, pixels)),
  );
  for (const [i, shot] of crossing.shots.entries()) {
    assert.deepEqual(withoutActors.shots[i].state, shot.state);
    assert(torsoPixels[i].every((point) => torsoChanges(shot.pixels, withoutActors.shots[i].pixels, [point]) > 60));
  }
  const changed = torsoChanges(crossing.shots[0].pixels, crossing.shots[1].pixels, torsoPixels.flat());
  assert(changed > 40, 'The accepted crossing reaction changes the people in the fixed camera.');
  const after = await get(cue + end);
  assert(
    after.shots.every(
      ({
        state: {
          people: [a, b],
        },
      }) => a.position[0] - shoulder / 2 > 1.2 && b.position[2] - shoulder / 2 > 1.2,
    ),
  );

  exact(await get(cue + end + 48), after);
  exact(await get(cue + passage, 'restore'), crossing);
  exact(await get(cue + end), after);
  exact(await get(cue + approach, 'restore'), approaching);
  exact(await get(cue + passage), crossing);
  exact(await get(cue + end), after);
  exact(await get(0), before);
  exact(await get(cue + end), after);

  const histories = await page.evaluate(() => window.pedestrianFilm.scan());
  const results = histories.map((history) => {
    let minSeparation = Infinity,
      minClearance = Infinity,
      maxLoad = 0;
    for (const [a, b] of history) {
      const delta = minus(horizontal(a.position), horizontal(b.position)),
        separation = Math.hypot(...delta);
      const n = delta.map((value) => value / separation);
      minSeparation = Math.min(minSeparation, separation);
      minClearance = Math.min(
        minClearance,
        separation - shoulderProjection(a, n, shoulder, depth) - shoulderProjection(b, n, shoulder, depth),
      );
      maxLoad = Math.max(maxLoad, a.normalLoad, b.normalLoad);
      for (const j of [0, 1]) {
        closeValue(a.anticipationForce[j] + b.anticipationForce[j], 0);
        closeValue(a.contactForce[j] + b.contactForce[j], 0);
      }
    }
    return { minSeparation, minClearance, maxLoad };
  });
  assert(results[0].minClearance > 0 && results[0].maxLoad === 0, JSON.stringify(results));
  assert(results[1].minClearance < 0 && results[1].maxLoad > 0, JSON.stringify(results));
  assert(results[0].minSeparation > results[1].minSeparation, JSON.stringify(results));
  assert.deepEqual(await page.evaluate(() => window.pedestrianFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_PEDESTRIAN_FILM_FRAMES === '1') {
    const dir = 'packages/physics/test-results/pedestrian-film';
    await mkdir(dir, { recursive: true });
    for (const [name, frame] of Object.entries({ before, approaching, crossing, after })) {
      await writeFile(`${dir}/${backend}-${name}-anticipation.png`, frame.shots[0].png);
      if (name === 'crossing') await writeFile(`${dir}/${backend}-${name}-contact.png`, frame.shots[1].png);
    }
  }
  console.log(
    `${backend} pedestrians: first forecast ${entry.toFixed(4)} s and ${Math.hypot(...force).toFixed(4)} N before contact, ` +
      `${results.map((r) => r.minSeparation.toFixed(4)).join('/')} m minimum separation, ${results.map((r) => r.maxLoad.toFixed(2)).join('/')} N peak contact, ` +
      `${changed} changed pixels at the two walkers, exact replay ${after.shots.map(({ state }) => state.hash).join('/')}.`,
  );
} finally {
  await close();
}
