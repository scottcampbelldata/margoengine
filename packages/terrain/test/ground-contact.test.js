// The ground-contact mask: footprint profiles and the CPU bake (`@margoengine/terrain/ground-contact`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUND_CONTACT_SETTINGS,
  applyGroundContactSettings,
  groundContactSettingDefaults,
} from '../dist/ground-contact-settings.js';

const near = (got, want, within, what) => assert.ok(Math.abs(got - want) <= within, `${what}: ${got}, want ${want}`);

test('footprintAt loses the sky of a resting sphere and lays soil that ends past the foot', async () => {
  const { footprintAt } = await import('../dist/ground-contact.js');
  for (const [x, loss] of [
    [1, 0.354],
    [2, 0.089],
    [3, 0.032],
  ])
    near(footprintAt(x, 1, 1)[1], loss, 0.001, `stone loss at ${x} radii`);
  near(footprintAt(1, 1, 0)[1], 0.6 * 0.354, 0.001, 'a trunk takes 0.6 of it');
  assert.deepEqual(footprintAt(4, 1, 1), [0, 0]);
  assert.deepEqual(footprintAt(1, 0, 1), [0, 0]);
  // A stone's ring: full (0.75) to a quarter radius past the edge, an e-fold of 0.35 radius beyond.
  near(footprintAt(0.5, 0.4, 1)[0], 0.75, 1e-9, 'ring');
  near(footprintAt(0.5 + 0.14, 0.4, 1)[0], 0.75 / Math.E, 0.001, 'one e-fold out');
  // A trunk's duff: exp(-s / (1.1 r)), none 3 radii past the bark.
  near(footprintAt(0.2 + 0.22, 0.2, 0)[0], 1 / Math.E, 0.001, 'trunk e-fold');
  assert.equal(footprintAt(0.2 + 0.6, 0.2, 0)[0], 0);
});

test('bakeGroundContact writes soil and sky loss in texels and combines footprints', async () => {
  const { bakeGroundContact, footprintAt } = await import('../dist/ground-contact.js');
  const size = 64,
    texel = 0.1,
    at = (mask, x, z) => {
      const k = (Math.floor(z / texel) * size + Math.floor(x / texel)) * 2;
      return [mask[k] / 255, mask[k + 1] / 255];
    };
  const one = bakeGroundContact([[3.25, 3.25, 0.5, 1]], [0, 0], size, texel);
  const [soil, loss] = at(one, 3.75, 3.25),
    centre = Math.hypot(3.75 - 3.25, 0),
    want = footprintAt(centre, 0.5, 1);
  near(soil, want[0], 0.01, 'soil');
  near(loss, want[1], 0.01, 'loss');
  assert.deepEqual(at(one, 5.45, 3.25), [0, 0], 'nothing past four radii');
  // Two stones: the soil takes the larger weight, the losses combine as independent occluders.
  const two = bakeGroundContact(
    [
      [3.25, 3.25, 0.5, 1],
      [4.25, 3.25, 0.5, 1],
    ],
    [0, 0],
    size,
    texel,
  );
  const [s2, l2] = at(two, 3.75, 3.25);
  near(s2, want[0], 0.01, 'largest soil');
  near(l2, 1 - (1 - want[1]) ** 2, 0.01, 'combined loss');
  // The buffer is reused and cleared; a footprint under a texel is scaled to the area it covers.
  const small = bakeGroundContact([[3.25, 3.25, 0.01, 1]], [0, 0], size, texel, two);
  assert.equal(small, two);
  assert.deepEqual(at(small, 4.25, 3.25), [0, 0]);
  assert.ok(at(small, 3.25, 3.25)[1] < 0.25);
});

test('TerrainGroundContact checks its options and footprints and patches the terrain shader', async () => {
  const { TerrainGroundContact } = await import('../dist/ground-contact.js'),
    terrain = { addLighting: () => () => {} };
  assert.throws(() => new TerrainGroundContact({}), TypeError);
  for (const bad of [{ texel: 0 }, { resolution: 63 }, { binding: 998 }, { soil: 2 }, { color: [0, 0] }])
    assert.throws(() => new TerrainGroundContact(terrain, bad), RangeError, JSON.stringify(bad));
  const contact = new TerrainGroundContact(terrain);
  assert.throws(() => contact.set('a', [0, 0, 1]), RangeError);
  assert.throws(() => contact.set('a', [0, Number.NaN, 1, 0]), RangeError);
  contact.set('a', [0, 0, 1, 0, 2, 2, 0.5, 1]);
  assert.equal(contact.count, 2);
  contact.set('a', []);
  assert.equal(contact.count, 0);
  const source =
    'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {return vec3f(1);}\n@fragment fn fragment(i:Output)->@location(0) vec4f {let linear=direct+base*frame.radiance.w*frame.ambient.rgb;}';
  const code = contact.shader(source, 1);
  assert.match(code, /\+base\*frame\.radiance\.w\*frame\.ambient\.rgb\*contactSky_c\d+;/);
  assert.match(code, /fn terrainColorBare_c\d+/);
  assert.throws(() => contact.shader('fn other(){}', 1), { code: 'unsupported' });
  contact.dispose();
  assert.throws(() => contact.set('a', [0, 0, 1, 0]), { code: 'disposed' });
});

test('the settings table writes the live look and refuses unknown names and values', () => {
  assert.deepEqual(
    GROUND_CONTACT_SETTINGS.map((row) => [row.name, row.live]),
    [
      ['contact.color', true],
      ['contact.soil', true],
      ['contact.occlusion', true],
    ],
  );
  const contact = new TerrainGroundContact({ addLighting: () => () => {} });
  assert.deepEqual(
    groundContactSettingDefaults(),
    Object.fromEntries(Object.entries(contact.look).map(([k, v]) => ['contact.' + k, v])),
  );
  applyGroundContactSettings(contact, { 'contact.soil': 0.5, 'contact.color': [0.2, 0.1, 0] });
  assert.deepEqual(contact.look, { color: [0.2, 0.1, 0], soil: 0.5, occlusion: 1 });
  assert.throws(() => applyGroundContactSettings(contact, { nope: 1 }), TypeError);
  assert.throws(() => applyGroundContactSettings(contact, { 'contact.soil': 2 }), RangeError);
});
