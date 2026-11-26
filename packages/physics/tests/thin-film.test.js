import assert from 'node:assert/strict';
import test from 'node:test';
import { ThinFilmSolver } from '../dist/thin-film.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const dt = 1 / rate.num;

async function patch(options, load = {}) {
  const film = await ThinFilmSolver.load(load);
  const world = new PhysicsWorld({ rate }).add(film, options);
  return { world, film };
}

function close(actual, wanted, tolerance) {
  assert.ok(Math.abs(actual - wanted) <= tolerance, `${actual} vs ${wanted}, bound ${tolerance}`);
}

test('ThinFilmSolver: hydrostatic plus capillary damping matches the closed-form discrete Fourier mode', async () => {
  const n = 16;
  const dx = 0.01;
  const h = 0.001;
  const epsilon = 1e-10;
  const density = 998;
  const viscosity = 0.001002;
  const sigma = 0.0728;
  const k = (3 * Math.PI) / n;
  const cosines = Array.from({ length: n }, (_, i) => Math.cos(k * (i + 0.5)));
  const { world, film } = await patch({ cells: [n, 1], spacing: dx, depth: cosines.map((v) => h + epsilon * v) });
  const eigenvalue = (4 * Math.sin(k / 2) ** 2) / (dx * dx);
  const mobility = h ** 3 / (3 * viscosity);
  const factor = 1 + dt * mobility * (density * -world.gravity[1] + sigma * eigenvalue) * eigenvalue;
  const frames = 12;
  world.advance(frames);
  const values = film.depths();
  const amplitude = (values.reduce((sum, value, i) => sum + (value - h) * cosines[i], 0) * 2) / n;
  const expected = epsilon / factor ** frames;
  const linearization = (12 * frames * epsilon * epsilon) / h;
  const rounding = 32 * frames * Number.EPSILON * h;
  close(amplitude, expected, linearization + rounding);
  close(film.budget.stored, film.budget.initial, frames * n * 8 * Number.EPSILON * film.budget.initial);
  assert.ok(amplitude > 0 && amplitude < epsilon);
  assert.equal(film.budget.substeps, 1);
});

test('ThinFilmSolver: the precursor contact-angle pressure has its derived linear decay rate', async () => {
  const n = 16;
  const dx = 0.002;
  const h = 0.0002;
  const epsilon = 1e-10;
  const angle = 0.35;
  const sigma = 0.0728;
  const density = 998;
  const viscosity = 0.001002;
  const k = (3 * Math.PI) / n;
  const cosines = Array.from({ length: n }, (_, i) => Math.cos(k * (i + 0.5)));
  const { world, film } = await patch({
    cells: [n, 1],
    spacing: dx,
    depth: cosines.map((value) => h + epsilon * value),
    wetting: { contactAngle: angle, precursorDepth: h },
  });
  const eigenvalue = (4 * Math.sin(k / 2) ** 2) / (dx * dx);
  const mobility = h ** 3 / (3 * viscosity);
  const stiffness = (2 * sigma * (1 - Math.cos(angle))) / (h * h);
  const decay = mobility * (density * -world.gravity[1] + stiffness + sigma * eigenvalue) * eigenvalue;
  const frames = 6;
  world.advance(frames);
  const amplitude = (film.depths().reduce((sum, value, i) => sum + (value - h) * cosines[i], 0) * 2) / n;
  // Perturbing mobility and the wetting derivative by O(epsilon / h) changes the mode at second order.
  const linearization = (24 * frames * epsilon * epsilon) / h;
  const rounding = 32 * frames * Number.EPSILON * h;
  close(amplitude, epsilon / (1 + dt * decay) ** frames, linearization + rounding);
  close(film.budget.stored, film.budget.initial, 16 * frames * n * Number.EPSILON * film.budget.initial);
});

