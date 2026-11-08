import test from 'node:test';
import assert from 'node:assert/strict';
import { SplatLighting, relightShader, shadowShader } from '../dist/lighting.js';
import { Splats } from '../dist/index.js';

const cloud = () => Splats.reserve(4);

test('SplatLighting checks its cloud and threshold, and keeps them live', () => {
  assert.throws(() => new SplatLighting({}), TypeError);
  assert.throws(() => new SplatLighting(cloud(), { threshold: 1.5 }), RangeError);
  assert.throws(() => new SplatLighting(cloud(), { threshold: Number.NaN }), RangeError);
  const lit = new SplatLighting(cloud(), { threshold: 0.25, relight: false });
  assert.equal(lit.threshold, 0.25);
  assert.equal(lit.relight, false);
  lit.threshold = 0.75;
  assert.equal(lit.threshold, 0.75);
  assert.throws(() => (lit.threshold = -0.1), RangeError);
  assert.equal(new SplatLighting(cloud()).relight, true, 'relights by default');
  assert.equal(new SplatLighting(cloud()).threshold, undefined, 'stochastic shadows by default');
  lit.threshold = undefined;
  assert.equal(lit.threshold, undefined);
});

test('SplatLighting draws no shadow for a cloud that is not attached, and refuses a setup after dispose', () => {
  const lit = new SplatLighting(cloud());
  const calls = [];
  const pass = new Proxy({}, { get: (_, k) => () => calls.push(k) });
  lit.drawShadow({ context: { device: {} }, pass, matrix: new Float32Array(16), cascade: 0 });
  assert.deepEqual(calls, [], 'an unattached cloud draws nothing');
  assert.equal(lit.disposed, false);
  lit.dispose();
  lit[Symbol.dispose]();
  assert.equal(lit.disposed, true, 'shadows drops a disposed source');
  assert.throws(() => lit.setup({ gpu: {} }), { code: 'disposed' });
  assert.throws(() => new SplatLighting(cloud()).setup({}), { code: 'unsupported' });
});

test('SplatLighting shaders use the flat axis and core diffuse terms', () => {
  assert.match(relightShader, /nl\/3\.14159265\+u\.radiance\.w\*u\.ambient\.rgb/);
  assert.match(relightShader, /if\(dot\(n,view\)<0\)\{n=-n;\}/, 'the normal faces the viewer');
  assert.match(shadowShader, /if\(cut<0\)\{/, 'stochastic coverage when the threshold is unset');
});
