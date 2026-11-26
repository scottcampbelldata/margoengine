import assert from 'node:assert/strict';
import test from 'node:test';
import { ThinFilmSolver } from '../dist/thin-film.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

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

test('ThinFilmSolver: the surface mesh copies local wet elevations, unit normals and full patch bounds', async () => {
  const spacing = 0.1;
  const cells = [3, 2];
  const origin = [0.2, 0.4, 0.3];
  const depth = [];
  const substrate = [];
  for (let y = 0; y < cells[1]; y++) {
    for (let x = 0; x < cells[0]; x++) {
      const u = (x + 0.5) * spacing;
      const v = (y + 0.5) * spacing;
      depth.push(0.0002 + 0.04 * u + 0.03 * v);
      substrate.push(0.005 + 0.05 * u - 0.02 * v);
    }
  }
  const { film, world } = await patch({ cells, spacing, origin, u: [0, 0, 1], v: [0, -1, 0], depth, substrate });
  const hash = world.hash();
  const surface = film.surfaceGeometry();
  const { positions, normals, uvs, indices } = surface;
  const meshWidth = cells[0] + 2;
  const sample = 2 * meshWidth + 2;
  const sampleHeight = 0.0052 + 0.09 * 0.15 + 0.01 * 0.15;
  const samplePosition = [origin[0] + sampleHeight, 0.25, 0.45].map(Math.fround);
  assert.deepEqual(Array.from(positions.subarray(3 * sample, 3 * sample + 3)), samplePosition);
  const normalLength = Math.hypot(1, 0.01, 0.09);
  for (const [axis, value] of [1, 0.01, -0.09].entries())
    close(normals[3 * sample + axis], value / normalLength, 2 ** -24);
  assert.deepEqual(Array.from(uvs.subarray(2 * sample, 2 * sample + 2)), [0.5, 0.25]);
  assert.equal(positions[1], Math.fround(origin[1]));
  assert.equal(positions[2], Math.fround(origin[2]));
  assert.equal(positions.at(-2), Math.fround(origin[1] - cells[1] * spacing));
  assert.equal(positions.at(-1), Math.fround(origin[2] + cells[0] * spacing));
  assert.equal(indices.length, 6 * (cells[0] + 1) * (cells[1] + 1));
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i],
      b = 3 * indices[i + 1],
      c = 3 * indices[i + 2];
    const determinant =
      (positions[b + 1] - positions[a + 1]) * (positions[c + 2] - positions[a + 2]) -
      (positions[b + 2] - positions[a + 2]) * (positions[c + 1] - positions[a + 1]);
    assert.ok(determinant > 0);
  }
  assert.deepEqual(film.surfaceGeometry(), surface);
  assert.equal(world.hash(), hash);
  const dry = await patch({ cells: [1, 1], spacing });
  assert.equal(dry.film.surfaceGeometry().indices.length, 0);
  const single = await patch({ cells: [1, 1], spacing, depth: 0.0003 });
  const wet = single.film.surfaceGeometry();
  assert.equal(wet.indices.length, 24);
  for (const [axis, value] of [0, 1, 0].entries()) close(wet.normals[axis], value, 0);
});

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

