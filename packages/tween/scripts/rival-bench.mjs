import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/tween/scripts/rival-bench.mjs')
)
  process.exit(0);
// 10,000 linear tweens, one 16 ms step, against tween.js installed outside the repository.
// tween.js is a black box (engine-bench/batch-167/tween.mjs). This file never names its functions.
// Margo's duration is in seconds; the rival's is in milliseconds. Both advance one frame of 16 ms.
// Times are per-round minima of paired turns in this process. Busy machine: diagnostic only.
import { Tween } from '../dist/index.js';
import { line, rivalUrl, rivalVersion } from '../../../scripts/rival-pair.mjs';

const COUNT = 10_000;
const ROUNDS = 7;

function make() {
  const tween = new Tween();
  const objects = [];
  for (let i = 0; i < COUNT; i++) {
    const object = { x: 0 };
    objects.push(object);
    tween.to(object, 'x', 100, { duration: 1 });
  }
  return {
    update() {
      tween.update(0.016);
      let sum = 0;
      for (let i = 0; i < objects.length; i++) sum += objects[i].x;
      return sum;
    },
  };
}

const rival = await import(rivalUrl('tween.mjs'));
const version = rivalVersion('@tweenjs/tween.js');

for (let i = 0; i < 2; i++) {
  make().update();
  rival.create().update(16);
}

const roundsA = [];
const roundsB = [];
let outA = 0;
let outB = 0;
for (let i = 0; i < ROUNDS; i++) {
  const mine = make();
  const other = rival.create();
  if (i % 2 === 0) {
    const a0 = performance.now();
    outA = mine.update();
    roundsA.push(performance.now() - a0);
    const b0 = performance.now();
    outB = other.update(16);
    roundsB.push(performance.now() - b0);
  } else {
    const b0 = performance.now();
    outB = other.update(16);
    roundsB.push(performance.now() - b0);
    const a0 = performance.now();
    outA = mine.update();
    roundsA.push(performance.now() - a0);
  }
}

const expect = COUNT * 1.6;
if (Math.abs(outA - expect) > 1e-6 || Math.abs(outB - expect) > 1e-4) {
  console.error('tween checksum off the linear halfway-of-a-frame value', outA, outB, expect);
  process.exit(1);
}
console.log(`tween.js ${version}`);
console.log(line('10k tweens x 16 ms', 'margo', Math.min(...roundsA), 'tween.js', Math.min(...roundsB)));
console.log(`checksum margo ${outA} tween.js ${outB} expect ${expect}`);
console.log(`rounds margo ${roundsA.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds tween.js ${roundsB.map((v) => v.toFixed(3)).join(' ')}`);
