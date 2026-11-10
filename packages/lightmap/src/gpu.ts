/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/lightmap/gpu: progressive lightmap baking in WebGPU compute. The texels of a triangle mesh's own UV1 are
// found on the CPU (the ./mesh rasterizer), then every pass traces, per texel, shadow rays to each light and one
// cosine-weighted path (AO, and with `bounces` diffuse indirect light by next-event estimation) through the
// @margoengine/bvh WGSL walker, and adds them to running sums. `texture` shows the mean after each pass, so a viewer sees
// the bake improve live. Random numbers: the PCG hash of Jarzynski and Olano, "Hash Functions for GPU Rendering", JCGT
// 9(3), 2020; the hemisphere basis of Duff et al., "Building an Orthonormal Basis, Revisited", JCGT 6(1), 2017.
import type { BakeLight } from '@margoengine/bvh/bake';
import { bvhWGSL, GPUMeshBVH, type GPUTarget } from '@margoengine/bvh/gpu';
import { MeshBVH } from '@margoengine/bvh/tree';
import { MargoError } from '@margoengine/math/errors';
import { checkpoint, inRange } from './checks.js';
import type { LightmapMesh, MeshLightmap, MeshLightmapOptions } from './mesh.js';
import { encode, type Prepared, prepare } from './texels.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number };
declare const GPUShaderStage: { COMPUTE: number };

/** Options of {@link GPULightmapBaker.create}: those of `bakeMeshLightmap` (but its CPU budgets), plus the path settings. */
export interface GPULightmapOptions
  extends Omit<MeshLightmapOptions, 'aoRays' | 'maxRays' | 'signal' | 'onProgress' | 'occluders'> {
  /** Diffuse bounces per path, 0 to 8; above 0 needs `radiometry: 'physical'`. Default 0 (direct light and AO). */
  bounces?: number;
  /** Linear RGB diffuse reflectance of the mesh, each 0 to 1, for bounces. Default [0.8, 0.8, 0.8]. */
  albedo?: readonly number[];
  /** Geometry that blocks light and AO, and with bounces reflects it with its own `albedo` (default the mesh's). */
  occluders?: readonly { positions: Float32Array; indices?: Uint32Array | Uint16Array; albedo?: readonly number[] }[];
  /** Cancels creation. */
  signal?: AbortSignal;
}

/** Options of {@link bakeMeshLightmapGPU}. */
export interface GPUBakeOptions extends GPULightmapOptions {
  /** Passes to run, 1 to 65,536. Default 256. */
  passes?: number;
  /** Passes per GPU submission, 1 to 64. Default 8. */
  passesPerStep?: number;
  /** Called with passes done and passes in all after each step. */
  onProgress?: (done: number, total: number) => void;
}

/** The per-pass constants of a bake. */
interface Settings {
  seed: number;
  lights: number;
  bounces: number;
  physical: boolean;
  bias: number;
  aoDistance: number;
}

const WORKGROUP = 64;
const LIGHT_FLOATS = 16;
const TYPES = { ambient: 0, directional: 1, point: 2, spot: 3 } as const;

