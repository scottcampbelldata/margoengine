import { threadId } from 'node:worker_threads';
import { sharedIndex } from '../../dist/parallel.js';
export function move({ components: c, delta }) {
  for (let i = 0; i < c.position.count; i++) {
    const row = sharedIndex(c.velocity, c.position.entities[i]);
    if (row >= 0) c.position.fields.x[i] += c.velocity.fields.x[row] * delta;
  }
}
export function report({ components: c }) {
  for (let i = 0; i < c.output.count; i++) {
    const row = sharedIndex(c.position, c.output.entities[i]);
    if (row >= 0) c.output.fields.x[i] = c.position.fields.x[row];
  }
}
export function rendezvous({ components }) {
  const gate = globalThis.testBarrier;
  Atomics.add(gate, 0, 1);
  Atomics.notify(gate, 0);
  while (Atomics.load(gate, 0) < 2) {
    const result = Atomics.wait(gate, 0, 1, 30000);
    if (result === 'timed-out') throw new TypeError('Independent systems did not overlap');
  }
  Object.values(components)[0].fields.x[0] = threadId;
}
export async function never() {
  await new Promise(() => {});
}
export function fail({ components }) {
  Object.values(components)[0].fields.x[0] = 5;
  throw new TypeError('deliberate system failure');
}
export function exit() {
  process.exit(23);
}
export function noop() {}
