import test from 'node:test';
import assert from 'node:assert/strict';
import { PBRModel } from '@margoengine/gltf-pro/model';

test('retained bitmap uploads declare external-copy destination usages', () => {
  const before = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 };
  const source = { width: 2, height: 3 };
  let descriptor, copy;
  const texture = {
    destroy() {
      assert.fail('successful upload must retain caller-owned texture');
    },
  };
  const device = {
    createTexture(d) {
      descriptor = d;
      return texture;
    },
    queue: {
      copyExternalImageToTexture(...args) {
        copy = args;
        assert.equal(descriptor.usage & 18, 18);
      },
    },
  };
  try {
    assert.equal(PBRModel.prototype.uploadImage.call({ image: () => source }, 0, device), texture);
    assert.deepEqual(copy, [{ source }, { texture }, [2, 3]]);
    assert.equal(descriptor.usage, 22);
  } finally {
    if (before === undefined) delete globalThis.GPUTextureUsage;
    else globalThis.GPUTextureUsage = before;
  }
});
