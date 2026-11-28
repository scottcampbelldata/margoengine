// GPULiquid (@margoengine/water/liquid) on the CPU twin, which runs the GPU's passes and fixed-point sums: free fall in
// closed form, the walls and colliders read as liquid at rest, a floor collider's force against the momentum balance,
// determinism and snapshots, collider distances, coded errors. The GPU itself: gpu-liquid-check.mjs (WebGPU and
// --compat).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPULiquid,
  LIQUID_PARTICLE_FLOATS as F,
  bakeLiquidMesh,
  colliderDistance,
  createLiquidState,
  liquidStateHash,
  resolveLiquidParams,
  stepLiquidCPU,
  wallFrictionVelocity,
} from '../dist/liquid.js';

const FIXED = 65536;
const FORCE_FIXED = 1024;

test('smooth walls: the wall function solves the sublayer and the log law, and a sliding layer slows by its shear', () => {
  // Launder and Spalding's (1974) laws, u = u*^2 y / nu below y+ = 11.225 and u / u* = ln(9.793 y u* / nu) / 0.4187 above
  // it, at the node's sampling depths 13/32 and 0.2751 of a cell; the larger u* holds.
  const kappa = 0.4187,
    E = 9.793,
    yl = 13 / 32,
    yg = Math.exp((9 / 8) * Math.log(3) - Math.log(2) - 11 / 6);
  for (const [u, h, nu] of [
    [1e-4, 0.01, 1e-6],
    [0.05, 0.02, 1e-6],
    [1, 0.02, 1e-6],
    [30, 0.1, 1e-6],
    [1e3, 1, 1e-6],
    [1, 0.02, 5e-4],
  ]) {
    const us = wallFrictionVelocity(u, h, nu);
    const lam = Math.sqrt((u * nu) / (yl * h));
    const ypl = (yg * h * us) / nu;
    const logResidual = Math.abs(u / us - Math.log(E * ypl) / kappa) / (u / us);
    assert.ok(us >= lam * (1 - 1e-12), `u* ${us} under the sublayer's ${lam}`);
    assert.ok(us === lam || logResidual < 1e-9, `u = ${u}: log law residual ${logResidual}`);
    assert.ok(us > 0 && Number.isFinite(us));
  }
  assert.equal(wallFrictionVelocity(0, 0.02, 1e-6), 0);
  // A layer d deep sliding at U along a smooth floor, no gravity, free-slip ends: its mean speed obeys dU/dt = -u*(U)^2 / d
  // (the shear over the floor's area, over the layer's mass per area). The grid wets the floor up to 1.5 cells past each
  // free end of the slab (L = 32 cells), so its friction is at most (1 + 3 h / L) of the closed form; over 12 substeps
  // the layer stays a plug, so the node on the floor reads U within the slowing itself, which moves u*^2 by under
  // 2 dU / U. The fast profile carries the balance exactly; the accurate profile's projection moves momentum where a free
  // surface's cells have massless corners, so its slab is not a clean balance (both run the same wall function).
  const h = 0.02;
  for (const [profile, cells] of [
    ['fast', 1],
    ['fast', 4],
  ]) {
    const d = cells * h;
    const p = resolveLiquidParams({
      count: 8 * 32 * cells * 4,
      box: { min: [0, 0, 0], max: [64 * h, 16 * h, 4 * h] },
      fill: { min: [8 * h, 0, 0], max: [40 * h, d, 4 * h] },
      resolution: 64,
      viscosity: 1e-6,
      gravity: [0, 0, 0],
      walls: ['slip', 'smooth', 'slip'],
      profile,
    });
    const s = createLiquidState(p);
    for (let i = 0; i < s.live; i++) s.particles[i * F + 4] = 1;
    for (let k = 0; k < 12; k++) stepLiquidCPU(s, p, 1 / 240);
    let mean = 0;
    for (let i = 0; i < s.live; i++) mean += s.particles[i * F + 4] / s.live;
    let U = 1;
    const n = 20000,
      dt = 0.05 / n;
    const f = (u) => -(wallFrictionVelocity(u, h, 1e-6) ** 2) / d;
    for (let k = 0; k < n; k++) {
      const a = f(U),
        b = f(U + (dt * a) / 2),
        c = f(U + (dt * b) / 2),
        e = f(U + dt * c);
      U += (dt * (a + 2 * b + 2 * c + e)) / 6;
    }
    const lost = 1 - mean,
      closed = 1 - U;
    assert.ok(
      lost >= closed * (1 - 2 * closed) && lost <= closed * (1 + 3 / 32),
      `${profile}, ${cells} cells deep: slowed by ${lost.toFixed(5)} m/s against ${closed.toFixed(5)} closed form`,
    );
  }
  // Free slip keeps the layer's speed; bad walls are refused with a coded error.
  const p = resolveLiquidParams({
    count: 1024,
    box: { min: [0, 0, 0], max: [1.28, 0.32, 0.08] },
    fill: { min: [0.16, 0, 0], max: [0.8, 0.04, 0.08] },
    resolution: 64,
    viscosity: 1e-6,
    gravity: [0, 0, 0],
    walls: 'slip',
  });
  const s = createLiquidState(p);
  for (let i = 0; i < s.live; i++) s.particles[i * F + 4] = 1;
  for (let k = 0; k < 12; k++) stepLiquidCPU(s, p, 1 / 240);
  let mean = 0;
  for (let i = 0; i < s.live; i++) mean += s.particles[i * F + 4] / s.live;
  assert.ok(Math.abs(mean - 1) < 1e-3, `free slip: ${mean} m/s`);
  assert.deepEqual(resolveLiquidParams({}).walls, [true, true, true]);
  assert.deepEqual(resolveLiquidParams({ walls: ['slip', 'smooth', 'slip'] }).walls, [false, true, false]);
  for (const walls of ['rough', ['smooth'], 1])
    assert.throws(() => resolveLiquidParams({ walls }), { code: 'unsupported' });
});

