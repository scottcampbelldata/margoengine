import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineKernel, PbrMaterial, box } from '../../core/dist/index.js';
import { Reflector, scenePasses } from '../dist/reflector.js';
import { Refractor } from '../dist/refractor.js';
import { CubeCamera } from '../dist/cube-camera.js';
import { Environment } from '../dist/index.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';

// Core engine on a fake WebGPU device: kernel, culling, camera matrices and the frame graph are real, GPU calls inert.
async function engine(t) {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
    canvas = { width: 400, height: 200, clientWidth: 400, clientHeight: 200, getContext: () => context };
  const resource = (d) => Object.assign({ destroy() {} }, d);
  const pass = () => ({
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    setViewport() {},
    setScissorRect() {},
    drawIndexed() {},
    draw() {},
    end() {},
  });
  const device = {
    features: new Set(),
    limits: { maxBufferSize: 2 ** 30, maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: { writeBuffer() {}, writeTexture() {}, submit() {} },
    createShaderModule: (d) => d,
    createBindGroup: () => ({}),
    createSampler: () => ({}),
    createBuffer: resource,
    createTexture: (d) =>
      Object.assign(resource(d), {
        width: d.size[0],
        height: d.size[1],
        depthOrArrayLayers: d.size[2] ?? 1,
        format: d.format,
        usage: d.usage,
        createView: () => ({}),
      }),
    async createRenderPipelineAsync() {
      return { getBindGroupLayout: () => ({}) };
    },
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({ beginRenderPass: pass, copyTextureToTexture() {}, finish: () => ({}) }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: {
        requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8, INDEX: 16, INDIRECT: 32, COPY_SRC: 64 };
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    COPY_SRC: 2,
    COPY_DST: 4,
    TEXTURE_BINDING: 8,
    STORAGE_BINDING: 16,
  };
  const e = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 5], target: [0, 0, 0], near: 0.1, far: 100 },
  });
  t.after(() => {
    e.dispose();
    for (const [key, d] of Object.entries(saved))
      if (d) Object.defineProperty(globalThis, key, d);
      else delete globalThis[key];
  });
  return e;
}
const clip = (m, p) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const ndc = (m, p) => {
  const c = clip(m, p);
  return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
};
const close = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;

test('capture-only surfaces retain matching projection metadata without drawing their rectangle', async t => {
  const e=await engine(t);
  assert.throws(()=>new Reflector({captureOnly:1}),/boolean/);
  const mirror=Reflector.attach(e,{captureOnly:true,roughness:0});
  assert.equal(mirror.textureMatrix,undefined);
  assert.equal(mirror.update(),true);
  assert.deepEqual(Array.from(mirror.textureMatrix),Array.from(mirror.camera.matrix));
  const snapshot=Array.from(mirror.textureMatrix);
  mirror.camera.position=[200,100,50];mirror.camera.update(2);
  assert.deepEqual(Array.from(mirror.textureMatrix),snapshot,'metadata belongs to the image, not mutable camera state');
  let created=0;const create=e.gpu.createRenderPipeline;
  e.gpu.createRenderPipeline=(...args)=>{created++;return create(...args);};
  e.render({delta:0});assert.equal(created,0,'capture-only does not build a rectangle pipeline');
  mirror.captureOnly=false;e.render({delta:0});assert.ok(created>0,'the regular surface can be enabled');
  mirror.onDeviceRestored();assert.equal(mirror.texture,undefined);assert.equal(mirror.textureMatrix,undefined);
});

test('scene captures own their target viewport and restore the outer background view',async(t)=>{
  const e=await engine(t),seen=[];
  e.scene.background='#ffffff';
  for(const order of [0.5,1e301])e.frameGraph.add({name:`capture-view-${order}`,order,execute:c=>seen.push({width:c.width,height:c.height,viewport:c.view?.viewport,clear:c.view?.clear})});
  const mirror=Reflector.attach(e,{resolution:.25,passes:()=>true});
  assert.equal(mirror.update(),true);
  assert.deepEqual(seen,[
    {width:100,height:50,viewport:[0,0,100,50],clear:{color:'#ffffff'}},
    {width:400,height:200,viewport:[0,0,400,200],clear:{color:'#ffffff'}},
  ]);
  assert.equal(mirror.texture.width,100);assert.equal(mirror.texture.height,50);
  assert.deepEqual(mirror.target.scene.viewContext.view.viewport,[0,0,100,50],'MSAA depth copies use the capture viewport too');
});
// Records which passes ran in each render.
function spies(e, orders) {
  const log = [];
  for (const order of orders)
    e.frameGraph.add({
      name: 'spy' + order,
      order,
      execute: (c) => log.push({ order, camera: c.camera, width: c.width, format: c.format }),
    });
  return log;
}

