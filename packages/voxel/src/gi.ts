/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/gi: ray-traced bounce light and soft sun shadows from the world's blocks themselves. The blocks of a
// window around the camera go into a GPU grid; each update a compute pass traces rays from a share of the window's open
// cells through that grid (Amanatides and Woo 1987 cell stepping): rays that hit a block bring back the sunlight that
// block's face reflects (its own shadow ray to the sun), gathered as L1 spherical harmonics per cell (Ramamoorthi and
// Hanrahan 2001), and a jittered ray toward the sun gives the cell's soft sun visibility. Both accumulate over updates.
// A `VoxelRenderer` lighting effect adds the bounce light per pixel (irradiance in the face's normal) and scales the sun
// term by the visibility, both read from the open cells around the point half a cell in front of the face.
import type { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { VoxelWorld } from './world.js';
import { unitLight } from '../../shared/unit-light.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; UNIFORM: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number };

const BINDING = 46,
  SIZE = 64, // window edge in cells: 2 x 2 x 2 chunks
  CELLS = SIZE * SIZE * SIZE;

/** Options of {@link VoxelGI.attach}. */
export interface VoxelGIOptions {
  /** The world whose blocks cast and bounce the light. */
  world: VoxelWorld;
  /** Linear albedo of block types by name, each channel 0 to 1, for the light they bounce. Default 0.5 grey. */
  albedo?: Record<string, Vec3>;
  /** Strength of the bounce light, 0 to 8. Live. Default 1. */
  strength?: number;
  /** Half-angle of the sun's cone in radians, 0 to 0.5: wider gives softer shadow edges. Default 0.05. */
  softness?: number;
  /** Open cells traced per update, 4,096 to 262,144: all 262,144 cells of the window are refreshed every `262144 / cells` updates. Default 32,768. */
  cells?: number;
  /** Bounce rays per traced cell per update, 1 to 16. Default 4. */
  rays?: number;
  /** Longest ray in cells, 4 to 64. Default 32. */
  range?: number;
}

const COMPUTE = /* wgsl */ `
const S = 64u;
struct Params { origin: vec4i, sun: vec4f, radiance: vec4f, frame: vec4u, settings: vec4f }
@group(0) @binding(0) var<storage, read> cells: array<u32>;
@group(0) @binding(1) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read_write> acc: array<vec4f>;
@group(0) @binding(4) var shR: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var shG: texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var shB: texture_storage_3d<rgba16float, write>;
@group(0) @binding(7) var sunTex: texture_storage_3d<rgba16float, write>;

// Cell word: block id in bits 0-15, opaque bit 16. Outside the window counts as open.
fn cell(c: vec3i) -> u32 {
  if (any(c < vec3i(0)) || any(c >= vec3i(i32(S)))) { return 0u; }
  return cells[u32(c.x) + u32(c.z) * S + u32(c.y) * S * S];
}
fn solid(c: vec3i) -> bool { return (cell(c) & 65536u) != 0u; }

fn hash(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
fn rand(seed: ptr<function, u32>) -> f32 { *seed = hash(*seed); return f32(*seed >> 8u) / 16777216.0; }

struct Hit { cell: vec3i, normal: vec3f, hit: bool }
// Steps cell by cell from point o (window cells) along d up to range cells (Amanatides and Woo 1987).
fn trace(o: vec3f, d: vec3f, range: f32) -> Hit {
  var c = vec3i(floor(o));
  let step = vec3i(sign(d));
  let inv = 1.0 / max(abs(d), vec3f(1e-6));
  var next = (select(vec3f(c) - o, vec3f(c) + 1.0 - o, d > vec3f(0.0))) * sign(d) * inv;
  next = max(next, vec3f(0.0));
  var h: Hit; h.hit = false;
  var t = 0.0;
  for (var i = 0; i < 200; i++) {
    var axis = 0;
    if (next.y < next.x && next.y <= next.z) { axis = 1; } else if (next.z < next.x && next.z < next.y) { axis = 2; }
    t = next[axis];
    if (t > range) { return h; }
    c[axis] += step[axis];
    next[axis] += inv[axis];
    if (any(c < vec3i(-1)) || any(c > vec3i(i32(S)))) { return h; }
    if (solid(c)) {
      h.hit = true; h.cell = c; h.normal = vec3f(0.0); h.normal[axis] = -f32(step[axis]);
      return h;
    }
  }
  return h;
}

// A direction within the sun's cone, uniformly over its cap.
fn toSun(seed: ptr<function, u32>) -> vec3f {
  let l = P.sun.xyz;
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(l.y) > 0.9);
  let a = normalize(cross(up, l)); let b = cross(l, a);
  let cosMax = cos(P.settings.y);
  let z = 1.0 - rand(seed) * (1.0 - cosMax); let r = sqrt(max(0.0, 1.0 - z * z)); let phi = rand(seed) * 6.2831853;
  return normalize(a * r * cos(phi) + b * r * sin(phi) + l * z);
}

@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.frame.y) { return; }
  let i = (g.x * P.frame.w + P.frame.z) % (S * S * S);
  let c = vec3i(i32(i % S), i32(i / (S * S)), i32((i / S) % S));
  let base = i * 4u;
  if (solid(c)) {
    acc[base] = vec4f(0.0); acc[base + 1u] = vec4f(0.0); acc[base + 2u] = vec4f(0.0); acc[base + 3u] = vec4f(0.0);
  } else {
    var seed = hash(i ^ hash(P.frame.x));
    let o = vec3f(c) + vec3f(0.5);
    let sunUp = P.sun.y > 0.0;
    // Soft sun visibility: one jittered ray toward the sun.
    var visible = 0.0;
    if (sunUp && !trace(o, toSun(&seed), P.settings.z * 4.0).hit) { visible = 1.0; }
    // Bounce: uniform directions over the sphere; a hit block's face sends back albedo x sun x cos x its own visibility.
    var r = vec4f(0.0); var gg = vec4f(0.0); var b = vec4f(0.0);
    let rays = u32(P.settings.w);
    for (var k = 0u; k < rays; k++) {
      let z = 1.0 - 2.0 * rand(&seed); let s = sqrt(max(0.0, 1.0 - z * z)); let phi = rand(&seed) * 6.2831853;
      let d = vec3f(s * cos(phi), z, s * sin(phi));
      let h = trace(o, d, P.settings.z);
      if (!h.hit || !sunUp) { continue; }
      let l = P.sun.xyz;
      let cosine = dot(h.normal, l);
      if (cosine <= 0.0) { continue; }
      let front = vec3f(h.cell) + vec3f(0.5) + h.normal * 0.501;
      if (trace(front, toSun(&seed), P.settings.z * 4.0).hit) { continue; }
      let a = albedo[cell(h.cell) & 65535u].rgb;
      // Radiance leaving a Lambert face: albedo / pi x sun irradiance.
      let L = a * P.radiance.rgb * cosine / 3.14159265;
      // L1 SH basis (Y00, Y1-1 = y, Y10 = z, Y11 = x).
      let y = vec4f(0.282095, 0.488603 * d.y, 0.488603 * d.z, 0.488603 * d.x);
      r += L.r * y; gg += L.g * y; b += L.b * y;
    }
    let scale = 12.5663706 / f32(rays);
    let blend = P.settings.x;
    acc[base] = mix(acc[base], r * scale, blend);
    acc[base + 1u] = mix(acc[base + 1u], gg * scale, blend);
    acc[base + 2u] = mix(acc[base + 2u], b * scale, blend);
    acc[base + 3u] = mix(acc[base + 3u], vec4f(visible, 1.0, 0.0, 0.0), blend);
  }
  // The window wraps in world space like a ring buffer: texel = world cell mod 64.
  let w = vec3u(((c + P.origin.xyz) % vec3i(i32(S)) + vec3i(i32(S))) % vec3i(i32(S)));
  let open = select(1.0, 0.0, solid(c));
  textureStore(shR, w, acc[base] * open);
  textureStore(shG, w, acc[base + 1u] * open);
  textureStore(shB, w, acc[base + 2u] * open);
  textureStore(sunTex, w, vec4f(acc[base + 3u].x * open, open, 0.0, 0.0));
}
`;

const DECLARATIONS = (group: number) => /* wgsl */ `
@group(${group}) @binding(${BINDING}) var voxelGiR:texture_3d<f32>;
@group(${group}) @binding(${BINDING + 1}) var voxelGiG:texture_3d<f32>;
@group(${group}) @binding(${BINDING + 2}) var voxelGiB:texture_3d<f32>;
@group(${group}) @binding(${BINDING + 3}) var voxelGiSunVolume:texture_3d<f32>;
@group(${group}) @binding(${BINDING + 4}) var voxelGiSampler:sampler;
@group(${group}) @binding(${BINDING + 5}) var<uniform> voxelGiWindow:vec4f;
// Window corner in world cells and the strength; outside it no bounce light and full sun.
fn voxelGiAt(p:vec3f,n:vec3f)->vec4f {
 let q=p+n*0.5;let l=q-voxelGiWindow.xyz;
 if(any(l<vec3f(0.5))||any(l>vec3f(63.5))){return vec4f(-1.0);}
 return vec4f(q/64.0,1.0);
}
// Bounce light on a face with normal n: L1 irradiance in n from the open cells around the point half a cell in front
// (trilinear over coefficients times openness, divided by openness), times the surface colour over pi.
fn voxelGiLight(p:vec3f,n:vec3f,base:vec3f)->vec3f {
 let at=voxelGiAt(p,n);if(at.w<0.0){return vec3f(0.0);}
 let open=textureSampleLevel(voxelGiSunVolume,voxelGiSampler,at.xyz,0.0).y;if(open<0.002){return vec3f(0.0);}
 let y=vec4f(3.14159265*0.282095,2.0943951*0.488603*n.y,2.0943951*0.488603*n.z,2.0943951*0.488603*n.x);
 let e=vec3f(dot(textureSampleLevel(voxelGiR,voxelGiSampler,at.xyz,0.0),y),dot(textureSampleLevel(voxelGiG,voxelGiSampler,at.xyz,0.0),y),dot(textureSampleLevel(voxelGiB,voxelGiSampler,at.xyz,0.0),y));
 return base*max(e/open,vec3f(0.0))/3.14159265*voxelGiWindow.w;
}
// Soft sun visibility in front of the face, 0 to 1.
fn voxelGiSun(p:vec3f,n:vec3f)->f32 {
 let at=voxelGiAt(p,n);if(at.w<0.0){return 1.0;}
 let t=textureSampleLevel(voxelGiSunVolume,voxelGiSampler,at.xyz,0.0);
 if(t.y<0.002){return 1.0;}
 return clamp(t.x/t.y,0.0,1.0);
}`;

interface Gpu {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  cells: GPUBuffer;
  albedo: GPUBuffer;
  params: GPUBuffer;
  acc: GPUBuffer;
  textures: GPUTexture[];
  sampler: GPUSampler;
  window: GPUBuffer;
  group: GPUBindGroup;
  entries: GPUBindGroupEntry[];
}

const isColor = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && c >= 0 && c <= 1);