const shader = (bvh: string) => /* wgsl */ `
${bvh}
struct Params {
  count: u32, frame: u32, seed: u32, lights: u32,
  bounces: u32, physical: u32, width: u32, rowThreads: u32,
  bias: f32, aoDistance: f32, pad0: f32, pad1: f32,
}
struct Light { kind: vec4f, rgb: vec4f, direction: vec4f, position: vec4f }
@group(1) @binding(0) var<uniform> params: Params;
@group(1) @binding(1) var<storage, read> texels: array<vec4f>;
@group(1) @binding(2) var<storage, read> lights: array<Light>;
@group(1) @binding(3) var<storage, read> triangles: array<vec4f>;
// Running sums per texel: light RGB, and the open (unoccluded) count in w.
@group(1) @binding(4) var<storage, read_write> sums: array<vec4f>;
@group(1) @binding(5) var live: texture_storage_2d<rgba16float, write>;

var<private> skipFace: u32;
var<private> rng: u32;

fn skipOwn(face: u32, barycoord: vec3f) -> bool { return face != skipFace; }

// PCG hash (Jarzynski and Olano 2020).
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn random() -> f32 {
  rng = pcg(rng);
  return f32(rng >> 8u) / 16777216.0;
}

// Windowed inverse power falloff and spot cone, the terms @margoengine/bvh/bake evaluates on the CPU.
fn directLight(p: vec3f, n: vec3f, own: u32) -> vec3f {
  var e = vec3f(0.0);
  for (var i = 0u; i < params.lights; i++) {
    let l = lights[i];
    let kind = u32(l.kind.x);
    if (kind == 0u) { e += l.rgb.xyz; continue; }
    var dir = l.direction.xyz;
    var scale = 1.0;
    var far = 3.4e38;
    if (kind != 1u) {
      let to = l.position.xyz - p;
      let d = length(to);
      if (d == 0.0) { continue; }
      dir = to / d;
      var reach = 0.0;
      if (l.kind.y > 0.0) { reach = pow(d / l.kind.y, 4.0); }
      let fade = clamp(1.0 - reach, 0.0, 1.0);
      scale = fade * fade / max(pow(max(d, 1e-6), l.kind.z), 0.000244140625);
      if (kind == 3u) {
        let c = -dot(dir, l.direction.xyz);
        let low = l.position.w;
        let high = l.direction.w;
        if (high > low) {
          let t = clamp((c - low) / (high - low), 0.0, 1.0);
          scale *= t * t * (3.0 - 2.0 * t);
        } else {
          scale *= select(0.0, 1.0, c >= low);
        }
      }
      far = d;
    }
    let lambert = dot(n, dir);
    if (!(lambert > 0.0 && scale > 0.0)) { continue; }
    var blocked: BVHHit;
    if (kind == 1u) {
      skipFace = BVH_MISS;
      blocked = bvhAny(p + n * params.bias, dir, 0.0, far, 0u);
    } else {
      // Point and spot: the segment to the light from the surface itself, skipping the receiving triangle.
      skipFace = own;
      blocked = bvhAny(p, dir, params.bias, far, 0u);
    }
    if (blocked.face == BVH_MISS) { e += l.rgb.xyz * scale * lambert; }
  }
  return e;
}

fn hemisphere(n: vec3f) -> vec3f {
  let sign = select(-1.0, 1.0, n.z >= 0.0);
  let k = -1.0 / (sign + n.z);
  let m = n.x * n.y * k;
  let t = vec3f(1.0 + sign * n.x * n.x * k, sign * m, -sign * n.x);
  let b = vec3f(m, sign + n.y * n.y * k, -n.y);
  let u = random();
  let phi = 6.283185307179586 * random();
  let r = sqrt(u);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u)));
}

@compute @workgroup_size(${WORKGROUP})
fn bake(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * params.rowThreads;
  if (i >= params.count) { return; }
  let a = texels[i * 2u];
  let b = texels[i * 2u + 1u];
  let p = a.xyz;
  let n = b.xyz;
  let own = bitcast<u32>(a.w);
  rng = pcg(i ^ pcg(params.frame ^ pcg(params.seed)));
  var light = directLight(p, n, own);
  // One cosine-weighted path: its first segment is the AO ray; each bounce adds the light reflected at the hit.
  skipFace = BVH_MISS;
  var dir = hemisphere(n);
  let first = bvhClosest(p + n * params.bias, dir, 0.0, 3.4e38, 0u);
  let open = select(1.0, 0.0, first.face != BVH_MISS && first.distance < params.aoDistance);
  if (params.physical == 0u) { light *= open; }
  var hit = first;
  var origin = p + n * params.bias;
  var throughput = vec3f(1.0);
  for (var bounce = 0u; bounce < params.bounces; bounce++) {
    if (hit.face == BVH_MISS) { break; }
    let t0 = triangles[hit.face * 3u];
    let t1 = triangles[hit.face * 3u + 1u];
    let t2 = triangles[hit.face * 3u + 2u];
    let x = origin + dir * hit.distance;
    var hn = normalize(cross(t1.xyz - t0.xyz, t2.xyz - t0.xyz));
    if (dot(hn, dir) > 0.0) { hn = -hn; }
    // Cosine sampling cancels cos / pi: the estimate of irradiance is pi * radiance = albedo * irradiance at the hit.
    throughput *= vec3f(t0.w, t1.w, t2.w);
    light += throughput * directLight(x, hn, hit.face);
    origin = x + hn * params.bias;
    dir = hemisphere(hn);
    skipFace = BVH_MISS;
    hit = bvhClosest(origin, dir, 0.0, 3.4e38, 0u);
  }
  let sum = sums[i] + vec4f(light, open);
  sums[i] = sum;
  let at = bitcast<u32>(b.w);
  textureStore(live, vec2u(at % params.width, at / params.width), vec4f(sum.xyz / f32(params.frame + 1u), 1.0));
}
`;