test('a reflector captures through the mirrored camera with only the scene passes, then restores the frame graph', async (t) => {
  const e = await engine(t),
    log = spies(e, [-1e6, -70, -50, -5, -1, 0.5, 1.5, 9, 31, 40, 1e9]),
    mirror = Reflector.attach(e, { width: 4, height: 4 });
  assert.equal(mirror.texture, undefined);
  assert.equal(mirror.update(), true);
  assert.deepEqual(
    log.map((entry) => entry.order),
    [-1e6, -5, -1, 0.5, 1.5],
    'post-processing (-110..-25) and resolves (9 and up) skipped',
  );
  assert.ok(log.every((entry) => entry.camera === mirror.camera && entry.format === 'rgba16float'));
  assert.ok(mirror.texture, 'captured image');
  log.length = 0;
  e.render();
  assert.deepEqual(
    log.map((entry) => entry.order),
    [-1e6, -70, -50, -5, -1, 0.5, 1.5, 9, 31, 40, 1e9],
    'the full graph again',
  );
  assert.ok(log.every((entry) => entry.camera !== mirror.camera));
  assert.deepEqual(scenePasses({ name: 'x', order: -25 }), true);
  assert.deepEqual(scenePasses({ name: 'x', order: -26 }), false);

  // The capture camera is the eye mirrored in z = 0; the mirror plane is its near plane.
  const m = mirror.camera.matrix,
    main = e.camera.matrix;
  assert.deepEqual(
    mirror.camera.position.map((v) => Math.round(v * 1e6) / 1e6),
    [0, 0, -5],
  );
  for (const p of [
    [0.5, 0.25, 0],
    [-1.2, 0.7, 0],
  ]) {
    const a = ndc(m, p),
      b = ndc(main, p);
    assert.ok(close(a[0], -b[0]) && close(a[1], b[1]), `mirror point ${p} lands x-flipped`);
    assert.ok(close(a[2], 1, 1e-4), `mirror point ${p} is on the near plane (depth ${a[2]})`);
  }
  const front = ndc(m, [0.3, 0.2, 1.5])[2],
    behind = ndc(m, [0, 0, -1])[2];
  assert.ok(front > 0 && front < 1, `in front of the mirror: depth ${front}`);
  assert.ok(behind > 1, `behind the mirror is clipped: depth ${behind}`);

  // Seen from behind or hidden: nothing to capture.
  e.camera.position = [0, 0, -5];
  assert.equal(mirror.update(), false);
  e.camera.position = [0, 0, 5];
  mirror.node.visible = false;
  assert.equal(mirror.update(), false);
  mirror.node.visible = true;
  mirror.dispose();
  assert.equal(e.hasPlugin(mirror.name), false);
});

test('a capture hides excluded and off-layer meshes only while it renders', async (t) => {
  const e = await engine(t),
    a = e.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([0, 0, 2]),
    b = e.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([1, 0, 2]),
    c = e.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([-1, 0, 2]);
  setRenderLayers(b, 0b10);
  const seen = [];
  e.frameGraph.add({
    name: 'visibility',
    order: 0.5,
    execute: () => seen.push([a.visible, b.visible, c.visible, e.stats.visible]),
  });
  const mirror = Reflector.attach(e, { width: 4, height: 4, exclude: [c], layers: 1 });
  mirror.update();
  assert.deepEqual(seen.pop(), [true, false, false, 1]);
  assert.deepEqual([a.visible, b.visible, c.visible], [true, true, true]);
  mirror.layers = 0b11;
  mirror.exclude = undefined;
  mirror.update();
  assert.deepEqual(seen.pop(), [true, true, true, 3]);
  assert.throws(() => (mirror.layers = -1), RangeError);
  assert.throws(() => (mirror.resolution = 0), RangeError);
  assert.throws(() => (mirror.roughness = 2), RangeError);
  assert.throws(() => (mirror.normalMap = { width: 2, height: 2, data: new Uint8Array(3) }), TypeError);
  assert.throws(() => new Reflector({ width: 0 }), RangeError);
});

