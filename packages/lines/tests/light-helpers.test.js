import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LightsHelper,
  PointLightHelper,
  SpotLightHelper,
  DirectionalLightHelper,
  HemisphereLightHelper,
  RectAreaLightHelper,
  lightKind,
} from '../dist/index.js';

const close = (a, b, e = 1e-5, m = '') => assert.ok(Math.abs(a - b) <= e, `${m} expected ${b}, got ${a}`);
const point = (line, i) => [line.points[i * 4], line.points[i * 4 + 1], line.points[i * 4 + 2]];
const color = (line, i) => [line.colors[i * 4], line.colors[i * 4 + 1], line.colors[i * 4 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('lights are told apart by shape; anything else is skipped', () => {
  assert.equal(lightKind({ position: [0, 1, 0], range: 3 }), 'point');
  assert.equal(lightKind({ position: [0, 1, 0], range: 3, direction: [0, -1, 0], outerAngle: 0.5 }), 'spot');
  assert.equal(lightKind({ direction: [0, -1, 0] }), 'directional');
  assert.equal(lightKind({ position: [0, 1, 0], direction: [0, -1, 0], width: 1, height: 2 }), 'rect');
  assert.equal(lightKind({ sky: '#88aaff', ground: '#443322' }), 'hemisphere');
  for (const other of [null, 5, { vertical: [0], candela: [[1]] }, { width: 2, height: 2, data: new Uint8Array(16) }])
    assert.equal(lightKind(other), null);
});

test('point, spot, directional, rectangle and hemisphere helpers draw their lights', () => {
  const p = new PointLightHelper({ position: [1, 2, 3], color: [2, 1, 0] }, { size: 0.5 });
  assert.equal(p.count, 3 * 32 * 2, 'three circles');
  for (let i = 0; i < p.count; i++) close(dist(point(p, i), [1, 2, 3]), 0.5, 1e-5, 'on the circles');
  assert.deepEqual(color(p, 0), [1, 0.5, 0], "the light's colour, brightest channel 1");

  const spot = { position: [0, 4, 0], range: 2, direction: [0, -2, 0], outerAngle: Math.PI / 4, innerAngle: 0.3 },
    s = new SpotLightHelper(spot);
  // Apex to the rim at the range: 8 lines of length range / cos(outer), then the outer and inner rims.
  assert.equal(s.count, 8 * 2 + 32 * 2 * 2);
  close(dist(point(s, 0), [0, 4, 0]), 0, 1e-6, 'apex');
  close(dist(point(s, 1), [0, 4, 0]), 2 / Math.cos(Math.PI / 4), 1e-5, 'generator');
  close(point(s, 1)[1], 2, 1e-5, 'rim at the range');
  close(dist(point(s, 16 + 64), [0, 2, 0]), 2 * Math.tan(0.3), 1e-5, 'inner rim');
  const angle = new SpotLightHelper({ position: [0, 0, 0], range: 0, direction: [1, 0, 0], angle: 0.4 }, { length: 3 });
  close(point(angle, 1)[0], 3, 1e-5, 'unlimited range: the given length');

  const d = new DirectionalLightHelper({ direction: [0, -1, 0] }, { size: 2, position: [0, 5, 0] });
  assert.equal(d.count, 10, 'square and direction');
  close(point(d, 9)[1], 1, 1e-6, 'the way the light travels, twice the size');
  for (let i = 0; i < 8; i++) close(point(d, i)[1], 5, 1e-6, 'square across the direction');

  const r = new RectAreaLightHelper({ position: [0, 3, 0], direction: [0, -1, 0], width: 2, height: 1, up: [0, 0, 1] });
  assert.equal(r.count, 10);
  // AreaLights' axes: right = up x normal = (0,0,1) x (0,-1,0) = (1,0,0), so the width runs along x.
  const xs = Array.from({ length: 8 }, (_, i) => point(r, i)[0]),
    zs = Array.from({ length: 8 }, (_, i) => point(r, i)[2]);
  close(Math.max(...xs), 1, 1e-6, 'half width');
  close(Math.max(...zs), 0.5, 1e-6, 'half height');
  close(point(r, 9)[1], 2.5, 1e-6, 'normal');

  const h = new HemisphereLightHelper({ sky: [0, 0, 1], ground: [1, 0, 0] }, { size: 1 });
  let sky = 0,
    ground = 0;
  for (let i = 0; i < 32 * 2 * 2; i += 2) {
    const y = (point(h, i)[1] + point(h, i + 1)[1]) / 2;
    if (Math.abs(y) < 0.05) continue;
    const c = color(h, i);
    assert.deepEqual(c, y > 0 ? [0, 0, 1] : [1, 0, 0], `half at y ${y}`);
    if (y > 0) sky++;
    else ground++;
  }
  assert.ok(sky > 20 && ground > 20);
  assert.throws(() => new PointLightHelper({ direction: [0, 1, 0] }), TypeError);
  assert.throws(() => new LightsHelper(() => [], { size: 0 }), RangeError);
});

test('LightsHelper draws a list in one Line and rebuilds only when a drawn value changes', () => {
  let list = Object.freeze([{ position: [0, 1, 0], range: 2 }]);
  const helper = new LightsHelper(() => list, { color: '#ff0000' }),
    version = helper.version;
  assert.equal(helper.count, 3 * 32 * 2);
  assert.deepEqual(color(helper, 0), [1, 0, 0], 'one colour for all');
  helper.update();
  assert.equal(helper.version, version, 'unchanged list: no rebuild');
  list = Object.freeze([...list, { direction: [0, -1, 0] }, { vertical: [0] }, null]);
  helper.update();
  assert.equal(helper.count, 3 * 32 * 2 + 10, 'point and directional; the rest skipped');
  list[0].position[1] = 5;
  helper.update();
  close(Math.max(...Array.from({ length: 192 }, (_, i) => point(helper, i)[1])), 5.25, 1e-5, 'moved in place');
  list = [];
  helper.update();
  assert.equal(helper.count, 2, 'nothing to draw: one empty segment');
});
