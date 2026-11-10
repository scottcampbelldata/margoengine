import assert from 'node:assert/strict';
import test from 'node:test';
import { Interaction } from '../src/interact.ts';

function fixture() {
  const canvas = Object.assign(new EventTarget(), { style: {} }),
    events = [],
    errors = [];
  let cpu = 0;
  const interaction = new Interaction(
    canvas,
    {},
    {
      pick: () => {
        cpu++;
        return null;
      },
      hover: (hit) => events.push(hit),
      error: (error) => errors.push(error),
      describe: () => null,
      controls: () => undefined,
      select: () => {},
    },
  );
  return { interaction, events, errors, cpu: () => cpu };
}
const drain = () => new Promise((resolve) => setImmediate(resolve));

test('async hover coalesces pointer positions, discards stale results and restores the CPU reference', async () => {
  const f = fixture(),
    a = Promise.withResolvers(),
    b = Promise.withResolvers(),
    calls = [];
  const remove = f.interaction.setPicker((x, y) => {
    calls.push([x, y]);
    return calls.length === 1 ? a.promise : b.promise;
  });
  f.interaction.update(1, 2);
  f.interaction.update(3, 4);
  f.interaction.update(5, 6);
  assert.deepEqual(calls, [[1, 2]]);
  assert.equal(f.cpu(), 0);
  a.resolve({ layer: 1, index: 1 });
  await drain();
  assert.deepEqual(f.events, []);
  assert.deepEqual(calls, [
    [1, 2],
    [5, 6],
  ]);
  b.resolve({ layer: 1, index: 2 });
  await drain();
  assert.deepEqual(f.events, [{ layer: 1, index: 2 }]);
  remove();
  f.interaction.update(1, 2);
  assert.equal(f.cpu(), 1);
  f.interaction.dispose();
});
test('pending hover cannot publish after disposal; failures are reported without poisoning future picks', async () => {
  const f = fixture(),
    pending = Promise.withResolvers();
  f.interaction.setPicker(() => pending.promise);
  f.interaction.update(1, 2);
  f.interaction.dispose();
  pending.resolve({ layer: 1, index: 1 });
  await drain();
  assert.deepEqual(f.events, []);
  const g = fixture(),
    reason = new Error('GPU lost');
  g.interaction.setPicker(() => Promise.reject(reason));
  g.interaction.update(1, 2);
  await drain();
  assert.deepEqual(g.errors, [reason]);
  g.interaction.setPicker(() => Promise.resolve({ layer: 1, index: 2 }));
  g.interaction.update(1, 2);
  await drain();
  assert.deepEqual(g.events, [{ layer: 1, index: 2 }]);
  g.interaction.dispose();
});
