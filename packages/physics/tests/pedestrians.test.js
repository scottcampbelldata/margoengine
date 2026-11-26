import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PedestrianCrowd } from '@margoengine/physics/pedestrians';
import { PhysicsWorld } from '@margoengine/physics/world';

test('the optional pedestrian load respects cancellation', async () => {
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(PedestrianCrowd.load({ signal: cancel.signal }), { name: 'AbortError' });
});

test('invalid clearance geometry and body mass provide actionable errors', async () => {
  const crowd = await PedestrianCrowd.load();
  assert.throws(() => new PhysicsWorld().add(crowd, { bodies: [{ position: [0, 0, 0], mass: 0 }] }), /Set mass/);
  assert.throws(
    () =>
      new PhysicsWorld().add(crowd, {
        bodies: [{ position: [0, 0, 0] }],
        walls: [
          [
            [1, 0],
            [1, 0],
          ],
        ],
      }),
    /Give each wall and aperture/,
  );
});