test('ThinFilmSolver: nonlinear wetting relaxes without gaining energy or losing water', async () => {
  const n = 48;
  const dx = 0.0008;
  const precursor = 0.0002;
  const angle = 0.35;
  const surfaceTension = 0.0728;
  const stiffness = (2 * surfaceTension * (1 - Math.cos(angle))) / (precursor * precursor);
  const initial = Array.from({ length: n }, (_, i) => {
    const offset = (i + 0.5 - n / 2) / 5;
    return precursor * (0.8 + 2 * Math.exp(-offset * offset));
  });
  const film = await ThinFilmSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(film, {
    cells: [n, 1],
    spacing: dx,
    depth: initial,
    surfaceTension,
    wetting: { contactAngle: angle, precursorDepth: precursor },
  });
  const freeEnergy = (depth) =>
    depth.reduce((result, h, i) => {
      const slope = i === 0 ? 0 : (h - depth[i - 1]) / dx;
      const stretch = h < precursor ? h - precursor : precursor * (1 - precursor / h);
      return result + surfaceTension * slope * slope * 0.5 + stiffness * stretch * stretch * 0.5;
    }, 0) * dx;
  const snapshot = world.takeSnapshot();
  const initialEnergy = freeEnergy(initial);
  let energy = initialEnergy;
  for (let frame = 1; frame <= 60; frame++) {
    world.advance(frame);
    const depths = film.depths();
    assert.ok(depths.every((h) => h > 0));
    const next = freeEnergy(depths);
    assert.ok(next <= energy + 128 * n * Number.EPSILON * initialEnergy);
    energy = next;
  }
  assert.ok(energy < initialEnergy);
  close(film.budget.stored, film.budget.initial, 64 * n * Number.EPSILON * film.budget.initial);
  const settledHash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(60);
  assert.equal(world.hash(), settledHash);
});

test('ThinFilmSolver: a material boundary pulls water toward the more wettable glass', async () => {
  // Schwartz and Eley (1998) prescribe an equilibrium angle field on the backing.
  const h = 0.0004;
  const precursorDepth = 0.0002;
  const spacing = 0.0015;
  const density = 998;
  const viscosity = 0.05;
  const surfaceTension = 0.0728;
  const angle = [0.25, 0.65];
  const { world, film } = await patch({
    cells: [2, 1],
    spacing,
    depth: h,
    density,
    viscosity,
    surfaceTension,
    wetting: { contactAngle: angle[0], precursorDepth },
    wettingAngleMap: [undefined, angle[1]],
  });
  const stiffness = angle.map((value) => (2 * surfaceTension * (1 - Math.cos(value))) / precursorDepth ** 2);
  const ratio = precursorDepth / h;
  const pressureDifference = (stiffness[1] - stiffness[0]) * precursorDepth * ratio ** 2 * (1 - ratio);
  const mobility = h ** 3 / (3 * viscosity);
  const implicit =
    (2 * density * -world.gravity[1] + stiffness[0] + stiffness[1]) / spacing ** 2 +
    (4 * surfaceTension) / spacing ** 4;
  const delta = (dt * mobility * pressureDifference) / (spacing ** 2 * (1 + dt * mobility * implicit));
  const initial = world.takeSnapshot();
  world.advance(1);
  const depth = film.depths();
  close(depth[0], h + delta, 64 * Number.EPSILON * h);
  close(depth[1], h - delta, 64 * Number.EPSILON * h);
  assert.ok(depth[0] > depth[1]);
  close(film.budget.stored, film.budget.initial, 64 * Number.EPSILON * film.budget.initial);
  const hash = world.hash();
  world.restoreSnapshot(initial.bytes);
  world.advance(1);
  assert.equal(world.hash(), hash);
});

test('ThinFilmSolver: advancing and receding angles hold or release a precursor film by its force balance', async () => {
  const precursorDepth = 0.0002;
  const h = 1.5 * precursorDepth;
  const spacing = 0.0015;
  const viscosity = 0.05;
  const surfaceTension = 0.0728;
  const angles = [0.2, 0.4, 0.55];
  const stiffness = angles.map((angle) => (2 * surfaceTension * (1 - Math.cos(angle))) / precursorDepth ** 2);
  const ratio = precursorDepth / h;
  const mobility = h ** 3 / (3 * viscosity);
  const threshold = ((stiffness[2] - stiffness[0]) * precursorDepth * ratio ** 2 * (1 - ratio)) / spacing;
  const shearWeight = (h * h) / (2 * viscosity);
  for (const factor of [-1.8, -0.8, 0.8, 1.8]) {
    const forcing = factor * threshold;
    const { world, film } = await patch({
      cells: [2, 1],
      spacing,
      depth: h,
      viscosity,
      surfaceTension,
      shear: [(mobility * forcing) / shearWeight, 0],
      wetting: { contactAngle: angles[1], precursorDepth },
      contactAngleHysteresis: [angles[0], angles[2]],
    });
    const implicit =
      (2 * (998 * -world.gravity[1] + stiffness[1])) / spacing ** 2 + (4 * surfaceTension) / spacing ** 4;
    const excess = Math.sign(forcing) * Math.max(0, Math.abs(forcing) - threshold);
    const delta = (dt * mobility * excess) / (spacing * (1 + dt * mobility * implicit));
    const initial = world.takeSnapshot();
    world.advance(1);
    assert.equal(film.budget.substeps, 1);
    // The normalized two-cell rate tolerance is 1e-10 of the unpinned flux.
    const tolerance = (4e-10 * dt * mobility * Math.abs(forcing)) / spacing + 64 * Number.EPSILON * h;
    close(film.sample(0, 0).depth, h - delta, tolerance);
    close(film.sample(1, 0).depth, h + delta, tolerance);
    close(film.budget.stored, film.budget.initial, 64 * Number.EPSILON * film.budget.initial);
    const final = world.hash();
    world.restoreSnapshot(initial.bytes);
    world.advance(1);
    assert.equal(world.hash(), final);
  }
});