test('a lone particle falls in the closed form of its substeps: v_n = n g h, y_n = y_0 + g h^2 n (n + 1) / 2', () => {
  // One particle has less than rest density, so no pressure, and APIC carries a uniform velocity exactly; only the
  // fixed-point sums round: per substep at most 27 nodes * 0.5 / 65,536 of momentum and of mass, so |dv| <= 27 * 0.5 *
  // (1 + |v|) / 65,536 a substep.
  const p = resolveLiquidParams({ count: 1, fill: { min: [-0.01, 0.89, -0.01], max: [0.01, 0.91, 0.01] } });
  const s = createLiquidState(p);
  const y0 = s.particles[1];
  const h = p.maxSubstep;
  const g = -9.81;
  let bound = 0;
  for (let n = 1; n <= 40; n++) {
    assert.equal(stepLiquidCPU(s, p, h), 1);
    bound += (27 * 0.5 * (1 + Math.abs(g * h * n))) / FIXED;
    assert.ok(Math.abs(s.particles[5] - n * g * h) <= bound, `v after ${n}: ${s.particles[5]} vs ${n * g * h}`);
    assert.ok(Math.abs(s.particles[1] - (y0 + (g * h * h * n * (n + 1)) / 2)) <= bound * h * n, `y after ${n}`);
    assert.ok(Math.abs(s.particles[4]) <= bound && Math.abs(s.particles[6]) <= bound, 'no sideways drift');
  }
});

test('walls and colliders read as liquid at rest: a resting block has its rest density against them (regression)', () => {
  // Without the wall mirrors the particles against the floor read 0.73 of rest density and the block sank by a quarter;
  // without the collider cover the particles on a collider read about 0.6 and pushed on it with half the pressure.
  const box = { min: [-0.25, 0, -0.25], max: [0.25, 1, 0.25] };
  const fill = { min: [-0.25, 0.2, -0.25], max: [0.25, 0.5, 0.25] };
  const floor = { shape: 'box', position: [0, 0.1, 0], halfExtents: [0.4, 0.1, 0.4] };
  const plane = { shape: 'plane', position: [0, 0.2, 0], normal: [0, 2, 0] };
  for (const [colliders, from] of [
    [[], 0.2],
    [[floor], 0.2],
    [[plane], 0.2],
  ]) {
    const p = resolveLiquidParams({
      count: 3000,
      box,
      fill: colliders.length ? fill : { ...fill, min: [-0.25, 0, -0.25] },
      gravity: [0, 0, 0],
      colliders,
    });
    const s = createLiquidState(p);
    stepLiquidCPU(s, p, p.maxSubstep);
    const edge = colliders.length ? from : 0;
    let sum = 0,
      n = 0,
      wall = 0,
      wn = 0;
    for (let i = 0; i < p.count; i++) {
      const b = i * F;
      const [x, y, z] = [s.particles[b], s.particles[b + 1], s.particles[b + 2]];
      if (y > (colliders.length ? 0.5 : 0.3) - p.cell[1]) continue;
      if (y < edge + p.cell[1]) {
        sum += s.particles[b + 3];
        n++;
      }
      if (Math.abs(Math.abs(x) - 0.25) < p.cell[0] || Math.abs(Math.abs(z) - 0.25) < p.cell[2]) {
        wall += s.particles[b + 3];
        wn++;
      }
    }
    // The jittered lattice moves a particle by a quarter spacing, which moves the interpolated density by about 2%.
    assert.ok(Math.abs(sum / n - 1) < 0.03, `${colliders.length ? 'collider' : 'floor'} layer density ${sum / n}`);
    assert.ok(Math.abs(wall / wn - 1) < 0.03, `side wall density ${wall / wn}`);
  }
});

test("a floor collider's force balances the column's weight and momentum change, impulse for impulse", () => {
  // The liquid touches nothing but the collider vertically (the side walls are free slip), so over any window the
  // body's impulse is -(dP + M g T): APIC transfers keep momentum, the stress sums to zero, and only the fixed-point
  // sums round (bounded below per substep).
  const box = { min: [-0.2, 0, -0.2], max: [0.2, 0.8, 0.2] };
  const p = resolveLiquidParams({
    count: 2000,
    box,
    fill: { min: [-0.2, 0.1, -0.2], max: [0.2, 0.4, 0.2] },
    colliders: [{ shape: 'box', position: [0, 0.05, 0], halfExtents: [0.3, 0.05, 0.3] }],
  });
  const s = createLiquidState(p);
  const momentum = () => {
    let m = 0;
    for (let i = 0; i < p.count; i++) m += s.particles[i * F + 5];
    return m;
  };
  for (let k = 0; k < 20; k++) stepLiquidCPU(s, p, 1 / 60);
  const p0 = momentum();
  let impulse = 0,
    time = 0,
    substeps = 0;
  for (let k = 0; k < 30; k++) {
    const n = stepLiquidCPU(s, p, 1 / 60);
    substeps += n;
    time += 1 / 60;
    impulse += s.impulses[1] / FORCE_FIXED;
  }
  // The liquid's momentum changes by gravity's impulse plus the body's push on it, and the body takes the opposite.
  const expected = -(momentum() - p0) + p.count * -9.81 * time;
  // Rounding: each fixed-point term is off by a uniform error of at most half a unit (standard deviation 0.29 units),
  // independently: three momentum components of 27 terms a particle in two passes at 1 / 65,536, and up to six impulse
  // terms per node and per particle at 1 / 1,024, every substep. Six standard deviations of their sum:
  const momentumTerms = substeps * 3 * 27 * 2 * p.count;
  const impulseTerms = substeps * (p.nodes + p.count);
  const bound = 6 * 0.29 * (Math.sqrt(momentumTerms) / FIXED + Math.sqrt(impulseTerms) / FORCE_FIXED);
  assert.ok(Math.abs(impulse - expected) <= bound, `impulse ${impulse} vs ${expected} (bound ${bound})`);
  // And it carries the column: the mean force is the weight within the momentum the column still has.
  const weight = p.count * p.particleMass * 9.81;
  const force = (impulse * p.particleMass) / time;
  assert.ok(force < 0, 'the liquid presses the floor down');
  assert.ok(Math.abs(-force - weight) <= (Math.abs(momentum() - p0) * p.particleMass) / time + 0.01 * weight);
});