test('a refractor captures through the main camera and keeps only what lies beyond the surface', async (t) => {
  const e = await engine(t),
    glass = Refractor.attach(e, { width: 4, height: 4 });
  assert.equal(glass.update(), true);
  const m = glass.camera.matrix,
    main = e.camera.matrix;
  assert.deepEqual(glass.camera.position, e.camera.position);
  const on = ndc(m, [0.4, -0.3, 0]),
    seen = ndc(main, [0.4, -0.3, 0]);
  assert.ok(close(on[0], seen[0]) && close(on[1], seen[1]), 'same view as the main camera');
  assert.ok(close(on[2], 1, 1e-4), 'surface on the near plane');
  const beyond = ndc(m, [0, 0, -1.5])[2],
    near = ndc(m, [0, 0, 1])[2];
  assert.ok(beyond > 0 && beyond < 1, `beyond the glass: depth ${beyond}`);
  assert.ok(near > 1, `between the eye and the glass is clipped: depth ${near}`);
  // From the other side the far side flips.
  e.camera.position = [0, 0, -5];
  assert.equal(glass.update(), true);
  assert.ok(ndc(glass.camera.matrix, [0, 0, 1])[2] < 1);
  assert.ok(ndc(glass.camera.matrix, [0, 0, -1])[2] > 1);
});

test('a cube camera renders six standard faces, each culled against its own face, not the main view', async (t) => {
  const e = await engine(t),
    _behind = e.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([0, 0, 20]),
    faces = [];
  e.frameGraph.add({
    name: 'faces',
    order: 0.5,
    execute: (c) =>
      faces.push({ matrix: Float64Array.from(c.camera.matrix), width: c.width, visible: e.stats.visible }),
  });
  e.render();
  const mainVisible = faces.pop().visible;
  assert.equal(mainVisible, 0, 'the box behind the main camera is culled there');
  const cube = CubeCamera.attach(e, { size: 64, position: [0, 0, 0], far: 50, mips: true });
  assert.equal(cube.texture.depthOrArrayLayers, 6);
  assert.equal(cube.texture.mipLevelCount, 7);
  assert.equal(cube.update(), 6);
  assert.equal(faces.length, 6);
  assert.ok(faces.every((face) => face.width === 64));
  assert.deepEqual(
    faces.map((face) => face.visible),
    [0, 0, 0, 0, 1, 0],
    'the +Z face sees the box the main camera culls',
  );
  // WebGPU cube addressing (major axis, then sc/tc per face); the capture is flipped in x into its layer.
  const standard = (d) => {
    const [x, y, z] = d,
      ax = Math.abs(x),
      ay = Math.abs(y),
      az = Math.abs(z);
    let face, sc, tc, ma;
    if (ax >= ay && ax >= az) [face, sc, tc, ma] = x > 0 ? [0, -z, -y, ax] : [1, z, -y, ax];
    else if (ay >= az) [face, sc, tc, ma] = y > 0 ? [2, x, z, ay] : [3, x, -z, ay];
    else [face, sc, tc, ma] = z > 0 ? [4, x, -y, az] : [5, -x, -y, az];
    return [face, (sc / ma + 1) / 2, (tc / ma + 1) / 2];
  };
  for (const d of [
    [1, 0.5, -0.25],
    [-1, -0.3, 0.6],
    [0.2, 1, 0.7],
    [-0.4, -1, 0.1],
    [0.3, -0.6, 1],
    [-0.5, 0.2, -1],
  ]) {
    const [face, u, v] = standard(d),
      p = ndc(faces[face].matrix, d);
    assert.ok(close(1 - (p[0] * 0.5 + 0.5), u, 1e-6) && close(0.5 - p[1] * 0.5, v, 1e-6), `direction ${d}`);
  }
  faces.length = 0;
  assert.equal(cube.update(2), 2);
  assert.equal(cube.update(2), 2);
  assert.equal(faces.length, 4);
  assert.throws(() => cube.update(7), RangeError);
  assert.throws(() => (cube.facesPerFrame = 7), RangeError);
  assert.throws(() => new CubeCamera({ size: 100 }), RangeError);
  // A GPU cube source must be a square power-of-two rgba16float cube with COPY_SRC.
  await assert.rejects(Environment.create(e, { texture: { createView() {}, format: 'rgba8unorm' } }), TypeError);
  cube.dispose();
  assert.throws(() => cube.texture, /disposed/);
});
