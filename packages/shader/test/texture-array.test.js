import test from 'node:test';
import assert from 'node:assert/strict';
import { Texture } from '@margoengine/materials';
import { captureMaterialLibrary, restoreMaterialLibrary } from '@margoengine/materials/serialization';
import { shaderMaterialCodecs } from '../dist/serialization.js';
import { NodeMaterial, NodePass, ComputePass, storage, uint, uniform, vec2, vec3 } from '../dist/index.js';
import { textureArray } from '../dist/texture-array.js';
const source = () => ({ dimension: '2d-array', bind: () => [{}, {}] });
test('many layer nodes share one sampled texture and sampler in every host', () => {
  const t = source(),
    layer = uniform(3, { type: 'i32' });
  let sum = vec3(0);
  for (let i = 0; i < 32; i++) sum = sum.add(textureArray(t, i).rgb);
  const m = new NodeMaterial({ colorNode: sum }),
    p = new NodePass(textureArray(t, layer)),
    out = storage(1, 'vec4f'),
    c = new ComputePass(1, (i) => out.store(i, textureArray(t, uint(2), vec2(0.5))));
  for (const program of [m.program, p.program, c.program])
    assert.equal(program.resources.filter((r) => r.resource.prefix === 'ndt').length, 1);
  assert.match(m.program.declare(2), /texture_2d_array<f32>/);
  assert.match(p.code(), /textureSample\(/);
  assert.match(c.code, /textureSampleLevel\(.*2u, 0.0\)/);
  assert.match(
    new NodePass(textureArray(t, uint(4294967295))).code(),
    /, 4294967295u\)/,
    'large unsigned layers retain unsigned clamping semantics',
  );
  const old = p.code();
  layer.value = 7;
  assert.equal(p.code(), old);
  assert.match(new NodePass(textureArray(t, 0, vec2(0.25), 2)).code(), /textureSampleLevel\(.*2.0\)/);
});
test('array layers validate integral types and source dimensions before pipeline construction', () => {
  const t = source();
  for (const layer of [0.5, NaN, Infinity, 2147483648]) assert.throws(() => textureArray(t, layer), /integer/);
  assert.throws(() => textureArray(t, vec3(1)), /i32 or u32/);
  assert.throws(() => textureArray({ dimension: '3d', bind() {} }, 0), /2d-array/);
  assert.throws(() => textureArray(t, 0, vec3(0)), /vec2f/);
  assert.throws(() => textureArray({}, 0), /Texture/);
  assert.ok(textureArray(t, -1));
});
test('the existing white placeholder uses an explicit array view and reuses it per device', () => {
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
  let made = 0;
  const device = {
    createTexture() {
      made++;
      return { createView: (d) => d };
    },
    createSampler: () => ({}),
    queue: { writeTexture() {} },
  };
  const t = { dimension: '2d-array', bind: () => undefined },
    m = new NodeMaterial({ colorNode: textureArray(t, 12).rgb });
  const r = m.program.resources.find((r) => r.resource.prefix === 'ndt').resource;
  assert.equal(r.entries(device)[0].dimension, '2d-array');
  assert.equal(r.entries(device)[0].dimension, '2d-array');
  assert.equal(made, 1);
});
test('material serialization restores array resource dimensions and exact shader declarations', async () => {
  const t = new Texture(
      { width: 1, height: 1, depth: 2, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) },
      { dimension: '2d-array' },
    ),
    material = new NodeMaterial({ colorNode: textureArray(t, 1).rgb });
  const archive = await captureMaterialLibrary({ material }, { codecs: shaderMaterialCodecs }),
    restored = await restoreMaterialLibrary(JSON.parse(JSON.stringify(archive)), { codecs: shaderMaterialCodecs });
  assert.equal(restored.material.fragmentCode, material.fragmentCode);
  assert.equal(restored.material.program.declare(2), material.program.declare(2));
  const texture = restored.material.program.resources.find((r) => r.resource.prefix === 'ndt').resource.source;
  assert.equal(texture.dimension, '2d-array');
  assert.notEqual(texture, t);
});