test('surface tension rounds a cube of liquid into a drop with the Laplace pressure 2 sigma / R inside', () => {
  // Without gravity a 0.2 m cube of liquid (4,096 particles, 8 a cell of 0.025 m) with sigma = 10 N/m pulls into a ball
  // of the same volume, R = 0.2 (3 / (4 pi))^(1/3) = 0.124 m. The surface force (on the grid, from the gradient of the
  // density) smears the surface over about a cell, so the curvature it sees lies between that of balls a cell smaller and larger: the mean pressure inside (from the
  // particles' density by the Tait equation, averaged over the second half second while the drop still rings) lies
  // between 2 sigma / (R + h) and 2 sigma / (R - h). Without the surface force it is zero and the cube keeps its
  // corners.
  const sigma = 10;
  const p = resolveLiquidParams({
    count: 4096,
    box: { min: [-0.2, -0.2, -0.2], max: [0.2, 0.2, 0.2] },
    fill: { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] },
    gravity: [0, 0, 0],
    speedOfSound: 2,
    resolution: 16,
    viscosity: 0.002,
    surfaceTension: sigma,
  });
  const s = createLiquidState(p);
  const R = 0.2 * Math.cbrt(3 / (4 * Math.PI));
  const h = p.cellSize;
  let pressure = 0,
    frames = 0,
    corner = 0;
  for (let f = 0; f < 60; f++) {
    stepLiquidCPU(s, p, 1 / 60);
    if (f < 30) continue;
    let sum = 0,
      n = 0;
    corner = 0;
    for (let i = 0; i < p.count; i++) {
      const b = i * F;
      const d = Math.hypot(s.particles[b], s.particles[b + 1], s.particles[b + 2]);
      corner = Math.max(corner, d);
      if (d > R / 2) continue;
      const r = Math.min(s.particles[b + 3], 3);
      sum += r > 1 ? ((p.density * p.speedOfSound ** 2) / 7) * (r ** 7 - 1) : 0;
      n++;
    }
    pressure += sum / n;
    frames++;
  }
  pressure /= frames;
  assert.ok(
    pressure >= (2 * sigma) / (R + h) && pressure <= (2 * sigma) / (R - h),
    `pressure ${pressure} Pa against 2 sigma / R = ${(2 * sigma) / R} Pa`,
  );
  // The cube's corners (0.173 m out) are pulled in to the ball's radius within a cell.
  assert.ok(corner < R + h, `farthest particle ${corner} m against R ${R} m`);
});

test('adhesion above gravity holds a film on the ceiling, and below gravity lets it fall', () => {
  // Liquid within one cell of a wall takes the full adhesion, so a film thinner than a cell hangs exactly when the
  // adhesion beats gravity (the walls hold it from moving into them).
  for (const [adhesion, held] of [
    [0.5 * 9.81, false],
    [1.5 * 9.81, true],
  ]) {
    const p = resolveLiquidParams({
      count: 1600,
      box: { min: [-0.2, 0, -0.2], max: [0.2, 0.2, 0.2] },
      fill: { min: [-0.1, 0.19, -0.1], max: [0.1, 0.2, 0.1] },
      resolution: 32,
      adhesion,
    });
    const s = createLiquidState(p);
    for (let f = 0; f < 30; f++) stepLiquidCPU(s, p, 1 / 60);
    let top = 0;
    for (let i = 0; i < p.count; i++) if (s.particles[i * F + 1] > 0.2 - 2 * p.cellSize) top++;
    assert.equal(top, held ? p.count : 0, `adhesion ${adhesion}: ${top} of ${p.count} still on the ceiling`);
  }
  assert.throws(() => resolveLiquidParams({ adhesion: -1 }), { code: 'unsupported' });
  assert.throws(() => resolveLiquidParams({ surfaceTension: 1e6 }), /surfaceTension/);
});

