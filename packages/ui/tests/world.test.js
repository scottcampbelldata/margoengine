import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Button, Panel, Slider } from '../dist/index.js';
import { WorldPanel, WorldPanels, pickPanel, rayFromMatrix, screenRay } from '../dist/world.js';
import { makeUi, near } from './helpers.js';

// A 400 by 200 CSS pixel UI on a 2 by 1 metre panel at z = -3, facing +Z (towards a viewer at the origin).
function setup(options = {}) {
  const ui = makeUi({ width: 400, height: 200 });
  const panel = new WorldPanel(ui, { width: 2, position: [0, 1, -3], ...options });
  return { ui, panel };
}
const toward = (x, y, z, from = [0, 1, 0]) => ({ origin: from, direction: [x - from[0], y - from[1], z - from[2]] });

test('a ray meets the panel at the UI pixel under it; the height keeps the UI shape', () => {
  const { panel } = setup();
  near(panel.height, 1, 'height from the 2:1 UI');
  const centre = panel.intersect(toward(0, 1, -3));
  near(centre.x, 200, 'centre x');
  near(centre.y, 100, 'centre y');
  near(centre.distance, 1, 'unit distance = the whole direction');
  assert.equal(centre.inside, true);
  // The top-left corner of the panel is the UI's (0, 0); +Y in the world is up, y in the UI is down.
  const corner = panel.intersect(toward(-1, 1.5, -3));
  near(corner.x, 0, 'left edge');
  near(corner.y, 0, 'top edge');
  const lower = panel.intersect(toward(0.5, 0.75, -3));
  near(lower.x, 300, 'three quarters across');
  near(lower.y, 150, 'three quarters down');
  assert.deepEqual(
    lower.point.map((v) => Math.round(v * 1e6) / 1e6),
    [0.5, 0.75, -3],
  );
  assert.equal(panel.intersect(toward(1.5, 1, -3)).inside, false, 'past the right edge, on the plane');
});

test('rays that miss: parallel, pointing away, or from the back of a one-sided panel', () => {
  const { panel } = setup();
  assert.equal(panel.intersect({ origin: [0, 1, 0], direction: [1, 0, 0] }), null, 'parallel');
  assert.equal(panel.intersect({ origin: [0, 1, 0], direction: [0, 0, 1] }), null, 'away');
  assert.equal(panel.intersect(toward(0, 1, -3, [0, 1, -6])), null, 'from behind');
  assert.equal(panel.side([0, 1, 0]), 1);
  assert.equal(panel.side([0, 1, -6]), -1);
});

test('a double-sided panel is hit from behind, mirrored so its text reads the right way', () => {
  const { panel } = setup({ doubleSided: true });
  const front = panel.intersect(toward(0.5, 1, -3));
  const back = panel.intersect(toward(0.5, 1, -3, [0, 1, -6]));
  near(front.x, 300, 'right of centre from the front');
  // Seen from behind, world +X is the viewer's left: the UI is mirrored, so the same world point is left of centre.
  near(back.x, 100, 'left of centre from behind');
  assert.equal(back.back, true);
});

test('a rotated pose: a panel turned to face +X', () => {
  const s = Math.SQRT1_2;
  // 90 degrees about +Y: the panel's +Z normal points along +X, its +X axis along -Z.
  const { panel } = setup({ position: [3, 1, 0], rotation: [0, s, 0, s] });
  const hit = panel.intersect(toward(3, 1, -0.5, [6, 1, 0]));
  near(hit.distance, 1, 'reaches the plane at the end of the direction');
  near(hit.x, 300, 'half a metre along the panel X axis (world -Z) on a 2 metre panel');
  assert.throws(() => panel.setPose([0, 0, 0], [0, 0, 0, 2]), RangeError);
  assert.throws(() => new WorldPanel(makeUi(), { width: 0 }), RangeError);
  assert.throws(() => new WorldPanel({}), TypeError);
});

test('a ray click presses a button on the panel; a click beside it reaches nothing', () => {
  const { ui, panel } = setup();
  let clicks = 0;
  const button = new Button({ text: 'Go', width: 120, anchor: 'center', onClick: () => clicks++ });
  ui.add(button);
  ui.update(0);
  const ray = toward(0, 1, -3);
  assert.equal(panel.pointerMove(ray), true);
  assert.equal(panel.pointerDown(ray), true);
  assert.equal(panel.pointerUp(ray), true);
  assert.equal(clicks, 1);
  const beside = toward(1.5, 1, -3);
  assert.equal(panel.pointerDown(beside), false, 'off the panel, the game has the press');
  assert.equal(clicks, 1);
});

