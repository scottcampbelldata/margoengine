import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PointLightHelper } from '../dist/index.js';

function reference(position, size) {
  const points = [];
  for (const [u, v] of [
    [
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, 1],
    ],
  ])
    for (let i = 0; i < 32; i++)
      for (const j of [i, i + 1]) {
        const a = (j / 32) * Math.PI * 2;
        for (let k = 0; k < 3; k++) points.push(position[k] + (u[k] * Math.cos(a) + v[k] * Math.sin(a)) * size);
        points.push(0);
      }
  return new Float32Array(points);
}
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
test('moving point helpers retain all geometry bytes with zero repeated circle trigonometry', () => {
  const light = { position: [1, 2, 3], color: [2, 1, 0.5] };
  const expected = reference(light.position, 0.25);
  const sin = Math.sin,
    cos = Math.cos;
  let calls = 0;
  mock.method(Math, 'sin', (x) => {
    calls++;
    return sin(x);
  });
  mock.method(Math, 'cos', (x) => {
    calls++;
    return cos(x);
  });
  try {
    const helper = new PointLightHelper(light);
    assert.equal(calls, 66, 'one 33-sample circle table, rather than 1152 transcendental calls');
    assert.deepEqual(bytes(helper.points), bytes(expected));
    for (const position of [
      [-0, 1e-20, -1e10],
      [12.5, -3.75, 2],
      [1, 2, 3],
    ]) {
      light.position = position;
      calls = 0;
      helper.update();
      assert.equal(calls, 0, 'moving a helper reuses its original circle samples');
      // Keep the independent reference calculation out of the work count.
      const actual = bytes(helper.points);
      assert.deepEqual(actual, bytes(reference(position, 0.25)));
    }
  } finally {
    mock.restoreAll();
  }
});