test('two liquids: the floor carries both weights, the heavier sinks through the lighter, colours mix only when asked', () => {
  // A layer of 3000 kg/m3 liquid starts on top of a layer of 1000 kg/m3 in a free-slip column on a floor collider. The
  // body takes the opposite of the liquid's change of momentum, so over a window its impulse is -(dP + M g T) with M the
  // sum of both liquids' masses (each particle weighs its liquid's mass ratio), within the fixed-point rounding.
  const box = { min: [-0.15, 0, -0.15], max: [0.15, 0.9, 0.15] };
  const options = {
    count: 1600,
    box,
    liquids: [
      { fill: { min: [-0.15, 0.1, -0.15], max: [0.15, 0.3, 0.15] }, color: [0, 0, 1] },
      { fill: { min: [-0.15, 0.3, -0.15], max: [0.15, 0.5, 0.15] }, density: 3000, color: [1, 0, 0] },
    ],
    colliders: [{ shape: 'box', position: [0, 0.05, 0], halfExtents: [0.3, 0.05, 0.3] }],
    walls: 'slip',
  };
  const p = resolveLiquidParams(options);
  assert.deepEqual(
    p.kinds.map((k) => [k.count, k.massRatio]),
    [
      [800, 1],
      [800, 3],
    ],
  );
  const s = createLiquidState(p);
  const mass = (i) => p.kinds[s.particles[i * F + 7]].massRatio;
  const momentum = () => {
    let m = 0;
    for (let i = 0; i < p.count; i++) m += mass(i) * s.particles[i * F + 5];
    return m;
  };
  for (let k = 0; k < 10; k++) stepLiquidCPU(s, p, 1 / 60);
  const p0 = momentum();
  let impulse = 0,
    time = 0,
    substeps = 0;
  for (let k = 0; k < 20; k++) {
    substeps += stepLiquidCPU(s, p, 1 / 60);
    time += 1 / 60;
    impulse += s.impulses[1] / FORCE_FIXED;
  }
  const M = 800 + 3 * 800;
  const expected = -(momentum() - p0) + M * -9.81 * time;
  // As in the one-liquid test, six standard deviations of the rounding, the heavy particles' terms three times larger.
  const bound =
    6 *
    0.29 *
    ((3 * Math.sqrt(substeps * 3 * 27 * 2 * p.count)) / FIXED +
      Math.sqrt(substeps * (p.nodes + p.count)) / FORCE_FIXED);
  assert.ok(Math.abs(impulse - expected) <= bound, `impulse ${impulse} vs ${expected} (bound ${bound})`);
  // The heavy layer has sunk below the light one by 1.5 s (Rayleigh-Taylor).
  for (let k = 0; k < 60; k++) stepLiquidCPU(s, p, 1 / 60);
  const mean = (kind) => {
    let y = 0,
      n = 0;
    for (let i = 0; i < p.count; i++) if (s.particles[i * F + 7] === kind) (y += s.particles[i * F + 1]), n++;
    return y / n;
  };
  assert.ok(mean(1) < mean(0), `heavy liquid at ${mean(1)} m, light at ${mean(0)} m`);
  // Without mixing every particle keeps its liquid's colour exactly; with it, colours blend where the liquids meet.
  for (let i = 0; i < p.count; i++)
    assert.deepEqual([...s.particles.subarray(i * F + 17, i * F + 20)], s.particles[i * F + 7] ? [1, 0, 0] : [0, 0, 1]);
  const pm = resolveLiquidParams({ ...options, colliders: [], mixing: 20 });
  const sm = createLiquidState(pm);
  for (let k = 0; k < 20; k++) stepLiquidCPU(sm, pm, 1 / 60);
  let blended = 0,
    worst = 0;
  for (let i = 0; i < pm.count; i++) {
    const r = sm.particles[i * F + 17],
      b = sm.particles[i * F + 19];
    worst = Math.max(worst, Math.abs(r + b - 1), -r, -b, r - 1, b - 1);
    if (r > 0.05 && b > 0.05) blended++;
  }
  // A blend of red and blue stays on the line between them, within the colour sums' rounding: each relaxation moves a
  // colour part of the way to a weighted mean whose channels are each off by at most 27 half-units of 1 / 65,536 over a
  // weight sum of at least 1 (a lone particle's own), and the relaxation is a contraction, so the two channels' sum is
  // off by at most twice that, 4.2e-4, however many substeps.
  assert.ok(worst <= (2 * 27 * 0.5) / 65536, `off the red-blue line by ${worst}`);
  assert.ok(blended > 50, `${blended} particles blended at the interface`);
  for (const bad of [
    { liquids: [] },
    { liquids: Array.from({ length: 5 }, () => ({})) },
    { liquids: [{}, {}] },
    {
      liquids: [
        { fill: { min: [-0.5, 0, -0.5], max: [0, 0.5, 0.5] } },
        { fill: { min: [-0.1, 0, -0.5], max: [0.5, 0.5, 0.5] } },
      ],
    },
    { liquids: [{ color: [2, 0, 0] }] },
    { liquids: [{ density: 0 }] },
    { mixing: -1 },
  ])
    assert.throws(
      () => resolveLiquidParams(bad),
      (e) => e.code === 'unsupported' && /errors#gpu-liquid/.test(e.message),
      JSON.stringify(bad),
    );
});

test('emitters add exactly rate * time particles at rest density, drains remove what enters them in order', () => {
  // A jet pouring down at 1 m/s from a nozzle of radius 0.05 m: its default rate is the flow at rest density, pi r^2 v /
  // V0 particles a second, and every frame adds the whole part of what it owes, so after T seconds it has added
  // floor(rate T) (to rounding of the owed fraction) while there is room.
  const base = {
    count: 500,
    capacity: 4000,
    box: { min: [-0.3, 0, -0.3], max: [0.3, 0.8, 0.3] },
    fill: { min: [-0.3, 0, -0.3], max: [0.3, 0.05, 0.3] },
    emitters: [{ position: [0, 0.6, 0], velocity: [0, -1, 0], radius: 0.05 }],
  };
  const p = resolveLiquidParams(base);
  const V0 = p.lattice[0] * p.lattice[1] * p.lattice[2];
  const rate = p.emitters[0].rate;
  assert.ok(Math.abs(rate - (Math.PI * 0.05 ** 2 * 1) / V0) < 1e-9 * rate);
  const s = createLiquidState(p);
  for (let k = 0; k < 30; k++) stepLiquidCPU(s, p, 1 / 60);
  assert.equal(
    s.live - p.count,
    Math.floor(rate * 0.5 + 1e-6),
    `added ${s.live - p.count} against rate * T = ${rate * 0.5}`,
  );
  assert.equal(s.emission[0], s.live - p.count);
  for (let i = 0; i < s.live; i++) assert.ok(Number.isFinite(s.particles[i * F + 1]) && s.particles[i * F + 3] >= 0);
  for (let i = s.live; i < p.capacity; i++)
    assert.ok(Number.isNaN(s.particles[i * F]), 'slots past the live count are empty');
  // At capacity the emitter stops adding.
  const full = resolveLiquidParams({ ...base, capacity: 600 });
  const sf = createLiquidState(full);
  for (let k = 0; k < 30; k++) stepLiquidCPU(sf, full, 1 / 60);
  assert.equal(sf.live, 600);
  // A drain on the floor takes every particle that enters it and keeps the rest in their order.
  const pd = resolveLiquidParams({
    ...base,
    emitters: [],
    drains: [{ shape: 'box', position: [0, 0, 0], halfExtents: [0.1, 0.2, 0.1] }],
  });
  const sd = createLiquidState(pd);
  // Tag each particle with its index in its colour (colours ride along unchanged without mixing).
  for (let i = 0; i < sd.live; i++) sd.particles[i * F + 17] = i / sd.live;
  stepLiquidCPU(sd, pd, 1 / 60);
  assert.ok(sd.live < pd.count, `the drain took ${pd.count - sd.live} particles`);
  for (let i = 0; i < sd.live; i++) {
    const b = i * F;
    assert.ok(
      !(Math.abs(sd.particles[b]) < 0.1 && sd.particles[b + 1] < 0.2 && Math.abs(sd.particles[b + 2]) < 0.1),
      'no live particle in the drain',
    );
    if (i) assert.ok(sd.particles[b + 17] > sd.particles[b + 17 - F], 'the survivors keep their order');
  }
  // Emitters and drains together repeat bit for bit, also from a copied state.
  const both = { ...base, drains: [{ shape: 'sphere', position: [0.2, 0.02, 0.2], radius: 0.08 }], seed: 2 };
  const run = (frames, from) => {
    const q = resolveLiquidParams(both);
    const st = from ?? createLiquidState(q);
    for (let k = 0; k < frames; k++) stepLiquidCPU(st, q, 1 / 60);
    return st;
  };
  const whole = run(20);
  const half = run(10);
  const copy = { ...half, particles: half.particles.slice(), emission: half.emission.slice(), grid: half.grid.slice() };
  assert.equal(liquidStateHash(run(10, copy).particles), liquidStateHash(whole.particles));
  for (const bad of [
    { capacity: 10, count: 20 },
    { emitters: Array.from({ length: 5 }, () => ({ position: [0, 0.5, 0] })) },
    { emitters: [{ position: [0, 2, 0] }] },
    { emitters: [{ position: [0, 0.5, 0], liquid: 1 }] },
    { emitters: [{ position: [0, 0.5, 0], rate: -1 }] },
    { drains: [{ shape: 'cone', position: [0, 0, 0] }] },
    { drains: [{ shape: 'sphere', position: [0, 0, 0], radius: 0 }] },
  ])
    assert.throws(
      () => resolveLiquidParams(bad),
      (e) => e.code === 'unsupported' && /errors#gpu-liquid/.test(e.message),
      JSON.stringify(bad),
    );
});

