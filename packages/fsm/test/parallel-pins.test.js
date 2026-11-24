// Pins ParallelRegions' raise limit: 10,000 events raised by hooks in one delivery are taken, one more throws, and
// the event still waiting when it throws is dropped, so the next delivery starts clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ParallelRegions } from '../dist/parallel.js';

const pingPong = (limit) => {
  let raised = 0;
  const forwarded = [];
  let regions;
  const hook = () => { if (raised++ < limit) regions.raise('ping'); };
  regions = new ParallelRegions({
    one: {
      states: { a: { enter: hook }, b: { enter: hook } },
      initial: 'a',
      transitions: [{ from: 'a', to: 'b', event: 'ping' }, { from: 'b', to: 'a', event: 'ping' }],
    },
  }, {}, { forward: (event) => forwarded.push(event) });
  return { regions, forwarded };
};

test('10,000 raised events in one delivery are taken; the 10,001st throws and is dropped', () => {
  const fine = pingPong(10000);
  fine.regions.start();
  assert.equal(fine.regions.active.one, 'a', '10,000 pings from a end in a');
  const over = pingPong(10001);
  assert.throws(() => over.regions.start(), (e) => e.code === 'state' && /raise events for ever/.test(e.message));
  const at = over.regions.active.one;
  over.regions.raise('noop');
  assert.equal(over.regions.active.one, at, 'no waiting ping is delivered after the throw');
  assert.deepEqual(over.forwarded, ['noop']);
});