test('ThinFilmSolver: a tilted cap with wetting hysteresis loses energy in either grid direction', async () => {
  const size = 32;
  const spacing = 0.025 / size;
  const precursorDepth = 0.00008;
  const radius = 0.004;
  const density = 998;
  const sigma = 0.0728;
  const equilibrium = 0.3;
  const tilt = Math.PI / 15;
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  const coordinate = (i) => (i + 0.5 - size / 2) * spacing;
  const depth = Array.from({ length: size * size }, (_, i) => {
    const u = coordinate(i % size);
    const v = coordinate(Math.floor(i / size));
    return precursorDepth + 0.0006 * Math.max(0, 1 - (u * u + v * v) / (radius * radius));
  });
  const options = {
    cells: [size, size],
    spacing,
    depth,
    density,
    viscosity: 0.05,
    surfaceTension: sigma,
    wetting: { contactAngle: equilibrium, precursorDepth },
    contactAngleHysteresis: [0.18, 0.45],
  };
  const first = await patch({ ...options, u: [c, -s, 0] });
  const second = await patch({ ...options, v: [0, -s, -c] });
  const gravity = -first.world.gravity[1];
  const energy = (values) => {
    let total = 0;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const index = i + size * j;
        const h = values[index];
        const stretch = h > precursorDepth ? 1 - precursorDepth / h : (h - precursorDepth) / precursorDepth;
        total +=
          density * gravity * (0.5 * c * h * h - s * coordinate(i) * h) +
          sigma * (1 - Math.cos(equilibrium)) * stretch * stretch;
        if (i > 0) total += 0.5 * sigma * ((h - values[index - 1]) / spacing) ** 2;
        if (j > 0) total += 0.5 * sigma * ((h - values[index - size]) / spacing) ** 2;
      }
    }
    return total * spacing * spacing;
  };
  const oldEnergy = energy(depth);
  for (const { world, film } of [first, second]) {
    world.advance(8);
    close(film.budget.stored, film.budget.initial, 128 * size * size * Number.EPSILON * film.budget.initial);
  }
  const alongU = first.film.depths();
  const alongV = second.film.depths();
  assert.ok(energy(alongU) < oldEnergy);
  let downhill = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h = alongU[i + size * j];
      close(h, alongV[j + size * i], 2e-9 * precursorDepth);
      downhill += coordinate(i) * (h - depth[i + size * j]);
    }
  }
  assert.ok(downhill > 0);
});