test('WorldPanels routes a pointer to the nearest panel, keeps a drag on its panel, and handles XR controllers', () => {
  const near1 = setup({ position: [0, 1, -2] }),
    far1 = setup({ position: [0, 1, -4] });
  let nearClicks = 0,
    farClicks = 0;
  near1.ui.add(new Button({ text: 'Near', width: 400, height: 200, anchor: 'stretch', onClick: () => nearClicks++ }));
  far1.ui.add(new Button({ text: 'Far', width: 400, height: 200, anchor: 'stretch', onClick: () => farClicks++ }));
  near1.ui.update(0);
  far1.ui.update(0);
  const panels = new WorldPanels({ input: false }).add(near1.panel, far1.panel);
  assert.equal(pickPanel(panels.list, toward(0, 1, -3)).panel, near1.panel, 'the nearer panel is in front');
  const ray = toward(0, 1, -3);
  assert.equal(panels.pointer(ray, false), true);
  panels.pointer(ray, true);
  panels.pointer(ray, false);
  assert.deepEqual([nearClicks, farClicks], [1, 0]);
  near1.panel.visible = false;
  panels.pointer(ray, true);
  panels.pointer(ray, false);
  assert.deepEqual([nearClicks, farClicks], [1, 1], 'a hidden panel lets the ray through');

  // A slider drag keeps going when the ray slides off the panel's edge.
  const { ui, panel } = setup();
  const slider = new Slider({ value: 0.5, width: 400, anchor: 'center' });
  ui.add(new Panel({ anchor: 'stretch', children: [slider] }));
  ui.update(0);
  const drag = new WorldPanels({ input: false }).add(panel);
  const r = slider.rect;
  const at = (x) => {
    const cx = r.x + x,
      cy = r.y + r.height / 2;
    return toward(-1 + (cx / 400) * 2, 1.5 - cy / 200, -3);
  };
  drag.pointer(at(r.width / 2), true);
  drag.pointer(at(r.width * 2), true);
  assert.equal(slider.value, 1, 'dragging past the right edge, off the panel, pins the slider at its maximum');
  drag.pointer(at(r.width * 2), false);

  // An XR controller pointing at the button presses with its trigger (button 0, the "pressed" entry at index 1).
  const pose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]); // at (0, 1, 0), pointing -Z
  assert.deepEqual([...rayFromMatrix(pose).direction], [-0, -0, -1]);
  near1.panel.visible = true;
  const buttons = new Float32Array(96);
  panels.controller({ targetRayMatrix: pose, buttons }, 1);
  buttons[1] = 1;
  panels.controller({ targetRayMatrix: pose, buttons }, 1);
  buttons[1] = 0;
  panels.controller({ targetRayMatrix: pose, buttons }, 1);
  assert.equal(nearClicks, 2, 'the trigger clicked the near panel');
  assert.equal(panels.controller({ targetRayMatrix: new Float32Array(16), buttons }, 1), false, 'untracked');
  assert.throws(() => panels.add({}), TypeError);
});

test('screenRay goes from the camera through the pixel', () => {
  // A camera at the origin looking down -Z with a 90 degree field of view, on the WebGPU depth convention.
  const n = 0.1,
    f = 100,
    matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = n / (f - n);
  matrix[11] = -1;
  matrix[14] = (f * n) / (f - n);
  const camera = { matrix, position: [0, 0, 0] };
  const centre = screenRay(camera, 50, 50, 100, 100);
  near(centre.direction[2], -1, 'the centre looks straight ahead');
  const corner = screenRay(camera, 100, 0, 100, 100);
  const d = corner.direction;
  near(d[0], 1 / Math.sqrt(3), 'top right x');
  near(d[1], 1 / Math.sqrt(3), 'top right y');
  near(d[2], -1 / Math.sqrt(3), 'top right z');
});

test('WorldPanels refuses the WebGL2 preview before installing input or taking ownership', () => {
  const { ui, panel } = setup();
  const plugin = new WorldPanels({ input: false }).add(panel);
  try {
    assert.throws(
      () => plugin.setup({ backend: 'webgl2' }),
      (error) => error.code === 'unsupported' && /https:\/\/margoengine.com\/errors#webgpu/.test(error.message),
    );
    let updated = 0;
    const update = ui.update.bind(ui);
    ui.update = (dt) => {
      updated++;
      update(dt);
    };
    plugin.onPreUpdate(1 / 60);
    assert.equal(updated, 1);
  } finally {
    plugin.dispose();
  }
});
