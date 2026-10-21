// Fog on water, VFX particles, Gaussian splats, points/sprites and lines, and SkeletonHelper: physical GPU, published
// dist boundaries, raw HDR readback of the 1x scene capture (or canvas screenshots, taken by the check script).
// Runs against the dist from before fog existed too (no setFog, no SkeletonHelper), which records the baseline.
import { Engine } from '../packages/core/dist/extension.js';
import { PostStack } from '../packages/post/dist/stack.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';
import { Water } from '../packages/water/dist/index.js';
import { VFX } from '../packages/vfx/dist/base.js';
import { textureFeature } from '../packages/vfx/dist/texture.js';
import { Splats } from '../packages/splats/dist/index.js';
import { PointsPlugin, PointCloud, SpriteBatch } from '../packages/points/dist/index.js';
import * as linesPackage from '../packages/lines/dist/index.js';
import { Skeleton } from '../packages/animation/dist/index.js';
import { invertMatrix } from '../packages/math/dist/mat4.js';
import { parseColor, LinearToSRGB } from '../packages/math/dist/color.js';

declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare global {
  var margoLow: number | undefined;
}
type Kind = 'water' | 'spray' | 'vfx' | 'points' | 'sprites' | 'splats' | 'lines' | 'skeleton';
type FogSpec = {
  color?: string | number[];
  near?: number;
  far?: number;
  density?: number;
  heightFalloff?: number;
  height?: number;
  enabled?: boolean;
  env?: boolean;
};
type Fogged = { setFog?: (fog: object | null) => unknown };
const { Lines, Line } = linesPackage,
  SkeletonHelper = (linesPackage as Record<string, unknown>).SkeletonHelper as
    | (new (
        skeleton: Skeleton,
        options?: object,
      ) => InstanceType<typeof Line>)
    | undefined;
globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const W = 320,
  H = 240,
  canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 1, 8], target: [0, 1, 0], near: 0.1, far: 300 },
  }),
  errors: string[] = [],
  images = new Map<string, Float32Array>();
engine.stop();
engine.onError = (error) => errors.push(String(error));
let observed: GPUDevice | undefined,
  sampleCount = 0,
  mode: 'hdr' | 'canvas' = 'hdr',
  stack: PostStack | undefined,
  scene: { kind: Kind; target: Fogged; dispose(): void; skeleton?: Skeleton; helper?: unknown; material?: unknown };
