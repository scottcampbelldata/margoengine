import test from 'node:test';
import assert from 'node:assert/strict';
import { junctions } from '../dist/junctions.js';

test('junctions reject float32 face collapse and UV overflow instead of returning corrupt data', async () => {
  await assert.rejects(
    junctions([
      {
        points: [
          [999990, 999990],
          [1000000, 999990],
        ],
        width: 0.01,
      },
    ]),
    { code: 'failed', message: /float32 precision/ },
  );
  await assert.rejects(
    junctions(
      [
        {
          points: [
            [0, 0],
            [10, 0],
          ],
          width: 4,
        },
      ],
      { uvMeters: 1e-300 },
    ),
    { code: 'failed', message: /UV coordinates overflowed/ },
  );
  const local = await junctions([
    {
      points: [
        [0, 0],
        [10, 0],
      ],
      width: 0.01,
    },
  ]);
  assert.ok(local.area > 0);
  assert.ok(local.uvs.every(Number.isFinite));
});
