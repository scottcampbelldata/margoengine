import test from 'node:test';
import assert from 'node:assert/strict';
import { layered } from '../dist/layered.js';
import { sootDensity, sootMask, soot, sootDecal } from '../dist/soot.js';
import * as presets from '../dist/presets.js';

const fire = [0, 0.2, 0];
const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test('the plume: densest at the fire, thinning as (b0 / b)^(5/3) with height and as a Gaussian sideways', () => {
  close(sootDensity({ fire }, fire), 0.85);
  // b0 = 0.3 (width 0.6), b = 0.3 + 0.12 x 0.5 = 0.36 half a metre up.
  close(sootDensity({ fire }, [0, 0.7, 0]), 0.85 * (0.3 / 0.36) ** (5 / 3));
  close(sootDensity({ fire }, [0.36, 0.7, 0]), 0.85 * (0.3 / 0.36) ** (5 / 3) * Math.exp(-1));
  close(sootDensity({ fire, width: 1, strength: 1, spread: 0.2 }, [0, 1.2, 0]), (0.5 / 0.7) ** (5 / 3));
  // The floor patch: radial around the fire, fading below its base.
  close(sootDensity({ fire }, [0.3, 0.2, 0]), 0.85 * Math.exp(-1));
  close(sootDensity({ fire }, [0, 0.1, 0]), 0.85 * Math.exp(-1));
  assert.ok(sootDensity({ fire }, [0, 2, 0]) < sootDensity({ fire }, [0, 1, 0]));
  assert.ok(sootDensity({ fire }, [2, 0.2, 0]) < 1e-6);
});

test('sootMask: the density over a face as a linear clamped texture, row 0 at v = 0', () => {
  // A back wall 0.3 m behind the fire, 1.2 m wide and 1.6 m tall, from the hearth floor up.
  const wall = { origin: [-0.6, 0.2, -0.3], u: [1.2, 0, 0], v: [0, 1.6, 0] };
  const t = sootMask({ fire }, wall, { size: 8 }),
    { data, width, height } = t.source;
  assert.equal(width, 8);
  assert.equal(height, 8);
  assert.equal(t.options.colorSpace, 'linear');
  assert.equal(t.options.wrapS, 'clamp');
  const at = (col, row) => data[(row * 8 + col) * 4];
  const expected = Math.round(sootDensity({ fire }, [-0.6 + (3.5 / 8) * 1.2, 0.2 + (0.5 / 8) * 1.6, -0.3]) * 255);
  assert.equal(at(3, 0), expected);
  assert.ok(at(3, 0) > at(3, 7), 'darker at the bottom, by the fire');
  assert.ok(at(3, 4) > at(0, 4), 'darker over the fire than at the side');
  assert.equal(data[3], 255);
  assert.throws(() => sootMask({ fire }, wall, { size: 3 }), RangeError);
  assert.throws(() => sootMask({ fire }, { origin: [0, 0], u: [1, 0, 0], v: [0, 1, 0] }), RangeError);
});

test('soot: a layered() layer of the deposit colour, matte, masked by the plume', () => {
  const mantel = { origin: [-0.8, 0.95, 0.2], u: [1.6, 0, 0], v: [0, 0, -0.3] };
  const layer = soot({ fire }, mantel);
  assert.deepEqual(layer.color, [0.03, 0.028, 0.026]);
  assert.equal(layer.roughness, 0.95);
  assert.equal(layer.metalness, 0);
  assert.equal(layer.mask.source.width, 64);
  const feature = layered({ layers: [layer] });
  assert.equal(feature.layers[0], layer);
  assert.equal(soot({ fire }, mantel, { color: [0.1, 0.1, 0.1], roughness: 0.5, size: 16 }).mask.source.width, 16);
  for (const bad of [
    () => soot(null, mantel),
    () => soot({ fire: [0, NaN, 0] }, mantel),
    () => soot({ fire, width: 0 }, mantel),
    () => soot({ fire, strength: 2 }, mantel),
    () => soot({ fire, spread: -1 }, mantel),
    () => soot({ fire, floorDepth: 0 }, mantel),
    () => soot({ fire }, mantel, { color: [2, 0, 0] }),
    () => soot({ fire }, mantel, { roughness: -1 }),
  ])
    assert.throws(bad, /soot/);
});

test('sootDecal: a multiply decal over the plume that reads a soot atlas fire end down', () => {
  const d = sootDecal({ fire }, [0, 0, -1]);
  assert.deepEqual(d.position, [0, 0.95, 0]);
  assert.deepEqual(d.direction, [0, 0, -1]);
  assert.equal(d.height, 1.5);
  close(d.width, 2 * (0.3 + 0.12 * 1.5) * 1.5);
  assert.deepEqual(d.rect, [0, 1, 1, 0]);
  assert.equal(d.mode, 'multiply');
  assert.equal(d.opacity, 0.85);
  assert.throws(() => sootDecal({ fire }, [0, -1, 0]), RangeError);
  assert.throws(() => sootDecal({ fire }, [0, 0, -1], { height: 0 }), RangeError);
});

test('presets: plain frozen options; metals from measured F0, tarnished copper darker and rougher', () => {
  // Johnson and Christy 1972 and 1974 through the spectral integrator (test/measured-library.test.js); Hoffman's
  // course figures (0.955, 0.638, 0.538) and (0.562, 0.565, 0.578) until 2026-11-28.
  assert.deepEqual(presets.copper.color, [0.9216, 0.6251, 0.5207, 1]);
  assert.deepEqual(presets.iron.color, [0.5289, 0.5136, 0.4938, 1]);
  assert.equal(presets.copper.metalness, 1);
  assert.ok(presets.tarnishedCopper.roughness > presets.copper.roughness);
  for (let k = 0; k < 3; k++) assert.ok(presets.tarnishedCopper.color[k] < presets.copper.color[k]);
  for (const name of ['soot', 'hearthstone', 'weatheredWood', 'brick']) assert.equal(presets[name].metalness, 0);
  assert.ok(Object.isFrozen(presets.copper) && Object.isFrozen(presets.copper.color));
  assert.ok(presets.soot.color[0] < 0.05);
  // Weathered wood reflects enough moonlight to read as wood at night: at luminance 0.13 the Cabin Hearth's log walls
  // read black in every outside shot (the page's measured fix was 0.21, sRGB #8b7d6b).
  const [r, g, b] = presets.weatheredWood.color;
  assert.ok(
    0.2126 * r + 0.7152 * g + 0.0722 * b >= 0.2,
    `weathered wood luminance ${0.2126 * r + 0.7152 * g + 0.0722 * b}`,
  );
});
