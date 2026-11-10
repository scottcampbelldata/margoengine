import test from 'node:test';
import assert from 'node:assert/strict';
import { Light2D, Lighting2D } from '../dist/index.js';
import { SoftLight2D, SoftLighting2D, softShadowFactor } from '../dist/soft.js';
import { CookieLight2D, CookieLighting2D } from '../dist/cookie.js';
import { EmissiveSprite2D, EmissiveLighting2D, emissiveLightAt } from '../dist/emissive.js';

function diagnostic(run, field, guidance) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof RangeError);
    assert.ok(error.message.includes(field), error.message);
    assert.ok(error.message.includes(guidance), error.message);
    assert.ok(error.message.includes('https://margoengine.com/errors#pixel-lighting'));
    return true;
  });
}

for (const [field, guidance, bad] of [
  ['x', 'finite', NaN], ['y', 'finite', Infinity],
  ['radius', 'positive', 0], ['width', 'positive', 0], ['height', 'positive', -1],
  ['falloff', 'positive', 0], ['intensity', 'non-negative', -1],
  ['glowRadius', 'non-negative', -1], ['bloomStrength', 'non-negative', -1],
  ['bloomThreshold', 'non-negative', -1],
]) {
  test(`emissive ${field} identifies its allowed range in constructor and CPU validation`, () => {
    for (const value of [bad, NaN, Infinity, -Infinity]) {
      diagnostic(() => new EmissiveSprite2D({ [field]: value }), field, guidance);
      diagnostic(() => emissiveLightAt({ [field]: value }, 0, 0), field, guidance);
    }
  });
}

test('emissive shape, color and pass diagnostics explain the repair', () => {
  diagnostic(() => new EmissiveSprite2D({ shape: 'triangle' }), 'shape', 'circle or box');
  diagnostic(() => new EmissiveSprite2D({ color: 'bad' }), 'color', '#rrggbb');
  diagnostic(() => new EmissiveLighting2D({ order: NaN }), 'order', 'finite');
  for (const field of ['bloomIntensity', 'bloomThreshold']) {
    diagnostic(() => new EmissiveLighting2D({ [field]: -1 }), field, 'non-negative');
  }
  diagnostic(() => emissiveLightAt({}, 0, 0, undefined, -1), 'bloomIntensity', 'non-negative');
  diagnostic(() => emissiveLightAt({}, 0, 0, undefined, 1, -1), 'bloomThreshold', 'non-negative');
});

for (const Light of [Light2D, SoftLight2D, CookieLight2D]) {
  test(`${Light.name} identifies every shared field and constraint`, () => {
    for (const field of ['x', 'y', 'angle', 'elevation']) {
      diagnostic(() => new Light({ [field]: NaN }), field, 'finite');
    }
    for (const field of ['radius', 'falloff', 'cone']) {
      diagnostic(() => new Light({ [field]: 0 }), field, 'positive');
      diagnostic(() => new Light({ [field]: Infinity }), field, 'finite');
    }
    for (const field of ['height', 'intensity']) {
      diagnostic(() => new Light({ [field]: -1 }), field, 'non-negative');
      diagnostic(() => new Light({ [field]: Infinity }), field, 'finite');
    }
    diagnostic(() => new Light({ kind: 'area' }), 'kind', 'point, spot or directional');
    diagnostic(() => new Light({ color: 'bad' }), 'color', '#rrggbb');
    for (const value of [-1, 1.01, NaN, Infinity]) {
      diagnostic(() => new Light({ softness: value }), 'softness', '[0, 1]');
    }
    for (const value of [-1, 0x100000000, 0.5, NaN]) {
      diagnostic(() => new Light({ layers: value }), 'layers', 'integer in [0, 4294967295]');
    }
  });
}

test('mask diagnostics identify each shape constraint', () => {
  for (const [mask, field, guidance] of [
    [{ kind: 'rect', minX: 2, maxX: 1, minY: 0, maxY: 1 }, 'mask', 'minX <= maxX'],
    [{ kind: 'circle', radius: -1 }, 'radius', 'non-negative'],
    [{ kind: 'circle', radius: 1, center: [NaN, 0] }, 'center', 'two finite coordinates'],
    [{ kind: 'polygon', points: [[0, 0]] }, 'points', 'at least three'],
    [{ kind: 'line' }, 'kind', 'rect, circle or polygon'],
  ]) diagnostic(() => new Light2D({ mask }), field, guidance);
});

test('camera, layer, order and ambient errors retain field-specific guidance', () => {
  for (const Pass of [Lighting2D, SoftLighting2D, CookieLighting2D]) {
    diagnostic(() => new Pass({ target: {}, order: NaN }), 'order', 'finite');
    let execute;
    const pass = new Pass({ target: {}, ambient: 'bad' });
    pass.setup({
      backend: 'webgpu',
      frameGraph: { add(frame) { execute = frame.execute; } },
      removePlugin() {},
      sceneOf() {
        return this;
      },
    });
    diagnostic(() => execute({ backend: 'webgpu' }), 'ambient color', '#rrggbb');
    pass.dispose();
  }
  for (const [camera, field, guidance] of [
    [{ x: NaN, y: 0, zoom: 1 }, 'camera.x', 'finite'],
    [{ x: 0, y: Infinity, zoom: 1 }, 'camera.y', 'finite'],
    [{ x: 0, y: 0, zoom: 0 }, 'camera.zoom', 'positive'],
  ]) diagnostic(() => new EmissiveLighting2D({ camera }), field, guidance);
  diagnostic(() => new EmissiveLighting2D({ layer: -1 }), 'layer', 'integer in [0, 4294967295]');
});

test('soft and cookie diagnostics distinguish the failing field', () => {
  diagnostic(() => new SoftLight2D({ sourceRadius: -1 }), 'sourceRadius', 'non-negative');
  diagnostic(() => new SoftLight2D({ samples: 1.5 }), 'samples', 'integer in [1, 64]');
  diagnostic(() => softShadowFactor(new Light2D(), [], 0, 0, { sourceRadius: -1 }), 'sourceRadius', 'non-negative');
  diagnostic(() => softShadowFactor(new Light2D(), [], 0, 0, { samples: 65 }), 'samples', 'integer in [1, 64]');
  for (const [options, field, guidance] of [
    [{ cookieScale: [0, 1] }, 'cookieScale', 'positive'],
    [{ cookieOffset: [NaN, 1] }, 'cookieOffset', 'finite'],
    [{ cookieRotation: NaN }, 'cookieRotation', 'finite'],
    [{ cookieWrap: 'bad' }, 'cookieWrap', 'zero, clamp, repeat or mirror'],
    [{ cookieMode: 'bad' }, 'cookieMode', 'multiply, alpha or color'],
  ]) diagnostic(() => new CookieLight2D(options), field, guidance);
});

test('restored guidance keeps zero, positive and inclusive upper boundaries', () => {
  new EmissiveSprite2D({ radius: Number.MIN_VALUE, intensity: 0, glowRadius: 0, bloomStrength: 0, bloomThreshold: 0 });
  new Light2D({ radius: Number.MIN_VALUE, height: 0, intensity: 0, softness: 1, layers: 0xffffffff });
  new SoftLight2D({ sourceRadius: 0, samples: 64 });
  new CookieLight2D({ cookieScale: [Number.MIN_VALUE, 1] });
  new EmissiveLighting2D({ bloomIntensity: 0, bloomThreshold: 0, layer: 0 });
});
