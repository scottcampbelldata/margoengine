// Real-GPU fixture for @margoengine/environment's Reflector, Refractor and CubeCamera and @margoengine/cameras' layers.
// Built imports exercise the published package boundary as well as the real WGSL.
import { Engine, PbrMaterial, box } from '../packages/core/dist/extension.js';
import type { Mesh } from '../packages/core/dist/extension.js';
import { Reflector } from '../packages/environment/dist/reflector.js';
import { Refractor } from '../packages/environment/dist/refractor.js';
import { CubeCamera } from '../packages/environment/dist/cube-camera.js';
import { Environment } from '../packages/environment/dist/index.js';
import { ALL_LAYERS, setCameraLayers, setRenderLayers } from '../packages/cameras/dist/layers.js';
import { CameraProjection } from '../packages/cameras/dist/index.js';
import { TAA } from '../packages/taa/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';

declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare const GPUTextureUsage: { COPY_SRC: number; RENDER_ATTACHMENT: number };
declare global {
  var margoLow: number | undefined;
}

type Vec = [number, number, number];
type State = {
  scene: 'baseline' | 'mirror' | 'reference' | 'mirror-view' | 'glass' | 'glass-reference';
  tonemap?: boolean;
  tint?: Vec;
  clipBias?: number;
  green?: boolean;
  yellow?: boolean;
  roughness?: number;
  normal?: boolean;
  frames?: number;
  taa?: boolean;
  ortho?: boolean;
  layers?: 'none' | 'main' | 'both';
  redX?: number;
  redHidden?: boolean;
  hiddenMirror?: boolean;
  keepHistory?: boolean;
};

globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { near: 0.1, far: 100 } }),
  device = engine.gpu!,
  errors: string[] = [];
engine.stop();
const output = canvas.getContext('webgpu')!, configuration = output.getConfiguration()!;
output.configure({...configuration, usage: (configuration.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC});
engine.onError = (error) => errors.push(String(error));
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
let sampleCount = 0;
engine.frameGraph.add({
  name: 'mirror:sample-count',
  order: -100,
  execute(c) {
    if (c.backend === 'webgpu') sampleCount = c.descriptor.multisample?.count ?? 1;
  },
});

const part = (color: string | Vec, position: Vec, size: Vec, rotation = 0): Mesh =>
  engine
    .createMesh()
    .setGeometry(box(...size))
    .setMaterial(new PbrMaterial({ color, roughness: 0.55 }))
    .setPosition(position)
    .setRotation([0, 0, rotation]);
const mirrored = (p: Vec): Vec => [p[0], p[1], -p[2]];
// Mirror scene: everything in front of the mirror (z > 0), a box behind it (z < 0), a wall behind the camera that only
// the reflection shows. The reference scene is the mirror scene reflected in z = 0, light included. The mirror view is
// the mirror scene (without the box behind the mirror) from the main camera reflected in z = 0, up kept: a proper
// camera, so its picture is the reference picture flipped left to right, drawn with the samples the capture uses.
const RED: Vec = [-0.6, 0.2, 1.2],
  BLUE: Vec = [0.7, -0.4, 0.8],
  WALL: Vec = [0, 0, 9],
  red = part('#d0402a', RED, [0.6, 0.6, 0.6], 0.4),
  blue = part('#2f5fd0', BLUE, [0.5, 0.5, 0.5]),
  wall = part('#8090a0', WALL, [30, 30, 0.5]),
  green = part('#30c040', [0.1, 0, -0.9], [0.8, 0.8, 0.8]),
  virtualRed = part('#d0402a', mirrored(RED), [0.6, 0.6, 0.6], 0.4),
  virtualBlue = part('#2f5fd0', mirrored(BLUE), [0.5, 0.5, 0.5]),
  virtualWall = part('#8090a0', mirrored(WALL), [30, 30, 0.5]),
  // Glass scene: a box and a wall beyond the glass, a box between the camera and the glass.
  backdrop = part('#a08a70', [0, 0, -6], [30, 30, 0.5]),
  cyan = part('#30b0c0', [0.3, -0.2, -1.5], [0.7, 0.7, 0.7], 0.3),
  yellow = part('#e0c020', [-0.5, 0.3, 1.5], [0.5, 0.5, 0.5]),
  // Cube scene: one colour per axis at distance 3 and a white marker above and toward -Z of the +X box.
  axisColors: Vec[] = [
    [0.8, 0.1, 0.1],
    [0.1, 0.8, 0.1],
    [0.1, 0.1, 0.8],
    [0.8, 0.8, 0.1],
    [0.1, 0.8, 0.8],
    [0.8, 0.1, 0.8],
  ],
  axes: Vec[] = [
    [3, 0, 0],
    [-3, 0, 0],
    [0, 3, 0],
    [0, -3, 0],
    [0, 0, 3],
    [0, 0, -3],
  ],
  cubeParts = [
    ...axes.map((position, i) => part(axisColors[i], position, [1, 1, 1])),
    part([1, 1, 1], [3, 1, -1], [0.4, 0.4, 0.4]),
  ],
  groups = {
    mirror: [red, blue, wall, green],
    reference: [virtualRed, virtualBlue, virtualWall],
    glass: [backdrop, cyan, yellow],
    cube: cubeParts,
  },
  all = Object.values(groups).flat();
let tonemap: Tonemap | undefined;
let taa: TAA | undefined, projection: CameraProjection | undefined;
// Attached on first use, so the first baseline frame is drawn without them (feature-off reference).
let mirror: Reflector | undefined, glass: Refractor | undefined;

// A tangent-space wave normal map for the distortion check.
const waves = new Uint8Array(64 * 64 * 4);
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const nx = 0.6 * Math.sin((x / 64) * Math.PI * 6),
      ny = 0.6 * Math.cos((y / 64) * Math.PI * 4),
      l = Math.hypot(nx, ny, 1);
    waves.set(
      [((nx / l) * 0.5 + 0.5) * 255, ((ny / l) * 0.5 + 0.5) * 255, ((1 / l) * 0.5 + 0.5) * 255, 255],
      (y * 64 + x) * 4,
    );
  }

