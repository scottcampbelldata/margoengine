import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CookieTexture2D,
  createCookieTexture,
  createWindowCookie,
  createSpotCookie,
  cookieSample,
  CookieLight2D,
  cookieLightAt,
  CookieLighting2D,
} from '../dist/cookie.js';
import { lightAt } from '../dist/index.js';

test('CookieTexture2D validation and dimensions', () => {
  assert.throws(
    () => new CookieTexture2D({ width: 0, height: 4, data: new Uint8Array(16) }),
    /Invalid cookie texture dimensions/,
  );
  assert.throws(
    () => new CookieTexture2D({ width: 2, height: 2, data: new Uint8Array(10) }),
    /length must match width \* height \* 4/,
  );

  const tex = createCookieTexture(2, 2, [
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  assert.equal(tex.width, 2);
  assert.equal(tex.height, 2);
  assert.equal(tex.data[0], 1.0);
  assert.equal(tex.data[1], 0.0);
});

test('Cookie factory presets: window and spot cookies', () => {
  const windowCookie = createWindowCookie(16, 16, 4);
  assert.equal(windowCookie.width, 16);
  assert.equal(windowCookie.height, 16);
  assert.ok(windowCookie.data.length === 16 * 16 * 4);

  const spotCookie = createSpotCookie(32, 0.4, 0.8);
  assert.equal(spotCookie.width, 32);
  assert.equal(spotCookie.height, 32);

  // Center should be full intensity (1.0)
  const centerSample = cookieSample(spotCookie, 0.5, 0.5);
  assert.equal(centerSample[0], 1.0);
  assert.equal(centerSample[3], 1.0);

  // Far corner should be zero intensity
  const cornerSample = cookieSample(spotCookie, 0.05, 0.05);
  assert.equal(cornerSample[0], 0.0);
});

test('cookieSample wrap modes: zero, clamp, repeat, mirror', () => {
  const tex = createCookieTexture(2, 2, [
    255, 255, 255, 255, 128, 128, 128, 255,
    64, 64, 64, 255, 32, 32, 32, 255,
  ]);

  // 'zero' wrap mode returns [0, 0, 0, 0] outside [0, 1]
  const oobZero = cookieSample(tex, 1.5, 0.5, 'zero');
  assert.deepEqual(oobZero, [0, 0, 0, 0]);

  // 'clamp' wrap mode clamps to edge
  const oobClamp = cookieSample(tex, 1.5, 0.0, 'clamp');
  assert.ok(oobClamp[3] > 0);

  // 'repeat' wraps periodically
  const oobRepeat = cookieSample(tex, 1.25, 0.25, 'repeat');
  const inRepeat = cookieSample(tex, 0.25, 0.25, 'repeat');
  assert.deepEqual(oobRepeat, inRepeat);

  // 'mirror' reflects across boundaries
  const oobMirror = cookieSample(tex, 1.2, 0.5, 'mirror');
  const inMirror = cookieSample(tex, 0.8, 0.5, 'mirror');
  assert.deepEqual(oobMirror, inMirror);
});

test('CookieLight2D validation and defaults', () => {
  const light = new CookieLight2D({
    x: 10,
    y: 20,
    radius: 50,
  });
  assert.equal(light.x, 10);
  assert.equal(light.y, 20);
  assert.deepEqual(light.cookieScale, [100, 100]);
  assert.deepEqual(light.cookieOffset, [0, 0]);
  assert.equal(light.cookieRotation, 0);
  assert.equal(light.cookieWrap, 'zero');
  assert.equal(light.cookieMode, 'multiply');

  assert.throws(
    () => new CookieLight2D({ cookieScale: [0, 10] }),
    /Invalid cookieScale: must be finite and positive/,
  );
  assert.throws(
    () => new CookieLight2D({ cookieWrap: 'invalid' }),
    /Invalid cookieWrap: use zero, clamp, repeat or mirror/,
  );
  assert.throws(
    () => new CookieLight2D({ cookieMode: 'invalid' }),
    /Invalid cookieMode: use multiply, alpha or color/,
  );
});

test('cookieLightAt with and without cookie', () => {
  const baseLight = new CookieLight2D({
    x: 0,
    y: 0,
    radius: 100,
    height: 10,
    color: '#ffffff',
    intensity: 1,
  });

  // Without cookie, exactly matches standard lightAt
  const standard = lightAt(baseLight, 10, 0);
  const cookieNone = cookieLightAt(baseLight, 10, 0);
  assert.ok(Math.abs(standard[0] - cookieNone[0]) < 1e-5);
  assert.ok(Math.abs(standard[1] - cookieNone[1]) < 1e-5);
  assert.ok(Math.abs(standard[2] - cookieNone[2]) < 1e-5);

  // With full white cookie, matches standard
  const whiteCookie = createCookieTexture(2, 2, [
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
  ]);
  const whiteLight = new CookieLight2D({
    ...baseLight,
    cookie: whiteCookie,
    cookieScale: [200, 200],
  });
  const cookieWhite = cookieLightAt(whiteLight, 10, 0);
  assert.ok(Math.abs(standard[0] - cookieWhite[0]) < 1e-5);

  // With half-intensity red cookie in multiply mode
  const redCookie = createCookieTexture(2, 2, [
    255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 255, 255, 0, 0, 255,
  ]);
  const redLight = new CookieLight2D({
    ...baseLight,
    cookie: redCookie,
    cookieScale: [200, 200],
    cookieMode: 'multiply',
  });
  const cookieRed = cookieLightAt(redLight, 10, 0);
  assert.ok(cookieRed[0] > 0);
  assert.equal(cookieRed[1], 0);
  assert.equal(cookieRed[2], 0);

  // Out of bounds with zero wrap produces zero light
  const oobLight = cookieLightAt(redLight, 150, 0);
  assert.deepEqual(oobLight, [0, 0, 0]);
});

test('cookieLightAt with alpha and color blend modes', () => {
  const cookie = createCookieTexture(2, 2, [
    255, 0, 0, 128, 255, 0, 0, 128,
    255, 0, 0, 128, 255, 0, 0, 128,
  ]);
  const lightAlpha = new CookieLight2D({
    x: 0,
    y: 0,
    radius: 100,
    height: 10,
    color: '#00ff00',
    intensity: 1,
    cookie,
    cookieScale: [200, 200],
    cookieMode: 'alpha',
  });

  const litAlpha = cookieLightAt(lightAlpha, 0, 0);
  // Color should stay green, scaled by cookie alpha (128/255 ~ 0.502)
  assert.equal(litAlpha[0], 0);
  assert.ok(litAlpha[1] > 0);
  assert.equal(litAlpha[2], 0);

  const lightColor = new CookieLight2D({
    x: 0,
    y: 0,
    radius: 100,
    height: 10,
    color: '#00ff00',
    intensity: 1,
    cookie,
    cookieScale: [200, 200],
    cookieMode: 'color',
  });
  const litColor = cookieLightAt(lightColor, 0, 0);
  // Color mode takes the cookie's red tint
  assert.ok(litColor[0] > 0);
  assert.equal(litColor[1], 0);
  assert.equal(litColor[2], 0);
});

test('CookieLighting2D lifecycle and WebGL2 refusal', () => {
  const fakeTarget = { width: 100, height: 100, format: 'rgba8unorm', createView: () => ({}) };
  const plugin = new CookieLighting2D({ target: fakeTarget });
  const light = plugin.addLight({ x: 5, y: 5 });
  assert.ok(light instanceof CookieLight2D);

  plugin.removeLight(light);

  const fakeWebGL2Engine = {
    backend: 'webgl2',
    [Symbol.for('margo.engine.runtime')]: {
      backend: 'webgl2',
    },
  };

  assert.throws(
    () => plugin.setup(fakeWebGL2Engine),
    /CookieLighting2D needs WebGPU/,
  );

  plugin.dispose();
  assert.throws(
    () => plugin.addLight({ x: 1, y: 1 }),
    /CookieLighting2D has been disposed/,
  );
});

test('cookieSample picks the texel of an exact edge for a coordinate a few f32 ULP under it (as the GPU computes it)', () => {
  // 16 x 1 cookie whose texel i holds i * 16: the texel picked is readable from the red value.
  const data = [];
  for (let i = 0; i < 16; i++) data.push(i * 16, 0, 0, 255);
  const tex = createCookieTexture(16, 1, data);
  // -7.5 / 20 + 0.5 is exactly 0.125, the edge between texels 1 and 2. WGSL allows 2.5 ULP of division error, and
  // Metal returns a value just under it: both must pick texel 2.
  const exact = cookieSample(tex, -7.5 / 20 + 0.5, 0.5);
  const under = cookieSample(tex, 0.125 - 2 ** -26, 0.5);
  assert.equal(Math.round(exact[0] * 255), 32);
  assert.equal(Math.round(under[0] * 255), 32);
});