engine.frameGraph.add({
  name: 'fog-all:sample-count',
  order: -100,
  execute(c) {
    if (c.backend === 'webgpu') sampleCount = c.descriptor.multisample?.count ?? 1;
  },
});
function device(): GPUDevice {
  const gpu = engine.gpu!;
  if (gpu !== observed) {
    observed = gpu;
    gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  }
  return gpu;
}
device();
async function frame(): Promise<void> {
  engine.render({ delta: 0 });
  await device().queue.onSubmittedWorkDone();
}
function grid(columns: number, rows: number, x0: number, x1: number, y0: number, y1: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++)
      out.push(x0 + ((x1 - x0) * i) / (columns - 1), y0 + ((y1 - y0) * j) / (rows - 1), 0);
  return out;
}
const tint = (i: number): [number, number, number] => [
  0.25 + (0.7 * ((i * 37) % 11)) / 10,
  0.3 + (0.6 * ((i * 17) % 7)) / 6,
  0.2 + (0.7 * ((i * 29) % 5)) / 4,
];
function heightmap(): GPUTexture {
  const gpu = device(),
    size = 16,
    texture = gpu.createTexture({
      size: [size, size],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }),
    heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) heights[y * size + x] = x < 10 ? -1.5 + x * 0.1 : 0.6;
  gpu.queue.writeTexture({ texture }, heights, { bytesPerRow: size * 4 }, [size, size]);
  return texture;
}
function build(kind: Kind): typeof scene {
  if (kind === 'water' || kind === 'spray') {
    const terrain = kind === 'spray' ? heightmap() : undefined,
      water = Water.attach(engine, {
        size: [400, 400],
        segments: 4,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        ...(stack ? { depth: () => stack!.depthTexture } : {}),
        ...(terrain ? { terrain: { heightmap: () => terrain, origin: [-8, -8], size: [16, 16] }, spray: true } : {}),
      });
    return {
      kind,
      target: water as Fogged,
      dispose() {
        water.dispose();
        terrain?.destroy();
      },
    };
  }
  if (kind === 'vfx') {
    // One still particle per emitter on a grid, so no two overlap: overlapping particles blend in the order an atomic
    // counter lists them, which changes from frame to frame. Every third emitter draws the textured billboard.
    const texture = {
        width: 2,
        height: 2,
        data: new Uint8Array([255, 255, 255, 255, 120, 200, 255, 255, 255, 160, 90, 255, 200, 255, 140, 255]),
      },
      effects = grid(7, 3, -3, 3, 0.2, 1.8).flatMap((_, i, all) =>
        i % 3
          ? []
          : [
              new VFX(
                {
                  capacity: 1,
                  initialCount: 1,
                  rate: 0,
                  position: all.slice(i, i + 3) as [number, number, number],
                  velocity: [0, 0, 0],
                  spread: 0,
                  gravity: [0, 0, 0],
                  turbulence: 0,
                  lifetime: [100, 100],
                  size: 0.7,
                  color: [...tint(i / 3), 1] as [number, number, number, number],
                  ground: -100,
                  ...((i / 3) % 3 === 2 ? { texture } : {}),
                },
                { texture: textureFeature },
              ),
            ],
      );
    for (const effect of effects) engine.use(effect);
    return {
      kind,
      target: { setFog: (fog: object | null) => effects.forEach((effect) => (effect as Fogged).setFog!(fog)) },
      dispose: () => effects.forEach((effect) => effect.dispose()),
    };
  }
  if (kind === 'points' || kind === 'sprites') {
    const plugin = PointsPlugin.attach(engine);
    if (kind === 'points') {
      const positions = grid(7, 3, -3, 3, 0.2, 1.8),
        colors = positions.flatMap((_, i) => (i % 3 ? [] : tint(i / 3))),
        cloud = plugin.add(
          new PointCloud({ positions, colors, colorSpace: 'linear', material: { size: 12, shape: 'square' } }),
        );
      return {
        kind,
        target: plugin as Fogged,
        material: cloud.material,
        dispose: () => engine.removePlugin(plugin.name),
      };
    }
    const batch = plugin.add(
      new SpriteBatch({
        material: { blending: 'additive' },
        sprites: grid(5, 2, -2.4, 2.4, 0.5, 1.5).flatMap((_, i, all) =>
          i % 3 ? [] : [{ position: all.slice(i, i + 3) as [number, number, number], size: 0.9, color: tint(i / 3) }],
        ),
      }),
    );
    return {
      kind,
      target: plugin as Fogged,
      material: batch.material,
      dispose: () => engine.removePlugin(plugin.name),
    };
  }
  if (kind === 'splats') {
    const positions = new Float32Array(grid(7, 3, -3, 3, 0.2, 1.8)),
      n = positions.length / 3,
      covariances = new Float32Array(n * 6),
      colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      covariances.set([0.03, 0, 0, 0.03, 0, 0.03], i * 6);
      colors.set([...tint(i), 0.9], i * 4);
    }
    const splats = Splats.attach(engine, { positions, covariances, colors });
    return { kind, target: splats as Fogged, dispose: () => splats.dispose() };
  }
  const lines = Lines.attach(engine);
  if (kind === 'lines') {
    const positions: number[] = [];
    for (let i = 0; i < 7; i++) positions.push(-4, 0.1 + 0.3 * i, 0, 4, 0.1 + 0.3 * i, 0);
    const line = lines.add(
      new Line({ mode: 'segments', positions, width: 6, antialias: false, cap: 'butt', color: '#ffcc66' }),
    );
    return {
      kind,
      target: lines as Fogged,
      material: line.material,
      dispose: () => engine.removePlugin(lines.name),
    };
  }
  // A posed four-bone rig; the helper is added by setHelper so the same scene renders with and without it.
  const skeleton = new Skeleton([
    { name: 'root', parent: -1, translation: [0, 0, 0] },
    { name: 'spine', parent: 0, translation: [0, 0.8, 0] },
    { name: 'neck', parent: 1, translation: [0, 0.8, 0] },
    { name: 'head', parent: 2, translation: [0, 0.6, 0] },
  ]);
  skeleton.setPose(1, { rotation: [0, 0, Math.sin(0.25), Math.cos(0.25)] });
  skeleton.setPose(2, { rotation: [0, 0, Math.sin(-0.4), Math.cos(-0.4)] });
  return { kind, target: lines as Fogged, skeleton, dispose: () => engine.removePlugin(lines.name) };
}
function makeFog(spec: FogSpec | null): object | null {
  if (!spec) return null;
  const { env, ...fog } = spec;
  void env;
  return { ...fog };
}
async function ensure(kind: Kind): Promise<void> {
  if (scene?.kind === kind) return;
  scene?.dispose();
  scene = build(kind);
  await frame();
  await frame();
}
async function read(): Promise<Float32Array> {
  const gpu = device(),
    source = stack!.sceneTexture!,
    buffer = gpu.createBuffer({ size: W * H * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = gpu.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: W * 8 }, [W, H]);
    gpu.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const words = new Uint16Array(buffer.getMappedRange()),
      out = new Float32Array(W * H * 3);
    const half = (word: number) => {
      const exponent = (word >> 10) & 31,
        mantissa = word & 1023,
        value = exponent ? 2 ** (exponent - 15) * (1 + mantissa / 1024) : (2 ** -14 * mantissa) / 1024;
      return word & 32768 ? -value : value;
    };
    for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) out[p * 3 + c] = half(words[p * 4 + c]);
    return out;
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}
const linear = (color: string | number[] | undefined) => parseColor((color ?? '#ffffff') as never) as number[];
/** environment Fog's fogAmount, in float64. */
function amount(p: number[], eye: ArrayLike<number>, fog: FogSpec): number {
  const near = fog.near ?? 1,
    far = fog.far ?? 1000,
    density = fog.density ?? 0,
    d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]),
    a =
      density > 0
        ? 1 - Math.exp(-density * density * d * d)
        : Math.min(1, Math.max(0, (d - near) / Math.max(far - near, 1e-6)));
  return fog.enabled === false ? 0 : a * Math.exp(-(fog.heightFalloff ?? 0) * Math.max(p[1] - (fog.height ?? 0), 0));
}
/**
 * Per pixel centre: the fog amount where the view ray meets the plane z = 0 (or y = 0); NaN where it does not. Points
 * and splats are fogged at their centre, so `centres` gives each pixel the amount of the nearest centre on screen; lines
 * at their centre line, so `snapY` moves the plane point to the nearest line height.
 */