test('ThinFilmSolver: complete wetting has the measured capillary spreading exponent under refinement', async () => {
  const width = 0.012;
  const initialRadius = 0.0017;
  const volume = 1e-9;
  const precursorDepth = 5e-8;
  const centreDepth = (2 * volume) / (Math.PI * initialRadius ** 2);
  const tension = 0.0205;
  // Rescale the Stokes time by 1/10 to represent the 0.020 Pa s experiment.
  const viscosity = 0.002;
  const capillaryTime = (3 * viscosity * initialRadius ** 4) / (tension * centreDepth ** 3);
  const first = Math.ceil((4 * capillaryTime) / dt);
  const frames = [first, 2 * first, 4 * first];
  const measured = [0.094, 0.125]; // Cazabat and Cohen Stuart (1986), reported by Ehrhard (1993), Table 2.
  let coarse;
  for (const n of [40, 80]) {
    const spacing = width / n;
    const r2 = Array.from({ length: n * n }, (_, i) => {
      const u = ((i % n) + 0.5 - n * 0.5) * spacing;
      const v = (Math.floor(i / n) + 0.5 - n * 0.5) * spacing;
      return u * u + v * v;
    });
    const profile = r2.map((r) => Math.max(0, 1 - r / initialRadius ** 2));
    const scale = volume / (spacing ** 2 * profile.reduce((sum, value) => sum + value, 0));
    const film = await ThinFilmSolver.load();
    const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(film, {
      cells: [n, n],
      spacing,
      depth: profile.map((h) => precursorDepth + scale * h),
      viscosity,
      surfaceTension: tension,
      wetting: { contactAngle: 0, precursorDepth },
    });
    const radii = frames.map((frame) => {
      world.advance(frame);
      const depth = film.depths();
      let water = 0;
      let moment = 0;
      for (const [i, h] of depth.entries()) {
        const excess = h - precursorDepth;
        water += excess;
        moment += r2[i] * excess;
      }
      close(water * spacing ** 2, volume, 64 * frame * Number.EPSILON * volume);
      // A shallow parabolic cap has a radial second moment of R²/3.
      return Math.sqrt((3 * moment) / water);
    });
    for (let i = 1; i < radii.length; i++) {
      const exponent = Math.log2(radii[i] / radii[i - 1]);
      assert.ok(exponent >= measured[0] && exponent <= measured[1], `n=${n}, local exponent ${exponent}`);
    }
    if (coarse) {
      for (const [i, radius] of radii.entries()) close(radius, coarse[i], width / 40);
    } else coarse = radii;
  }
});

test('ThinFilmSolver: malformed wetting parameters report the range and its fix', async () => {
  const options = { cells: [4, 1], spacing: 0.001 };
  await assert.rejects(() => patch({ ...options, wetting: null }), {
    name: 'TypeError',
    code: 'PHYSICS_INPUT_TYPE',
    message: /Pass an object with contactAngle and precursorDepth/,
  });
  await assert.rejects(() => patch({ ...options, wetting: { contactAngle: Math.PI / 2, precursorDepth: 0.0002 } }), {
    name: 'RangeError',
    code: 'PHYSICS_INPUT_RANGE',
    message: /Use a finite contact angle/,
  });
  await assert.rejects(
    () => patch({ ...options, wetting: { contactAngle: 0.35, precursorDepth: 0.0002 }, wettingAngleMap: [0.5] }),
    { name: 'RangeError', code: 'PHYSICS_INPUT_RANGE', message: /one angle in radians per row-major film cell/ },
  );
  await assert.rejects(
    () =>
      patch({
        ...options,
        wetting: { contactAngle: 0.35, precursorDepth: 0.0002 },
        contactAngleHysteresis: [0.4, 0.5],
      }),
    {
      name: 'RangeError',
      code: 'PHYSICS_INPUT_RANGE',
      message: /receding and advancing angles that bracket equilibrium/,
    },
  );
});

test('ThinFilmSolver: a suspended film amplifies the long mode and damps the short mode', async () => {
  // Fermigier et al. (1992), equation 1.3 and the silicone-oil properties in section 2.
  const n = 32;
  const dx = 0.0008;
  const h = 0.0002;
  const epsilon = 1e-10;
  const density = 970;
  const viscosity = 1;
  const surfaceTension = 0.021;
  const frames = 480;
  for (const [mode, unstable] of [
    [4, true],
    [8, false],
  ]) {
    const cosines = Array.from({ length: n }, (_, i) => Math.cos((mode * Math.PI * (i + 0.5)) / n));
    const { world, film } = await patch({
      cells: [n, 1],
      spacing: dx,
      v: [0, 0, 1],
      depth: cosines.map((value) => h + epsilon * value),
      density,
      viscosity,
      surfaceTension,
      suspended: true,
    });
    const eigenvalue = (4 * Math.sin((mode * Math.PI) / (2 * n)) ** 2) / (dx * dx);
    const mobility = h ** 3 / (3 * viscosity);
    const gravity = 1 - dt * mobility * density * world.gravity[1] * eigenvalue;
    const capillary = 1 + dt * mobility * surfaceTension * eigenvalue ** 2;
    const initial = world.takeSnapshot();
    world.advance(frames);
    const amplitude = (film.depths().reduce((sum, value, i) => sum + (value - h) * cosines[i], 0) * 2) / n;
    const bound = (24 * frames * epsilon * epsilon) / h + 32 * frames * Number.EPSILON * h;
    close(amplitude, epsilon * (gravity / capillary) ** frames, bound);
    assert.equal(amplitude > epsilon, unstable);
    close(film.budget.stored, film.budget.initial, 16 * frames * n * Number.EPSILON * film.budget.initial);
    const hash = world.hash();
    world.restoreSnapshot(initial.bytes);
    world.advance(frames);
    assert.equal(world.hash(), hash);
  }
});

