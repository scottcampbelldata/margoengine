import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/fsm/scripts/rival-bench.mjs')
)
  process.exit(0);
// 10,000 transitions of a two-state toggle, against XState installed outside the repository.
// XState is a black box (engine-bench/batch-167/fsm.mjs). This file never names its functions.
// Times are per-round minima of paired turns in this process. Busy machine: diagnostic only.
import { StateMachine } from '../dist/index.js';
import { line, rivalUrl, rivalVersion } from '../../../scripts/rival-pair.mjs';

const TRANSITIONS = 10_000;
const ROUNDS = 7;

function make() {
  const machine = new StateMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'NEXT' },
    { from: 'b', to: 'a', event: 'NEXT' },
  ]);
  return {
    step() {
      for (let i = 0; i < TRANSITIONS; i++) machine.send('NEXT');
      return machine.state;
    },
  };
}

const rival = await import(rivalUrl('fsm.mjs'));
const version = rivalVersion('xstate');

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

if (outA !== 'a' || outB !== 'a') {
  console.error('fsm ended in the wrong state', outA, outB);
  process.exit(1);
}
console.log(`xstate ${version}`);
console.log(line('10k transitions', 'margo', Math.min(...roundsA), 'xstate', Math.min(...roundsB)));
console.log(`final margo ${outA} xstate ${outB}`);
console.log(`rounds margo ${roundsA.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds xstate ${roundsB.map((v) => v.toFixed(3)).join(' ')}`);
