import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box, FrameGraph } from '@margoengine/core/extension';
import { wgsl } from '../../core/dist/shaders.js';
import { XR, XRManager, XRController, useXRSession, createXREngine } from '../dist/index.js';
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const pose = (x) => ({
  transform: {
    matrix: identity(),
    inverse: { matrix: identity() },
    position: { x, y: 0, z: 3, w: 1 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  emulatedPosition: false,
});
class Session extends EventTarget {
  inputSources = [
    {
      handedness: 'left',
      targetRayMode: 'tracked-pointer',
      targetRaySpace: { ray: true },
      gripSpace: { grip: true },
      profiles: ['generic-trigger'],
      gamepad: { buttons: [], axes: [] },
    },
  ];
  handles = new Map();
  ended = 0;
  next = 0;
  async requestReferenceSpace(type) {
    this.space = type;
    return {};
  }
  updateRenderState(state) {
    this.state = state;
  }
  requestAnimationFrame(fn) {
    const id = ++this.next;
    this.handles.set(id, fn);
    return id;
  }
  cancelAnimationFrame(id) {
    this.handles.delete(id);
  }
  async end() {
    this.ended++;
    this.dispatchEvent(new Event('end'));
  }
  tick(time, viewer) {
    const callbacks = [...this.handles.values()];
    this.handles.clear();
    for (const fn of callbacks)
      fn(time, { session: this, getViewerPose: () => viewer, getPose: (space) => (space.grip ? null : pose(1)) });
  }
}
async function fixture(t) {
  const saved = new Map(
    ['navigator', 'XRGPUBinding', 'GPUBufferUsage', 'GPUTextureUsage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const buffers = [],
    textures = [],
    writes = [],
    passes = [],
    requests = [],
    devices = [];
  let session = new Session(),
    rejectSpace = false,
    resolveLost;
  const device = new EventTarget();
  device.limits = { maxBufferSize: 16 * 1024 * 1024 };
  device.destroyed = 0;
  device.destroy = () => device.destroyed++;
  device.lost = new Promise((resolve) => {
    resolveLost = resolve;
  });
  device.createBuffer = (descriptor) => {
    const buffer = {
      descriptor,
      destroyed: 0,
      destroy() {
        this.destroyed++;
      },
    };
    buffers.push(buffer);
    return buffer;
  };
  device.queue = {
    writeBuffer(buffer, offset, data, start = 0, count = data.length) {
      writes.push({ buffer, data: Array.from(data).slice(start, start + count) });
    },
    submit(commands) {
      device.submitted = (device.submitted ?? 0) + commands.length;
    },
  };
  device.createTexture = (descriptor) => {
    const texture = {
      ...descriptor,
      width: descriptor.size[0],
      height: descriptor.size[1],
      destroyed: 0,
      destroy() {
        this.destroyed++;
      },
      createView() {
        return { texture };
      },
    };
    textures.push(texture);
    return texture;
  };
  device.pipelines = [];
  device.createShaderModule = (descriptor) => descriptor;
  device.createRenderPipeline = (descriptor) => {
    device.pipelines.push(descriptor);
    device.pipeline ??= descriptor;
    return { getBindGroupLayout: () => ({}) };
  };
  device.createBindGroup = (descriptor) => descriptor;
  device.createCommandEncoder = () => ({
    beginRenderPass(descriptor) {
      const pass = {
        descriptor,
        draws: 0,
        setViewport(...args) {
          this.viewport = args;
        },
        setPipeline() {},
        setBindGroup(index, group) {
          this.group = group;
        },
        setVertexBuffer() {},
        setIndexBuffer() {},
        drawIndexed() {
          this.draws++;
        },
        draw() {
          this.draws++;
        },
        end() {},
      };
      passes.push(pass);
      return pass;
    },
    finish() {
      return {};
    },
  });
  class Binding {
    constructor(native, gpu) {
      assert.equal(gpu, device);
      this.session = native;
    }
    getPreferredColorFormat() {
      return 'rgba8unorm';
    }
    createProjectionLayer(init) {
      this.layer = {
        init,
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
      };
      return this.layer;
    }
    getViewSubImage(layer, view) {
      const texture = { width: 128, height: 128, format: 'rgba8unorm', createView: (descriptor) => ({ descriptor }) };
      return {
        colorTexture: texture,
        depthStencilTexture: texture,
        viewport: { x: 0, y: 0, width: 128, height: 128 },
        getViewDescriptor: () => ({
          dimension: '2d',
          baseArrayLayer: view.eye === 'right' ? 1 : 0,
          arrayLayerCount: 1,
        }),
      };
    }
  }
  const native = {
    isSessionSupported: async (mode) => mode === 'immersive-vr',
    async requestSession(mode, init) {
      requests.push({ mode, init });
      if (rejectSpace)
        session.requestReferenceSpace = async () => {
          throw new Error('reference space failure');
        };
      return session;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      xr: native,
      gpu: {
        async requestAdapter(options) {
          devices.push(options);
          return { requestDevice: async () => device };
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'XRGPUBinding', { configurable: true, value: Binding });
  Object.defineProperty(globalThis, 'GPUTextureUsage', {
    configurable: true,
    value: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
  });
  Object.defineProperty(globalThis, 'GPUBufferUsage', {
    configurable: true,
    value: { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 },
  });
  const store = await TransformStore.create(4),
    context = {
      backend: 'webgpu',
      shader: wgsl,
      descriptor: { vertex: { entryPoint: 'vertex', buffers: [] } },
      draw() {},
    };
  const engine = new Engine(
      { width: 1, height: 1, getContext() {} },
      store,
      {
        backend: 'webgpu',
        add() {},
        remove() {},
        dispose() {},
        render(camera, light, batches, graph) {
          graph.execute(context);
        },
      },
      undefined,
      null,
    ),
    errors = [];
  engine.onError = (error) => errors.push(error);
  engine.starts = 0;
  engine.start = () => engine.starts++;
  const mesh = engine.createMesh().setGeometry(box());
  t.after(() => {
    engine.dispose();
    for (const [key, descriptor] of saved)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  return {
    engine,
    mesh,
    device,
    buffers,
    textures,
    writes,
    passes,
    requests,
    devices,
    errors,
    get session() {
      return session;
    },
    nextSession() {
      return (session = new Session());
    },
    rejectSpace() {
      rejectSpace = true;
    },
    lose() {
      resolveLost({ message: 'test loss' });
    },
  };
}
test('XR negotiates webgpu and reference space, reads input poses, and renders distinct eye buffers', async (t) => {
  const f = await fixture(t);
  assert.equal(await XR.isSupported(), true);
  assert.equal(await XR.isSupported('immersive-ar'), false);
  const xr = await XR.create(f.engine);
  assert.equal(f.devices[0].xrCompatible, true);
  assert.equal(f.engine.hasPlugin('xr'), true);
  let state;
  await xr.requestSession('immersive-ar', {
    referenceSpace: 'local-floor',
    requiredFeatures: ['webgpu'],
    optionalFeatures: ['hand-tracking'],
    onFrame: (frame) => {
      state = frame;
    },
  });
  assert.deepEqual(f.requests[0].init.requiredFeatures, ['webgpu', 'local-floor']);
  assert.equal(f.session.state.depthNear, f.engine.camera.near);
  const viewer = {
    ...pose(0),
    views: [
      { eye: 'left', projectionMatrix: identity(), transform: pose(-0.03).transform },
      { eye: 'right', projectionMatrix: identity(), transform: pose(0.03).transform },
    ],
  };
  f.session.tick(100, viewer);
  assert.equal(state.delta, 0);
  assert.equal(state.inputs[0].grip, null);
  assert.equal(state.inputs[0].targetRay.transform.position.x, 1);
  assert.equal(f.passes.length, 6);
  assert.ok(f.passes.filter((_, i) => i % 3 !== 2).every((pass) => pass.draws === 1));
  assert.equal(f.passes[0].descriptor.colorAttachments[0].clearValue.a, 0);
  assert.equal(f.passes[3].descriptor.colorAttachments[0].resolveTarget.descriptor.baseArrayLayer, 1);
  assert.equal(f.device.pipeline.depthStencil.depthCompare, 'less-equal');
  assert.equal(f.device.pipeline.multisample.count, 4);
  assert.equal(f.textures.length, 4);
  assert.ok(f.textures.every((t) => t.sampleCount === 4));
  assert.ok(
    f.passes.filter((_, i) => i % 3 === 0).every((p) => p.descriptor.colorAttachments[0].storeOp === 'discard'),
  );
  assert.ok(
    f.passes.filter((_, i) => i % 3 === 2).every((p) => p.descriptor.depthStencilAttachment.depthStoreOp === 'discard'),
  );
  assert.equal(f.passes[4].descriptor.depthStencilAttachment.view.descriptor.baseArrayLayer, 1);
  const left = f.textures[0];
  f.engine.lighting.ambient.set([2, 0.5, 0]);
  f.session.tick(110, viewer);
  assert.equal(f.textures.length, 4);
  assert.equal(f.textures[0], left);
  const eyeWrites = f.writes.filter((write) => write.buffer.descriptor.size === 128);
  assert.equal(eyeWrites.length, 4);
  assert.notEqual(eyeWrites[0].buffer, eyeWrites[1].buffer);
  assert.ok(eyeWrites[0].data[16] < 0 && eyeWrites[1].data[16] > 0);
  assert.deepEqual(eyeWrites[0].data.slice(28, 32), [1, 1, 1, 0]);
  assert.deepEqual(eyeWrites[1].data.slice(28, 32), [1, 1, 1, 0]);
  assert.deepEqual(eyeWrites[2].data.slice(28, 32), [2, 0.5, 0, 0]);
  assert.deepEqual(eyeWrites[3].data.slice(28, 32), [2, 0.5, 0, 0]);
  f.session.tick(120, viewer);
  assert.ok(Math.abs(state.delta - 0.01) < 1e-8);
  f.mesh.dispose();
  f.session.tick(140, null);
  assert.equal(state.viewer, null);
  const layer = f.session.state.layers[0];
  await xr.end();
  assert.equal(xr.session, null);
  assert.equal(layer.destroyed, 1);
  assert.equal(f.session.handles.size, 0);
  assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
  assert.ok(f.textures.every((t) => t.destroyed === 1));
  assert.equal(f.engine.starts, 1);
  xr.dispose();
  assert.equal(f.engine.hasPlugin('xr'), false);
  assert.equal(f.device.destroyed, 1);
  assert.deepEqual(f.errors, []);
});
test('XR rejects duplicates and tears down failed initialization without losing the original error', async (t) => {
  const f = await fixture(t),
    xr = await XR.create(f.engine);
  await assert.rejects(XR.create(f.engine), { code: 'state', message: /without an XR plugin/ });
  f.rejectSpace();
  await assert.rejects(xr.requestSession(), /reference space failure/);
  assert.equal(xr.session, null);
  assert.equal(f.session.ended, 1);
  assert.equal(f.session.state.layers[0].destroyed, 1);
  xr.dispose();
  await assert.rejects(xr.requestSession(), { code: 'disposed' });
});
test('XR.create and requestSession reject with an aborted signal before any work', async (t) => {
  const f = await fixture(t),
    signal = AbortSignal.abort(new Error('stop'));
  await assert.rejects(XR.create(f.engine, { signal }), /stop/);
  const xr = await XR.create(f.engine);
  await assert.rejects(xr.requestSession('immersive-vr', { signal }), /stop/);
  assert.equal(xr.session, null);
  xr.dispose();
});
test('XR cleanup handles pending session disposal, frame failures and device loss', async (t) => {
  const f = await fixture(t),
    xr = await XR.create(f.engine);
  const pending = xr.requestSession();
  xr.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(f.session.ended, 1);
  f.nextSession();
  const next = await XR.create(f.engine);
  await next.requestSession('immersive-vr', {
    onFrame() {
      throw new Error('frame failure');
    },
  });
  f.session.tick(0, null);
  await Promise.resolve();
  assert.equal(next.session, null);
  assert.match(f.errors[0].message, /frame failure/);
  f.lose();
  await Promise.resolve();
  await assert.rejects(next.requestSession(), /lost/);
  assert.ok(f.errors.some((error) => /test loss/.test(error.message)));
});
test('XR SSR imports and feature detection require no browser globals', async () => {
  assert.equal(await XR.isSupported(), false);
  assert.ok(new FrameGraph());
});
test('inline uses viewer space without WebGPU layers and preserves reusable input buffers', async (t) => {
  const f = await fixture(t);
  assert.equal(XRManager, XR);
  const xr = await XRManager.create(f.engine);
  let state;
  f.session.inputSources[0].gamepad = { buttons: [{ value: 0.7, pressed: true, touched: true }], axes: [-0.5, 0.25] };
  await useXRSession(xr, 'inline', {
    onFrame: (value) => {
      state = value;
    },
  });
  assert.equal(f.session.space, 'viewer');
  assert.deepEqual(f.requests[0].init.requiredFeatures, []);
  assert.equal(f.session.state, undefined);
  f.session.tick(0, null);
  const first = state,
    inputs = state.inputs,
    controller = inputs[0],
    matrix = controller.targetRayMatrix;
  assert.ok(controller instanceof XRController);
  assert.ok(Math.abs(controller.buttons[0] - 0.7) < 1e-6);
  assert.equal(controller.axes[0], -0.5);
  f.session.tick(20, null);
  assert.equal(state, first);
  assert.equal(state.inputs, inputs);
  assert.equal(state.inputs[0], controller);
  assert.equal(controller.targetRayMatrix, matrix);
  f.session.inputSources = [];
  f.session.dispatchEvent(new Event('inputsourceschange'));
  f.session.tick(40, null);
  assert.equal(state.inputs.length, 0);
  await xr.end();
  assert.equal(f.engine.starts, 0);
});
test('controller hand matrices are preallocated and clear when tracking is lost', () => {
  const source = { targetRaySpace: {}, profiles: [], hand: new Map([['wrist', {}]]) },
    controller = new XRController(source),
    matrix = controller.handMatrices;
  const frame = { getPose: () => null, getJointPose: () => pose(2) };
  controller.update(frame, {});
  assert.equal(controller.handTracked[0], 1);
  assert.equal(controller.handMatrices, matrix);
  frame.getJointPose = () => null;
  controller.update(frame, {});
  assert.equal(controller.handTracked[0], 0);
  assert.ok(matrix.every((value) => value === 0));
});
test('controller joint radii follow the joint poses and clear when tracking is lost', () => {
  const controller = new XRController({ targetRaySpace: {}, profiles: [], hand: new Map([['wrist', {}]]) }),
    frame = { getPose: () => null, getJointPose: () => ({ ...pose(2), radius: 0.011 }) };
  controller.update(frame, {});
  assert.ok(Math.abs(controller.handRadii[0] - 0.011) < 1e-7);
  frame.getJointPose = () => null;
  controller.update(frame, {});
  assert.equal(controller.handRadii[0], 0);
});
test('xr.onFrame runs every XR frame before the session callback, and its stop function ends it', async (t) => {
  const f = await fixture(t),
    xr = await XRManager.create(f.engine),
    order = [];
  assert.throws(() => xr.onFrame(1), /pass \(state\) =>/);
  const stop = xr.onFrame((state) => order.push(['hook', state.inputs.length]));
  await useXRSession(xr, 'inline', { onFrame: () => order.push(['session']) });
  f.session.tick(0, null);
  stop();
  f.session.tick(20, null);
  assert.deepEqual(order, [['hook', 1], ['session'], ['session']]);
  await xr.end();
});
test('missing immersive bindings permit inline tracking and leave the desktop loop active', async (t) => {
  const f = await fixture(t);
  delete globalThis.XRGPUBinding;
  navigator.xr.isSessionSupported = async () => true;
  assert.equal(await XRManager.isSupported('inline'), true);
  assert.equal(await XRManager.isSupported('immersive-vr'), false);
  const xr = await XRManager.create(f.engine);
  assert.equal(f.devices[0].xrCompatible, false);
  await assert.rejects(xr.requestSession(), /bindings are unavailable/);
  await xr.requestSession('inline');
  f.session.tick(0, null);
  await xr.end();
  assert.equal(f.engine.starts, 0);
  assert.deepEqual(f.errors, []);
});

test('late completion of a prior end preserves a newly active session', async (t) => {
  for (const rejected of [false, true])
    await t.test(rejected ? 'rejected end' : 'resolved end', async (t) => {
      const f = await fixture(t),
        xr = await XR.create(f.engine);
      await xr.requestSession('inline');
      const previous = f.session,
        error = new Error('previous end failed');
      let resolveEnd, rejectEnd;
      previous.end = () => {
        previous.dispatchEvent(new Event('end'));
        return new Promise((resolve, reject) => {
          resolveEnd = resolve;
          rejectEnd = reject;
        });
      };
      const pending = xr.end();
      const session = f.nextSession();
      await xr.requestSession('inline');
      const controller = xr.controllers[0];
      assert.equal(xr.session, session);
      if (rejected) {
        rejectEnd(error);
        await assert.rejects(pending, (value) => value === error);
      } else {
        resolveEnd();
        await pending;
      }
      assert.equal(xr.session, session);
      assert.equal(session.handles.size, 1);
      assert.equal(xr.controllers[0], controller);
      await xr.end();
      assert.equal(session.handles.size, 0);
      assert.deepEqual(f.errors, []);
    });
});

test('XR reuses owned multisample views for stable frames and invalidates them on resize and a new session', async (t) => {
  const f = await fixture(t),
    xr = await XR.create(f.engine),
    createTexture = f.device.createTexture;
  let viewCreates = 0;
  f.device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor),
      createView = texture.createView;
    texture.createView = function (...args) {
      viewCreates++;
      return createView.apply(this, args);
    };
    return texture;
  };
  let width = 128,
    format = 'rgba8unorm';
  const Binding = globalThis.XRGPUBinding,
    getImage = Binding.prototype.getViewSubImage;
  Binding.prototype.getPreferredColorFormat = () => format;
  Binding.prototype.getViewSubImage = function (...args) {
    const image = getImage.apply(this, args);
    image.colorTexture.width = width;
    image.depthStencilTexture.width = width;
    image.colorTexture.format = format;
    return image;
  };
  const viewer = {
    ...pose(0),
    views: [
      { eye: 'left', projectionMatrix: identity(), transform: pose(-0.03).transform },
      { eye: 'right', projectionMatrix: identity(), transform: pose(0.03).transform },
    ],
  };
  await xr.requestSession();
  f.session.tick(0, viewer);
  const firstViews = f.passes.slice(0, 6),
    firstTextures = f.textures.slice();
  const warmViews = viewCreates;
  for (let i = 1; i <= 120; i++) f.session.tick(i * 10, viewer);
  assert.equal(viewCreates, warmViews, 'stable eye attachments must reuse their native views');
  const last = f.passes.slice(-6);
  for (const eye of [0, 3]) {
    assert.equal(last[eye].descriptor.colorAttachments[0].view, firstViews[eye].descriptor.colorAttachments[0].view);
    assert.equal(
      last[eye].descriptor.depthStencilAttachment.view,
      firstViews[eye].descriptor.depthStencilAttachment.view,
    );
    assert.equal(
      last[eye + 2].descriptor.depthStencilAttachment.view,
      last[eye].descriptor.depthStencilAttachment.view,
    );
  }
  width = 256;
  f.session.tick(1220, viewer);
  assert.equal(viewCreates, warmViews + 4);
  assert.ok(firstTextures.every((texture) => texture.destroyed === 1));
  assert.ok(f.textures.slice(-4).every((texture) => texture.width === 256 && texture.sampleCount === 4));
  const resized = f.passes.slice(-6);
  assert.notEqual(resized[0].descriptor.colorAttachments[0].view, last[0].descriptor.colorAttachments[0].view);
  await xr.end();
  assert.ok(f.textures.every((texture) => texture.destroyed === 1));
  f.nextSession();
  format = 'bgra8unorm';
  await xr.requestSession();
  f.session.tick(0, viewer);
  assert.ok(f.textures.slice(-4).filter((texture) => texture.format === format).length === 2);
  assert.notEqual(f.passes.at(-6).descriptor.colorAttachments[0].view, resized[0].descriptor.colorAttachments[0].view);
  const restoredViews = viewCreates;
  f.session.tick(10, viewer);
  assert.equal(viewCreates, restoredViews);
  await xr.end();
  assert.ok(f.textures.every((texture) => texture.destroyed === 1));
  assert.deepEqual(f.errors, []);
});

test('XR destroys every eye attachment when native view creation fails and a new session can retry', async (t) => {
  const f = await fixture(t),
    xr = await XR.create(f.engine),
    createTexture = f.device.createTexture,
    error = new Error('native view failure');
  const viewer = {
    ...pose(0),
    views: [{ eye: 'left', projectionMatrix: identity(), transform: pose(-0.03).transform }],
  };
  let fail = true;
  f.device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor),
      createView = texture.createView;
    texture.createView = function (...args) {
      if (fail && descriptor.format === 'depth24plus') throw error;
      return createView.apply(this, args);
    };
    return texture;
  };
  await xr.requestSession();
  f.session.tick(0, viewer);
  await Promise.resolve();
  assert.equal(xr.session, null);
  assert.equal(f.errors[0], error);
  assert.ok(f.textures.every((texture) => texture.destroyed === 1));
  assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
  fail = false;
  f.nextSession();
  await xr.requestSession();
  f.session.tick(0, viewer);
  assert.ok(f.passes.some((pass) => pass.draws === 1));
  await xr.end();
  assert.ok(f.textures.every((texture) => texture.destroyed === 1));
  assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
});

test('device loss releases cached eye views and prevents reuse of the lost manager', async (t) => {
  const f = await fixture(t),
    xr = await XR.create(f.engine);
  const viewer = {
    ...pose(0),
    views: [{ eye: 'left', projectionMatrix: identity(), transform: pose(-0.03).transform }],
  };
  await xr.requestSession();
  f.session.tick(0, viewer);
  assert.equal(f.textures.length, 2);
  assert.ok(f.textures.every((texture) => texture.destroyed === 0));
  f.lose();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(xr.session, null);
  assert.ok(f.textures.every((texture) => texture.destroyed === 1));
  assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
  await assert.rejects(xr.requestSession(), /lost/);
  assert.ok(f.errors.some((error) => /test loss/.test(error.message)));
});

test('XR grows isolated instance storage after the core store expands', async (t) => {
  const f = await fixture(t),
    xr = await XR.create(f.engine);
  await xr.requestSession();
  const viewer = { ...pose(0), views: [{ eye: 'left', projectionMatrix: identity(), transform: pose(0).transform }] };
  f.session.tick(100, viewer);
  const initial = f.buffers.find((buffer) => buffer.descriptor.size === 4 * 24 * 4);
  for (let i = 0; i < 8; i++) f.engine.createMesh().setGeometry(f.mesh.geometry).setPosition([i, 0, 0]);
  f.session.tick(116, viewer);
  assert.deepEqual(f.errors, []);
  assert.ok(f.writes.some((write) => write.data.length === 9 * 24));
  assert.equal(initial.destroyed, 1);
  await xr.end();
  assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
});

test('XR.create refuses the WebGL2 compatibility layer with a coded error naming what it needs', async (t) => {
  const f = await fixture(t);
  navigator.gpu.requestAdapter = async () => ({
    info: { vendor: 'margo-webgl2' },
    requestDevice: async () => f.device,
  });
  await assert.rejects(XR.create(f.engine), {
    code: 'unsupported',
    message: /XR needs the browser's own WebGPU \(XRGPUBinding\) or, on the WebGL2 compatibility layer, its route/,
  });
  assert.equal(f.engine.hasPlugin('xr'), false);
});

test("the WebGL2 layer's binding runs a session on an XRWebGLLayer: no webgpu feature, its projection, shown after the submit", async (t) => {
  const f = await fixture(t);
  navigator.gpu.requestAdapter = async () => ({
    info: { vendor: 'margo-webgl2' },
    requestDevice: async () => f.device,
  });
  const Native = globalThis.XRGPUBinding,
    baseLayer = { webgl: true },
    projection = identity(),
    shown = [],
    color = { width: 64, height: 64, format: 'rgba8unorm', createView: () => ({}) };
  projection[0] = 7;
  class Layer extends Native {
    static webgl = true;
    createProjectionLayer(init) {
      return Object.assign(super.createProjectionLayer(init), { baseLayer });
    }
    getViewSubImage() {
      return {
        colorTexture: color,
        depthStencilTexture: null,
        viewport: { x: 0, y: 0, width: 64, height: 64 },
        getViewDescriptor: () => ({}),
      };
    }
    projection() {
      return projection;
    }
    present(layer) {
      shown.push({ layer, submitted: f.device.submitted });
    }
  }
  Object.defineProperty(globalThis, 'XRGPUBinding', { configurable: true, value: Layer });
  const xr = await XR.create(f.engine);
  await xr.requestSession('immersive-vr');
  assert.deepEqual(f.requests[0].init.requiredFeatures, ['local']);
  assert.equal(f.session.state.baseLayer, baseLayer);
  assert.equal(f.session.state.layers, undefined);
  const view = { projectionMatrix: identity(), transform: pose(0).transform };
  f.session.tick(100, { ...pose(0), views: [{ ...view, eye: 'left' }] });
  assert.deepEqual(f.errors, []);
  assert.equal(shown.length, 1, 'present runs once a frame');
  assert.equal(shown[0].submitted, 1, 'present runs after the submit');
  assert.ok(
    f.writes.some((write) => write.data[0] === 7),
    "the eye's matrix is built from the binding's projection",
  );
  assert.equal(
    f.passes.filter((pass) => !pass.descriptor.colorAttachments.length).length,
    0,
    'no depth pass without a compositor depth texture',
  );
  await xr.end();
});

test('createXREngine asks for an XR-compatible adapter and puts requestAdapter back, also when creation fails', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const asked = [];
  const gpu = {
    async requestAdapter(init) {
      asked.push(init);
      return null;
    },
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
  const own = gpu.requestAdapter;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
  try {
    const canvas = { width: 8, height: 8, getContext: () => null, addEventListener() {}, removeEventListener() {} };
    await assert.rejects(createXREngine(canvas, { powerPreference: 'high-performance' }));
    assert.ok(asked.length >= 1, 'the engine asked for an adapter');
    for (const init of asked) assert.equal(init.xrCompatible, true);
    assert.equal(asked[0].powerPreference, 'high-performance', 'the engine options still reach the adapter');
    assert.equal(gpu.requestAdapter, own);
    assert.ok(Object.hasOwn(gpu, 'requestAdapter'));
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});

test('createXREngine without WebGPU says what is needed', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try {
    await assert.rejects(createXREngine({}), /needs WebGPU; use a browser with WebGPU and WebXR/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});
