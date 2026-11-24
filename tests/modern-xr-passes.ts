// Package passes and post effects in both eyes, on real WebGPU with a stand-in XR session (no headset here). Each eye
// of an engine from createXREngine must match, byte for byte, the same camera drawn to a texture without XR; on a plain
// engine (XR's own device) the line, points and terrain are missing, which is what this route fixes.
import { Engine, box, PbrMaterial, Camera } from '@margoengine/core';
import { XR, createXREngine } from '@margoengine/xr';
import type {
  XRBinding,
  XRNativeFrame,
  XRNativeSession,
  XRProjectionLayer,
  XRSpace,
  XRSubImage,
  XRSystem,
  XRView,
} from '@margoengine/xr';
import { Lines, Line } from '@margoengine/lines';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { Terrain } from '@margoengine/terrain';
import { Bloom } from '@margoengine/post';

const SIZE = 96;
let device: GPUDevice, color: GPUTexture, depth: GPUTexture;
const gpuErrors: string[] = [],
  errors: string[] = [];
/** Two eyes 0.2 apart at z = 3, looking down -z, with a WebGPU [0, 1] projection (near 0.1, far 100). */
function eyes(): XRView[] {
  return ([-0.1, 0.1] as const).map((x, index) => {
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0.5, 3, 1]),
      inverse = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -0.5, -3, 1]),
      near = 0.1,
      far = 100,
      f = 1 / Math.tan(Math.PI / 6);
    return {
      eye: index ? 'right' : 'left',
      projectionMatrix: new Float32Array([
        f,
        0,
        0,
        0,
        0,
        f,
        0,
        0,
        0,
        0,
        far / (near - far),
        -1,
        0,
        0,
        (near * far) / (near - far),
        0,
      ]),
      transform: {
        matrix,
        inverse: { matrix: inverse },
        position: { x, y: 0.5, z: 3, w: 1 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
  });
}
class SimulatedSession extends EventTarget implements XRNativeSession {
  inputSources = [];
  enabledFeatures = ['webgpu', 'local'];
  ended = false;
  async requestReferenceSpace(): Promise<XRSpace> {
    return {};
  }
  updateRenderState(): void {}
  requestAnimationFrame(callback: (time: number, frame: XRNativeFrame) => void): number {
    return requestAnimationFrame((time) => {
      if (this.ended) return;
      const views = eyes();
      callback(time, {
        session: this,
        getPose: () => null,
        getViewerPose: () => ({ transform: views[0].transform, emulatedPosition: false, views }),
      });
    });
  }
  cancelAnimationFrame(id: number): void {
    cancelAnimationFrame(id);
  }
  async end(): Promise<void> {
    this.ended = true;
    this.dispatchEvent(new Event('end'));
  }
}
class SimulatedBinding implements XRBinding {
  // Keep the simulated projection binding on the device selected by the harness.
  // The installXR framebuffer bridge has its own native/compat stereo comparison.
  static readonly webgl = !!(globalThis as { __margoCompat?: boolean }).__margoCompat;
  constructor(_session: XRNativeSession, gpu: GPUDevice) {
    device = gpu;
    device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    color = device.createTexture({ size: [SIZE, SIZE, 2], format: 'rgba8unorm', usage: 0x10 | 1 });
    depth = device.createTexture({ size: [SIZE, SIZE, 2], format: 'depth24plus', usage: 0x10 | 4 });
  }
  getPreferredColorFormat(): GPUTextureFormat {
    return 'rgba8unorm';
  }
  createProjectionLayer(): XRProjectionLayer {
    return {
      destroy() {
        color.destroy();
        depth.destroy();
      },
    };
  }
  getViewSubImage(_layer: XRProjectionLayer, view: XRView): XRSubImage {
    return {
      colorTexture: color,
      depthStencilTexture: depth,
      viewport: { x: 0, y: 0, width: SIZE, height: SIZE },
      getViewDescriptor: () => ({ dimension: '2d', baseArrayLayer: view.eye === 'left' ? 0 : 1, arrayLayerCount: 1 }),
    };
  }
}
Object.defineProperty(globalThis, 'XRGPUBinding', { configurable: true, value: SimulatedBinding });
const simulated: XRSystem = {
  isSessionSupported: async () => true,
  requestSession: async () => new SimulatedSession(),
};
Object.defineProperty(navigator, 'xr', { configurable: true, value: simulated });

