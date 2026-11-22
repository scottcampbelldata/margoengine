// Pins InvokeMachine where invoke.test.js leaves it open: each refused task definition, a disposed runtime taking no
// events, and a task whose state was left without its exit hook (restoreMachine) cancelled at the next stable point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InvokeMachine } from '../dist/invoke.js';
import { restoreMachine, snapshotMachine } from '../dist/trace.js';

const run = () => new Promise(() => {});

test('a task needs a unique non-empty string id and a run function, on a state that is not final', () => {
  const refused = (states, what) =>
    assert.throws(
      () => new InvokeMachine(states, 'a', {}),
      (e) => e instanceof TypeError && /^Invalid invoked task/.test(e.message),
      what,
    );
  refused({ a: { invoke: [null] } }, 'a missing task');
  refused({ a: { invoke: { id: 7, run } } }, 'an id that is not a string');
  refused({ a: { invoke: { id: '', run } } }, 'an empty id');
  refused(
    {
      a: {
        invoke: [
          { id: 'x', run },
          { id: 'x', run },
        ],
      },
    },
    'a repeated id in one state',
  );
  refused({ a: { invoke: { id: 'x', run } }, b: { invoke: { id: 'x', run } } }, 'a repeated id across states');
  refused({ a: { invoke: { id: 'x', run: 'go' } } }, 'run that is not a function');
  refused({ a: {}, f: { final: true, invoke: { id: 'x', run } } }, 'a task on a final state');
  using ok = new InvokeMachine(
    {
      a: {
        invoke: [
          { id: 'x', run },
          { id: 'y', run },
        ],
      },
    },
    'a',
    {},
  );
  assert.deepEqual([...ok.invocations.keys()], ['x', 'y']);
});

test('a disposed runtime takes no events', () => {
  const m = new InvokeMachine({ a: { invoke: { id: 'x', run } }, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'go' },
  ]);
  m.dispose();
  assert.equal(m.invocations.get('x').status, 'cancelled');
  assert.equal(m.send('go'), false);
  assert.equal(m.state, 'a');
});

test('a task whose state was left without hooks is cancelled at the next stable point', async () => {
  using m = new InvokeMachine({ load: { invoke: { id: 'x', run } }, idle: {} }, 'load', {}, [
    { from: 'idle', to: 'load', event: 'reload' },
  ]);
  const record = m.invocations.get('x');
  const save = snapshotMachine(m);
  save.state = 'idle';
  save.entered = [['idle', 0]];
  restoreMachine(m, save); // runs no hooks, so the task is still running
  assert.equal(record.status, 'running');
  assert.equal(m.send('nothing'), false);
  assert.equal(record.status, 'cancelled');
  assert.equal(record.signal.aborted, true);
  await record.settled;
});