/**
 * Ray-traced bounce light and soft sun shadows for a `VoxelRenderer`, from the world's blocks themselves: add it to the
 * renderer and call {@link VoxelGI.update} each frame. The light follows the engine's directional light
 * (`engine.lighting`) and works inside a 64 x 64 x 64 window of cells around the camera.
 */
export class VoxelGI {
  readonly world: VoxelWorld;
  /** Bounce light strength, 0 to 8. */
  strength: number;
  /** Engine this effect belongs to (the renderer checks it). */
  readonly owner: Engine;
  #engine: Engine;
  #albedo: Record<string, Vec3>;
  #softness: number;
  #cells: number;
  #rays: number;
  #range: number;
  #gpu?: Gpu;
  #origin?: [number, number, number];
  #dirty = true;
  #updates = 0;
  #traced = 0;
  #cursor = 0;
  #tableLength = -1;
  #hooks = new Map<number, { declarations: string; light: string; direct(d: string): string }>();
  #off: (() => void)[] = [];
  #disposed = false;

  private constructor(engine: Engine, options: VoxelGIOptions) {
    this.#engine = this.owner = engine;
    this.world = options.world;
    this.#albedo = options.albedo ?? {};
    this.strength = options.strength ?? 1;
    this.#softness = options.softness ?? 0.05;
    this.#cells = options.cells ?? 32768;
    this.#rays = options.rays ?? 4;
    this.#range = options.range ?? 32;
    const mark = () => {
      this.#dirty = true;
    };
    this.#off.push(this.world.onChange(mark), this.world.onChunk(mark));
  }

