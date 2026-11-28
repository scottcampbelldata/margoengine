// VolumetricClouds groundLights and mist: lit ground under the deck lights its base from below, and the air under the
// deck takes that light (Kyba et al. 2011, Kocifaj 2007, Jechow and Holker 2019). The pictures are proved on a real GPU,
// WebGPU and the WebGL2 layer, by features-check.mjs ground-light.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VolumetricClouds,
  CLOUD_FLOATS,
  cloudDeckTransmittance,
  cloudGroundLight,
  layerOf,
  writeGround,
} from '@margoengine/sky/volumetric-clouds';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const deck = { coverage: 1, bottom: 800, top: 1400, density: 0.03 };

test('ground lights and mist validate and name the fix', () => {
  const ok = { color: [1, 0.5, 0.2], x: -3000, z: 3000, radius: 4000 };
  assert.doesNotThrow(() => new VolumetricClouds({ groundLights: [ok], mist: { visibility: 3000 } }));
  assert.doesNotThrow(() => new VolumetricClouds({ groundLights: [] }));
  for (const groundLights of [
    {},
    new Array(9).fill(ok),
    [{ ...ok, color: [1, 1] }],
    [{ ...ok, color: [-1, 0, 0] }],
    [{ ...ok, x: Number.NaN }],
    [{ ...ok, radius: 0 }],
    [null],
  ])
    assert.throws(() => new VolumetricClouds({ groundLights }), /groundLights/, JSON.stringify(groundLights));
  for (const mist of [null, {}, { visibility: 5 }, { visibility: Infinity }])
    assert.throws(() => new VolumetricClouds({ mist }), /mist/, JSON.stringify(mist));
});

test('a lit disc lights the base by the Lambertian disc law and keeps its whole flux', () => {
  const light = { color: [2, 1, 0.5], x: 100, z: -200, radius: 3000 },
    options = { ...deck, groundAlbedo: 0, groundLights: [light] },
    h = deck.bottom,
    rho = light.radius;
  // Over the centre: the view factor of a disc to a parallel point over it, rho^2 / (h^2 + rho^2).
  const centre = cloudGroundLight(options, light.x, light.z);
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(centre[i] - (light.color[i] * rho ** 2) / (h ** 2 + rho ** 2)) < 1e-12);
  // Falls with distance across and is round.
  const near = cloudGroundLight(options, light.x + 2000, light.z)[0],
    far = cloudGroundLight(options, light.x + 8000, light.z)[0];
  assert.ok(centre[0] > near && near > far && far > 0);
  assert.equal(cloudGroundLight(options, light.x, light.z + 2000)[0], near);
  // Flux: the base receives pi x radiance (E = pi L) over the plane, which sums to the disc's pi rho^2 x pi L.
  let flux = 0;
  for (let r = 5; r < 4e6; r *= 1.002)
    flux += Math.PI * cloudGroundLight(options, light.x + r, light.z)[0] * 2 * Math.PI * r * r * 0.002;
  assert.ok(Math.abs(flux / (Math.PI * rho ** 2 * Math.PI * light.color[0]) - 1) < 0.005, `flux ${flux}`);
  // A disc wider than the sky gives the even light from below it would as `ambient[1]`.
  const wide = cloudGroundLight({ ...options, groundLights: [{ ...light, radius: 1e6 }] }, 0, 0);
  assert.ok(Math.abs(wide[0] / light.color[0] - 1) < 1e-5);
  // None: nothing.
  assert.deepEqual(cloudGroundLight(deck, 0, 0), [0, 0, 0]);
});

test('the ground and the deck reflect the light between them: 1 / (1 - albedo x deck reflectance)', () => {
  const light = { color: [1, 1, 1], x: 0, z: 0, radius: 2000 },
    plain = cloudGroundLight({ ...deck, groundAlbedo: 0, groundLights: [light] }, 0, 0)[0];
  for (const groundAlbedo of [0.1, 0.8]) {
    const r = 1 - cloudDeckTransmittance(layerOf(deck), 0.6),
      gain = cloudGroundLight({ ...deck, groundAlbedo, groundLights: [light] }, 0, 0)[0] / plain;
    assert.ok(Math.abs(gain - 1 / (1 - groundAlbedo * r)) < 1e-12, `albedo ${groundAlbedo}: ${gain}`);
  }
  // Fresh snow under a thick deck more than doubles it (Jechow and Holker 2019).
  const thick = { ...deck, density: 0.1 },
    bare = cloudGroundLight({ ...thick, groundAlbedo: 0, groundLights: [light] }, 0, 0)[0];
  assert.ok(cloudGroundLight({ ...thick, groundAlbedo: 0.8, groundLights: [light] }, 0, 0)[0] > 2 * bare);
});

test('the uniform holds the lights and the mist after the haze, and nothing without them', () => {
  const v = new Float32Array(CLOUD_FLOATS).fill(7),
    light = { color: [0.4, 0.2, 0.1], x: -50, z: 70, radius: 300 },
    options = { ...deck, groundAlbedo: 0, groundLights: [light], mist: { visibility: 3912 } };
  writeGround(v, options);
  const f = Math.fround;
  assert.deepEqual([...v.subarray(232, 240)], [f(0.4), f(0.2), f(0.1), 90000, -50, 0, 70, 0]);
  assert.ok(
    v.subarray(240, 296).every((x) => x === 0),
    'the lights left over end the list',
  );
  const r = 1 - cloudDeckTransmittance(layerOf(options), 0.6);
  assert.deepEqual([...v.subarray(296, 300)], [f(0.001), f(r), f(1 - r), 200]);
  assert.ok(
    v.subarray(0, 232).every((x) => x === 7),
    'the layer, the light and the haze stay as they are',
  );
  writeGround(v, deck);
  assert.ok(
    v.subarray(232).every((x) => x === 0),
    'no lights, no mist',
  );
});

test('the march takes the ground lights from below and the picture draws the mist over the sky', () => {
  const h = tracedGPU(),
    clouds = new VolumetricClouds({
      ...deck,
      sunDirection: [0, -1, 0],
      groundLights: [{ color: [1, 0.5, 0.2], x: 0, z: 0 }],
    });
  h.engine.use(clouds);
  clouds.onPreUpdate(h.context.delta);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /let sky=cloudSkyScatter\(above,below\+cloudGround\(p\.xz,bottom\),aUp,below0,nuUp\);/);
  assert.match(code, /if\(open&&clouds\.mist\.x>0\.0\)\{let air=cloudMist\(d\);/);
  assert.equal(
    clouds['values'][232],
    Math.fround(1 / (1 - 0.2 * (1 - cloudDeckTransmittance(layerOf(deck), 0.6)))),
    'gain',
  );
  clouds.dispose();
});
