// Rough-transmission blur level: the mip whose box width matches the transmitted GGX lobe on screen. Runs the hook's
// own WGSL and checks it against the normal-incidence Snell construction worked out here from first principles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Transmission } from '../dist/transmission.js';
import { wgslModule } from './support/wgsl-subset.js';

const HEIGHT = 128,
  LEVELS = 9;
// Perspective with cot(fov/2) = `scale`, eye at +3 looking down -Z (columns).
const perspective = (scale) => [
  [scale / 2, 0, 0, 0],
  [0, scale, 0, 0],
  [0, 0, -1, -1],
  [0, 0, 2.9, 3],
];
// Orthographic view of height 4 world units (y scale 2/4); w row is (0, 0, 0, 1).
const orthographic = [
  [0.25, 0, 0, 0],
  [0, 0.5, 0, 0],
  [0, 0, -0.1, 0],
  [0, 0, 0.5, 1],
];
const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const pass = new Transmission().declarations(2);

function level({ roughness, ior, camera = perspective(1), thickness = 0 }) {
  let read;
  const shader = wgslModule(pass, {
    f: { eye: [0, 0, 3, 1], camera, model: identity, ext: [0, ior, 0, 0] },
    margoVolume: [thickness, 1, 1, 1],
    margoScene: 'scene',
    margoSceneSampler: 'sampler',
    textureDimensions: () => [256, HEIGHT],
    textureNumLevels: () => LEVELS,
    textureSampleLevel: (_t, _s, _uv, l) => {
      read ??= l;
      return [0, 0, 0, 1];
    },
  });
  const surface = { n: [0, 0, 1], base: [1, 1, 1, 1], metal: 0, roughness, tr: 1, th: 1, f0: [0, 0, 0] };
  shader.call('margoTransmission', surface, [0, 0, 1], { position: [0, 0, 0] });
  return read;
}
// Expected: median GGX tilt atan(alpha), Snell at that facet, deviation from straight through, lobe diameter in texels.
function expected({ roughness, ior, scale = 1, reach = 1 }) {
  const tilt = Math.atan(roughness * roughness),
    out = Math.asin(Math.sin(tilt) / ior),
    texels = Math.tan(tilt - out) * reach * scale * HEIGHT;
  return Math.min(Math.max(Math.log2(Math.max(texels, 1)), 0), LEVELS - 1);
}

test('no blur at IOR 1 or roughness 0', () => {
  for (const roughness of [0, 0.5, 1]) assert.equal(level({ roughness, ior: 1 }), 0);
  for (const ior of [1.2, 1.5, 2.4]) assert.equal(level({ roughness: 0, ior }), 0);
});

test('level matches the Snell construction and grows with IOR past 1.5 (no saturation)', () => {
  const iors = [1.1, 1.33, 1.5, 1.8, 2.4];
  const levels = iors.map((ior) => level({ roughness: 0.7, ior }));
  for (let k = 0; k < iors.length; k++) {
    assert.ok(Math.abs(levels[k] - expected({ roughness: 0.7, ior: iors[k] })) < 1e-4, `IOR ${iors[k]}`);
    if (k > 0) assert.ok(levels[k] > levels[k - 1], String(levels));
  }
});

test('a wider field of view (smaller cot) shrinks the footprint by its ratio', () => {
  const narrow = level({ roughness: 0.8, ior: 1.5, camera: perspective(2) }),
    wide = level({ roughness: 0.8, ior: 1.5, camera: perspective(1) });
  assert.ok(Math.abs(narrow - wide - 1) < 1e-4, 'twice the y scale is one mip up');
  assert.ok(Math.abs(narrow - expected({ roughness: 0.8, ior: 1.5, scale: 2 })) < 1e-4);
});

test('orthographic views spread over the volume path instead of an angle', () => {
  const thin = level({ roughness: 1, ior: 1.5, camera: orthographic, thickness: 0 }),
    thick = level({ roughness: 1, ior: 1.5, camera: orthographic, thickness: 8 });
  assert.equal(thin, 0, 'no path, no lateral spread');
  assert.ok(Math.abs(thick - expected({ roughness: 1, ior: 1.5, scale: 0.5, reach: 8 })) < 1e-4);
});

test('level stays within the mip chain', () => {
  assert.equal(level({ roughness: 1, ior: 3, camera: perspective(50) }), LEVELS - 1);
});