  /**
   * @throws TypeError when `engine` is not an Engine or `world` is not a VoxelWorld.
   * @throws RangeError for an option out of range or an albedo that is not [r, g, b] in 0..1.
   * @throws MargoError `unsupported` without the WebGPU backend.
   */
  static attach(engine: Engine, options: VoxelGIOptions): VoxelGI {
    if (typeof engine?.createMesh !== 'function') throw new TypeError('VoxelGI.attach expects an Engine');
    if (typeof options?.world?.getChunk !== 'function' || typeof options.world.onChange !== 'function')
      throw new TypeError('VoxelGI world must be a VoxelWorld');
    const range = (name: keyof VoxelGIOptions, min: number, max: number, whole = false) => {
      const v = options[name];
      if (v === undefined) return;
      if (typeof v !== 'number' || !(v >= min && v <= max) || (whole && !Number.isInteger(v)))
        throw new RangeError(`VoxelGI ${name} is ${v}; pass ${whole ? 'a whole number ' : ''}from ${min} to ${max}`);
    };
    range('strength', 0, 8);
    range('softness', 0, 0.5);
    range('cells', 4096, CELLS, true);
    range('rays', 1, 16, true);
    range('range', 4, 64, true);
    for (const [name, color] of Object.entries(options.albedo ?? {}))
      if (!isColor(color)) throw new RangeError(`VoxelGI albedo of "${name}" must be [r, g, b] in 0..1`);
    if (!engine.gpu)
      throw new MargoError('unsupported', 'VoxelGI needs the WebGPU backend; create the engine with WebGPU');
    return new VoxelGI(engine, options);
  }