test('ThinFilmSolver: a micrometre strip resolves stiff capillary modes with or without contact-angle hysteresis', async () => {
  const n = 128;
  const spacing = 20e-6;
  const h = 120e-6;
  const amplitude = 1e-10;
  const viscosity = 1.92;
  const surfaceTension = 0.0198;
  const mobility = h ** 3 / (3 * viscosity);
  const modes = [2, 3, 5].map((mode) => {
    const wavenumber = (mode * Math.PI) / n;
    const eigenvalue = 4 * (Math.sin(wavenumber / 2) / spacing) ** 2;
    const shape = Array.from({ length: n }, (_, i) => Math.cos(wavenumber * (i + 0.5)));
    return { shape, damping: 1 / (1 + dt * mobility * surfaceTension * eigenvalue ** 2) };
  });
  const depthAt = (i, evolved) =>
    h + amplitude * modes.reduce((sum, mode) => sum + mode.shape[i] * (evolved ? mode.damping : 1), 0);
  const initial = Array.from({ length: n }, (_, i) => depthAt(i, false));
  // Bound the quadratic mobility correction and the roundoff in the measured depth.
  const tolerance = (64 * amplitude ** 2) / h + 32 * Number.EPSILON * h;
  for (const cells of [
    [n, 1],
    [1, n],
  ]) {
    for (const contact of [
      {},
      { wetting: { precursorDepth: h / 2, contactAngle: 1e-9 }, contactAngleHysteresis: [0, 2e-9] },
    ]) {
      let plain;
      for (const shared of [false, true]) {
        const film = await ThinFilmSolver.load();
        const world = new PhysicsWorld({ rate, gravity: [0, 0, 0], memory: worldMemory(shared) }).add(film, {
          cells,
          spacing,
          depth: initial,
          viscosity,
          surfaceTension,
          // The nonzero interval exercises the contact solve with sub-roundoff wetting pressure.
          ...contact,
        });
        world.advance(1);
        const evolved = film.depths();
        assert.equal(film.budget.substeps, 1);
        for (const [i, depth] of evolved.entries()) close(depth, depthAt(i, true), tolerance);
        close(film.budget.stored, film.budget.initial, 32 * Number.EPSILON * film.budget.initial);
        if (shared) assert.deepEqual(evolved, plain);
        else plain = evolved;
      }
    }
  }
});

test('ThinFilmSolver: a shallow strip retains or slides under a bracket of the Furmidge force', async () => {
  const radius = 0.0018;
  const density = 998;
  const surfaceTension = 0.05;
  const precursorDepth = 24e-6;
  const angle = 0.26;
  const angleLimits = [0.22, 0.3];
  const normalGravity = 9.80665;
  for (const count of [64, 128]) {
    const spacing = (4 * radius) / count;
    const x = (i) => (i + 0.5 - count / 2) * spacing;
    const initial = Array.from({ length: count }, (_, i) => {
      return precursorDepth + 0.5 * angle * radius * Math.max(0, 1 - (x(i) / radius) ** 2);
    });
    async function strip(depth, acceleration, hysteresis) {
      const film = await ThinFilmSolver.load();
      const world = new PhysicsWorld({ rate: { num: 30, den: 1 }, gravity: [acceleration, -normalGravity, 0] }).add(
        film,
        {
          cells: [count, 1],
          spacing,
          depth,
          density,
          viscosity: 0.06,
          surfaceTension,
          wetting: { precursorDepth, contactAngle: angle },
          contactAngleHysteresis: hysteresis ? angleLimits : undefined,
        },
      );
      return { film, world };
    }

    const level = await strip(initial, 0, false);
    level.world.advance(100);
    const depth = level.film.depths();
    const dropArea = depth.reduce((sum, h) => sum + (h - precursorDepth) * spacing, 0);
    const centroid = (values) =>
      values.reduce((sum, h, i) => sum + (h - precursorDepth) * x(i) * spacing, 0) / dropArea;
    // The work of translating a cap per unit width is σ(cos θR − cos θA)
    // times the wet-area fraction at the cap's peak, for a finite precursor.
    const coveredPeak = (1 - precursorDepth / Math.max(...depth)) ** 2;
    const retention = surfaceTension * (Math.cos(angleLimits[0]) - Math.cos(angleLimits[1])) * coveredPeak;
    const releaseAcceleration = retention / (density * dropArea);
    for (const [factor, hysteresis] of [
      [0.8, true],
      [0.8, false],
      [1.4, true],
    ]) {
      const { film, world } = await strip(depth, factor * releaseAcceleration, hysteresis);
      world.advance(90);
      const earlier = centroid(film.depths());
      world.advance(120);
      const later = centroid(film.depths());
      assert.ok(later > 0 && later < radius);
      if (factor < 1 && hysteresis) assert.ok(later - earlier < 0.002 * radius, `late creep: ${later - earlier}`);
      else assert.ok(later - earlier > 0.02 * radius, `late translation: ${later - earlier}`);
      close(film.budget.stored, film.budget.initial, 128 * Number.EPSILON * film.budget.initial);
    }
  }
});

