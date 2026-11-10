import assert from 'node:assert/strict';
import test from 'node:test';
import { profileTask } from '../bench/lib/profile-task.mjs';

test('profile task executes one operation and discards all timing fields', async () => {
  const methods = [];
  let calls = 0,
    disconnected = false;
  const session = {
    connect() {},
    disconnect() {
      disconnected = true;
    },
    async post(method) {
      methods.push(method);
      if (method === 'Profiler.stop')
        return {
          profile: {
            startTime: 1,
            endTime: 100,
            timeDeltas: [99],
            nodes: [
              { callFrame: { functionName: 'work', url: 'local.js', lineNumber: 3 }, hitCount: 2 },
              { callFrame: { functionName: 'unused', url: '', lineNumber: 0 } },
            ],
          },
        };
    },
  };
  const result = await profileTask(async (i) => {
    assert.equal(i, 0);
    calls++;
  }, session);
  assert.equal(calls, 1);
  assert.equal(disconnected, true);
  assert.deepEqual(methods, ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop']);
  assert.deepEqual(result, [{ function: 'work', url: 'local.js', line: 4, samples: 2 }]);
});

test('profile task preserves task errors and disconnects the inspector', async () => {
  const error = new Error('task failed');
  let disconnected = false;
  await assert.rejects(
    profileTask(
      () => {
        throw error;
      },
      {
        connect() {},
        async post() {},
        disconnect() {
          disconnected = true;
        },
      },
    ),
    (e) => e === error,
  );
  assert.equal(disconnected, true);
});