function apply(state: State, attach = true) {
  if (attach && !mirror) {
    mirror = Reflector.attach(engine, { width: 3.2, height: 2.4, autoUpdate: false });
    glass = Refractor.attach(engine, { width: 3.2, height: 2.4, autoUpdate: false });
  }
  for (const mesh of all) mesh.visible = false;
  const scene = state.scene,
    glassScene = scene === 'glass' || scene === 'glass-reference';
  const shown =
    scene === 'baseline' || scene === 'mirror' || scene === 'mirror-view'
      ? groups.mirror
      : scene === 'reference'
        ? groups.reference
        : groups.glass;
  for (const mesh of shown) mesh.visible = true;
  green.visible = scene === 'mirror' && state.green !== false;
  yellow.visible = glassScene && state.yellow !== false;
  if (state.redHidden) red.visible = virtualRed.visible = false;
  red.setPosition([state.redX ?? RED[0], RED[1], RED[2]]);
  virtualRed.setPosition([state.redX ?? RED[0], RED[1], -RED[2]]);
  if (mirror && glass) {
    mirror.node.visible = scene === 'mirror' && !state.hiddenMirror;
    glass.node.visible = scene === 'glass';
    mirror.color = state.tint ?? [1, 1, 1];
    glass.color = state.tint ?? [1, 1, 1];
    mirror.clipBias = state.clipBias ?? 0;
    glass.clipBias = state.clipBias ?? 0;
    mirror.roughness = state.roughness ?? 0;
    mirror.normalMap = state.normal ? { width: 64, height: 64, data: waves } : undefined;
    mirror.distortion = 0.03;
    mirror.layers = (state.layers ?? 'none') === 'both' ? 1 : ALL_LAYERS;
  }
  engine.camera.position = glassScene ? [0.5, 0.3, 5] : scene === 'mirror-view' ? [1.2, 0.8, -5] : [1.2, 0.8, 5];
  // Any post-processing makes the main pass resolve its samples in linear HDR, as the capture does.
  if (state.tonemap && !tonemap) tonemap = Tonemap.attach(engine);
  if (!state.tonemap && tonemap) {
    engine.removePlugin(tonemap.name);
    tonemap = undefined;
  }
  engine.camera.target = [0, 0, 0];
  engine.lighting.direction.set([0.4, 0.7, scene === 'reference' ? -0.6 : 0.6, 2.5]);
  engine.lighting.radiance.set([1, 1, 1, 0.25]);
  engine.lighting.ambient.set([1, 1, 1]);
  // A positive near plane: the default ortho depth range reaches behind the eye, where the wall stands.
  if (state.ortho && !projection) projection = CameraProjection.attach(engine, { near: 0.1, far: 100 });
  if (!state.ortho && projection) {
    engine.removePlugin(projection.name);
    projection = undefined;
  }
  if (state.taa && !taa) taa = TAA.attach(engine);
  if (!state.taa && taa) {
    engine.removePlugin(taa.name);
    taa = undefined;
  }
  if (!state.keepHistory) taa?.reset();
  const mode = state.layers ?? 'none';
  setRenderLayers(red, mode === 'none' ? 1 : 0b10);
  setRenderLayers(virtualRed, mode === 'none' ? 1 : 0b10);
  // The main camera draws layer 0 only when layers are on; captures keep their own masks.
  setCameraLayers(engine.camera, mode === 'none' ? ALL_LAYERS : 1);
}
async function render(state: State & { pristine?: boolean }) {
  apply(state, !state.pristine);
  device.pushErrorScope('validation');
  let captured = 0;
  for (let frame = 0; frame < (state.frames ?? 1); frame++) {
    if (mirror?.node.visible) captured += +mirror.update();
    if (glass?.node.visible) captured += +glass.update();
    engine.render({ delta: 1 / 60 });
  }
  // Enqueue the copy in this task, before the canvas texture expires, and map only after the
  // queued work completes. This also waits for a first-use compatibility compute-runtime load.
  const buffer = device.createBuffer({size: 320 * 240 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  let pixels: number[];
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({texture: output.getCurrentTexture()}, {buffer, bytesPerRow: 320 * 4}, [320, 240]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange()), bgra = configuration.format.startsWith('bgra');
    pixels = Array.from(bytes, (_, i) => bytes[bgra && i % 4 !== 3 ? (i & ~3) + 2 - i % 4 : i]);
  } finally { buffer.destroy(); }
  const visibility = [red.visible, virtualRed.visible];
  const error = await device.popErrorScope();
  if (error) errors.push(error.message);
  return { pixels, sampleCount, captured, visibility };
}
const half = (word: number) => {
  const exponent = (word >> 10) & 31,
    mantissa = word & 1023,
    value = exponent ? 2 ** (exponent - 15) * (1 + mantissa / 1024) : (2 ** -14 * mantissa) / 1024;
  return word & 32768 ? -value : value;
};
async function readTexture(texture: GPUTexture, layer = 0) {
  const width = texture.width,
    height = texture.height,
    bytesPerRow = Math.ceil((width * 8) / 256) * 256,
    buffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, origin: [0, 0, layer] }, { buffer, bytesPerRow, rowsPerImage: height }, [
      width,
      height,
      1,
    ]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const words = new Uint16Array(buffer.getMappedRange()),
      out: number[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 4; c++) out.push(half(words[(y * bytesPerRow) / 2 + x * 4 + c]));
    return { width, height, data: out };
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}

