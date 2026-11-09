import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Light2D, occluderEdges } from '../dist/index.js';
import {
  SoftLight2D,
  SoftLighting2D,
  SoftShadows2D,
  softShadowFactor,
  softInShadow,
  softLightAt,
} from '../dist/soft.js';

const near = (actual, expected, label, tol = 1e-6) => {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < tol, `${label}: ${actual} vs ${expected}`);
  }
};

test('SoftLight2D options validation', () => {
  const light = new SoftLight2D({ x: 10, y: 20, sourceRadius: 8, samples: 24 });
  assert.equal(light.sourceRadius, 8);
  assert.equal(light.samples, 24);
  assert.equal(light.kind, 'point');

  // Negative radius or non-finite throws RangeError
  assert.throws(() => new SoftLight2D({ sourceRadius: -1 }), RangeError);
  assert.throws(() => new SoftLight2D({ sourceRadius: Number.NaN }), RangeError);
  assert.throws(() => new SoftLight2D({ samples: 0 }), RangeError);
  assert.throws(() => new SoftLight2D({ samples: 100 }), RangeError);
});

test('penumbra edges soften with distance from the occluder', () => {
  // Light at (0, 0), source radius 8
  const light = new SoftLight2D({ x: 0, y: 0, radius: 100, sourceRadius: 8, samples: 32 });
  // Horizontal occluder edge from (-10, 20) to (10, 20) at y = 20
  const edges = occluderEdges([{ shape: 'segment', from: [-10, 20], to: [10, 20] }]);

  // Test close to the occluder at y = 25 (distance from occluder = 5)
  // Inside umbra: x = 0 (straight behind center)
  const visCloseUmbra = softShadowFactor(light, edges, 0, 25);
  assert.equal(visCloseUmbra, 0, 'fully in umbra close to occluder');

  // Edge transition close to occluder (near x = 10..16):
  const visClose10 = softShadowFactor(light, edges, 10, 25);
  const visClose13 = softShadowFactor(light, edges, 13, 25);
  const visClose16 = softShadowFactor(light, edges, 16, 25);
  assert.equal(visClose10, 0, 'still in shadow close to occluder');
  assert.ok(visClose13 > 0 && visClose13 < 1, 'in penumbra');
  assert.equal(visClose16, 1, 'fully lit past the narrow penumbra close to occluder');

  // Test far from occluder at y = 60 (distance from occluder = 40)
  const visFarUmbra = softShadowFactor(light, edges, 0, 60);
  assert.equal(visFarUmbra, 0, 'still in umbra along center line');

  // Far from occluder, the penumbra spreads much wider
  const visFar16 = softShadowFactor(light, edges, 16, 60);
  const visFar25 = softShadowFactor(light, edges, 25, 60);
  assert.ok(visFar16 > 0 && visFar16 < 0.2, 'x=16 is barely entering soft penumbra at distance 40');
  assert.ok(visFar25 > 0 && visFar25 < 1, 'x=25 is still in soft penumbra at distance 40');
  assert.ok(visFar25 > visFar16, 'visibility increases smoothly across penumbra');
});

test('sourceRadius 0 degenerates to hard shadow boundary', () => {
  const light = new SoftLight2D({ x: 0, y: 0, radius: 100, sourceRadius: 0, samples: 16 });
  const edges = occluderEdges([{ shape: 'segment', from: [-10, 20], to: [10, 20] }]);

  // Just inside shadow: x = 9.9 at y = 30 -> ray intersects segment
  assert.equal(softShadowFactor(light, edges, 9.9, 30), 0);
  assert.equal(softInShadow(light, edges, 9.9, 30), true);

  // Just outside shadow: x = 15.1 at y = 30 -> ray misses segment
  assert.equal(softShadowFactor(light, edges, 15.1, 30), 1);
  assert.equal(softInShadow(light, edges, 15.1, 30), false);
});

test('softLightAt scales light by visibility and normal', () => {
  const light = new SoftLight2D({
    x: 0,
    y: 0,
    radius: 100,
    height: 10,
    color: '#ffffff',
    intensity: 1,
    sourceRadius: 8,
  });
  const edges = occluderEdges([{ shape: 'segment', from: [-10, 20], to: [10, 20] }]);

  const fullyBlocked = softLightAt(light, 0, 25, edges);
  near(fullyBlocked, [0, 0, 0], 'full shadow gets no light');

  const unshadowed = softLightAt(light, 13, 25, []);
  assert.ok(unshadowed[0] > 0, 'unblocked point gets light');

  const partial = softLightAt(light, 13, 25, edges);
  assert.ok(partial[0] > 0 && partial[0] < unshadowed[0], 'penumbra point gets partial light');
});

test('directional light soft shadows soften with distance', () => {
  const dir = new Light2D({
    kind: 'directional',
    elevation: Math.PI / 4,
    angle: Math.PI / 2, // shines downwards
    color: '#ffffff',
    intensity: 1,
  });
  const edges = occluderEdges([{ shape: 'segment', from: [-10, 20], to: [10, 20] }]);
  const nearShadow = softShadowFactor(dir, edges, 0, 25, { sourceRadius: 0.1 });
  assert.equal(nearShadow, 0, 'directly behind occluder');

  const outside = softShadowFactor(dir, edges, 20, 25, { sourceRadius: 0.1 });
  assert.equal(outside, 1, 'outside occluder');
});

test('SoftLighting2D plugin management and WebGL2 fallback refusal', () => {
  const target = {};
  const soft = new SoftLighting2D({ target, ambient: '#101010', sourceRadius: 6 });
  assert.equal(soft.sourceRadius, 6);
  assert.equal(soft.name.startsWith('soft-lighting2d-'), true);

  const l1 = soft.addLight({ x: 5, y: 5 });
  assert.equal(soft.lights.length, 1);
  assert.equal(l1.sourceRadius, 6);

  soft.removeLight(l1);
  assert.equal(soft.lights.length, 0);

  // Rejects WebGL2 engine with coded error and help link
  const fakeWebGLEngine = {
    backend: 'webgl2',
    frameGraph: { add() {} },
  };
  assert.throws(
    () => soft.setup(fakeWebGLEngine),
    (err) => err.name === 'MargoError' && err.code === 'unsupported' && err.message.includes('WebGPU'),
  );

  // SoftShadows2D alias is exported and equivalent
  assert.equal(SoftShadows2D, SoftLighting2D);

  soft.dispose();
  assert.throws(() => soft.setup(fakeWebGLEngine), (err) => err.code === 'disposed');
});
