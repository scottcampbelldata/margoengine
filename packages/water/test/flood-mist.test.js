// FG-10: spray mist of a flood's spray sites as Gaussian puffs (floodMist), splatted into a sparse density grid
// (@margoengine/environment/density-volume) for VolumetricFog. Checks the puff model against the formulas written out
// here: the drops in the air, the Gaussian's peak, the rise to the ballistic apex and the settling, the wind's drift,
// the strongest-first cap, and that the splatted grid holds the drops' whole extinction cross-section.
import test from 'node:test';
import assert from 'node:assert/strict';
import { floodMist } from '../dist/flood-bake.js';
import { DensityVolume } from '../../environment/dist/density-volume.js';

const site = (x, y, z, vy, rate) => ({
  count: 1,
  position: Float32Array.of(x, y, z),
  velocity: Float32Array.of(1, vy, 0),
  rate: Float32Array.of(rate),
  cell: Uint32Array.of(0),
});
const join = (...list) => ({
  count: list.length,
  position: Float32Array.from(list.flatMap((s) => [...s.position])),
  velocity: Float32Array.from(list.flatMap((s) => [...s.velocity])),
  rate: Float32Array.from(list.flatMap((s) => [...s.rate])),
  cell: Uint32Array.from(list.map((_, i) => i)),
});
const close = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

test('validation', () => {
  assert.throws(() => floodMist(undefined), TypeError);
  const s = site(0, 0, 0, 2, 10);
  for (const bad of [
    { wind: [1] },
    { wind: [Number.NaN, 0] },
    { lifetime: 0 },
    { diffusivity: -1 },
    { fallSpeed: 11 },
    { dropRadius: 0 },
    { dropsPerParticle: -1 },
    { sourceRadius: 0 },
    { puffs: 0 },
    { puffs: 2.5 },
    { maxPuffs: -1 },
  ])
    assert.throws(() => floodMist(s, bad), RangeError, JSON.stringify(bad));
  assert.equal(floodMist(site(0, 0, 0, 2, 0)).count, 0, 'a site that emits nothing makes no mist');
});

test('one site: puff ages, Gaussian peak, apex and settling, wind drift', () => {
  const vy = 3,
    rate = 50,
    o = { lifetime: 2, diffusivity: 0.5, fallSpeed: 0.2, dropRadius: 2e-4, dropsPerParticle: 1000, sourceRadius: 0.4 },
    mist = floodMist(site(5, 1, -3, vy, rate), { ...o, wind: [2, -1], puffs: 4 });
  assert.equal(mist.count, 4);
  const dt = (3 * o.lifetime) / 4,
    g = 9.81,
    apex = (vy * vy) / (2 * g),
    rise = vy / g;
  // Strongest first: the youngest puff holds the most drops in the smallest spread.
  for (let k = 0; k < 4; k++) {
    const t = (k + 0.5) * dt,
      s = Math.sqrt(o.sourceRadius ** 2 + 2 * o.diffusivity * t),
      w =
        (rate * dt * Math.exp(-t / o.lifetime) * 2 * Math.PI * o.dropRadius ** 2 * o.dropsPerParticle) /
        ((2 * Math.PI) ** 1.5 * s ** 3),
      y = 1 + Math.max(0, t < rise ? vy * t - 0.5 * g * t * t : apex - o.fallSpeed * (t - rise));
    close(mist.radius[k], s, 1e-6, `puff ${k} radius`);
    close(mist.weight[k], w, 1e-6, `puff ${k} peak`);
    close(mist.position[3 * k], 5 + 2 * t, 1e-6, `puff ${k} x drifts with the wind`);
    close(mist.position[3 * k + 1], y, 1e-6, `puff ${k} height`);
    close(mist.position[3 * k + 2], -3 - t, 1e-6, `puff ${k} z drifts with the wind`);
  }
  assert.ok(mist.position[1] > 1 + apex - 0.5, 'the young puff sits near the apex');
  // Settled for long enough, a puff rests on the water it left.
  const low = floodMist(site(0, 1, 0, 1, 10), { fallSpeed: 10, lifetime: 5, puffs: 3 });
  assert.equal(Math.min(...[0, 1, 2].map((k) => low.position[3 * k + 1])), 1);
});

test('cap keeps the strongest puffs, deterministically', () => {
  const sites = join(site(0, 0, 0, 2, 10), site(10, 0, 0, 2, 40), site(20, 0, 0, 2, 20)),
    all = floodMist(sites),
    capped = floodMist(sites, { maxPuffs: 5 });
  assert.equal(all.count, 18);
  assert.equal(capped.count, 5);
  const top = [...all.weight].sort((a, b) => b - a).slice(0, 5);
  assert.deepEqual([...capped.weight], top);
  assert.deepEqual(floodMist(sites, { maxPuffs: 5 }), capped);
});

test('splatted into a DensityVolume, the grid holds the cross-section of every drop in the air', () => {
  const o = { lifetime: 1.5, dropRadius: 1e-4, dropsPerParticle: 1e4, puffs: 8 },
    sites = join(site(0, 0, 0, 2, 30), site(3, 0, 1, 1, 60)),
    mist = floodMist(sites, { ...o, wind: [1, 0] }),
    grid = new DensityVolume({ voxelSize: 0.2 });
  grid.splat(mist.position, { radius: mist.radius, weight: mist.weight });
  // Integral of the extinction over space: the drops in the air times 2 pi r^2 each.
  const dt = (3 * o.lifetime) / o.puffs;
  let inAir = 0;
  for (const rate of [30, 60])
    for (let k = 0; k < o.puffs; k++) inAir += rate * dt * Math.exp(-((k + 0.5) * dt) / o.lifetime);
  const want = inAir * o.dropsPerParticle * 2 * Math.PI * o.dropRadius ** 2,
    { voxels } = grid.pack(),
    got = voxels.reduce((a, v) => a + v, 0) * 0.2 ** 3;
  // The Gaussians are cut at three standard deviations, which keeps 97.07 % of each.
  close(got, want * 0.9707, 0.02, 'integrated extinction');
  assert.ok(grid.sample([0, 0.15, 0]) > grid.sample([0, 4, 0]), 'mist is thickest near the spray');
});