test('ThinFilmSolver: planar pressure damps a product of orthogonal Neumann modes', async () => {
  const cells = [17, 12];
  const spacing = 42e-6;
  const depth = 95e-6;
  const amplitude = 1e-10;
  const viscosity = 0.04;
  const surfaceTension = 0.03;
  const kx = (2 * Math.PI) / cells[0];
  const ky = (3 * Math.PI) / cells[1];
  const shape = Array.from({ length: cells[0] * cells[1] }, (_, i) => {
    const x = i % cells[0];
    const y = Math.floor(i / cells[0]);
    return Math.cos(kx * (x + 0.5)) * Math.cos(ky * (y + 0.5));
  });
  const eigenvalue = 4 * ((Math.sin(kx / 2) / spacing) ** 2 + (Math.sin(ky / 2) / spacing) ** 2);
  const mobility = depth ** 3 / (3 * viscosity);
  const damping = 1 / (1 + dt * mobility * surfaceTension * eigenvalue ** 2);
  const film = await ThinFilmSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(film, {
    cells,
    spacing,
    depth: shape.map((mode) => depth + amplitude * mode),
    viscosity,
    surfaceTension,
  });
  world.advance(1);
  const tolerance = (64 * amplitude ** 2) / depth + 32 * Number.EPSILON * depth;
  for (const [i, value] of film.depths().entries()) close(value, depth + amplitude * damping * shape[i], tolerance);
  close(film.budget.stored, film.budget.initial, 128 * Number.EPSILON * film.budget.initial);
});

function shallowCapDepth({ count, radius, spacing, density, gravity, surfaceTension, volume, precursorDepth }) {
  const x = (i) => (i + 0.5 - count / 2) * spacing;
  // The shallow gravity-capillary profile solves the radial linear Young–Laplace
  // equation. The modified Bessel I0 series supplies its shape before scaling to volume.
  const inverseCapillaryLength = Math.sqrt((density * gravity) / surfaceTension);
  const bessel0 = (value) => {
    let term = 1;
    let sum = 1;
    for (let i = 1; i <= 12; i++) {
      term *= (value * value) / (4 * i * i);
      sum += term;
    }
    return sum;
  };
  const wetEdge = bessel0(inverseCapillaryLength * radius);
  const profile = Array.from({ length: count * count }, (_, i) => {
    const r = Math.hypot(x(i % count), x(Math.floor(i / count)));
    return r < radius ? wetEdge - bessel0(inverseCapillaryLength * r) : 0;
  });
  const scale = volume / (spacing ** 2 * profile.reduce((sum, h) => sum + h, 0));
  return profile.map((h) => precursorDepth + scale * h);
}

test('ThinFilmSolver: a stiff low-viscosity planar cap advances conservatively on an incline', async () => {
  const count = 32;
  const radius = 0.0034;
  const spacing = (3.2 * radius) / count;
  const density = 726;
  const viscosity = 0.000845;
  const surfaceTension = 0.0234;
  const precursorDepth = 20e-6;
  const volume = 10e-9;
  const gravity = 9.80665;
  const tilt = (0.85 * Math.PI) / 180;
  const x = (i) => (i + 0.5 - count / 2) * spacing;
  const depth = shallowCapDepth({ count, radius, spacing, density, gravity, surfaceTension, volume, precursorDepth });
  const setup = async (normal, tangent, values, contactAngleHysteresis) => {
    const film = await ThinFilmSolver.load();
    const world = new PhysicsWorld({ rate, gravity: [tangent, -normal, 0] }).add(film, {
      cells: [count, count],
      spacing,
      depth: values,
      density,
      viscosity,
      surfaceTension,
      wetting: { precursorDepth, contactAngle: 0.368 },
      contactAngleHysteresis,
    });
    return { world, film };
  };
  const level = await setup(gravity, 0, depth);
  level.world.advance(4);
  const initial = level.film.depths();
  const { world, film } = await setup(gravity * Math.cos(tilt), gravity * Math.sin(tilt), initial, [0.363, 0.373]);
  const moment = (values) => values.reduce((sum, h, i) => sum + (h - precursorDepth) * x(i % count), 0);
  world.advance(2);
  const first = moment(film.depths());
  const snapshot = world.takeSnapshot();
  world.advance(4);
  const final = film.depths();
  assert.ok(final.every((h) => h > 0));
  assert.ok(first > moment(initial) && moment(final) > first);
  close(film.budget.stored, film.budget.initial, 128 * Number.EPSILON * film.budget.initial);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(4);
  assert.equal(world.hash(), hash);
});

