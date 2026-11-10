import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventMachine, EventTrace } from '../dist/events.js';

test('payload reaches guards, exit, entry and bounded trace without changing context', () => {
  const seen = [], context = {}, data = { value: 42 };
  const m = new EventMachine({ a: { exit: (c, d) => seen.push([c, d]) },
    b: { enter: (c, d) => seen.push([c, d]) } }, 'a', context,
    [{ from: 'a', to: 'b', event: 'go', guard: (c, d) => { seen.push([c, d]); return d?.value === 42; } }]);
  using trace = new EventTrace(m, { capacity: 1 });
  assert.equal(m.send('go', { value: 0 }), false);
  seen.length = 0;
  assert.equal(m.send('go', data), true);
  assert.deepEqual(seen, [[context, data], [context, data], [context, data]]);
  assert.equal(trace.records[0].data, data);
  assert.equal(m.data, undefined);
  assert.deepEqual(context, {});
});

test('planned delivery retains its own payload and exceptions restore delivery', () => {
  const seen = [];
  const m = new EventMachine({ a: {}, b: { enter: (_c, d) => seen.push(d) } }, 'a', {},
    [{ from: 'a', to: 'b', event: 'go' }]);
  const action = m.plan('go', 'first');
  m.plan('go', 'second');
  action();
  assert.deepEqual(seen, ['first']);
  const bad = new EventMachine({ a: {}, b: { enter: () => { throw new TypeError('hook'); } } }, 'a', {},
    [{ from: 'a', to: 'b', event: 'go' }]);
  assert.throws(() => bad.send('go', 42), /hook/);
  assert.equal(bad.data, undefined);
});

test('payload bubbles to ancestors, reaches nested plans and does not leak into delays', () => {
  const seen = [];
  const m = new EventMachine({ root: {}, a: { parent: 'root', plan: (_event, d) => { seen.push(d); return null; } },
    b: { parent: 'root' }, c: { enter: (_c, d) => seen.push(d) } }, 'a', {},
    [{ from: 'root', to: 'b', event: 'go' }, { from: 'b', to: 'c', after: 1 }]);
  using trace = new EventTrace(m);
  m.send('go', 7);
  m.update(1);
  assert.deepEqual(seen, [7, undefined]);
  assert.deepEqual(trace.records.map(r => r.data), [7, undefined]);
});