test('the same options give the same state, and a copied state repeats the same steps', () => {
  const options = { count: 600, seed: 9, colliders: [{ shape: 'sphere', position: [0, 0.2, 0], radius: 0.1 }] };
  const run = (frames) => {
    const p = resolveLiquidParams(options);
    const s = createLiquidState(p);
    for (let k = 0; k < frames; k++) stepLiquidCPU(s, p, 1 / 60);
    return { p, s };
  };
  const a = run(20);
  const b = run(20);
  assert.equal(liquidStateHash(a.s.particles), liquidStateHash(b.s.particles));
  const half = run(10);
  const copy = { ...createLiquidState(half.p), particles: half.s.particles.slice() };
  for (let k = 0; k < 10; k++) stepLiquidCPU(copy, half.p, 1 / 60);
  assert.equal(liquidStateHash(copy.particles), liquidStateHash(a.s.particles));
  assert.notEqual(
    liquidStateHash(createLiquidState(resolveLiquidParams({ ...options, seed: 10 })).particles),
    liquidStateHash(createLiquidState(half.p).particles),
  );
});

test('GPULiquid.restore checks the whole snapshot before it changes anything', () => {
  const liquid = new GPULiquid({ count: 8 });
  const good = createLiquidState(resolveLiquidParams({ count: 8 })).particles;
  const bad = (particles, extra = {}) => ({
    count: 8,
    live: 8,
    steps: 0,
    emission: new Float64Array(8),
    particles,
    ...extra,
  });
  assert.throws(() => liquid.restore(bad(good, { count: 9 })), { code: 'unsupported' });
  assert.throws(() => liquid.restore(bad(good.subarray(0, 8 * F - 1))), { code: 'unsupported' });
  assert.throws(() => liquid.restore(bad(good, { steps: -1 })), { code: 'unsupported' });
  assert.throws(() => liquid.restore(bad(good, { live: 9 })), { code: 'unsupported' });
  assert.throws(() => liquid.restore(bad(good, { emission: new Float64Array(8).fill(-1) })), { code: 'unsupported' });
  const nan = good.slice();
  nan[8 * F - 1] = NaN;
  assert.throws(() => liquid.restore(bad(nan)), /not finite/);
  const out = good.slice();
  out[7 * F + 1] = 2;
  assert.throws(() => liquid.restore(bad(out)), /outside the container/);
  const kind = good.slice();
  kind[3 * F + 7] = 1;
  assert.throws(() => liquid.restore(bad(kind)), /names liquid 1/);
  liquid.restore(bad(good, { steps: 4 }));
  assert.equal(liquid.stats.steps, 4);
  liquid.dispose();
  assert.throws(() => liquid.restore(bad(good)), { code: 'disposed' });
});

test('collider distances: a sphere and a turned box in closed form', () => {
  const n = [0, 0, 0];
  const sphere = { kind: 0, position: [1, 0, 0], half: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1] };
  assert.equal(colliderDistance(sphere, [1, 2, 0], n), 1.5);
  assert.deepEqual(n, [0, 1, 0]);
  // A 2 x 0.5 x 1 box turned a quarter about y: its long axis lies along z.
  const q = Math.SQRT1_2;
  const box = { kind: 1, position: [0, 0, 0], half: [1, 0.25, 0.5], rotation: [0, q, 0, q] };
  assert.ok(Math.abs(colliderDistance(box, [0, 0, 1.5], n) - 0.5) < 1e-12);
  assert.ok(Math.abs(n[2] - 1) < 1e-12);
  assert.ok(Math.abs(colliderDistance(box, [0.75, 0, 0], n) - 0.25) < 1e-12);
  assert.ok(
    Math.abs(colliderDistance(box, [0, 0.1, 0], n) + 0.15) < 1e-12,
    'inside: minus the distance to the nearest face',
  );
  assert.ok(Math.abs(n[1] - 1) < 1e-12);
});