test('ThinFilmSolver: a suspended film rejects removal of its restoring surface tension', async () => {
  await assert.rejects(() => patch({ cells: [4, 1], spacing: 0.001, suspended: true, surfaceTension: 0 }), {
    name: 'RangeError',
    code: 'PHYSICS_INPUT_RANGE',
    message: /Use positive surface tension/,
  });
});

test('ThinFilmSolver: rapid suspended growth subdivides at the capillary–gravity rate', async () => {
  const h = 0.0006;
  const density = 970;
  const viscosity = 0.005;
  const surfaceTension = 0.021;
  const { world, film } = await patch({
    cells: [32, 1],
    spacing: 0.0008,
    v: [0, 0, 1],
    depth: h,
    density,
    viscosity,
    surfaceTension,
    suspended: true,
  });
  const growth = (h ** 3 * (density * world.gravity[1]) ** 2) / (12 * viscosity * surfaceTension);
  world.advance(1);
  assert.ok(4 * dt * growth > 1);
  assert.equal(film.budget.substeps, Math.ceil(4 * dt * growth));
  assert.ok(film.depths().every((value) => value === h));
});

test('ThinFilmSolver: a level puddle is a fixed point on an uneven substrate', async () => {
  const dx = 0.05;
  const base = [0.0001, 0.0002, -0.0001, -0.0001, 0.00004, -0.0002];
  const initial = base.map((v) => 0.0005 - v);
  const { world, film } = await patch({ cells: [3, 2], spacing: dx, substrate: base, depth: initial });
  world.advance(120);
  for (const [i, h] of film.depths().entries()) close(h, initial[i], 120 * 8 * Number.EPSILON * initial[i]);
  assert.equal(film.budget.dripped, 0);
});

test('ThinFilmSolver: a vertical one-cell glass patch sends the Nusselt gravity flux into its open bottom', async () => {
  const dx = 0.02;
  const h = 0.0002;
  const density = 998;
  const viscosity = 0.001002;
  const { world, film } = await patch({
    cells: [1, 1],
    spacing: dx,
    depth: h,
    u: [1, 0, 0],
    v: [0, -1, 0],
    drains: [false, false, false, true],
  });
  const expected = (density * -world.gravity[1] * h ** 3 * dx * dt) / (3 * viscosity);
  world.advance(1);
  assert.equal(film.budget.substeps, 1);
  close(film.budget.dripped, expected, 32 * Number.EPSILON * expected);
  close(film.sample(0, 0).dripRate, expected / dt, (32 * Number.EPSILON * expected) / dt);
  close(film.budget.stored + film.budget.dripped, film.budget.initial, 32 * Number.EPSILON * film.budget.initial);
});

test('ThinFilmSolver: drying is limited to available water and wet/dry flow stays positive', async () => {
  const h = 0.00003;
  const spacing = 0.006;
  const { world, film } = await patch({
    cells: [7, 1],
    spacing,
    depth: [0, 0, 0, h, 0, 0, 0],
    rainRate: 0.000003,
    evaporation: 0.00002,
  });
  world.advance(200);
  assert.ok(film.depths().every((value) => value >= 0));
  assert.equal(film.budget.stored, 0);
  const expectedRain = 7 * spacing * spacing * 0.000003 * dt * 200;
  close(film.budget.rain, expectedRain, 200 * 8 * Number.EPSILON * expectedRain);
  close(film.budget.initial + film.budget.rain, film.budget.evaporated, 200 * 8 * Number.EPSILON * expectedRain);
});

test('ThinFilmSolver: contact-line retention distinguishes a pinned bead from a driven runnel', async () => {
  const base = {
    cells: [1, 5],
    spacing: 0.003,
    u: [1, 0, 0],
    v: [0, -1, 0],
    surfaceTension: 0,
    depth: [0, 0.0001, 0, 0, 0],
  };
  const held = await patch({ ...base, pinning: 0.2 });
  const released = await patch({ ...base, pinning: 0 });
  held.world.advance(30);
  released.world.advance(30);
  assert.deepEqual(Array.from(held.film.depths()), base.depth);
  assert.ok(released.film.sample(0, 2).depth > 0);
  close(released.film.budget.stored, held.film.budget.stored, 30 * 5 * Number.EPSILON * held.film.budget.stored);
});
