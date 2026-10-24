import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lightSolidAngle,
  lumensToCandela,
  candelaToLumens,
  candelaToLux,
  luxToCandela,
  nitsToLumens,
  lumensToNits,
  nitsToCandela,
  ev100,
  exposureFromEV100,
} from '../dist/units.js';
import { parseIES } from '../dist/ies.js';
import { applyGLTFLights, GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { headless } from '../../../tests/support/pbr-snapshot.js';
import { iesFile, range } from './ies-reference.js';

const near = (a, b, tolerance, label) =>
  assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${label}: ${a} vs ${b}`);
// Clustered's spot cone (packages/shared/light-terms.js decayTerms): smoothstep(cos outer, cos inner, cos theta).
const cone = (x, lo, hi) => {
  if (hi <= lo) return x >= lo ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

test('a point light spreads its lumens over 4 pi; a spot over its cone, smooth edge integrated exactly', () => {
  near(lumensToCandela(4 * Math.PI * 100), 100, 1e-12, 'point');
  near(candelaToLumens(100), 4 * Math.PI * 100, 1e-12, 'point inverse');
  for (const [outer, inner] of [
    [0.5, 0.5],
    [0.6, 0.2],
    [Math.PI / 2, 0],
    [0.3, 0],
  ]) {
    // Midpoint rule over the sphere of the cone the shader evaluates.
    let omega = 0;
    const steps = 200000;
    for (let i = 0; i < steps; i++) {
      const x = -1 + ((i + 0.5) * 2) / steps;
      omega += cone(x, Math.cos(outer), Math.cos(inner)) * ((2 * Math.PI * 2) / steps);
    }
    near(lightSolidAngle({ outerAngle: outer, innerAngle: inner }), omega, 1e-4, `cone ${outer}/${inner}`);
  }
  near(
    lightSolidAngle({ angle: 0.6, penumbra: 0.5 }),
    lightSolidAngle({ outerAngle: 0.6, innerAngle: 0.3 }),
    1e-12,
    'angle form',
  );
  const spot = { outerAngle: 0.4, innerAngle: 0.1 };
  near(candelaToLumens(lumensToCandela(800, spot), spot), 800, 1e-12, 'spot round trip');
  for (const bad of [{ outerAngle: 2 }, { outerAngle: 0.3, innerAngle: 0.5 }, { angle: 0.3, outerAngle: 0.3 }, {}])
    assert.throws(() => lightSolidAngle(bad), RangeError);
  assert.throws(() => lumensToCandela(-1), RangeError);
  assert.throws(() => lightSolidAngle(5), TypeError);
});

test('an IES profile turns lumens into its peak candela through its own flux', () => {
  const profile = parseIES(iesFile(range(0, 90, 5), [0], (t) => 500 * Math.cos((t * Math.PI) / 180)));
  near(lumensToCandela(profile.flux, profile), profile.peak, 1e-12, 'its own flux gives its own peak');
  near(lumensToCandela(2 * profile.flux, profile), 1000, 1e-12, 'twice the lumens');
  near(candelaToLumens(1000, profile), 2 * profile.flux, 1e-12, 'inverse');
  // 500 cos(theta) over the lower hemisphere: pi 500 lumens.
  near(profile.flux, Math.PI * 500, 2e-3, 'flux');
});

test('lux, nits and exposure conversions', () => {
  near(candelaToLux(400, 2), 100, 1e-12, 'inverse square');
  near(luxToCandela(100, 2), 400, 1e-12, 'its inverse');
  assert.throws(() => candelaToLux(1, 0), RangeError);
  near(nitsToLumens(1000, 2, 0.5), Math.PI * 1000, 1e-12, 'pi L A');
  near(nitsToLumens(1000, 2, 0.5, true), 2 * Math.PI * 1000, 1e-12, 'two-sided');
  near(lumensToNits(nitsToLumens(37, 0.3, 1.2), 0.3, 1.2), 37, 1e-12, 'nits round trip');
  near(nitsToCandela(50, 2, 3), 300, 1e-12, 'area light as a point light seen face on');
  assert.throws(() => lumensToNits(1, 0, 1), RangeError);
  near(ev100(1, 1), 0, 1e-12, 'f/1, 1 s, ISO 100');
  near(ev100(16, 1 / 100, 100), Math.log2(25600), 1e-12, 'sunny 16');
  near(ev100(16, 1 / 100, 200), Math.log2(12800), 1e-12, 'twice the ISO is one stop less');
  near(exposureFromEV100(0), 1 / 1.2, 1e-12, 'EV 0');
  near(exposureFromEV100(15) * 1.2 * 2 ** 15, 1, 1e-12, 'saturating luminance maps to 1');
  assert.throws(() => ev100(0, 1), RangeError);
  assert.throws(() => exposureFromEV100(NaN), RangeError);
});

test("gltf-pro's applyGLTFLights passes KHR_lights_punctual units through: candela and lux, times exposure", async () => {
  const engine = await headless(),
    positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [
      { mesh: 0 },
      { extensions: { KHR_lights_punctual: { light: 0 } } },
      { translation: [0, 2, 0], extensions: { KHR_lights_punctual: { light: 1 } } },
    ],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          { type: 'directional', intensity: 3, color: [1, 1, 1] },
          { type: 'point', intensity: lumensToCandela(1200), color: [1, 1, 1] },
        ],
      },
    },
  };
  // Real loader records and Wasm-backed Mesh nodes; this units test needs no GPU setup.
  const model = new PBRModel(engine, new GLTFAsset(doc, [positions])),
    set = [];
  const clustered = { setLights: (lights) => set.push(...lights), add: () => () => {} };
  try {
    applyGLTFLights(model, { clustered, exposure: 0.5 });
    near(engine.lighting.direction[3], 1.5, 1e-7, 'sun: lux x exposure');
    near(set[0].intensity, (0.5 * 1200) / (4 * Math.PI), 1e-12, 'point: candela x exposure');
    near(candelaToLumens(set[0].intensity / 0.5), 1200, 1e-9, 'the lumens it was given');
    assert.deepEqual(set[0].position, [0, 2, 0]);
  } finally {
    model.dispose();
    engine.dispose();
  }
});
