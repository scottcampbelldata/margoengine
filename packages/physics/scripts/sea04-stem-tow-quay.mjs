import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { QuayPotential } from '../../../test-results/sea04-stem/built/loads.js';

// Manufactured harmonic phi=U*x on a graph with a wet rectangular tow body.
const cells = [16, 12];
const [nx, nz] = cells;
const depths = [0, 0.125, 0.25, 0.5];
const dx = 0.125;
const speed = 1.25;
const plane = nx * nz;
const count = plane * (depths.length - 1);
const wet = Uint8Array.from({ length: count }, (_, place) => {
  const x = place % nx;
  const z = Math.floor(place / nx) % nz;
  return x >= 6 && x < 9 && z >= 4 && z < 8 ? 0 : 1;
});
const potential = new QuayPotential({ cells, depths, cellSize: dx, wet });
const trace = Float64Array.from({ length: plane }, (_, place) => speed * (((place % nx) + 0.5) * dx));
const wall = new Float64Array(count);
const exterior = new Float64Array(count);
let plusFlux = 0;
let minusFlux = 0;
for (let place = 0; place < count; place++) {
  if (!wet[place]) continue;
  const x = place % nx;
  const layer = Math.floor(place / plane);
  const flux = speed * dx * (depths[layer + 1] - depths[layer]);
  const west = x === 0 || wet[place - 1];
  const east = x === nx - 1 || wet[place + 1];
  wall[place] = flux * (Number(west) - Number(east));
  exterior[place] = x === 0 ? -flux : x === nx - 1 ? flux : 0;
  plusFlux += Math.max(0, wall[place]);
  minusFlux += Math.min(0, wall[place]);
}
function solve(sign) {
  const rise = new Float64Array(plane);
  const bulk = new Float64Array(count);
  const source = Float64Array.from(wall, (value, place) => -(sign * value + exterior[place]));
  const iterations = potential.project(trace, rise, source, 0, bulk);
  let maxExpectedDifference = 0;
  for (let i = 0; i < count; i++) {
    if (wet[i]) maxExpectedDifference = Math.max(maxExpectedDifference, Math.abs(bulk[i] - trace[i % plane]));
  }
  return { iterations, maxExpectedDifference, maxSurfaceRise: Math.max(...rise.map(Math.abs)) };
}
const correct = solve(1);
const reversed = solve(-1);
const outcome = { wet: [...wet].reduce((a, b) => a + b, 0), plusFlux, minusFlux, correct, reversed };
writeFileSync(
  new URL('../../../test-results/sea04-stem/tow-quay-sign.json', import.meta.url),
  JSON.stringify(outcome, null, 2),
);
console.log(outcome);
assert.ok(plusFlux > 0.1);
assert.ok(Math.abs(plusFlux + minusFlux) < 1e-14);
assert.ok(correct.maxExpectedDifference < 1e-10);
assert.ok(correct.maxSurfaceRise < 1e-10);
assert.ok(reversed.maxExpectedDifference > 0.05);
