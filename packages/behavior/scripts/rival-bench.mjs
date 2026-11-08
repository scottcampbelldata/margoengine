// Flock of 1,000 agents, one step, against Yuka 0.7.x installed outside the repository.
// Yuka is a black box (engine-bench/batch-167/behavior.mjs). This file never names its classes.
// Reynolds 1987 is the flock; the rival's documented example is cited in docs/clean-room.md.
// Times are per-round minima of paired turns in this process. Busy machine: diagnostic only.
import { flock } from '../dist/steering.js';
import { line, rivalUrl, rivalVersion } from '../../../scripts/rival-pair.mjs';

const COUNT = 1000;
const COLUMNS = 40;
const ROUNDS = 7;
const DELTA = 1 / 60;

function fresh() {
  const x = new Float64Array(COUNT);
  const y = new Float64Array(COUNT);
  const z = new Float64Array(COUNT);
  const vx = new Float64Array(COUNT);
  const vy = new Float64Array(COUNT);
  const vz = new Float64Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    x[i] = i % COLUMNS;
    z[i] = Math.floor(i / COLUMNS);
    vx[i] = 1;
  }
  return { x, y, z, vx, vy, vz };
}

function checksum(state) {
  let sum = 0;
  for (let i = 0; i < COUNT; i++) sum += state.x[i] + state.z[i];
  return sum;
}

const rival = await import(rivalUrl('behavior.mjs'));
const version = rivalVersion('yuka');
const options = { radius: 2, separation: 1.5, alignment: 1, cohesion: 1, maxSpeed: 3, maxForce: 6 };

// Warmup, discarded. Each round builds a fresh flock outside the timer so the step is the first update.
for (let i = 0; i < 2; i++) {
  const state = fresh();
  flock(state, COUNT, options, DELTA);
  const other = rival.create();
  other.update(DELTA);
}

const roundsA = [];
const roundsB = [];
let outA = 0;
let outB = 0;
for (let i = 0; i < ROUNDS; i++) {
  const state = fresh();
  const other = rival.create();
  const stepMargo = () => {
    flock(state, COUNT, options, DELTA);
    return checksum(state);
  };
  const stepYuka = () => other.update(DELTA);
  if (i % 2 === 0) {
    const a0 = performance.now();
    outA = stepMargo();
    roundsA.push(performance.now() - a0);
    const b0 = performance.now();
    outB = stepYuka();
    roundsB.push(performance.now() - b0);
  } else {
    const b0 = performance.now();
    outB = stepYuka();
    roundsB.push(performance.now() - b0);
    const a0 = performance.now();
    outA = stepMargo();
    roundsA.push(performance.now() - a0);
  }
}

const minA = Math.min(...roundsA);
const minB = Math.min(...roundsB);
if (!Number.isFinite(outA) || !Number.isFinite(outB)) {
  console.error('non-finite flock checksum', outA, outB);
  process.exit(1);
}
console.log(`yuka ${version}`);
console.log(line('flock 1000 x 1 step', 'margo', minA, 'yuka', minB));
console.log(`checksum margo ${outA} yuka ${outB}`);
console.log(`rounds margo ${roundsA.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds yuka ${roundsB.map((v) => v.toFixed(3)).join(' ')}`);
