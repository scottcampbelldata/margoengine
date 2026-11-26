import assert from 'node:assert/strict';
import { DfsphSolver } from '../dist/dfsph.js';
import { PhysicsWorld } from '../dist/world.js';

// Rayleigh (1879), small-amplitude quadrupole mode: omega² = 8 sigma / (rho R³).
const tension = 0.07274;
const density = 1000;
const nominalRadius = 0.02;
const rate = 960;
const halfColumns = 8;
const spacing = nominalRadius / halfColumns;
const stretch = 1.04;
const transverse = 1 / Math.sqrt(stretch);
const points = [];
for (let x = -halfColumns; x < halfColumns; x++)
  for (let y = -halfColumns; y < halfColumns; y++)
    for (let z = -halfColumns; z < halfColumns; z++) {
      const xx = (x + 0.5) * spacing;
      const yy = (y + 0.5) * spacing;
      const zz = (z + 0.5) * spacing;
      if (Math.hypot(xx, yy, zz) <= nominalRadius)
        points.push({ position: [xx * stretch, yy * transverse, zz * transverse] });
    }
const particleVolume = spacing ** 3;
const conservedVolume = points.length * particleVolume;
const radius = Math.cbrt((3 * conservedVolume) / (4 * Math.PI));
const period = (2 * Math.PI) / Math.sqrt((8 * tension) / (density * radius ** 3));
const extent = 4 * nominalRadius;
const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, 0, 0] });
const liquid = await DfsphSolver.load(world.memory, { rate: 4 });
world.add(liquid, {
  profile: 'accurate',
  particles: points,
  spacing,
  density,
  surfaceTension: tension,
  viscosity: 1e-6,
  friction: 0,
  bounds: [
    [-extent, -extent, -extent],
    [extent, extent, extent],
  ],
});

const storage = new Float32Array(points.length * 3);
function anisotropy() {
  liquid.positions(storage);
  let moment = 0;
  for (let i = 0; i < storage.length; i += 3)
    moment += storage[i] ** 2 - (storage[i + 1] ** 2 + storage[i + 2] ** 2) / 2;
  return moment / (radius ** 2 * points.length);
}

let previous = anisotropy();
const crossings = [];
for (let frame = 1; frame <= Math.ceil(2 * rate * period) && crossings.length < 2; frame++) {
  world.advance(frame);
  const current = anisotropy();
  if (previous * current < 0) crossings.push((frame - 1 + previous / (previous - current)) / rate);
  previous = current;
}
assert.equal(crossings.length, 2, 'The shape has not crossed its axisymmetric reference twice.');
assert.ok(Math.abs(liquid.mass - density * conservedVolume) <= Number.EPSILON);
const computedPeriod = 2 * (crossings[1] - crossings[0]);
console.log(
  JSON.stringify(
    {
      particles: points.length,
      radiusMetres: radius,
      massKilograms: liquid.mass,
      surfaceTension: tension,
      rayleighPeriodSeconds: period,
      crossingSeconds: crossings,
      measuredPeriodSeconds: computedPeriod,
      ratio: computedPeriod / period,
    },
    null,
    2,
  ),
);
