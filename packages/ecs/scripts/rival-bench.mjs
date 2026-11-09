import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/ecs/scripts/rival-bench.mjs')
)
  process.exit(0);
// 100,000 entities, one SoA pass of position += velocity, against bitECS installed outside the repository.
// bitECS is a black box (engine-bench/batch-167/ecs.mjs). This file never names its functions.
// Times are per-round minima of paired turns in this process. Busy machine: diagnostic only.
import { World } from '../dist/index.js';
import { line, rivalUrl, rivalVersion } from '../../../scripts/rival-pair.mjs';

const COUNT = 100_000;
const ROUNDS = 7;

function make() {
  const world = new World(COUNT);
  const position = world.component({ x: Float32Array, y: Float32Array });
  const velocity = world.component({ x: Float32Array, y: Float32Array });
  for (let i = 0; i < COUNT; i++) {
    const id = world.create();
    position.add(id, { x: i, y: 0 });
    velocity.add(id, { x: 1, y: 0 });
  }
  const ids = new Uint32Array(world.capacity);
  return {
    step() {
      const n = world.query([position, velocity], ids);
      let sum = 0;
      const px = position.fields.x;
      const py = position.fields.y;
      const vx = velocity.fields.x;
      const vy = velocity.fields.y;
      for (let i = 0; i < n; i++) {
        const id = ids[i];
        const p = position.index(id);
        const v = velocity.index(id);
        px[p] += vx[v];
        py[p] += vy[v];
        sum += px[p];
      }
      return { n, sum };
    },
  };
}

const rival = await import(rivalUrl('ecs.mjs'));
const version = rivalVersion('bitecs');

for (let i = 0; i < 2; i++) {
  make().step();
  rival.create().step();
}

const roundsA = [];
const roundsB = [];
let outA;
let outB;
for (let i = 0; i < ROUNDS; i++) {
  const mine = make();
  const other = rival.create();
  if (i % 2 === 0) {
    const a0 = performance.now();
    outA = mine.step();
    roundsA.push(performance.now() - a0);
    const b0 = performance.now();
    outB = other.step();
    roundsB.push(performance.now() - b0);
  } else {
    const b0 = performance.now();
    outB = other.step();
    roundsB.push(performance.now() - b0);
    const a0 = performance.now();
    outA = mine.step();
    roundsA.push(performance.now() - a0);
  }
}

if (outA.n !== COUNT || outB.n !== COUNT || !Number.isFinite(outA.sum) || !Number.isFinite(outB.sum)) {
  console.error('bad ecs result', outA, outB);
  process.exit(1);
}
console.log(`bitecs ${version}`);
console.log(line('100k position += velocity', 'margo', Math.min(...roundsA), 'bitecs', Math.min(...roundsB)));
console.log(`checksum margo n=${outA.n} sum=${outA.sum} bitecs n=${outB.n} sum=${outB.sum}`);
console.log(`rounds margo ${roundsA.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds bitecs ${roundsB.map((v) => v.toFixed(3)).join(' ')}`);