/** RGBA bytes of `texture`'s layer `layer` (BGRA swapped when `bgra`). */
async function read(gpu: GPUDevice, texture: GPUTexture, layer: number, bgra = false): Promise<Uint8Array> {
  // Rows of a texture-to-buffer copy are a multiple of 256 bytes.
  const row = Math.ceil((SIZE * 4) / 256) * 256,
    buffer = gpu.createBuffer({ size: SIZE * row, usage: 1 | 8 }),
    encoder = gpu.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, origin: [0, 0, layer] }, { buffer, bytesPerRow: row }, [SIZE, SIZE]);
  gpu.queue.submit([encoder.finish()]);
  await buffer.mapAsync(1);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      for (let c = 0; c < 4; c++) out[(y * SIZE + x) * 4 + c] = raw[y * row + x * 4 + (bgra && c < 3 ? 2 - c : c)];
  buffer.unmap();
  buffer.destroy();
  return out;
}
/** Pixels where `test(r, g, b, a)` holds. */
const count = (pixels: Uint8Array, test: (r: number, g: number, b: number, a: number) => boolean): number => {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) if (test(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])) n++;
  return n;
};
/** Pixels of the bottom quarter (below the horizon, where only the terrain is) that are not the clear colour. */
const ground = (pixels: Uint8Array): number => {
  let n = 0;
  for (let y = Math.floor((SIZE * 3) / 4); y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (
        Math.abs(pixels[i] - pixels[0]) + Math.abs(pixels[i + 1] - pixels[1]) + Math.abs(pixels[i + 2] - pixels[2]) >
        12
      )
        n++;
    }
  return n;
};
const green = (r: number, g: number, b: number) => g > 120 && g > r * 2 && g > b * 2,
  blue = (r: number, g: number, b: number) => b > 120 && b > r * 2 && b > g * 1.5,
  red = (r: number, g: number, b: number) => r > 120 && r > g * 2 && r > b * 2;

