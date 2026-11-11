import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

// A device at the WebGPU compatibility level binds a texture only through the view dimension it was made for:
// `textureBindingViewDimension`, which defaults to '2d' for a texture of one layer. Receivers bind the shadow maps as
// '2d-array' views, so a one-layer map (one cascade with `bounds`) made without
// the hint is a validation error at createBindGroup, and every frame's command buffer is invalid
// (webgl2-compat adapter-browser.mjs). Every map receivers bind must be made for '2d-array'.
async function harness({ scopes }) {
  const gpu = mockGPU(),
    device = gpu.device,
    stack = [];
  // A browser's own device at the compatibility level: no core-features-and-limits.
  device.features.delete('core-features-and-limits');
  if (scopes) {
    device.pushErrorScope = (filter) => stack.push(filter);
    device.popErrorScope = async () => {
      if (!stack.pop()) throw new DOMException('No error scope', 'OperationError');
      return null;
    };
  } else {
    delete device.pushErrorScope;
    delete device.popErrorScope;
  }
  const create = device.createTexture;
  device.createTexture = (descriptor) => {
    const texture = create(descriptor),
      view = texture.createView;
    texture.hint = descriptor.textureBindingViewDimension;
    texture.createView = (d = {}) => Object.assign(view(d), { texture, viewDimension: d.dimension ?? '2d' });
    return texture;
  };
  const store = await TransformStore.create(16),
    buffers = { vertex: device.createBuffer({ size: 576 }), index: device.createBuffer({ size: 144 }) };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    {
      backend: 'webgpu',
      gpu: device,
      add() {},
      remove() {},
      render() {},
      dispose() {},
      geometryBuffers: () => buffers,
    },
    { position: [0, 2, 6], target: [0, 0, 0] },
    null,
  );
  const cube = engine.createMesh().setGeometry(box()).setPosition([0, 0.5, 0]),
    view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' });
  return {
    engine,
    cube,
    frame(shadows) {
      store.tick(false);
      view.begin(0);
      view.camera.position = [0, 2, 6];
      gpu.record(() => passes(shadows)(view.c));
    },
  };
}
/** The view dimension a compatibility-level device lets this texture bind as (WebGPU, textureBindingViewDimension). */
const bindable = (t) =>
  t.hint ??
  (t.dimension === '3d' ? '3d' : t.dimension === '1d' ? '1d' : t.depthOrArrayLayers === 1 ? '2d' : '2d-array');
const mismatches = (shadows) =>
  shadows
    .bindings()
    .filter((e) => e.resource?.texture)
    .map((e) => ({ binding: e.binding, view: e.resource.viewDimension, texture: bindable(e.resource.texture) }))
    .filter((m) => m.view !== m.texture);

const checked = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const [name, options, scopes] of [
  ['one cascade (bounds)', { resolution: 64, bounds: { min: [-2, -2, -2], max: [2, 2, 2] }, colored: true }, false],
  ['two cascades', { resolution: 64, cascades: 2, colored: true }, false],
]) {
  test(`Shadows: receivers bind ${name} through the view dimension its texture was made for`, async () => {
    const h = await harness({ scopes }),
      shadows = new Shadows(options);
    try {
      shadows.setup(h.engine);
      shadows.add(h.cube);
      h.frame(shadows);
      assert.ok(shadows.bindings().some((e) => e.resource?.texture), 'receivers bind textures');
      assert.deepEqual(mismatches(shadows), []);
      if (scopes) {
        await checked();
        h.frame(shadows);
        assert.deepEqual(mismatches(shadows), [], 'and the confirmed maps');
      }
    } finally {
      shadows.dispose();
      h.engine.dispose();
    }
  });
}
