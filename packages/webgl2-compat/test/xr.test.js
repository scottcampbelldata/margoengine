// The XR route's logic without a browser; test/xr-browser.mjs draws through it on a real GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatXRBinding, CompatXRProjectionLayer, installXR } from '../dist/xr.js';
import { CompatDevice, CompatGPU } from '../dist/device.js';

function stage(t, { xr = {}, layer = class {}, gpu = Object.create(CompatGPU.prototype) } = {}) {
  const saved = ['navigator', 'XRWebGLLayer', 'XRGPUBinding'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { xr, gpu } });
  Object.defineProperty(globalThis, 'XRWebGLLayer', { configurable: true, writable: true, value: layer });
  delete globalThis.XRGPUBinding;
  t.after(() => {
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
}
/** A binding on a stand-in device that hands out textures of the asked size. */
function binding(device = {}) {
  const textures = [];
  const stand = Object.assign(Object.create(CompatDevice.prototype), {
    createTexture(descriptor) {
      const texture = {
        ...descriptor,
        width: descriptor.size[0],
        height: descriptor.size[1],
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
      };
      textures.push(texture);
      return texture;
    },
    ...device,
  });
  return { binding: new CompatXRBinding({}, stand), textures };
}

test('a z in [-1, 1] projection comes out with z in [0, 1]', () => {
  const near = 0.1,
    far = 100,
    gl = new Float32Array(16);
  gl[0] = gl[5] = 1;
  gl[10] = (far + near) / (near - far);
  gl[11] = -1;
  gl[14] = (2 * far * near) / (near - far);
  const p = binding().binding.projection({ projectionMatrix: gl });
  const ndc = (z) => (p[10] * z + p[14]) / (p[11] * z + p[15]);
  assert.ok(Math.abs(ndc(-near)) < 1e-5, 'the near plane is 0');
  assert.ok(Math.abs(ndc(-far) - 1) < 1e-5, 'the far plane is 1');
  assert.deepEqual([p[0], p[5], p[11]], [1, 1, -1], 'x, y and w stay');
  assert.notEqual(p[14], gl[14], 'the view keeps its own matrix');
});

test('each eye keeps its texture across frames, and a new size replaces it', () => {
  const { binding: b, textures } = binding();
  let viewport = { x: 512, y: 0, width: 512, height: 400 };
  const layer = new CompatXRProjectionLayer({ framebuffer: null, getViewport: () => viewport });
  const first = b.getViewSubImage(layer, {});
  assert.deepEqual(first.viewport, { x: 0, y: 0, width: 512, height: 400 });
  assert.equal(first.depthStencilTexture, null);
  assert.deepEqual(first.getViewDescriptor(), {});
  assert.equal(b.getViewSubImage(layer, {}).colorTexture, first.colorTexture);
  assert.equal(textures.length, 1);
  viewport = { ...viewport, width: 256 };
  const second = b.getViewSubImage(layer, {});
  assert.equal(second.colorTexture.width, 256);
  assert.equal(textures[0].destroyed, 1);
  layer.destroy();
  assert.equal(textures[1].destroyed, 1);
  assert.equal(layer.eyes.size, 0);
});

test('a view outside the layer and a colour format it cannot take are refused', (t) => {
  stage(t);
  const { binding: b } = binding();
  const layer = new CompatXRProjectionLayer({ framebuffer: null, getViewport: () => null });
  assert.throws(() => b.getViewSubImage(layer, {}), { code: 'state' });
  assert.throws(() => b.createProjectionLayer({ colorFormat: 'bgra8unorm' }), TypeError);
  assert.throws(() => new CompatXRBinding({}, {}), TypeError);
});

test('a frame still waiting for the compute runtime is not shown', () => {
  const { binding: b } = binding({ queue: { waiting: Promise.resolve() } });
  const layer = new CompatXRProjectionLayer({ framebuffer: null, getViewport: () => ({ x: 0, y: 0, width: 4, height: 4 }) });
  b.getViewSubImage(layer, {});
  b.present(layer); // reaching for GL here would throw: the stand-in device has none
  assert.equal(layer.drawn.size, 0);
});

test('the session gets an XRWebGLLayer on the device context, without multisampling or depth', (t) => {
  const made = [];
  stage(t, {
    layer: class {
      constructor(session, gl, init) {
        made.push({ session, gl, init });
      }
    },
  });
  const gl = {},
    session = {},
    device = Object.assign(Object.create(CompatDevice.prototype), { gl });
  const handle = installXR({ framebufferScale: 0.75 });
  t.after(() => handle.dispose());
  new globalThis.XRGPUBinding(session, device).createProjectionLayer({ colorFormat: 'rgba8unorm' });
  assert.equal(made[0].session, session);
  assert.equal(made[0].gl, gl);
  assert.deepEqual(
    { ...made[0].init },
    { antialias: false, depth: false, stencil: false, alpha: true, ignoreDepthValues: true, framebufferScaleFactor: 0.75 },
  );
});

test('navigator.gpu of the layer gives its route to code that does not name the layer', async (t) => {
  stage(t);
  const handle = await globalThis.navigator.gpu.xrRoute({ framebufferScale: 0.5 });
  t.after(() => handle.dispose());
  assert.equal(globalThis.XRGPUBinding, CompatXRBinding);
  await assert.rejects(globalThis.navigator.gpu.xrRoute(), { code: 'state' });
});

test('installXR takes the place of XRGPUBinding until disposed, once at a time', (t) => {
  stage(t);
  const before = { value: 'native', configurable: true };
  Object.defineProperty(globalThis, 'XRGPUBinding', before);
  const handle = installXR();
  assert.equal(globalThis.XRGPUBinding, CompatXRBinding);
  assert.equal(globalThis.XRGPUBinding.webgl, true);
  assert.throws(() => installXR(), { code: 'state' });
  handle.dispose();
  handle.dispose();
  assert.equal(globalThis.XRGPUBinding, 'native');
  using again = installXR();
  assert.ok(again);
});

test('installXR refuses a browser without WebXR and a page where the layer is not installed', (t) => {
  stage(t, { xr: null });
  assert.throws(() => installXR(), { code: 'unsupported' });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { xr: {}, gpu: {} } });
  assert.throws(() => installXR(), { code: 'state', message: /comes after install\(\)/ });
  delete globalThis.XRWebGLLayer;
  assert.throws(() => installXR(), { code: 'unsupported' });
});
test('per-session projection scale overrides install defaults without changing later defaults',t=>{const made=[];stage(t,{layer:class{constructor(session,gl,init){made.push(init);}}});const handle=installXR({framebufferScale:.75});t.after(()=>handle.dispose());const device=Object.assign(Object.create(CompatDevice.prototype),{gl:{}}),b=new globalThis.XRGPUBinding({},device);b.createProjectionLayer({colorFormat:'rgba8unorm',scaleFactor:.5});b.createProjectionLayer({colorFormat:'rgba8unorm'});assert.equal(made[0].framebufferScaleFactor,.5);assert.equal(made[1].framebufferScaleFactor,.75);for(const scaleFactor of [0,-1,NaN,Infinity,1e308,1e-100])assert.throws(()=>b.createProjectionLayer({colorFormat:'rgba8unorm',scaleFactor}),RangeError);});
test('invalid install scales fail before changing the global XR binding',t=>{stage(t);for(const framebufferScale of [0,-1,NaN,Infinity,1e308,1e-100])assert.throws(()=>installXR({framebufferScale}),RangeError);assert.equal(globalThis.XRGPUBinding,undefined);});