test('capsule, plane and mesh distances in closed form', () => {
  const n = [0, 0, 0];
  // A capsule of radius 0.2 round the segment y in [-0.5, 0.5], turned a quarter about z so its axis lies along -x.
  const q = Math.SQRT1_2;
  const capsule = { kind: 2, position: [1, 0, 0], half: [0.2, 0.5, 0], rotation: [0, 0, q, q] };
  assert.ok(Math.abs(colliderDistance(capsule, [1.2, 1, 0], n) - 0.8) < 1e-12, 'side of the segment');
  assert.ok(Math.abs(n[1] - 1) < 1e-12);
  assert.ok(Math.abs(colliderDistance(capsule, [2.5, 0, 0], n) - 0.8) < 1e-12, 'past the end cap');
  assert.ok(Math.abs(n[0] - 1) < 1e-12);
  assert.ok(Math.abs(colliderDistance(capsule, [1, 0.05, 0], n) + 0.15) < 1e-12, 'inside');
  const plane = { kind: 3, position: [0, 1, 0], half: [0, 0.6, 0.8], rotation: [0, 0, 0, 1] };
  assert.ok(Math.abs(colliderDistance(plane, [5, 1, 1], n) - 0.8) < 1e-12);
  assert.deepEqual(n, [0, 0.6, 0.8]);
  // A unit cube baked at 33 samples: in each face's region the exact distance is linear, so the trilinear field is exact
  // there; elsewhere the field is off by at most a sample spacing (the distance is 1-Lipschitz).
  const v = [];
  for (let i = 0; i < 8; i++) v.push(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5);
  // The cube's faces, two triangles each, wound inward (either winding bakes the same field).
  const faces = [
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 1, 3, 2],
    [4, 6, 7, 5],
  ];
  const indices = faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const mesh = bakeLiquidMesh(v, indices, { resolution: 33, margin: 0.25 });
  const spacing = (2 * mesh.half[0]) / 32;
  const cube = { kind: 4, position: [0, 2, 0], half: mesh.half, rotation: [0, 0, 0, 1], mesh };
  assert.ok(Math.abs(colliderDistance(cube, [0.6, 2.05, 0.02], n) - 0.1) < 1e-6, 'outside a face');
  assert.ok(Math.abs(n[0] - 1) < 1e-6);
  assert.ok(Math.abs(colliderDistance(cube, [0.45, 2.02, -0.03], n) + 0.05) < 1e-6, 'inside near a face');
  assert.ok(Math.abs(colliderDistance(cube, [0, 2, 0], n) + 0.5) <= spacing, 'the centre');
  assert.ok(Math.abs(colliderDistance(cube, [2, 2, 0], n) - 1.5) < 1e-6, 'outside the field: field plus box distance');
  // A soup of the same triangles without indices bakes the same field.
  const soup = indices.flatMap((i) => v.slice(i * 3, i * 3 + 3));
  assert.deepEqual(
    bakeLiquidMesh(soup, null, { resolution: 9 }).distances,
    bakeLiquidMesh(v, indices, { resolution: 9 }).distances,
  );
  const outward = faces.flatMap(([a, b, c, d]) => [a, c, b, a, d, c]);
  assert.deepEqual(
    bakeLiquidMesh(v, outward, { resolution: 9 }).distances,
    bakeLiquidMesh(v, indices, { resolution: 9 }).distances,
  );
  for (const bad of [
    () => bakeLiquidMesh([0, 0, 0, 1, 0], null),
    () => bakeLiquidMesh(v, [0, 1, 99]),
    () => bakeLiquidMesh(v, indices, { resolution: 65 }),
    () => bakeLiquidMesh([0, 0, 0, 0, 0, 0, 0, 0, 0], null),
    () =>
      bakeLiquidMesh(
        v,
        Array.from({ length: 3 * 40000 }, (_, i) => i % 8),
        { resolution: 64 },
      ),
    () => resolveLiquidParams({ colliders: [{ shape: 'mesh', position: [0, 0, 0] }] }),
    () =>
      resolveLiquidParams({ colliders: [{ shape: 'mesh', position: [0, 0, 0], mesh: { ...mesh, resolution: 5 } }] }),
    () => resolveLiquidParams({ colliders: [{ shape: 'plane', position: [0, 0, 0], normal: [0, 0, 0] }] }),
    () => resolveLiquidParams({ colliders: [{ shape: 'capsule', position: [0, 0, 0], halfHeight: -1 }] }),
  ])
    assert.throws(bad, (e) => e.name === 'MargoError' && /errors#gpu-liquid/.test(e.message));
});