function deviceOf(target: GPUTarget): GPUDevice {
  const device = target && 'gpu' in target ? target.gpu : (target as GPUDevice);
  if (!device || typeof (device as GPUDevice).createComputePipeline !== 'function')
    throw new TypeError('GPULightmapBaker needs a GPUDevice or an engine with one; create the engine on WebGPU');
  return device as GPUDevice;
}

function rgbOf(value: readonly number[] | undefined, name: string): number[] {
  const rgb = value ?? [0.8, 0.8, 0.8];
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((v) => v >= 0 && v <= 1))
    throw new RangeError(`GPULightmapBaker ${name} must be 3 values from 0 to 1; pass linear RGB reflectance`);
  return [...rgb];
}

function packLights(lights: readonly BakeLight[]): Float32Array {
  const out = new Float32Array(Math.max(1, lights.length) * LIGHT_FLOATS);
  lights.forEach((l, i) => {
    if (l.visible === false) return;
    const o = i * LIGHT_FLOATS,
      { type, color = [1, 1, 1], intensity = 1, distance = 0, decay = 2, angle = 0, penumbra = 0 } = l;
    if (!(type in TYPES))
      throw new TypeError("GPULightmapBaker light type must be 'ambient', 'directional', 'point' or 'spot'");
    if (!Array.isArray(color) || color.length !== 3)
      throw new TypeError('GPULightmapBaker light color must be linear RGB [r, g, b]; pass three numbers');
    if (!(intensity >= 0 && intensity < Infinity && distance >= 0 && decay >= 0))
      throw new RangeError('GPULightmapBaker light intensity, distance and decay must be finite and 0 or more');
    const dir = l.direction ?? [0, 1, 0],
      dl = Math.hypot(...dir) || 1,
      position = l.position ?? [0, 0, 0];
    if (type === 'spot' && !(angle > 0 && angle <= Math.PI / 2 && penumbra >= 0 && penumbra <= 1))
      throw new RangeError('GPULightmapBaker spot light needs an angle in (0, pi/2] and a penumbra 0 to 1');
    out.set([TYPES[type], distance, decay, 0], o);
    out.set([color[0] * intensity, color[1] * intensity, color[2] * intensity, 0], o + 4);
    out.set([dir[0] / dl, dir[1] / dl, dir[2] / dl, Math.cos(angle * (1 - penumbra))], o + 8);
    out.set([position[0], position[1], position[2], Math.cos(angle)], o + 12);
  });
  return out;
}

/**
 * Bakes a triangle mesh's lightmap on the GPU, progressively: each {@link step} adds passes, and {@link texture} (an
 * rgba16float storage texture at the lightmap size) holds the running mean, ready to sample while the bake goes on.
 * {@link read} returns the same record as `bakeMeshLightmap` (`@margoengine/lightmap/mesh`), dilated and encoded.
 */
export class GPULightmapBaker {
  readonly device: GPUDevice;
  /** The live lightmap: mean light per texel so far, rgba16float, row 0 at the top. Undilated; empty texels stay 0. */
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  /** Texels baked (covered by a triangle). */
  readonly samples: number;
  /** 'physical' when baked with `radiometry: 'physical'` (irradiance): `applyLightmap` then draws it Lambertian. */
  readonly radiometry?: 'physical';
  #passes = 0;
  #disposed = false;
  #bvh: GPUMeshBVH;
  #buffers: GPUBuffer[];
  #params: GPUBuffer;
  #sums: GPUBuffer;
  #pipeline: GPUComputePipeline;
  #groups: GPUBindGroup[];
  #setup: Prepared;
  #settings: Settings;