function amounts(plane: 'z' | 'y', fog: FogSpec, centres?: number[], snapY?: number[]): Float32Array {
  const camera = engine.camera,
    inverse = invertMatrix(camera.matrix, new Float64Array(16))!,
    eye = camera.position,
    out = new Float32Array(W * H).fill(NaN),
    unproject = (x: number, y: number, z: number) => {
      const m = inverse,
        w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [0, 1, 2].map((k) => (m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k]) / w);
    },
    axis = plane === 'z' ? 2 : 1;
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++) {
      const x = ((px + 0.5) / W) * 2 - 1,
        y = 1 - ((py + 0.5) / H) * 2,
        a = unproject(x, y, 0.9),
        b = unproject(x, y, 0.1),
        d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      if (Math.abs(d[axis]) < 1e-9) continue;
      const t = -a[axis] / d[axis],
        p = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t],
        front =
          (p[0] - eye[0]) * (a[0] - eye[0]) + (p[1] - eye[1]) * (a[1] - eye[1]) + (p[2] - eye[2]) * (a[2] - eye[2]);
      if (snapY) p[1] = snapY.reduce((best, y) => (Math.abs(y - p[1]) < Math.abs(best - p[1]) ? y : best));
      if (front > 0) out[py * W + px] = amount(p, eye, fog);
    }
  if (centres) {
    const screen: number[][] = [],
      clip = camera.matrix;
    for (let i = 0; i < centres.length; i += 3) {
      const p = centres.slice(i, i + 3),
        w = clip[3] * p[0] + clip[7] * p[1] + clip[11] * p[2] + clip[15],
        x = (clip[0] * p[0] + clip[4] * p[1] + clip[8] * p[2] + clip[12]) / w,
        y = (clip[1] * p[0] + clip[5] * p[1] + clip[9] * p[2] + clip[13]) / w;
      screen.push([((x + 1) / 2) * W, ((1 - y) / 2) * H, amount(p, eye, fog)]);
    }
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        let best = Infinity;
        for (const [x, y, a] of screen) {
          const d = Math.hypot(x - px - 0.5, y - py - 0.5);
          if (d < best) {
            best = d;
            out[py * W + px] = a;
          }
        }
      }
  }
  return out;
}
const centresOf = (kind: Kind): number[] | undefined =>
  kind === 'points' || kind === 'splats' ? grid(7, 3, -3, 3, 0.2, 1.8) : undefined;