test('GPULiquid.link takes a body with a pose and impulses, counts toward the 8 colliders, and unlinks', () => {
  const body = () => ({
    position: [0, 0.5, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    applyImpulse() {},
    applyTorqueImpulse() {},
  });
  const liquid = new GPULiquid({
    count: 8,
    colliders: Array.from({ length: 7 }, () => ({ shape: 'sphere', position: [0, 0, 0] })),
  });
  const a = body();
  const link = liquid.link(a, { shape: 'box', halfExtents: [0.1, 0.1, 0.1] });
  assert.equal(link.body, a);
  assert.throws(() => liquid.link(body(), { shape: 'sphere' }), /at most 8/);
  assert.throws(() => liquid.link(a, { shape: 'sphere' }), /linked already/);
  assert.throws(() => liquid.link({ ...body(), applyImpulse: undefined }, { shape: 'sphere' }), {
    code: 'unsupported',
  });
  assert.throws(() => liquid.link({ ...body(), rotation: undefined }, { shape: 'sphere' }), { code: 'unsupported' });
  link.unlink();
  liquid.link(body(), { shape: 'capsule', radius: 0.05 });
  // The debug view draws every shape: a capsule's two cap rings (3 x 32 lines each) and 4 side lines, a plane's square
  // and normal (5 lines), a box's 12 edges.
  const lines = (colliders) =>
    new GPULiquid({ count: 8, colliders, debug: { grid: false, container: false } }).debugLines().length / 8;
  assert.equal(lines([{ shape: 'capsule', position: [0, 0.5, 0] }]), 2 * 96 + 4);
  assert.equal(lines([{ shape: 'plane', position: [0, 0.1, 0] }]), 5);
  assert.equal(lines([{ shape: 'box', position: [0, 0.5, 0] }]), 12);
  liquid.dispose();
  assert.throws(() => liquid.link(body(), { shape: 'sphere' }), { code: 'disposed' });
});

test('every bad option is a coded error naming the value, with the help link', () => {
  const bad = [
    { count: 0 },
    { count: 1.5 },
    { count: 2_000_000 },
    { box: { min: [0, 0, 0], max: [1, 0, 1] } },
    { fill: { min: [-2, 0, -0.5], max: [0, 0.5, 0.5] } },
    { resolution: 4 },
    { resolution: 300 },
    { box: { min: [0, 0, 0], max: [1, 0.05, 1] }, resolution: 16 },
    { gravity: [0, NaN, 0] },
    { speedOfSound: 0 },
    { viscosity: -1 },
    { viscosity: 100 },
    { maxSubsteps: 0 },
    { seed: -1 },
    { paused: 1 },
    { pointer: { position: [0, 0] } },
    { pointer: { position: [0, 0, 0], radius: 0 } },
    { colliders: [{ shape: 'cone', position: [0, 0, 0] }] },
    { colliders: Array.from({ length: 9 }, () => ({ shape: 'sphere', position: [0, 0, 0] })) },
    { colliders: [{ shape: 'box', position: [0, 0, 0], rotation: [0, 0, 0, 2] }] },
    { colliders: [{ shape: 'sphere', position: [0, 0, 0], radius: -1 }] },
    { debug: { particles: 'pressure' } },
    { debug: { enabled: 'yes' } },
    { profile: 'exact' },
    { pressureIterations: 0 },
    { pressureIterations: 1.5 },
    { pressureTolerance: 0 },
    { pressureTolerance: 0.5 },
  ];
  for (const options of bad)
    assert.throws(
      () => resolveLiquidParams(options),
      (e) => e.name === 'MargoError' && e.code === 'unsupported' && /errors#gpu-liquid/.test(e.message),
      JSON.stringify(options),
    );
  const liquid = new GPULiquid({ count: 8 });
  assert.throws(() => liquid.step(1 / 60), { code: 'state' }, 'step needs the liquid attached');
  assert.throws(() => liquid.setPointer({ position: [0, 0, 0], strength: -1 }), { code: 'unsupported' });
  assert.throws(
    () => stepLiquidCPU(createLiquidState(resolveLiquidParams({ count: 8 })), resolveLiquidParams({ count: 8 }), 2),
    {
      code: 'unsupported',
    },
  );
});

test('the defaults: 65,536 particles, two spacings a cell, every wall on a node, a stable substep', () => {
  const p = resolveLiquidParams();
  assert.equal(p.count, 65_536);
  assert.ok(p.restDensity > 6 && p.restDensity < 10, `rest density ${p.restDensity} particles a cell`);
  for (let a = 0; a < 3; a++) {
    assert.ok(Math.abs(p.origin[a] + 2 * p.cell[a] - p.boxMin[a]) < 1e-12);
    assert.ok(Math.abs(p.origin[a] + (2 + p.cells[a]) * p.cell[a] - p.boxMax[a]) < 1e-12);
  }
  assert.ok(Math.abs(p.maxSubstep - (0.4 * p.cellSize) / p.speedOfSound) < 1e-15);
  assert.ok(Math.abs(p.speedOfSound - 2 * Math.sqrt(9.81)) < 1e-12);
  assert.ok(p.viscosity <= (p.cellSize * p.cellSize) / (8 * p.maxSubstep));
});

test('a floating origin: the liquid lives in a world cell, and a shift of the origin changes no bit and moves nothing', () => {
  // A liquid 1000 cells of 4096 m out along x, with a body linked 0.25 m from its frame's origin, against the same liquid
  // in cell 0: the debug lines (the linked collider placed in the liquid's frame) are the same to the bit, since
  // 4,096,000.25 - 4,096,000 is exact. The world's origin then moves to the liquid's cell (and the body with it): the
  // lines, the steps and the state stay the same to the bit.
  const S = 4096;
  const body = (x) => ({
    position: [x + 0.25, 0.5, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    applyImpulse() {},
    applyTorqueImpulse() {},
  });
  const make = (cell) =>
    new GPULiquid({ count: 512, seed: 4, originCell: cell, originCellSize: S, debug: { grid: false } });
  const near = make([0, 0, 0]);
  const far = make([1000, 0, 0]);
  assert.deepEqual(far.origin, [1000 * S, 0, 0]);
  const farBody = body(1000 * S);
  near.link(body(0), { shape: 'sphere', radius: 0.1 });
  far.link(farBody, { shape: 'sphere', radius: 0.1 });
  assert.deepEqual(far.debugLines(), near.debugLines(), 'the linked collider sits where it does in cell 0');
  const p = resolveLiquidParams(far.options, 512);
  const run = (steps, shift) => {
    const s = createLiquidState(p);
    for (let k = 0; k < steps; k++) {
      if (k === shift) far.shiftOrigin([1000, 0, 0]);
      stepLiquidCPU(s, resolveLiquidParams(far.options, 512), 1 / 60);
    }
    return liquidStateHash(s.particles);
  };
  const straight = run(20, -1);
  const shifted = run(20, 10);
  assert.equal(shifted, straight, 'steps across the shift repeat the steps without it');
  assert.deepEqual(far.options.originCell, [0, 0, 0]);
  assert.deepEqual(far.origin, [0, 0, 0]);
  farBody.position[0] -= 1000 * S;
  assert.deepEqual(far.debugLines(), near.debugLines(), 'no jump: the collider stays put in the liquid frame');
  far.shiftOrigin([-3, 2, 0]);
  assert.deepEqual(far.options.originCell, [3, -2, 0]);
  // Coded errors: a delta that is not whole cells, a cell past 2^31, a cell size that is not a power of two.
  assert.throws(() => far.shiftOrigin([0.5, 0, 0]), { code: 'unsupported' });
  assert.throws(() => far.shiftOrigin([-(2 ** 31), 0, 0]), { code: 'unsupported' });
  assert.deepEqual(far.options.originCell, [3, -2, 0], 'a refused shift changes nothing');
  for (const options of [
    { originCell: [0, 0] },
    { originCell: [0.5, 0, 0] },
    { originCellSize: 1000 },
    { originCellSize: 2 ** 21 },
  ])
    assert.throws(() => resolveLiquidParams(options), { code: 'unsupported' }, JSON.stringify(options));
  near.dispose();
  far.dispose();
  assert.throws(() => far.shiftOrigin([1, 0, 0]), { code: 'disposed' });
});

test('accurate profile: still water stays still at rest density with the hydrostatic pressure rho g d, and the floor carries its weight', () => {
  // A 0.2 m layer on a floor collider. The projection holds the liquid's volume (the centroid stays where it started, to
  // the particles' start jitter), the pressure in a liquid cell is rho g times its depth below the surface, which the
  // cells place within one cell h, and the floor's impulse balances gravity's on the column with its momentum change.
  const box = { min: [0, 0, 0], max: [0.4, 0.4, 0.4] };
  const p = resolveLiquidParams({
    count: 8192,
    box,
    profile: 'accurate',
    fill: { min: [0, 0.1, 0], max: [0.4, 0.3, 0.4] },
    colliders: [{ shape: 'box', position: [0.2, 0.05, 0.2], halfExtents: [0.3, 0.05, 0.3] }],
  });
  assert.equal(p.profile, 'accurate');
  assert.ok(
    Math.abs(p.maxSubstep - (0.5 * p.cellSize) / Math.sqrt(2 * 9.81 * 0.4)) < 1e-15,
    'half a cell over the fall speed',
  );
  const s = createLiquidState(p);
  const centroid = () => {
    let y = 0;
    for (let i = 0; i < s.live; i++) y += s.particles[i * F + 1];
    return y / s.live;
  };
  const momentum = () => {
    let m = 0;
    for (let i = 0; i < s.live; i++) m += s.particles[i * F + 5];
    return m;
  };
  const y0 = centroid();
  for (let k = 0; k < 60; k++) stepLiquidCPU(s, p, 1 / 60);
  const p0 = momentum();
  let impulse = 0;
  for (let k = 0; k < 30; k++) {
    stepLiquidCPU(s, p, 1 / 60);
    impulse += s.impulses[1] / FORCE_FIXED;
  }
  let fastest = 0;
  for (let i = 0; i < s.live; i++)
    fastest = Math.max(fastest, Math.hypot(s.particles[i * F + 4], s.particles[i * F + 5], s.particles[i * F + 6]));
  // From rest, its start jitter (a quarter spacing) settles: no particle moves faster than the speed of falling that far.
  const jitterFall = Math.sqrt(2 * 9.81 * 0.25 * p.lattice[1]);
  assert.ok(fastest < jitterFall, `fastest particle ${fastest} m/s after 1.5 s, against ${jitterFall}`);
  assert.ok(Math.abs(centroid() - y0) < 0.25 * p.lattice[1], `centroid ${centroid()} from ${y0}: the volume is kept`);
  const expected = -(momentum() - p0) - p.count * 9.81 * 0.5;
  const weight = p.count * 9.81 * 0.5;
  assert.ok(Math.abs(impulse - expected) <= 0.01 * weight, `floor impulse ${impulse} against ${expected}`);
  // Hydrostatic pressure down the middle column of cells.
  const [nx, ny, nz] = p.dims;
  const cx = nx - 1,
    cy = ny - 1;
  const i = Math.floor(cx / 2),
    l = Math.floor((nz - 1) / 2);
  let checked = 0;
  for (let j = 0; j < cy; j++) {
    const pressure = s.pressure[i + cx * (j + cy * l)];
    if (!pressure) continue;
    const y = p.origin[1] + (j + 0.5) * p.cell[1];
    if (y < 0.15 || y > 0.25) continue;
    const exact = 1000 * 9.81 * (0.3 - y);
    assert.ok(
      Math.abs(pressure - exact) <= 1000 * 9.81 * p.cellSize,
      `pressure ${pressure} Pa at ${y} m against ${exact}`,
    );
    checked++;
  }
  assert.ok(checked >= 2, 'liquid cells down the column');
  assert.ok(s.iterations > 0 && s.iterations < p.pressureIterations, `the solve converges: ${s.iterations} iterations`);
  assert.ok(s.residual <= p.pressureTolerance, `to its tolerance: ${s.residual}`);
});

test('accurate profile against fast: the same dam break keeps its volume where the Tait liquid compresses', () => {
  // A column falls in a 0.4 m tank; after 0.6 s the mean density over rest of the particles more than a cell under the
  // surface stays within the projection's tolerance of 1 in the accurate profile, while the fast one compresses by its
  // Mach number squared (c = 2 sqrt(g H) here).
  const run = (profile) => {
    const p = resolveLiquidParams({
      count: 8192,
      box: { min: [0, 0, 0], max: [0.4, 0.4, 0.2] },
      fill: { min: [0, 0, 0], max: [0.15, 0.3, 0.2] },
      profile,
    });
    const s = createLiquidState(p);
    for (let k = 0; k < 36; k++) stepLiquidCPU(s, p, 1 / 60);
    let sum = 0,
      n = 0;
    for (let i = 0; i < s.live; i++)
      if (s.particles[i * F + 1] < 0.03) {
        sum += s.particles[i * F + 3];
        n++;
      }
    return sum / n;
  };
  const accurate = run('accurate');
  const fast = run('fast');
  assert.ok(Math.abs(accurate - 1) < 0.05, `accurate: mean density ${accurate} of rest at the floor`);
  assert.ok(fast - 1 > accurate - 1, `fast compresses more: ${fast} against ${accurate}`);
});