const mirrorFixture = {
  errors,
  render,
  // The latest capture image of the mirror or the glass (linear rgba16float), after rendering `state`.
  async capture(which: 'mirror' | 'glass', state: State) {
    const result = await render(state);
    const texture = (which === 'mirror' ? mirror : glass)!.texture!;
    return { ...(await readTexture(texture)), captured: result.captured };
  },
  async cube() {
    apply({ scene: 'baseline' });
    for (const mesh of all) mesh.visible = false;
    for (const mesh of groups.cube) mesh.visible = true;
    if (mirror && glass) mirror.node.visible = glass.node.visible = false;
    engine.camera.position = [0, 0, -10];
    engine.camera.target = [0, 0, -20];
    engine.lighting.direction[3] = 0;
    engine.lighting.radiance.set([1, 1, 1, 1]);
    engine.lighting.ambient.set([1, 1, 1]);
    device.pushErrorScope('validation');
    engine.render();
    const mainVisible = engine.stats.visible,
      camera = CubeCamera.attach(engine, { size: 64, mips: true });
    const drawn = camera.update(),
      faces = [];
    for (let layer = 0; layer < 6; layer++) faces.push((await readTexture(camera.texture, layer)).data);
    const environment = await Environment.create(engine, camera, { specularSize: 32 }),
      axis = (v: Vec) => environment.irradianceAt(v),
      before = axes.map((a) => axis(a.map(Math.sign) as Vec));
    // Live: recolour the +X box, capture again and refresh the environment in place.
    (cubeParts[0] as unknown as { material: PbrMaterial }).material.set({ color: [0.1, 0.1, 0.9] });
    camera.update();
    const version = environment.version;
    await environment.refresh();
    const after = axis([1, 0, 0]),
      refreshedFace = (await readTexture(camera.texture, 0)).data;
    (cubeParts[0] as unknown as { material: PbrMaterial }).material.set({ color: axisColors[0] });
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
    const result = {
      mainVisible,
      drawn,
      faces,
      size: 64,
      mipLevels: camera.texture.mipLevelCount,
      viewDimension: 'cube',
      before,
      after,
      versionKept: environment.version === version,
      refreshedFace,
    };
    environment.dispose();
    engine.removePlugin(camera.name);
    return result;
  },
  dispose() {
    engine.dispose();
  },
};
Object.assign(window, { mirrorFixture });