  /** Adds the effect to a `VoxelRenderer` (its `addLighting`). Returns the remover. */
  add(voxels: { addLighting(effect: VoxelGI): () => void }): () => void {
    return voxels.addLighting(this);
  }

  /** Lowest corner of the window in world cells, once the first update placed it. */
  get origin(): Vec3 | undefined {
    return this.#origin && [...this.#origin];
  }

  /**
   * Follows the camera (the window moves in steps of 32 cells), uploads the window's blocks when they changed, and
   * traces the next `cells` cells of the window. Call it once a frame, before rendering. Returns the cells traced.
   * @throws MargoError `disposed` after `dispose()`.
   */
  update(): number {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelGI is disposed; attach a new one');
    const gpu = (this.#gpu ??= this.#create()),
      eye = this.#engine.camera.position,
      origin: [number, number, number] = [0, 1, 2].map((a) => Math.round(eye[a] / 32) * 32 - 32) as [
        number,
        number,
        number,
      ];
    if (!this.#origin || origin.some((v, a) => v !== this.#origin![a])) {
      this.#origin = origin;
      this.#dirty = true;
      this.#traced = 0;
      this.#cursor = 0;
    }
    if (this.world.blocks.table.length !== this.#tableLength) this.#uploadAlbedo(gpu);
    if (this.#dirty) this.#uploadCells(gpu);
    const { device } = gpu,
      lighting = this.#engine.lighting,
      count = this.#cells,
      params = new ArrayBuffer(80),
      i = new Int32Array(params),
      u = new Uint32Array(params),
      f = new Float32Array(params);
    i.set(origin, 0);
    unitLight(f, 4, lighting.direction);
    f.set(lighting.radiance, 8);
    // Passes walk the window in a stride coprime with its size, each starting where the last ended; the first sweep of a
    // window sets its cells outright, later ones blend in an eighth.
    u.set([this.#updates++, count, this.#cursor, 40503], 12);
    f.set([this.#traced < CELLS ? 1 : 1 / 8, this.#softness, this.#range, this.#rays], 16);
    device.queue.writeBuffer(gpu.params, 0, params);
    device.queue.writeBuffer(gpu.window, 0, new Float32Array([...origin, this.strength]));
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, gpu.group);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.#cursor = (this.#cursor + count * 40503) % CELLS;
    this.#traced += count;
    return count;
  }

  #create(): Gpu {
    const device = engineRuntime(this.#engine).gpu as GPUDevice,
      module = device.createShaderModule({ label: 'margoengine voxel gi', code: COMPUTE }),
      pipeline = device.createComputePipeline({
        label: 'margoengine voxel gi',
        layout: 'auto',
        compute: { module, entryPoint: 'gather' },
      }),
      buffer = (size: number, usage: number) => device.createBuffer({ label: 'margoengine voxel gi', size, usage }),
      cells = buffer(CELLS * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      albedo = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      params = buffer(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      acc = buffer(CELLS * 64, GPUBufferUsage.STORAGE),
      textures = [0, 1, 2, 3].map(() =>
        device.createTexture({
          label: 'margoengine voxel gi',
          dimension: '3d',
          size: [SIZE, SIZE, SIZE],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        }),
      ),
      sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
      }),
      window = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const gpu: Gpu = {
      device,
      pipeline,
      cells,
      albedo,
      params,
      acc,
      textures,
      sampler,
      window,
      group: undefined as unknown as GPUBindGroup,
      entries: [
        ...textures.map((t, k) => ({ binding: BINDING + k, resource: t.createView() })),
        { binding: BINDING + 4, resource: sampler },
        { binding: BINDING + 5, resource: { buffer: window } },
      ],
    };
    this.#bind(gpu);
    return gpu;
  }

  #bind(gpu: Gpu): void {
    gpu.group = gpu.device.createBindGroup({
      layout: gpu.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: gpu.cells } },
        { binding: 1, resource: { buffer: gpu.albedo } },
        { binding: 2, resource: { buffer: gpu.params } },
        { binding: 3, resource: { buffer: gpu.acc } },
        ...gpu.textures.map((t, k) => ({ binding: 4 + k, resource: t.createView() })),
      ],
    });
  }

  // Albedo per block id (only opaque cubes block rays and bounce light).
  #uploadAlbedo(gpu: Gpu): void {
    const table = this.world.blocks.table,
      data = new Float32Array(Math.max(1, table.length) * 4);
    table.forEach((t, id) => {
      data.set(this.#albedo[t.name] ?? [0.5, 0.5, 0.5], id * 4);
      data[id * 4 + 3] = 1;
    });
    if (gpu.albedo.size < data.byteLength) {
      gpu.albedo.destroy();
      gpu.albedo = gpu.device.createBuffer({
        label: 'margoengine voxel gi',
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#bind(gpu);
    }
    gpu.device.queue.writeBuffer(gpu.albedo, 0, data);
    this.#tableLength = table.length;
    this.#dirty = true;
  }

  // The window's cells: block id, and bit 16 for an opaque cube (what stops rays). Unloaded chunks are open.
  #uploadCells(gpu: Gpu): void {
    const [ox, oy, oz] = this.#origin!,
      table = this.world.blocks.table,
      opaque = table.map((t) => (t.layer === 'opaque' && t.shape === 'cube' ? 65536 : 0)),
      data = new Uint32Array(CELLS);
    for (let cy = 0; cy < 2; cy++)
      for (let cz = 0; cz < 2; cz++)
        for (let cx = 0; cx < 2; cx++) {
          const chunk = this.world.getChunk(ox / 32 + cx, oy / 32 + cy, oz / 32 + cz);
          if (!chunk) continue;
          for (let y = 0; y < 32; y++)
            for (let z = 0; z < 32; z++)
              for (let x = 0, o = cx * 32 + (cz * 32 + z) * SIZE + (cy * 32 + y) * SIZE * SIZE; x < 32; x++, o++) {
                const id = chunk.get(x, y, z) & 0xffff;
                data[o] = id | (opaque[id] ?? 0);
              }
        }
    gpu.device.queue.writeBuffer(gpu.cells, 0, data);
    this.#dirty = false;
  }

  /** The renderer's lighting hooks: bounce light and the soft sun term. Undefined until the first `update()`. */
  pbr(group: number): { declarations: string; light: string; direct(d: string): string } | undefined {
    if (!this.#gpu || this.#disposed) return undefined;
    let hook = this.#hooks.get(group);
    if (!hook) {
      hook = {
        declarations: DECLARATIONS(group),
        light: 'voxelGiLight(i.position,s.n,s.base.rgb)',
        direct: (d: string) => `(${d}*voxelGiSun(i.position,s.n))`,
      };
      this.#hooks.set(group, hook);
    }
    return hook;
  }

  /** Bind group entries of the hooks: the four volumes, their sampler and the window. */
  bindings(): GPUBindGroupEntry[] {
    return this.#gpu?.entries ?? [];
  }

  /** Stops following the world and frees the GPU resources. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#off) off();
    const gpu = this.#gpu;
    if (gpu) {
      for (const t of gpu.textures) t.destroy();
      for (const b of [gpu.cells, gpu.albedo, gpu.params, gpu.acc, gpu.window]) b.destroy();
    }
    this.#gpu = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
