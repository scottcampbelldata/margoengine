import test from 'node:test';
import assert from 'node:assert/strict';
import { heightfieldGeometry, TerrainHeightmap } from '../dist/index.js';

test('heightfield normals and world coordinates follow the supplied height sampler', () => {
  const data = heightfieldGeometry((x, z) => x + 2 * z, { size: [4, 6], origin: [10, 20], resolution: 2 });
  for (let i = 0; i < data.positions.length; i += 3) {
    const [x, y, z] = data.positions.subarray(i, i + 3);
    assert.equal(y, x + 2 * z);
    assert.ok(x >= 10 && x <= 14 && z >= 20 && z <= 26);
    const normal = data.normals.subarray(i, i + 3),
      length = Math.sqrt(6);
    assert.ok(Math.abs(normal[0] + 1 / length) < 1e-6);
    assert.ok(Math.abs(normal[1] - 1 / length) < 1e-6);
    assert.ok(Math.abs(normal[2] + 2 / length) < 1e-6);
  }
  assert.throws(() => heightfieldGeometry(() => NaN, { size: [4, 6] }), /finite/);
  assert.throws(() => new TerrainHeightmap(() => 0, { size: [0, 6] }), /heightfield/);
});

test('height texture samples cell centers, restores and releases owned resources', () => {
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
  const textures = [],
    writes = [],
    engine = {
      gpu: {
        limits: { maxTextureDimension2D: 256 },
        createTexture(descriptor) {
          const t = {
            ...descriptor,
            destroyed: false,
            destroy() {
              this.destroyed = true;
            },
          };
          textures.push(t);
          return t;
        },
        queue: {
          writeTexture(_target, data) {
            writes.push(new Float32Array(data));
          },
        },
      },
      removePlugin() {},
    };
  const options = { size: [4, 4], origin: [10, 20], resolution: 2 },
    map = new TerrainHeightmap((x, z) => x + z, options);
  options.origin[0] = 100;
  map.setup(engine);
  assert.deepEqual(Array.from(writes[0]), [32, 34, 34, 36]);
  const original = map.texture;
  map.onDeviceRestored(engine);
  assert.ok(original.destroyed);
  assert.notEqual(map.texture, original);
  assert.deepEqual(writes[0], writes[1]);
  map.dispose();
  map.dispose();
  assert.ok(textures.every((t) => t.destroyed));
  assert.equal(map.texture, undefined);
  assert.throws(() => map.setup(engine), /WebGPU/);
  const huge = new TerrainHeightmap(() => 0, { size: [4, 4], resolution: 512 });
  assert.throws(() => huge.setup(engine), /GPU/);
  assert.equal(textures.length, 2);
  const bad = new TerrainHeightmap(() => NaN, { size: [4, 4], resolution: 2 });
  assert.throws(() => bad.setup(engine), /finite/);
  assert.equal(textures.length, 2);
});
