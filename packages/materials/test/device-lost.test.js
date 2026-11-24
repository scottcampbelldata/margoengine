// A reaction on device.lost cannot be removed: one made per texture slot or per material uniform kept every disposed
// texture and every released material state alive as long as the device (docs/known-bugs.md). Each device now has one
// reaction over a set that textures and material states leave when they go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { PhongMaterial, Texture, createMesh } from '../dist/index.js';

/** A stand-in `device.lost` that counts the reactions made on it, and a function that loses the device. */
function losable(device) {
  let lose,
    reactions = 0;
  const lost = new Promise((resolve) => (lose = resolve));
  device.lost = {
    then(done, failed) {
      reactions++;
      return lost.then(done, failed);
    },
  };
  return { lose: () => lose({ reason: 'unknown', message: 'test' }), reactions: () => reactions };
}

async function scene() {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  let n = 0;
  const frame = () =>
    gpu.record(() => {
      store.tick(false);
      view.begin(n++);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, frame };
}
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};

test('a disposed texture is collected while its device lives; a live one drops its GPU copy when the device is lost', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  try {
    const gpu = optionalGPU().engine.gpu,
      device = losable(gpu),
      make = () => new Texture({ data: new Uint8Array(16), width: 2, height: 2 }, { mipmaps: false });
    const reference = (() => {
      const texture = make();
      texture.bind(gpu, true);
      texture.dispose();
      return new WeakRef(texture);
    })();
    for (let i = 0; i < 5 && reference.deref(); i++) {
      await setImmediate();
      gc();
    }
    assert.ok(reference.deref() === undefined, 'the disposed texture is still reachable from its live device');
    const textures = Array.from({ length: 4 }, make);
    for (const texture of textures) texture.bind(gpu, true);
    assert.equal(device.reactions(), 1, 'one reaction for the device, not one per texture');
    assert.ok(textures[3].gpuTexture(gpu));
    device.lose();
    await setImmediate();
    assert.equal(textures[3].gpuTexture(gpu), undefined, 'the lost device takes the GPU copy with it');
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
});

test('material uniforms make one device.lost reaction per device, and a live one is destroyed when it is lost', async () => {
  const s = await scene(),
    device = losable(s.gpu.device),
    made = [],
    create = s.gpu.device.createBuffer;
  s.gpu.device.createBuffer = (descriptor) => {
    const buffer = create.call(s.gpu.device, descriptor);
    made.push({ descriptor, buffer });
    return buffer;
  };
  try {
    const draw = () => {
      const material = new PhongMaterial({ color: [1, 0, 0] }),
        mesh = createMesh(s.engine, quad, material);
      s.frame();
      return { material, mesh };
    };
    const first = draw();
    first.mesh.dispose();
    first.material.dispose();
    const after = device.reactions();
    for (let i = 0; i < 4; i++) {
      const { material, mesh } = draw();
      mesh.dispose();
      material.dispose();
    }
    assert.equal(device.reactions(), after, 'released material states add no reaction to the live device');
    const live = draw();
    const phong = made.filter(
      ({ descriptor }) => descriptor.size === 16 && descriptor.usage & GPUBufferUsage.UNIFORM,
    ).at(-1).buffer;
    assert.equal(phong.destroyed, undefined);
    device.lose();
    await setImmediate();
    assert.equal(phong.destroyed, true, 'the lost device takes the live material uniform with it');
    live.mesh.dispose();
  } finally {
    s.engine.dispose();
  }
});