/** A scene with a core box, a line, a point cloud, flat terrain and bloom. */
function scene(engine: Awaited<ReturnType<typeof Engine.create>>): void {
  engine
    .createMesh()
    .setGeometry(box(0.6, 0.6, 0.6))
    .setMaterial(new PbrMaterial({ color: '#ff0000' }))
    .setPosition([0, 0.5, 0]);
  Lines.attach(engine).add(new Line({ positions: [-3, 1.2, 0, 3, 1.2, 0], colors: [0, 1, 0, 0, 1, 0], width: 6 }));
  const n = 400,
    positions = new Float32Array(n * 3),
    colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions.set([-1.5 + (i % 20) * 0.15, -0.2 + Math.floor(i / 20) * 0.02, 0.5], i * 3);
    colours.set([0, 0, 1], i * 3);
  }
  PointsPlugin.attach(engine).add(
    new PointCloud({ positions, colors: colours, material: { size: 4, shape: 'square' } }),
  );
  Terrain.attach(engine, {
    size: [64, 64],
    origin: [-32, -32],
    // Heights are metres times heightScale: the -0.5 below puts the ground half a metre under the box.
    heightScale: 1,
    layers: [0, 1, 2, 3].map(() => ({ height: [-1e6, 1e6], slope: [0, 1], scale: 0.25 })),
    textures(gpu) {
      const heightmap = gpu.createTexture({ size: [4, 4], format: 'r32float', usage: 6 });
      gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(16).fill(-0.5), { bytesPerRow: 16 }, [4, 4]);
      const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
      gpu.queue.writeTexture(
        { texture: layers },
        new Uint8Array(16).fill(200),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1, 4],
      );
      const weight = gpu.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
      gpu.queue.writeTexture({ texture: weight }, new Uint8Array([255, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
      return { heightmap, layers, weights: [weight, weight] };
    },
  });
  Bloom.attach(engine, { threshold: 0.2, strength: 1.5 });
}
/** The camera an eye sees through, built from its pose and projection as the XR route builds it. */
function camera(view: XRView, near: number, far: number): Camera {
  const m = view.transform.matrix,
    p = view.projectionMatrix,
    projection = new Float64Array(16),
    eye = new Camera({ near, far, fov: (2 * Math.atan(1 / p[5]) * 180) / Math.PI });
  projection.set(p);
  for (let c = 0; c < 16; c += 4) projection[c + 2] = p[c + 3] - p[c + 2];
  eye.position = [m[12], m[13], m[14]];
  eye.target = [m[12] - m[8], m[13] - m[9], m[14] - m[10]];
  eye.up = [m[4], m[5], m[6]];
  eye.project = (out) => out.set(projection);
  return eye;
}
async function frames(xr: XR, mode: 'immersive-vr' | 'immersive-ar', n = 4, manual = false): Promise<void> {
  let seen = 0;
  await xr.requestSession(mode, { onFrame: () => {
    seen++;
    if (manual) { xr.renderFrame(); return false; }
  } });
  while (seen < n) {
    if (gpuErrors.length || errors.length) throw new Error([...errors, ...gpuErrors].join('\n'));
    await new Promise(requestAnimationFrame);
  }
  await device.queue.onSubmittedWorkDone();
}
/** Background pixels of eye `layer` that the layer depth puts at the far plane, found by a depth test at 0.999. */
/** Per pixel, 1 where a full-screen triangle at depth 0.999 passes a 'less' test against the layer's depth. */
async function far(gpu: GPUDevice, layer: number): Promise<Uint8Array> {
  const target = gpu.createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: 0x10 | 1 }),
    module = gpu.createShaderModule({
      code: '@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[i], 0.999, 1); }\n@fragment fn f() -> @location(0) vec4f { return vec4f(1); }',
    }),
    pipeline = gpu.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'v' },
      fragment: { module, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    }),
    encoder = gpu.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: {
        view: depth.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  gpu.queue.submit([encoder.finish()]);
  const pixels = await read(gpu, target, 0);
  target.destroy();
  return pixels.filter((_, i) => i % 4 === 0).map((r) => +(r === 255));
}