  private constructor(
    device: GPUDevice,
    setup: Prepared,
    bvh: GPUMeshBVH,
    settings: Settings,
    triangles: Float32Array,
    lights: Float32Array,
  ) {
    this.device = device;
    this.#setup = setup;
    this.#bvh = bvh;
    this.#settings = settings;
    this.width = setup.width;
    this.height = setup.height;
    this.samples = setup.covered.length;
    if (settings.physical) this.radiometry = 'physical';
    const buffer = (data: ArrayBufferView & { byteLength: number }, usage: number) => {
      const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage });
      device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
      return b;
    };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      texels = new Float32Array(this.samples * 8),
      words = new Uint32Array(texels.buffer);
    for (let i = 0; i < this.samples; i++) {
      texels.set(setup.points.subarray(i * 3, i * 3 + 3), i * 8);
      texels.set(setup.normals.subarray(i * 3, i * 3 + 3), i * 8 + 4);
      words[i * 8 + 3] = setup.owner[i];
      words[i * 8 + 7] = setup.covered[i];
    }
    this.#params = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#sums = device.createBuffer({ size: Math.max(16, this.samples * 16), usage: S | GPUBufferUsage.COPY_SRC });
    this.#buffers = [buffer(texels, S), buffer(lights, S), buffer(triangles, S)];
    this.texture = device.createTexture({
      size: [this.width, this.height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const module = device.createShaderModule({ code: shader(bvhWGSL({ group: 0, binding: 0, accept: 'skipOwn' })) });
    this.#pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'bake' } });
    this.#groups = [
      device.createBindGroup({ layout: this.#pipeline.getBindGroupLayout(0), entries: bvh.bindings() }),
      device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: this.#params } },
          { binding: 1, resource: { buffer: this.#buffers[0] } },
          { binding: 2, resource: { buffer: this.#buffers[1] } },
          { binding: 3, resource: { buffer: this.#buffers[2] } },
          { binding: 4, resource: { buffer: this.#sums } },
          { binding: 5, resource: this.texture.createView() },
        ],
      }),
    ];
  }

  /**
   * Prepares a bake: finds the texels on the CPU, uploads them, the lights and the tree, and compiles the shader. Takes
   * a GPUDevice or an engine (its `gpu`). Throws as `bakeMeshLightmap` does for bad input, before any GPU work.
   */
  static async create(
    target: GPUTarget,
    mesh: LightmapMesh,
    options: GPULightmapOptions = {},
  ): Promise<GPULightmapBaker> {
    const device = deviceOf(target),
      bounces = inRange(options.bounces ?? 0, 0, 8, 'GPULightmapBaker bounces');
    if (bounces > 0 && options.radiometry !== 'physical')
      throw new TypeError("GPULightmapBaker bounces need radiometry 'physical'; set it or bake without bounces");
    const albedo = rgbOf(options.albedo, 'albedo'),
      occluderAlbedo = (options.occluders ?? []).map((o, i) => rgbOf(o?.albedo ?? albedo, `occluder ${i} albedo`)),
      setup = prepare(mesh, { ...options, maxRays: 67108864 }, 'GPULightmapBaker', () => 0),
      lights = packLights(setup.lights);
    // Positions and reflectance per triangle of the tree (mesh first, then each occluder), for bounce hits.
    const triangles = new Float32Array(setup.indices.length * 4);
    let next = setup.meshTriangles,
      group = -1;
    for (let t = 0; t < setup.indices.length / 3; t++) {
      if (t === next) next += setup.occluderTriangles[++group];
      const rgb = group < 0 ? albedo : occluderAlbedo[group];
      for (let k = 0; k < 3; k++) {
        const v = setup.indices[t * 3 + k] * 3;
        triangles.set([setup.positions[v], setup.positions[v + 1], setup.positions[v + 2], rgb[k]], (t * 3 + k) * 4);
      }
    }
    await checkpoint(options.signal);
    const bvh = GPUMeshBVH.forShader(device, MeshBVH.build({ positions: setup.positions, indices: setup.indices }));
    device.pushErrorScope('validation');
    const baker = new GPULightmapBaker(
      device,
      setup,
      bvh,
      {
        seed: setup.seed,
        lights: setup.lights.length,
        bounces,
        physical: setup.physical,
        bias: setup.bias,
        aoDistance: setup.aoDistance,
      },
      triangles,
      lights,
    );
    const error = await device.popErrorScope();
    if (error) {
      baker[Symbol.dispose]();
      throw new MargoError(
        'unsupported',
        `GPULightmapBaker could not build its pipeline: ${error.message}; check the device limits`,
      );
    }
    return baker;
  }

  /** Passes done so far. */
  get passes(): number {
    return this.#passes;
  }

  /** Runs `passes` more passes (1 to 64) in one submission and waits for the GPU to finish them. */
  async step(passes = 1): Promise<void> {
    if (this.#disposed) throw new MargoError('state', 'GPULightmapBaker is disposed; create a new one');
    inRange(passes, 1, 64, 'GPULightmapBaker step passes');
    // A mesh whose UV1 covers no texel still counts its passes, so read() works and a bake loop ends.
    if (!this.samples) {
      this.#passes += passes;
      return;
    }
    const s = this.#settings,
      groups = Math.ceil(this.samples / WORKGROUP),
      x = Math.min(groups, 32768),
      y = Math.ceil(groups / x);
    for (let n = 0; n < passes; n++) {
      const data = new ArrayBuffer(48),
        u = new Uint32Array(data),
        f = new Float32Array(data);
      u.set([
        this.samples,
        this.#passes + n,
        s.seed,
        s.lights,
        s.bounces,
        s.physical ? 1 : 0,
        this.width,
        x * WORKGROUP,
      ]);
      f.set([s.bias, s.aoDistance], 8);
      this.device.queue.writeBuffer(this.#params, 0, data);
      const encoder = this.device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, this.#groups[0]);
      pass.setBindGroup(1, this.#groups[1]);
      pass.dispatchWorkgroups(x, y);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    }
    this.#passes += passes;
    await this.device.queue.onSubmittedWorkDone();
  }

  /** Reads the mean so far back and returns it as `bakeMeshLightmap` does: dilated, encoded RGBA8 and float. */
  async read(): Promise<MeshLightmap> {
    if (this.#disposed) throw new MargoError('state', 'GPULightmapBaker is disposed; create a new one');
    if (!this.#passes) throw new MargoError('state', 'GPULightmapBaker has run no passes; call step() first');
    const sumsBytes = Math.max(16, this.samples * 16),
      staging = this.device.createBuffer({
        size: sumsBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.#sums, 0, staging, 0, sumsBytes);
    this.device.queue.submit([encoder.finish()]);
    try {
      await staging.mapAsync(GPUMapMode.READ);
      const sums = new Float32Array(staging.getMappedRange(0, sumsBytes).slice(0)),
        light = new Float32Array(this.samples * 3),
        ao = new Float32Array(this.samples);
      for (let i = 0; i < this.samples; i++) {
        for (let a = 0; a < 3; a++) light[i * 3 + a] = sums[i * 4 + a] / this.#passes;
        ao[i] = sums[i * 4 + 3] / this.#passes;
      }
      return encode(this.#setup, light, ao, this.samples * (this.#passes * (1 + this.#settings.bounces)));
    } finally {
      staging.destroy();
    }
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const b of [...this.#buffers, this.#params, this.#sums]) b.destroy();
    this.texture.destroy();
    this.#bvh[Symbol.dispose]();
  }
}

/** Bakes on the GPU to completion: {@link GPULightmapBaker} with `passes` passes, then {@link GPULightmapBaker.read}. */
export async function bakeMeshLightmapGPU(
  target: GPUTarget,
  mesh: LightmapMesh,
  options: GPUBakeOptions = {},
): Promise<MeshLightmap> {
  const total = inRange(options.passes ?? 256, 1, 65536, 'bakeMeshLightmapGPU passes'),
    each = inRange(options.passesPerStep ?? 8, 1, 64, 'bakeMeshLightmapGPU passesPerStep');
  using baker = await GPULightmapBaker.create(target, mesh, options);
  while (baker.passes < total) {
    await baker.step(Math.min(each, total - baker.passes));
    options.onProgress?.(baker.passes, total);
    await checkpoint(options.signal);
  }
  return baker.read();
}