test('ThinFilmSolver: strongly coupled pressure converges on a water cap over a thin precursor', async () => {
  const density = 998.2;
  const gravity = 9.80665;
  const surfaceTension = 0.072;
  const volume = 20e-9;
  const precursorDepth = 20e-6;
  const radius = 0.0034827349076;
  const angle = (37.5 * Math.PI) / 180;
  for (const [count, tilt, contactAngleHysteresis] of [
    [24, 0, undefined],
    [16, (1.5 * Math.PI) / 180, [36, 39].map((degrees) => (degrees * Math.PI) / 180)],
  ]) {
    const spacing = (3.2 * radius) / count;
    const depth = shallowCapDepth({ count, radius, spacing, density, gravity, surfaceTension, volume, precursorDepth });
    const film = await ThinFilmSolver.load();
    const world = new PhysicsWorld({ rate, gravity: [gravity * Math.sin(tilt), -gravity * Math.cos(tilt), 0] }).add(
      film,
      {
        cells: [count, count],
        spacing,
        depth,
        density,
        viscosity: 0.001002,
        surfaceTension,
        wetting: { precursorDepth, contactAngle: angle },
        contactAngleHysteresis,
      },
    );
    world.advance(2);
    const evolved = film.depths();
    assert.ok(evolved.every((h) => h > 0));
    assert.ok(Math.max(...evolved) < Math.max(...depth));
    close(film.budget.stored, film.budget.initial, 128 * Number.EPSILON * film.budget.initial);
    const center = (values) =>
      values.reduce((sum, h, i) => sum + (h - precursorDepth) * ((i % count) + 0.5 - count / 2), 0) *
      (spacing ** 3 / volume);
    if (tilt) assert.ok(center(evolved) > 0);
    else close(center(evolved), 0, 1e-13);
  }
});

test('ThinFilmSolver: level cap width predicts the independently measured SLIC retention angle', async () => {
  const density = 998.2;
  const gravity = 9.80665;
  const surfaceTension = 0.072;
  const volume = 20e-9;
  const precursorDepth = 20e-6;
  // Radius from the level gravity-capillary profile at the prescribed volume and contact angle.
  const radius = 0.0034827349076;
  const [receding, advancing] = [36, 39].map((degrees) => (degrees * Math.PI) / 180);
  const contactAngle = (receding + advancing) / 2;
  for (const count of [16, 32]) {
    const spacing = (3.2 * radius) / count;
    const depth = shallowCapDepth({ count, radius, spacing, density, gravity, surfaceTension, volume, precursorDepth });
    const film = await ThinFilmSolver.load();
    const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0] }).add(film, {
      cells: [count, count],
      spacing,
      depth,
      density,
      viscosity: 0.001002,
      surfaceTension,
      wetting: { precursorDepth, contactAngle },
    });
    world.advance(8);
    const heights = film.depths();
    let width = 0;
    for (let j = 0; j < count; j++) {
      const cover = heights.subarray(j * count, (j + 1) * count).map((h) => Math.max(0, 1 - precursorDepth / h) ** 2);
      width += spacing * (Math.max(...cover) - Math.min(...cover));
    }
    // Integrate the dipole of cos(contact angle) around a nearly circular footprint.
    const force = (Math.PI / 4) * surfaceTension * width * (Math.cos(receding) - Math.cos(advancing));
    const tiltDegrees = (180 / Math.PI) * Math.asin(force / (density * gravity * volume));
    // Vallabhuneni (2023), Table 4.3, reports the separate 20 μL tilt result to a whole degree.
    assert.equal(Math.round(tiltDegrees), 3, `predicted release tilt: ${tiltDegrees} degrees`);
    close(film.budget.stored, film.budget.initial, 128 * Number.EPSILON * film.budget.initial);
  }
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