const linesY = (kind: Kind): number[] | undefined =>
  kind === 'lines' ? Array.from({ length: 7 }, (_, i) => 0.1 + 0.3 * i) : undefined;
function diff(a: Float32Array, b: Float32Array) {
  let max = 0,
    sum = 0,
    changed = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d);
    sum += d;
    changed += +(d > 0);
  }
  return { max, mean: sum / a.length, changed };
}
const toBase64 = (array: Float32Array) => {
  let text = '';
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => new Float32Array(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer);

window.fogFixture = {
  errors,
  hasFog: typeof (Water.prototype as Fogged).setFog === 'function',
  hasSkeletonHelper: typeof SkeletonHelper === 'function',
  async mode(next: 'hdr' | 'canvas') {
    scene?.dispose();
    scene = undefined!;
    stack?.dispose();
    stack = undefined;
    mode = next;
    if (mode === 'hdr') stack = PostStack.attach(engine, [new Tonemap({ curve: 'neutral' })]);
    await frame();
    return { mode, sampleCount };
  },
  /** Builds `kind` if needed, applies `fog` (undefined: setFog is not called) and renders; in HDR mode stores the image. */
  async render(label: string, kind: Kind, fog?: FogSpec | null, materialFog?: boolean) {
    await ensure(kind);
    if (fog !== undefined) {
      if (typeof scene.target.setFog !== 'function') throw new Error(kind + ' has no setFog');
      scene.target.setFog(fog?.env ? await environmentFog(fog) : makeFog(fog));
    }
    if (materialFog !== undefined) (scene.material as { fog: boolean }).fog = materialFog;
    await frame();
    await frame();
    if (mode === 'hdr') {
      const image = await read();
      if (!image.every(Number.isFinite)) throw new Error(label + ' has a non-finite channel');
      images.set(label, image);
    }
    return { label, sampleCount };
  },
  diff: (a: string, b: string) => diff(images.get(a)!, images.get(b)!),
  /** G against U + a (F - U), a from the analytic fog amount per pixel; F is the same scene at full fog. */
  analytic(g: string, u: string, f: string, kind: Kind, fog: FogSpec) {
    const G = images.get(g)!,
      U = images.get(u)!,
      F = images.get(f)!,
      A = amounts(kind === 'water' ? 'y' : 'z', fog, centresOf(kind), linesY(kind));
    let max = 0,
      sum = 0,
      count = 0,
      effect = 0,
      worst = -1;
    for (let p = 0; p < W * H; p++) {
      const a = A[p];
      if (!Number.isFinite(a)) continue;
      let span = 0;
      for (let c = 0; c < 3; c++) span = Math.max(span, Math.abs(F[p * 3 + c] - U[p * 3 + c]));
      if (span < 0.002) continue;
      for (let c = 0; c < 3; c++) {
        const i = p * 3 + c,
          error = Math.abs(G[i] - (U[i] + a * (F[i] - U[i])));
        if (error > max) {
          max = error;
          worst = p;
        }
        sum += error;
        effect = Math.max(effect, Math.abs(G[i] - U[i]));
      }
      count++;
    }
    return {
      max,
      mean: sum / Math.max(1, count * 3),
      pixels: count,
      effect,
      worst: [worst % W, Math.floor(worst / W)],
    };
  },
  amounts: (kind: Kind, fog: FogSpec) =>
    Array.from(amounts(kind === 'water' ? 'y' : 'z', fog, centresOf(kind), linesY(kind))),
  fogColor: (fog: FogSpec, encoded: boolean) => linear(fog.color).map((v) => (encoded ? LinearToSRGB(v) : v)),
  export: (label: string) => toBase64(images.get(label)!),
  import(label: string, data: string) {
    images.set(label, fromBase64(data));
  },
  /** Adds (or removes) the SkeletonHelper; `pose` re-poses the rig. Returns each bone's parent-to-child midpoint pixel. */
  skeleton(helper: boolean, pose?: number) {
    const s = scene.skeleton!,
      lines = scene.target as InstanceType<typeof Lines>;
    if (pose !== undefined) s.setPose(1, { rotation: [0, 0, Math.sin(pose), Math.cos(pose)] });
    if (helper && !scene.helper)
      scene.helper = lines.add(
        new SkeletonHelper!(s, { width: 4, antialias: false, color: '#ff0000', parentColor: '#ff0000' }),
      );
    if (!helper && scene.helper) {
      lines.remove(scene.helper as InstanceType<typeof Line>);
      scene.helper = undefined;
    }
    const m = s.matrices,
      clip = engine.camera.matrix,
      pixel = (b: number) => {
        const p = [m[b * 16 + 12], m[b * 16 + 13], m[b * 16 + 14]],
          w = clip[3] * p[0] + clip[7] * p[1] + clip[11] * p[2] + clip[15],
          x = (clip[0] * p[0] + clip[4] * p[1] + clip[8] * p[2] + clip[12]) / w,
          y = (clip[1] * p[0] + clip[5] * p[1] + clip[9] * p[2] + clip[13]) / w;
        return [((x + 1) / 2) * W, ((1 - y) / 2) * H];
      };
    return s.parents
      .map((parent, bone) => {
        if (parent < 0) return null;
        const a = pixel(parent),
          b = pixel(bone);
        return [Math.floor((a[0] + b[0]) / 2), Math.floor((a[1] + b[1]) / 2)];
      })
      .filter(Boolean);
  },
  pixel: (label: string, x: number, y: number) =>
    Array.from(images.get(label)!.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)),
  dispose() {
    scene?.dispose();
    stack?.dispose();
  },
};
async function environmentFog(spec: FogSpec): Promise<object> {
  const { Fog } = await import('../packages/environment/dist/index.js'),
    { env, ...options } = spec;
  void env;
  const fog = new Fog(options as never);
  if (spec.enabled === false) fog.enabled = false;
  return fog;
}
declare global {
  interface Window {
    fogFixture: Record<string, unknown>;
  }
}
