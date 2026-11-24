import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmissiveSprite2D,
  checkEmissiveSprite,
  emissiveLightAt,
  EmissiveLighting2D,
} from '../dist/emissive.js';

test('checkEmissiveSprite validates shape, radius, dimensions and intensity', () => {
  const circle = new EmissiveSprite2D({
    shape: 'circle',
    radius: 12,
    color: '#00ffcc',
    intensity: 2.5,
    glowRadius: 36,
    falloff: 2,
  });
  assert.equal(circle.shape, 'circle');
  assert.equal(circle.radius, 12);
  assert.equal(circle.intensity, 2.5);
  assert.equal(circle.glowRadius, 36);

  const box = new EmissiveSprite2D({
    shape: 'box',
    width: 24,
    height: 16,
    color: '#ffaa00',
  });
  assert.equal(box.shape, 'box');
  assert.equal(box.width, 24);
  assert.equal(box.height, 16);

  assert.throws(() => checkEmissiveSprite({ shape: 'polygon' }), /Unknown emissive sprite shape/);
  assert.throws(() => checkEmissiveSprite({ radius: -5 }), /Invalid sprite radius/);
  assert.throws(() => checkEmissiveSprite({ width: 0 }), /Invalid sprite width/);
  assert.throws(() => checkEmissiveSprite({ intensity: -1 }), /Invalid sprite intensity/);
  assert.throws(() => checkEmissiveSprite({ falloff: -2 }), /Invalid falloff/);
  assert.throws(() => checkEmissiveSprite({ color: 'invalid' }), /Invalid emissive color/);
});

test('emissiveLightAt computes direct emission inside sprite and glow with falloff', () => {
  const sprite = new EmissiveSprite2D({
    x: 10,
    y: 10,
    shape: 'circle',
    radius: 5,
    glowRadius: 20,
    color: '#ffffff',
    intensity: 1.0,
    bloomThreshold: 2.0, // High threshold so only pure emission
  });

  // Center (inside radius): full intensity
  const inside = emissiveLightAt(sprite, 10, 10);
  assert.deepEqual(inside, [1, 1, 1]);

  // Point at radius (x=15, y=10): still inside / on boundary
  const atEdge = emissiveLightAt(sprite, 15, 10);
  assert.deepEqual(atEdge, [1, 1, 1]);

  // Point outside at distance 10 from center (5 units from edge, out of 20):
  // atten = (1 - 5 / 20) ^ 2 = (0.75) ^ 2 = 0.5625
  const glow = emissiveLightAt(sprite, 20, 10);
  assert.ok(Math.abs(glow[0] - 0.5625) < 1e-4);
  assert.ok(Math.abs(glow[1] - 0.5625) < 1e-4);
  assert.ok(Math.abs(glow[2] - 0.5625) < 1e-4);

  // Far point beyond glowRadius (x=40, y=10): 0
  const far = emissiveLightAt(sprite, 40, 10);
  assert.deepEqual(far, [0, 0, 0]);
});

test('emissiveLightAt computes bloom glow when intensity exceeds threshold', () => {
  const glowingSprite = new EmissiveSprite2D({
    x: 0,
    y: 0,
    shape: 'circle',
    radius: 10,
    color: '#ff8800',
    intensity: 2.0,
    bloomThreshold: 1.0,
    bloomStrength: 1.5,
  });

  // Inside: intensity = 2.0, bloom = (2.0 - 1.0) * 1.5 = 1.5 -> total = 3.5
  const lit = emissiveLightAt(glowingSprite, 0, 0);
  // Color is [1.0, 0.5333, 0.0] * 3.5
  assert.ok(lit[0] > 2.0);
  assert.ok(lit[1] > 1.0);
  assert.equal(lit[2], 0);
});

test('emissiveLightAt respects layer masks', () => {
  const sprite = new EmissiveSprite2D({
    x: 0,
    y: 0,
    color: '#ffffff',
    layer: 0b0100,
  });

  // Layer matches
  const match = emissiveLightAt(sprite, 0, 0, 0b0100);
  assert.ok(match[0] > 0);

  // Layer does not match
  const noMatch = emissiveLightAt(sprite, 0, 0, 0b0011);
  assert.deepEqual(noMatch, [0, 0, 0]);
});

test('EmissiveLighting2D lifecycle, bloom hookup, and WebGL2 refusal', () => {
  const plugin = new EmissiveLighting2D({
    bloom: true,
    bloomIntensity: 1.2,
  });

  const sprite = plugin.addSprite({ x: 5, y: 5, intensity: 2.0 });
  assert.ok(sprite instanceof EmissiveSprite2D);
  assert.equal(plugin.removeSprite(sprite), true);

  // The factory owns an unattached encodeImage effect, never an unrecognized setInput mock.
  plugin.connectBloom(() => ({ encodeImage() {}, dispose() {} }));
  assert.throws(() => plugin.connectBloom({ setInput() {} }), TypeError);

  // WebGL2 mock refusal
  const mockWebgl = {
    backend: 'webgl2',
    gpu: null,
  };
  const mockKernel = {
    [Symbol.for('margo.engine')]: mockWebgl,
  };
  assert.throws(
    () => EmissiveLighting2D.attach(mockKernel, {}),
    /WebGL2 is not supported for @margoengine\/lighting2d\/emissive; use WebGPU/,
  );

  plugin.dispose();
  assert.throws(() => plugin.addSprite(), /EmissiveLighting2D has been disposed/);
});

test('F10 local extraction uses RGB brightness and removes threshold proportionally', () => {
  const sprite = { radius: 10, glowRadius: 10, color: '#404040', intensity: 2, bloomThreshold: 0.8 };
  const peak = 2 * 64 / 255;
  assert.deepEqual(emissiveLightAt(sprite, 0, 0), [peak, peak, peak]);
  const above = { ...sprite, intensity: 4 };
  const direct = 4 * 64 / 255;
  const expected = direct + direct - 0.8;
  for (const v of emissiveLightAt(above, 0, 0)) assert.ok(Math.abs(v - expected) < 1e-12);
});
