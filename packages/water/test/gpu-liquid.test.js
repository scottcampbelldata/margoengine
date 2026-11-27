// GPULiquid (@margoengine/water/liquid) on the CPU twin, which runs the GPU's passes and fixed-point sums: free fall in
// closed form, the walls and colliders read as liquid at rest, a floor collider's force against the momentum balance,
// determinism and snapshots, collider distances, coded errors. The GPU itself: gpu-liquid-check.mjs (WebGPU and
// --compat).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPULiquid,
  LIQUID_PARTICLE_FLOATS as F,
  colliderDistance,
  createLiquidState,
  liquidStateHash,
  resolveLiquidParams,
  stepLiquidCPU,
} from '../dist/liquid.js';

const FIXED = 65536;
const FORCE_FIXED = 1024;

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
  for (const [colliders, from] of [
    [[], 0.2],
    [[floor], 0.2],
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
  assert.notEqual(liquidStateHash(createLiquidState(resolveLiquidParams({ ...options, seed: 10 })).particles), liquidStateHash(createLiquidState(half.p).particles));
});

test('GPULiquid.restore checks the whole snapshot before it changes anything', () => {
  const liquid = new GPULiquid({ count: 8 });
  const good = createLiquidState(resolveLiquidParams({ count: 8 })).particles;
  const bad = (particles, extra = {}) => ({ count: 8, steps: 0, particles, ...extra });
  assert.throws(() => liquid.restore(bad(good, { count: 9 })), { code: 'unsupported' });
  assert.throws(() => liquid.restore(bad(good.subarray(0, 8 * F - 1))), { code: 'unsupported' });
  assert.throws(() => liquid.restore(bad(good, { steps: -1 })), { code: 'unsupported' });
  const nan = good.slice();
  nan[8 * F - 1] = NaN;
  assert.throws(() => liquid.restore(bad(nan)), /not finite/);
  const out = good.slice();
  out[7 * F + 1] = 2;
  assert.throws(() => liquid.restore(bad(out)), /outside the container/);
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
  assert.ok(Math.abs(colliderDistance(box, [0, 0.1, 0], n) + 0.15) < 1e-12, 'inside: minus the distance to the nearest face');
  assert.ok(Math.abs(n[1] - 1) < 1e-12);
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
  assert.throws(() => stepLiquidCPU(createLiquidState(resolveLiquidParams({ count: 8 })), resolveLiquidParams({ count: 8 }), 2), {
    code: 'unsupported',
  });
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