async function run() {
  const canvas = document.querySelector('canvas')!;
  // 1. Through the engine: every pass in both eyes, equal to the same camera without XR.
  const engine = await createXREngine(canvas, { capacity: 16 });
  engine.onError = (error) => errors.push(String(error));
  scene(engine);
  const xr = await XR.create(engine);
  if (xr.route !== 'engine') throw new Error(`createXREngine gave the ${xr.route} route`);
  await frames(xr, 'immersive-vr');
  const gpu = engine.gpu!,
    result: Record<string, unknown> = { route: xr.route, eyes: [] as unknown[] },
    format = engine.renderTarget!.format,
    farPixels = [await far(gpu, 0), await far(gpu, 1)];
  const eyePixels = [await read(gpu, color, 0), await read(gpu, color, 1)];
  await xr.end();
  await frames(xr, 'immersive-vr', 4, true);
  const manualEyes = [await read(gpu, color, 0), await read(gpu, color, 1)];
  for (let eye = 0; eye < 2; eye++)
    if (manualEyes[eye].some((value, i) => value !== eyePixels[eye][i]))
      throw new Error(`Manual renderFrame differs from automatic XR output in eye ${eye}`);
  result.manualEyesExact = true;
  await xr.end();
  const reference = gpu.createTexture({ size: [SIZE, SIZE], format, usage: 0x10 | 1 });
  // One reference render per eye, each compared with what XR drew for that eye.
  for (const [i, view] of eyes().entries()) {
    engine.render({
      views: [
        {
          camera: camera(view, engine.camera.near, engine.camera.far),
          viewport: [0, 0, 1, 1],
          target: { color: reference },
          id: `xr-${i}`,
        },
      ],
    });
    const expected = await read(gpu, reference, 0, format === 'bgra8unorm'),
      got = eyePixels[i];
    let differ = 0;
    for (let p = 0; p < got.length; p += 4)
      if (got[p] !== expected[p] || got[p + 1] !== expected[p + 1] || got[p + 2] !== expected[p + 2]) differ++;
    const eye = {
      differ,
      line: count(got, green),
      points: count(got, blue),
      box: count(got, red),
      terrain: ground(got),
      far: 0,
      farGround: 0,
      farBox: 0,
    };
    // The far test passes where the layer depth is 1 (nothing drawn): the sky, never the ground or the box.
    for (let p = 0; p < SIZE * SIZE; p++) {
      if (!farPixels[i][p]) continue;
      eye.far++;
      if (p >= SIZE * Math.floor((SIZE * 3) / 4)) eye.farGround++;
      if (red(got[p * 4], got[p * 4 + 1], got[p * 4 + 2])) eye.farBox++;
    }
    (result.eyes as unknown[]).push(eye);
    if (differ) throw new Error(`Eye ${i}: ${differ} pixels differ from the same camera without XR`);
    if (eye.line < 20 || eye.points < 20 || eye.box < 20 || eye.terrain < (SIZE * SIZE) / 8)
      throw new Error(`Eye ${i} misses a pass: ${JSON.stringify(eye)}`);
    if (eye.far < (SIZE * SIZE) / 8 || eye.farGround || eye.farBox)
      throw new Error(`Eye ${i} depth layer: ${JSON.stringify(eye)}`);
  }
  // The eyes differ: the box is 0.2 apart between them.
  if (eyePixels[0].every((v, i) => v === eyePixels[1][i])) throw new Error('Both eyes drew the same image');
  // 2. AR: where nothing wrote depth the real world shows through, kept only by the scene's own light (here the
  // bloom's glow): alpha is the brightest channel there. The box and the ground are opaque.
  await frames(xr, 'immersive-ar');
  const ar = await read(gpu, color, 0),
    sky = await far(gpu, 0);
  let open = 0,
    glow = 0,
    wrong = 0;
  for (let p = 0; p < SIZE * SIZE; p++) {
    if (!sky[p]) continue;
    open++;
    const [r, g, b, a] = ar.slice(p * 4, p * 4 + 4);
    if (a !== Math.max(r, g, b)) wrong++;
    if (a < 128) glow++;
  }
  const solid = count(ar, (r, g, b, a) => red(r, g, b) && a === 255),
    floor = count(ar.slice(SIZE * Math.floor((SIZE * 3) / 4) * 4), (_r, _g, _b, a) => a === 255);
  await xr.end();
  result.ar = { open, glow, wrong, solid, floor };
  if (open < (SIZE * SIZE) / 8 || glow < 50 || wrong || solid < 20 || floor < (SIZE * SIZE) / 4)
    throw new Error(`AR alpha: ${JSON.stringify(result.ar)}`);
  xr.dispose();
  if (gpu.destroyed) throw new Error('Disposing XR destroyed the engine device');
  engine.dispose();
  // 3. A plain engine: XR's own device draws core meshes and models only; the line, points and terrain are missing.
  const plain = await Engine.create(canvas, { backend: 'webgpu', capacity: 16 });
  plain.onError = (error) => errors.push(String(error));
  scene(plain);
  const separate = await XR.create(plain);
  await frames(separate, 'immersive-vr');
  const lost = await read(device, color, 0);
  result.separate = {
    route: separate.route,
    line: count(lost, green),
    points: count(lost, blue),
    box: count(lost, red),
  };
  await separate.end();
  separate.dispose();
  plain.dispose();
  if (separate.route !== 'separate' || count(lost, green) || count(lost, blue) || !count(lost, red))
    throw new Error(`Separate route: ${JSON.stringify(result.separate)}`);
  if (errors.length || gpuErrors.length) throw new Error([...errors, ...gpuErrors].join('\n'));
  return { ...result, gpuErrors, headset: 'simulated session; real WebGPU rendering' };
}
(globalThis as typeof globalThis & { xrVerification: Promise<unknown> }).xrVerification = run().then(
  (result) => ({ result }),
  (error) => ({ error: String(error) }),
);
