import test from 'node:test';
import assert from 'node:assert/strict';
import { Curve } from '../dist/index.js';
import { sweepGeometry } from '../dist/sweep.js';

class Loop extends Curve {
  getPoint(t) {
    const a = t * Math.PI * 2;
    return [30 * Math.cos(a), 2 * Math.sin(a * 2), 20 * Math.sin(a)];
  }
}

test('shared closed sweep wraps custom-curve endpoint tangents and joins positions and normals', () => {
  const path = new Loop(),
    frames = path.computeFrenetFrames(64, true);
  assert.deepEqual(frames.tangents[0], frames.tangents[64]);
  for (const up of [undefined, [0, 1, 0], frames.tangents[0]]) {
    const mesh = sweepGeometry(
      [
        [-2, 0],
        [2, 0],
      ],
      path,
      { steps: 64, closed: true, closedProfile: false, up },
    );
    const last = mesh.positions.length - 6;
    for (let k = 0; k < 6; k++) {
      assert.equal(mesh.positions[k], mesh.positions[last + k], `position ${k}`);
      assert.equal(mesh.normals[k], mesh.normals[last + k], `normal ${k}`);
    }
  }
});
