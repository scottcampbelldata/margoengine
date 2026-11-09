import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/netcode/scripts/rival-bench.mjs')
)
  process.exit(0);
// Rollback resimulation cost. No JavaScript rival does this: GGPO is C++ and Colyseus is not rollback.
// The number published is milliseconds per rolled-back frame, beside a forward-only run of the same game.
// Busy machine: diagnostic only. A run that never rolls back is a broken bench and exits 1.
import { defineGame, defineSchema, LoopbackNetwork } from '../dist/index.js';
import { RollbackSession } from '../dist/rollback.js';

const FRAMES = 180;
const ROUNDS = 7;

const schema = defineSchema({
  types: {
    Input: { x: { type: 'quantized', min: -1, max: 1, bits: 8 } },
    Fighter: { x: 'f32' },
    State: { fighters: { type: 'map', of: 'Fighter', maxSize: 4 } },
  },
});
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 60,
  initial: () => ({ fighters: new Map() }),
  join: (state, id) => void state.fighters.set(id, { x: id * 2 }),
  step(state, inputs) {
    for (const [id, input] of inputs) {
      const fighter = state.fighters.get(id);
      if (fighter) fighter.x += input.x * 0.1;
    }
  },
});

function run({ latency, input, frames }) {
  const network = new LoopbackNetwork({ latency, jitter: 0, loss: 0, seed: 1 });
  const [toTwo, toOne] = network.pair();
  const now = () => network.time;
  const one = new RollbackSession(game, {
    players: [1, 2],
    local: 1,
    peers: new Map([[2, toTwo]]),
    now,
    input,
  });
  const two = new RollbackSession(game, {
    players: [1, 2],
    local: 2,
    peers: new Map([[1, toOne]]),
    now,
    input,
  });
  const step = 1000 / 60;
  const t0 = performance.now();
  for (let frame = 0; frame < frames; frame++) {
    network.advance(step);
    one.update();
    two.update();
  }
  const ms = performance.now() - t0;
  return { ms, one: one.stats, two: two.stats };
}

const changing = (frame) => ({ x: frame % 2 === 0 ? 1 : -1 });
const steady = () => ({ x: 1 });

for (let i = 0; i < 2; i++) {
  run({ latency: 40, input: changing, frames: 60 });
  run({ latency: 0, input: steady, frames: 60 });
}

const rolled = [];
const forward = [];
const extras = [];
let lastRolled;
for (let i = 0; i < ROUNDS; i++) {
  const firstRollback = i % 2 === 0;
  const a = run({ latency: firstRollback ? 40 : 0, input: firstRollback ? changing : steady, frames: FRAMES });
  const b = run({ latency: firstRollback ? 0 : 40, input: firstRollback ? steady : changing, frames: FRAMES });
  const rollback = firstRollback ? a : b;
  const plain = firstRollback ? b : a;
  const resimulated = rollback.one.resimulated + rollback.two.resimulated;
  if (!(resimulated > 0)) {
    console.error('no rollback happened', rollback.one, rollback.two);
    process.exit(1);
  }
  rolled.push(rollback.ms);
  forward.push(plain.ms);
  extras.push((rollback.ms - plain.ms) / resimulated);
  lastRolled = rollback;
}
const minRolled = Math.min(...rolled);
const minForward = Math.min(...forward);
const minExtra = Math.min(...extras);
console.log('no JS rollback rival (GGPO is C++, Colyseus is not rollback)');
console.log(
  `forward-only ${(minForward / FRAMES).toFixed(4)} ms/frame, rollback run ${(minRolled / FRAMES).toFixed(4)} ms/frame (busy machine, per-round minimum of ${FRAMES} frames)`,
);
console.log(
  `last round resimulated ${lastRolled.one.resimulated + lastRolled.two.resimulated} frames across both peers, rollbacks ${lastRolled.one.rollbacks}+${lastRolled.two.rollbacks}, extra per rolled frame min ${(minExtra * 1000).toFixed(3)} us`,
);
console.log(`stats one ${JSON.stringify(lastRolled.one)}`);
console.log(`rounds rollback ms ${rolled.map((v) => v.toFixed(3)).join(' ')}`);
console.log(`rounds forward ms ${forward.map((v) => v.toFixed(3)).join(' ')}`);
