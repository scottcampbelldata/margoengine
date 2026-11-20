import test from 'node:test';
import assert from 'node:assert/strict';
import { ArcballGizmo } from '../dist/arcball.js';
import { camera } from './control-fakes.js';

// A press anywhere on a ring's drawn near half grabs that ring, with or without camera roll (ArcballControls writes
// camera.up). Pixels come from the camera's own matrix, which follows camera.up.
const AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const U = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 1, 0],
];
const V = [
  [0, -1, 0],
  [0, 0, -1],
  [-1, 0, 0],
];
const sweep = (up) => {
  const cam = camera({ position: [3, 4, 10], target: [0, 0, 0] });
  cam.up = up;
  cam.update(800 / 600, true);
  let turned = null;
  const target = {
    engine: { canvas: { clientWidth: 800 }, use() {}, sceneOf: () => null, camera: cam },
    element: { clientWidth: 800, clientHeight: 600 },
    camera: cam,
    state: 'none',
    rotate(axis, angle) {
      turned = [axis, angle];
    },
  };
  const gizmo = new ArcballGizmo(target, { autoHide: false }),
    r = gizmo.radius(),
    forward = [-3, -4, -10].map((v) => v / Math.hypot(3, 4, 10));
  const pixel = (p) => {
    const m = cam.matrix,
      x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [((x / w + 1) / 2) * 800, ((1 - y / w) / 2) * 600];
  };
  const on = (i, t) => U[i].map((x, j) => r * (x * Math.cos(t) + V[i][j] * Math.sin(t)));
  const nearHalf = (p) => p.reduce((s, v, j) => s + v * forward[j], 0) < -0.05 * r;
  // Screen samples of every ring's near half, to leave out presses within grab reach of another ring.
  const drawn = AXES.map((_, i) =>
    Array.from({ length: 2000 }, (_, k) => on(i, (k / 2000) * 2 * Math.PI))
      .filter(nearHalf)
      .map(pixel),
  );
  let presses = 0;
  const failures = [];
  AXES.forEach((axis, i) => {
    for (let k = 0; k < 720; k++) {
      const t = (k / 720) * 2 * Math.PI,
        p = on(i, t);
      if (!nearHalf(p)) continue;
      const s = pixel(p);
      if (drawn.some((ring, j) => j !== i && ring.some((q) => Math.hypot(q[0] - s[0], q[1] - s[1]) < 10))) continue;
      presses++;
      turned = null;
      if (!target.handle.begin(...s)) {
        failures.push(`ring ${i} at ${t.toFixed(3)} missed`);
        continue;
      }
      target.handle.move(...pixel(on(i, t + 0.01)));
      if (!turned || turned[0].join() !== axis.join()) failures.push(`ring ${i} at ${t.toFixed(3)} took another ring`);
      else if (!(turned[1] < 0)) failures.push(`ring ${i} at ${t.toFixed(3)} turned the wrong way`);
    }
  });
  gizmo.dispose();
  return { presses, failures };
};
for (const up of [
  [0, 1, 0],
  [1, 0, 0],
]) {
  test(`ArcballGizmo: every press on a ring's drawn near half grabs that ring, camera.up ${up}`, () => {
    const { presses, failures } = sweep(up);
    assert.ok(presses > 300, `${presses} presses`);
    assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${presses} presses failed`);
  });
}
