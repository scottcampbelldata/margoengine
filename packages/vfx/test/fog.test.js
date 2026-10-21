import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const encode = (c) => Math.fround(c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const billboards = (h) => h.pipelines.filter((p) => p.fragment).map((p) => p.vertex.module.code);

test('VFX.setFog fogs each particle pixel by its world position; null draws the original billboard', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = new VFX({ capacity: 8, texture: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) } });
  h.engine.use(effect);
  h.frame();
  const [plain] = billboards(h);
  assert.doesNotMatch(plain, /margoFog|fogAmount/);
  const fog = { color: [0.2, 0.4, 0.6], near: 2, far: 30, heightFalloff: 0.1, height: 1 };
  assert.equal(effect.setFog(fog), effect);
  h.frame();
  const fogged = billboards(h)[1];
  assert.ok(fogged, 'a second, fogged pipeline');
  assert.match(fogged, /@location\(7\) fogWorld:vec3f/);
  assert.match(fogged, /o\.fogWorld=position;/);
  assert.match(fogged, /textureSample\(sprite/, 'the textured billboard is fogged too');
  // 4x MSAA: the sample-mask fragment shades through the fogged colour.
  assert.match(fogged, /fn shade\(i:Out\)->vec4f \{return fogged\(i,unfogged\(i\)\);\}/);
  assert.match(fogged, /return vec4f\(mix\(c\.rgb,margoFog\.color\.rgb,fogAmount\(i\.fogWorld\)\),c\.a\);/);
  const group = h.groups.findLast((g) => g.entries.some((e) => e.binding === 5)),
    buffer = group.entries.find((e) => e.binding === 5).resource.buffer;
  assert.equal(buffer.size, 48);
  assert.deepEqual(
    [...new Float32Array(buffer.data)],
    [encode(0.2), encode(0.4), encode(0.6), 1, 2, 30, 0, Math.fround(0.1), 0, 1, 4, 0],
    'billboards write their colour as it is, so on bgra8unorm the fog colour goes in sRGB-encoded',
  );
  const count = h.pipelines.length;
  fog.enabled = false;
  h.frame();
  assert.equal(h.pipelines.length, count, 'switching enabled never compiles');
  assert.equal(new Float32Array(buffer.data)[4], 3.4028234663852886e38);
  effect.setFog(null);
  h.frame();
  assert.equal(h.pipelines.length, count, 'back to the original pipeline');
  assert.throws(() => effect.setFog('fog'), TypeError);
  assert.throws(() => effect.setFog({ density: -1 }), /Fog density is -1/);
  effect.dispose();
  assert.ok(buffer.destroyed, 'the fog uniform is released with the effect');
});
