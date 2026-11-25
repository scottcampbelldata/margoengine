// On a transparent canvas the curve took the premultiplied colour of partly covered pixels, so a silhouette laid over
// another picture had a light rim (GAP-FILM-ALPHA; the GPU proof is packages/headless/tests/transparent-gpu.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const MARK = Symbol.for('margoengine.premultiplied-canvas');
const lastShader = (h) => h.pipelines.findLast((p) => p.fragment).fragment.module.code;

for (const [name, options] of [
  ['the default curve', {}],
  ['effects', { grain: 0.2, vignette: 0.5, dither: true }],
  ['a classic curve with a shaped toe', { curve: 'reinhard', toe: 1.2 }],
])
  test(`Tonemap with ${name} divides by the alpha on a premultiplied canvas only`, () => {
    const h = gpuHarness();
    h.engine.canvas = {};
    using _effect = Tonemap.attach(h.engine, options);
    h.frame();
    const opaque = lastShader(h);
    assert.doesNotMatch(opaque, /margoStraight|margoOutput/);
    h.engine.canvas[MARK] = true;
    h.frame();
    const premultiplied = lastShader(h);
    assert.match(premultiplied, /var hdr=clean\(margoStraight\(source\)\);/);
    assert.match(premultiplied, /return margoOutput\(\(.*pow\(color,.*\),textureLoad\(scene.*,source\.a\);/);
    assert.equal(premultiplied.match(/return margoOutput\(/g).length, 1, 'one display output');
    const built = h.pipelines.length;
    h.frame();
    assert.equal(h.pipelines.length, built, 'a steady frame builds no pipeline');
    h.engine.canvas[MARK] = false;
    h.frame();
    assert.equal(lastShader(h), opaque, 'an opaque canvas keeps its shader');
  });