test('ThinFilmSolver: a fixed-volume gravity current predicts the measured absolute spreading radius', async () => {
  // Huppert (1982), Table 1(a), run ×. The measured radius fit is the output oracle only.
  const volume = 406e-6;
  const releaseRadius = 0.045;
  const kinematicViscosity = 13.2e-4;
  const gravity = 9.80665;
  const density = 970;
  const times = [120, 240, 480];
  const quadrantWidth = 0.34;
  let coarse;
  for (const [n, secondsPerStep] of [
    [24, 4],
    [48, 2],
  ]) {
    const spacing = quadrantWidth / n;
    const radiusSquared = [];
    const fillFraction = [];
    // Reflecting boundaries on the axes solve one quadrant of the cylindrical release.
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * spacing;
        const v = (y + 0.5) * spacing;
        radiusSquared.push(u * u + v * v);
        let covered = 0;
        for (let j = 0; j < 8; j++) {
          for (let i = 0; i < 8; i++) {
            const us = (x + (i + 0.5) / 8) * spacing;
            const vs = (y + (j + 0.5) / 8) * spacing;
            if (us * us + vs * vs < releaseRadius ** 2) covered++;
          }
        }
        fillFraction.push(covered / 64);
      }
    }
    const fill = volume / (4 * spacing ** 2 * fillFraction.reduce((sum, part) => sum + part, 0));
    const film = await ThinFilmSolver.load();
    const world = new PhysicsWorld({ rate: { num: 1, den: secondsPerStep }, gravity: [0, -gravity, 0] }).add(film, {
      cells: [n, n],
      spacing,
      depth: fillFraction.map((part) => part * fill),
      density,
      viscosity: density * kinematicViscosity,
      surfaceTension: 0,
    });
    const radii = times.map((time) => {
      const frame = time / secondsPerStep;
      world.advance(frame);
      let water = 0;
      let moment = 0;
      for (const [i, h] of film.depths().entries()) {
        water += h;
        moment += radiusSquared[i] * h;
      }
      close(4 * spacing ** 2 * water, volume, 64 * frame * Number.EPSILON * volume);
      // Huppert's late-time profile h ∝ (1 − r²/R²)^(1/3) gives ⟨r²⟩ = 3R²/7.
      const radius = Math.sqrt((7 * moment) / (3 * water));
      const measured = 0.9 * ((gravity * volume ** 3) / (3 * kinematicViscosity)) ** (1 / 8) * time ** 0.12;
      close(radius, measured, 0.05 * measured);
      return radius;
    });
    if (coarse) {
      for (const [i, radius] of radii.entries()) close(radius, coarse[i], spacing);
    } else coarse = radii;
  }
});

test('ThinFilmSolver: a gated incline retains Huppert’s measured cube-root front history', async () => {
  const gravity = 9.80665;
  const incline = (8 * Math.PI) / 180;
  const downslope = gravity * Math.sin(incline);
  const area = 8e-4;
  const kinematicViscosity = 9.8e-4;
  const gate = 0.05;
  const density = 1260;
  const times = [90, 180, 270];
  // Independent movie digitization over equal playback intervals (Huppert 2006, Movie 1).
  const measured = [0.78, 1.06];
  for (const count of [450, 900]) {
    const spacing = 0.9 / count;
    const positions = Array.from({ length: count }, (_, i) => (i + 0.5) * spacing);
    const depth = positions.map((x) => (x < gate ? area / gate + (x - gate / 2) * Math.tan(incline) : 0));
    const film = await ThinFilmSolver.load();
    const world = new PhysicsWorld({ rate: { num: 1, den: 1 }, gravity: [0, -gravity, 0] }).add(film, {
      cells: [1, count],
      spacing,
      depth,
      density,
      viscosity: density * kinematicViscosity,
      surfaceTension: 0,
      u: [1, 0, 0],
      v: [0, -Math.sin(incline), -Math.cos(incline)],
    });
    const cubes = times.map((time) => {
      world.advance(time);
      const heights = film.depths();
      const water = heights.reduce((sum, h) => sum + h, 0);
      const moment = heights.reduce((sum, h, i) => sum + h * positions[i], 0);
      // Huppert's late-time profile h ∝ sqrt(x) has a centroid at 3/5 of the nose distance.
      const nose = (5 * moment) / (3 * water);
      const expected = Math.cbrt((9 * area ** 2 * downslope * time) / (4 * kinematicViscosity));
      close(spacing * water, area, 64 * time * Number.EPSILON * area);
      close(nose, expected, 0.05 * expected);
      return nose ** 3;
    });
    const ratio = (cubes[2] - cubes[1]) / (cubes[1] - cubes[0]);
    assert.ok(ratio >= measured[0] && ratio <= measured[1], `n=${count}, cube increment ratio ${ratio}`);
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
