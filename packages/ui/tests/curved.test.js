import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CurvedPanel, layoutPanels } from '../dist/curved.js';
import { WorldPanel, pickPanel } from '../dist/world.js';
import { makeUi, near } from './helpers.js';

for (const shape of ['cylinder', 'sphere']) {
  test(`${shape}: analytic UVs, arbitrary ray length, transformed pose and missed patches`, () => {
    const panel = new CurvedPanel(makeUi({ width: 400, height: 200 }), { shape, width: 3, height: 1.6, radius: 2 });
    for (const u of [0.02, 0.25, 0.5, 0.9, 0.98])
      for (const v of [0.02, 0.3, 0.5, 0.98]) {
        const p = panel.pointAt(u, v),
          origin = [p[0] * 2, shape === 'sphere' ? p[1] * 2 : p[1], (p[2] + 2) * 2 - 2];
        const ray = { origin, direction: p.map((x, i) => x - origin[i]) },
          hit = panel.intersect(ray);
        assert.equal(hit.inside, true);
        near(hit.x, u * 400);
        near(hit.y, v * 200);
        near(hit.distance, 1);
      }
    assert.equal(panel.intersect({ origin: [10, 0, 5], direction: [0, 0, -1] }), null);
    assert.equal(panel.intersect({ origin: [0, 0, 3], direction: [0, 0, 1] }), null);
    panel.setPose([2, 3, 4], [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    const hit = panel.intersect({ origin: [5, 3, 4], direction: [-3, 0, 0] });
    near(hit.x, 200, 'rotated centre');
    near(hit.y, 100);
    near(hit.distance, 1);
    assert.equal(pickPanel([panel], { origin: [5, 3, 4], direction: [-3, 0, 0] }).panel, panel);
  });
  test(`${shape}: back hits mirror text and patch filtering checks both roots`, () => {
    const panel = new CurvedPanel(makeUi({ width: 400, height: 200 }), { shape, width: 3, radius: 2 });
    const p = panel.pointAt(0.75, 0.5),
      ray = { origin: [0, 0, -2], direction: [p[0], 0, p[2] + 2] };
    assert.equal(panel.intersect(ray), null);
    panel.doubleSided = true;
    const h = panel.intersect(ray);
    assert.equal(h.back, true);
    near(h.x, 100);
    near(h.distance, 1);
    // First sphere root is outside the finite patch; the second is the panel's back.
    const far = panel.intersect({ origin: [0, 0, -6], direction: [0, 0, 1] });
    assert.equal(far.inside, true);
    near(far.distance, 6);
  });
}
test('plane, cylinder and sphere arrangements set tangent poses and centre incomplete rows', () => {
  for (const shape of ['plane', 'cylinder', 'sphere']) {
    const panels = Array.from({ length: 5 }, () => new WorldPanel(makeUi()));
    layoutPanels(panels, { shape, columns: 3, spacing: [1, 1], radius: 3 });
    near(panels[1].matrix[12], 0);
    near(panels[3].matrix[12], -panels[4].matrix[12]);
    for (const p of panels) near(Math.hypot(p.matrix[8], p.matrix[9], p.matrix[10]), 1);
    if (shape === 'sphere') {
      for (const p of panels) {
        const radial = [p.matrix[12], p.matrix[13], p.matrix[14] + 3];
        for (let j = 0; j < 3; j++) near(radial[j] / 3, p.matrix[8 + j]);
      }
    }
  }
  assert.throws(() => layoutPanels([], { columns: 0 }), RangeError);
  assert.throws(() => new CurvedPanel(makeUi(), { radius: 0 }), RangeError);
  assert.throws(() => new CurvedPanel(makeUi(), { shape: 'sphere', height: 7 }), RangeError);
});
