/// <reference lib="esnext.disposable" preserve="true" />
// Soft ground contact shadows for product shots. Each update renders the added casters into a small square
// "nearness" texture with an orthographic camera standing on the ground and looking straight up (max blend keeps the
// surface closest to the ground per texel, no depth buffer), then softens it with one separable Gaussian (a horizontal
// and a vertical pass whose kernels are sized per axis so the blur is round in world units), and finally lays a
// transparent plane on the ground that composites the shadow colour over the scene.
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type Mesh,
  type PassContext,
  type Vec3,
} from '@margoengine/core/extension';
import {
  casterBuffers,
  drawCaster,
  clippedDepth,
  displacementGroup,
  opacityDepth,
  opacityEntries,
  solidVertexDepth,
  type CasterCutout,
} from '../../shared/caster.js';
import { displacedDepth } from '../../shared/displacement.js';
import { instancedDepth } from '../../shared/instances.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { fullscreen, group, render as fullscreenPipeline } from '../../shared/gpu.js';
import { applyView } from '../../shared/view-rect.js';
import { margoError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
type ContactPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link ContactShadows}. The object is kept and read every frame, so changes apply live. */
export interface ContactShadowOptions {
  /** Centre of the shadow on the ground; the ground is the horizontal plane y = position[1]. Default [0, 0, 0]. */
  position?: Vec3;
  /** Width (world x) and depth (world z) of the shadow plane; one number gives a square. Default 4. */
  size?: number | readonly [number, number];
  /**
   * Geometry from the ground up to this height casts. Darkness falls linearly from full at the ground to none at this
   * height. Default 1.
   */
  height?: number;
  /** Blur radius in world units; 0 keeps the hard shadow. Default 1.5% of the larger plane side. */
  blur?: number;
  /** Darkness where an object touches the ground, 0..1. Default 0.6. */
  opacity?: number;
  /** Shadow colour, linear RGB written as-is (not tone-mapped) to the scene target. Default black. */
  color?: Vec3;
  /** Texels per side of the square shadow texture, an integer in 16..4096. Default 256. */
  resolution?: number;
  /**
   * Re-render the shadow texture only when something it depends on changed (casters, transforms, visibility,
   * options) or after {@link ContactShadows.invalidate}; otherwise reuse it. Default false (every frame).
   */
  static?: boolean;
}

/**
 * One drawable caster, the same shape as `@margoengine/shadows`' shadow primitives. gltf-pro models and materials
 * meshes expose arrays of them as `shadowPrimitives`.
 */
export interface ContactPrimitive extends CasterCutout {
  /** Node whose world matrix places the primitive. */
  node: Mesh;
  /** Vertex buffer: 24-byte core vertices (position) or 80-byte gltf-pro vertices. */
  vertex: GPUBuffer;
  /** Byte offset of the caster's first vertex in `vertex` (a deformer's shared buffer). Default 0. */
  vertexOffset?: number;
  /** `uint32` index buffer. */
  index: GPUBuffer;
  /** Number of indices to draw. */
  count: number;
  /** Vertex stride in bytes, 24 or 80. */
  stride: number;
  /** Omitted means triangles; wireframe casters give line-list indices. */
  topology?: 'triangle-list' | 'line-list';
  /** Alpha mask (80-byte vertices); its alpha channel is multiplied in. Missing means opaque white. */
  alphaTexture?: GPUTextureView;
  /** Sampler of `alphaTexture`. */
  alphaSampler?: GPUSampler;
  /** Alpha factor. Default 1. */
  alpha?: number;
  /** Fragments with texture alpha x `alpha` x vertex alpha below this are dropped. Default 0. */
  cutoff?: number;
  /** 1 reads the mask with TEXCOORD_1, anything else with TEXCOORD_0. */
  texCoord?: number;
  /** Per-instance rows (80-byte primitives only); all `count` instances are drawn in one draw, none when 0. */
  instances?: { readonly count: number; upload(device: GPUDevice): GPUBuffer };
}

/** Anything that provides contact casters: gltf-pro `PBRModel`, `@margoengine/materials` meshes. */
export interface ContactSource {
  /** Casters, read again every frame (the list may change). */
  shadowPrimitives?: readonly ContactPrimitive[];
  /** When true the source is dropped on the next frame. */
  disposed?: boolean;
}

/** Validated, defaulted options of one frame. */
interface Settings {
  x: number;
  ground: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  blur: number;
  opacity: number;
  color: readonly number[];
  resolution: number;
  cached: boolean;
}

type Entry = { mesh: Mesh; proxy?: ContactPrimitive } | { source: ContactSource };

/** Per-draw GPU state, reused by draw slot so steady frames allocate nothing. */
interface Slot {
  uniform: GPUBuffer;
  values: Float32Array<ArrayBuffer>;
  group?: GPUBindGroup;
  pipeline?: GPURenderPipeline;
  mask?: GPUTextureView;
  sampler?: GPUSampler;
  opacity?: ContactPrimitive['opacity'];
  displacement?: ContactPrimitive['displacement'];
  displaced?: GPUBindGroup;
  clip?: GPUBuffer;
}

// Blur: Gaussian with sigma = radius / 2, cut at 3 sigma (the truncated tail is 0.3% of the weight, below r16float
// visibility), sampled with the bilinear pair trick (two neighbouring texel weights fetched by one filtered read at
// their weighted centre). At most 32 filtered reads per side; wider kernels spread their samples further apart.
const MAX_PAIRS = 32;
const KERNEL_FLOATS = 4 + MAX_PAIRS * 2;
const PLANE_LIFT = 1e-4; // share of the larger plane side the plane floats above the ground (avoids z-fighting)
const DEFAULT_RESOLUTION = 256; // 64 texels per world unit on the default 4-unit plane; the blur hides the texel grid
const STRIDES = new Set([24, 80]);

const occluderBody = (transformed = false) => `
struct Draw {camera:mat4x4f,model:mat4x4f,alpha:vec4f${transformed ? ',alphaUV0:vec4f,alphaUV1:vec4f' : ''}}
@group(0) @binding(0) var<uniform> f:Draw;`;

// 80-byte casters: alpha cutout from TEXCOORD_0 or _1. The text keeps the shape the shared caster edits rewrite:
// displacedDepth (shared/displacement.js), instancedDepth (shared/instances.js), opacityDepth, solidVertexDepth and
// clippedDepth (shared/caster.js).
const pbrOccluder = (transformed: boolean) => `${occluderBody(transformed)}
@group(0) @binding(1) var mask:texture_2d<f32>;
@group(0) @binding(2) var maskSampler:sampler;
struct In {@location(0) position:vec4f,@location(3) uv:vec4f,@location(4) color:vec4f}
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:In)->Out {
 var o:Out;
 o.clip=f.camera*f.model*vec4f(i.position.xyz,1);
 o.uv=select(i.uv.xy,i.uv.zw,f.alpha.z==1);
 o.alpha=i.color.a;
 ${transformed ? 'let sourceUV=o.uv;o.uv=vec2f(dot(f.alphaUV0.xy,sourceUV)+f.alphaUV0.z,dot(f.alphaUV1.xy,sourceUV)+f.alphaUV1.z);' : ''}
 return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 let coverage=textureSample(mask,maskSampler,i.uv).a*f.alpha.x*i.alpha;
 if (coverage<f.alpha.y) {discard;}
 return vec4f(1-i.clip.z,0,0,1);
}`;

// 24-byte core casters: position only.
const coreOccluder = `${occluderBody()}
@vertex fn vertex(@location(0) position:vec3f)->@builtin(position) vec4f {
 return f.camera*f.model*vec4f(position,1);
}
@fragment fn fragment(@builtin(position) clip:vec4f)->@location(0) vec4f {
 return vec4f(1-clip.z,0,0,1);
}`;

// One axis of the separable Gaussian. axis.xy: uv step per unit offset, axis.z: filtered pairs per side,
// axis.w: centre weight; taps hold (offset, weight) pairs, two per vec4.
const blurShader = `${fullscreen}
struct Kernel {axis:vec4f,taps:array<vec4f,${MAX_PAIRS / 2}>}
@group(0) @binding(0) var<uniform> kernel:Kernel;
@group(0) @binding(1) var nearness:texture_2d<f32>;
@group(0) @binding(2) var bilinear:sampler;
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 var sum=textureSampleLevel(nearness,bilinear,v.uv,0).r*kernel.axis.w;
 let pairs=u32(kernel.axis.z);
 for (var i=0u;i<pairs;i++) {
  let packed=kernel.taps[i/2u];
  let tap=select(packed.xy,packed.zw,(i&1u)==1u);
  let step=kernel.axis.xy*tap.x;
  sum+=tap.y*(textureSampleLevel(nearness,bilinear,v.uv+step,0).r+textureSampleLevel(nearness,bilinear,v.uv-step,0).r);
 }
 return vec4f(sum,0,0,1);
}`;

// The shadow catcher: a 4-vertex strip over the plane rectangle, premultiplied colour x coverage.
const planeShader = `
struct Plane {camera:mat4x4f,tint:vec4f,origin:vec4f,extent:vec4f}
@group(0) @binding(0) var<uniform> plane:Plane;
@group(0) @binding(1) var shade:texture_2d<f32>;
@group(0) @binding(2) var bilinear:sampler;
struct Varyings {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) corner:u32)->Varyings {
 let t=vec2f(f32(corner&1u),f32(corner>>1u));
 let world=vec3f(plane.origin.x+t.x*plane.extent.x,plane.origin.y,plane.origin.z+t.y*plane.extent.y);
 return Varyings(plane.camera*vec4f(world,1),vec2f(t.x,1-t.y));
}
@fragment fn fragment(v:Varyings)->@location(0) vec4f {
 let a=clamp(textureSample(shade,bilinear,v.uv).r,0,1)*plane.tint.a;
 return vec4f(plane.tint.rgb*a,a);
}`;

const optionError = (what: string) => new RangeError(`Invalid contact shadow options: ${what}`);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function triple(value: unknown, name: string): readonly number[] {
  const v = value as ArrayLike<unknown> | null;
  if (!v || typeof v !== 'object' || v.length !== 3 || ![0, 1, 2].every((i) => finite(v[i])))
    throw optionError(`${name} must be 3 finite numbers`);
  return value as readonly number[];
}

/** Writes the Gaussian kernel for a radius of `texels` along `axis` (uv step per texel) into `out`. */
function gaussianKernel(texels: number, axis: readonly [number, number], out: Float32Array): void {
  out.fill(0);
  const sigma = texels / 2,
    support = Math.max(1, Math.ceil(3 * sigma)),
    samples = Math.min(support, MAX_PAIRS * 2),
    spacing = support / samples,
    weight = (k: number) => Math.exp(-((k * spacing) ** 2) / (2 * sigma * sigma));
  let total = weight(0);
  for (let k = 1; k <= samples; k++) total += 2 * weight(k);
  let pairs = 0;
  for (let k = 1; k <= samples; k += 2) {
    const a = weight(k),
      b = k + 1 <= samples ? weight(k + 1) : 0;
    out[4 + pairs * 2] = ((k * a + (k + 1) * b) / (a + b)) * spacing;
    out[5 + pairs * 2] = (a + b) / total;
    pairs++;
  }
  out[0] = axis[0];
  out[1] = axis[1];
  out[2] = pairs;
  out[3] = weight(0) / total;
}

/**
 * Soft contact shadow under added objects: the ground darkens where an object is close above it, strongest where it
 * touches and fading to nothing at `height`, blurred by `blur` world units and drawn as a transparent shadow-catcher
 * plane over whatever is already on the ground. No light direction and no shadow map. WebGPU only.
 */
export class ContactShadows implements EnginePlugin {
  readonly name = 'contact-shadows';
  /** `updates`: frames that re-rendered the shadow texture; `cacheHits`: frames that reused it (`static`). */
  readonly stats = { updates: 0, cacheHits: 0 };
  private engine?: Engine;
  private disposed = false;
  private dirty = true;
  private readonly entries = new Map<object, Entry>();
  private signature: unknown[] = [];
  private nextSignature: unknown[] = [];
  private readonly slots: Slot[] = [];
  private readonly occluders = new Map<string, GPURenderPipeline>();
  private readonly planes = new Map<string, GPURenderPipeline>();
  private blurPipeline?: GPURenderPipeline;
  private sampler?: GPUSampler;
  private white?: GPUTexture;
  private whiteView?: GPUTextureView;
  private targets?: { size: number; textures: GPUTexture[]; views: GPUTextureView[] };
  private blurGroups?: GPUBindGroup[];
  private planeGroup?: { group: GPUBindGroup; view: GPUTextureView; pipeline: GPURenderPipeline };
  private kernels?: GPUBuffer[];
  private readonly kernelValues = [new Float32Array(KERNEL_FLOATS), new Float32Array(KERNEL_FLOATS)];
  private planeUniform?: GPUBuffer;
  private readonly planeValues = new Float32Array(28);
  private readonly view = new Float32Array(16);

  /** `options` is kept (not copied) and validated now and every frame; throws RangeError for invalid values. */
  constructor(readonly options: ContactShadowOptions = {}) {
    this.settings();
  }

  /** Creates the effect and registers it on `instance`; returns it. */
  static attach(instance: EngineKernel, options: ContactShadowOptions = {}): ContactShadows {
    const effect = new ContactShadows(options);
    engineRuntime(instance).use(effect);
    return effect;
  }

  /**
   * Centres the plane under `bounds` ([minX, minY, minZ, maxX, maxY, maxZ], as `model.bounds`): ground at minY,
   * a square `spread` times the larger footprint side, height the bounds height. Writes `position`, `size` and
   * `height` into `options`.
   */
  fit(bounds: ArrayLike<number>, spread = 2): this {
    if (
      !bounds ||
      bounds.length !== 6 ||
      !Array.from({ length: 6 }, (_, i) => bounds[i]).every(finite) ||
      bounds[0] > bounds[3] ||
      bounds[1] > bounds[4] ||
      bounds[2] > bounds[5] ||
      !(spread >= 1)
    )
      throw new RangeError(
        'Invalid contact shadow bounds; pass [minX, minY, minZ, maxX, maxY, maxZ] with min <= max and a spread >= 1',
      );
    this.options.position = [(bounds[0] + bounds[3]) / 2, bounds[1], (bounds[2] + bounds[5]) / 2];
    this.options.size = Math.max(bounds[3] - bounds[0], bounds[5] - bounds[2], 1e-6) * spread;
    this.options.height = Math.max(bounds[4] - bounds[1], 1e-6);
    this.settings();
    return this;
  }

  /**
   * Adds a caster: a core mesh handle, a gltf-pro model or a materials mesh. Returns a remover (safe to call twice).
   * Throws TypeError for anything else, MargoError 'disposed' for a disposed source and 'state' for a duplicate or a
   * mesh of another engine.
   */
  add(source: ContactSource | MeshHandle): () => void {
    if (!source || typeof source !== 'object' || this.disposed)
      throw new TypeError(
        this.disposed
          ? 'ContactShadows is disposed; create a new one to add casters'
          : 'Invalid contact shadow source; pass a mesh, a gltf-pro model or a materials mesh',
      );
    if ((source as ContactSource).disposed === true)
      throw margoError('disposed', 'Contact shadow source is disposed; add a live mesh or model');
    let entry: Entry;
    if ('shadowPrimitives' in source) entry = { source };
    else if ('id' in source) entry = { mesh: meshRuntime(source as MeshHandle) };
    else throw new TypeError('Invalid contact shadow source; pass a mesh, a gltf-pro model or a materials mesh');
    if (this.entries.has(source))
      throw margoError('state', 'Duplicate contact shadow source; add each mesh or model once');
    if ('mesh' in entry) {
      if (this.engine) this.owned(entry.mesh);
      entry.mesh.check();
    }
    this.entries.set(source, entry);
    this.dirty = true;
    return () => {
      if (this.entries.get(source) !== entry) return;
      this.entries.delete(source);
      this.dirty = true;
    };
  }

  /** Re-renders a `static` shadow on the next frame (for skinning or morph pose changes). */
  invalidate(): void {
    this.dirty = true;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'ContactShadows is disposed; create a new one');
    if (!engine.gpu)
      throw margoError('unsupported', 'ContactShadows needs WebGPU; it does not run on the WebGL2 fallback');
    for (const entry of this.entries.values()) if ('mesh' in entry) this.owned(entry.mesh, engine);
    this.engine = engine;
    const device = engine.gpu;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.white = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
    this.whiteView = this.white.createView();
    const uniform = (size: number) =>
      device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.kernels = [uniform(KERNEL_FLOATS * 4), uniform(KERNEL_FLOATS * 4)];
    this.planeUniform = uniform(this.planeValues.byteLength);
    this.dirty = true;
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'contact-shadows',
      order: 0.5,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.engine && !this.disposed) this.render(c);
      },
    });
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  /** Removes the effect from its engine and destroys every GPU resource it created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.release();
    this.engine?.removePlugin(this.name);
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** Throws MargoError 'state' when `mesh` belongs to another engine than `engine`. */
  private owned(mesh: Mesh, engine = this.engine): void {
    if (mesh.engine && mesh.engine !== engine)
      throw margoError('state', 'Contact shadow mesh belongs to another engine; add meshes of the engine it runs on');
  }

  /** Validates the live options and fills in the defaults. */
  private settings(): Settings {
    const o = this.options;
    if (!o || typeof o !== 'object') throw optionError('pass an options object');
    const position = o.position === undefined ? [0, 0, 0] : triple(o.position, 'position');
    const color = o.color === undefined ? [0, 0, 0] : triple(o.color, 'color');
    let width = 4,
      depth = 4;
    if (typeof o.size === 'number') width = depth = o.size;
    else if (o.size !== undefined) {
      const s = o.size as ArrayLike<number>;
      if (!s || typeof s !== 'object' || s.length !== 2) throw optionError('size must be a number or [width, depth]');
      width = s[0];
      depth = s[1];
    }
    if (!finite(width) || !finite(depth) || width <= 0 || depth <= 0)
      throw optionError('size must be finite and above 0');
    const height = o.height ?? 1,
      blur = o.blur ?? 0.015 * Math.max(width, depth),
      opacity = o.opacity ?? 0.6,
      resolution = o.resolution ?? DEFAULT_RESOLUTION;
    if (!finite(height) || height <= 0) throw optionError('height must be finite and above 0');
    if (!finite(blur) || blur < 0) throw optionError('blur must be finite and 0 or more');
    if (!finite(opacity) || opacity < 0 || opacity > 1) throw optionError('opacity must be in 0..1');
    if (!Number.isInteger(resolution) || resolution < 16 || resolution > 4096)
      throw optionError('resolution must be an integer in 16..4096');
    if (o.static !== undefined && typeof o.static !== 'boolean') throw optionError('static must be a boolean');
    return {
      x: position[0],
      ground: position[1],
      z: position[2],
      width,
      depth,
      height,
      blur,
      opacity,
      color,
      resolution,
      cached: o.static === true,
    };
  }

  /** The two r16float targets (nearness, blur scratch) at `size`, recreated when it changes. */
  private ensureTargets(device: GPUDevice, size: number): { views: GPUTextureView[] } {
    if (this.targets?.size === size) return this.targets;
    this.releaseTargets();
    const textures = [0, 1].map(() =>
      device.createTexture({
        size: [size, size],
        format: 'r16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.targets = { size, textures, views: textures.map((t) => t.createView()) };
    this.dirty = true;
    return this.targets;
  }

  /** Every primitive to draw this frame; drops disposed and removed sources. */
  private collect(engine: Engine): ContactPrimitive[] {
    const out: ContactPrimitive[] = [];
    for (const [key, entry] of this.entries) {
      let list: readonly ContactPrimitive[] | undefined;
      if ('source' in entry) {
        if (entry.source.disposed) {
          this.entries.delete(key);
          this.dirty = true;
          continue;
        }
        list = entry.source.shadowPrimitives;
      } else {
        const mesh = entry.mesh;
        this.owned(mesh, engine);
        if (engine.meshes.get(mesh.id) !== mesh) {
          this.entries.delete(key);
          this.dirty = true;
          continue;
        }
        const triangles = meshTriangles(mesh);
        if (!triangles) continue;
        if (triangles.kind === 'pbr')
          list = (triangles.source as unknown as ContactSource).shadowPrimitives as readonly ContactPrimitive[];
        else {
          const buffers = engine.geometryBuffers(triangles.geometry);
          if (!buffers) continue;
          const proxy = (entry.proxy ??= {
            node: mesh,
            vertex: buffers.vertex,
            index: buffers.index,
            count: 0,
            stride: 24,
          });
          proxy.vertex = buffers.vertex;
          proxy.index = buffers.index;
          proxy.count = triangles.geometry.indices.length;
          list = [proxy];
        }
      }
      for (const p of list ?? []) {
        if (!STRIDES.has(p.stride))
          throw new RangeError('Contact shadow primitive stride must be 24 or 80; pass core or gltf-pro vertices');
        if (p.instances && p.stride !== 80)
          throw new RangeError('Instanced contact shadow primitives need 80-byte vertices; pass gltf-pro instances');
        if ((p.opacity || p.displacement || p.clip) && p.stride !== 80)
          throw new RangeError(
            'Opacity-mapped, displaced and clipped contact shadow primitives need 80-byte vertices; pass gltf-pro vertices',
          );
        const transform = p.alphaTransform;
        if (
          transform !== undefined &&
          (!(transform instanceof Float32Array) ||
            transform.length !== 8 ||
            transform.some((value) => !Number.isFinite(value)) ||
            p.stride !== 80)
        )
          throw new TypeError(
            'Invalid contact shadow alpha transform; pass a Float32Array of 8 finite numbers on 80-byte vertices',
          );
        p.node.check();
        this.owned(p.node, engine);
        if (hiddenInTree(engine.store, p.node.id) || p.instances?.count === 0) continue;
        out.push(p);
      }
    }
    return out;
  }

  /** Whether the static texture is out of date for `draws` and `s`; records the new signature. */
  private changed(draws: readonly ContactPrimitive[], s: Settings): boolean {
    const next = this.nextSignature;
    next.length = 0;
    next.push(s.x, s.ground, s.z, s.width, s.depth, s.height, s.blur, s.resolution, draws.length);
    for (const p of draws) {
      next.push(
        p.node,
        p.vertex,
        p.vertexOffset ?? 0,
        p.index,
        p.count,
        p.topology ?? 'triangle-list',
        p.instances?.count ?? -1,
      );
      next.push(
        p.alpha,
        p.cutoff,
        p.texCoord,
        p.alphaTexture,
        p.alphaSampler,
        p.vertexAlpha,
        p.opacity,
        p.displacement,
        p.clip,
      );
      if (p.alphaTransform) next.push(...p.alphaTransform);
      for (let i = 0; i < 16; i++) next.push(p.node.matrix[i]);
    }
    // An opacity map's UV rows, a displacement's scale and a material's planes change on the GPU alone, so nothing here can
    // see them.
    const old = this.signature,
      differs =
        old.length !== next.length ||
        next.some((v, i) => !Object.is(v, old[i])) ||
        draws.some((p) => p.opacity || p.displacement || p.clip);
    this.nextSignature = old;
    this.signature = next;
    return differs;
  }

  private occluder(device: GPUDevice, p: ContactPrimitive): GPURenderPipeline {
    const stride = p.stride,
      instanced = !!p.instances,
      lines = p.topology === 'line-list',
      transformed = !!p.alphaTransform,
      opacity = !!p.opacity,
      solid = stride === 80 && p.vertexAlpha === false,
      displaced = !!p.displacement,
      clipped = !!p.clip,
      key = `${stride}|${instanced}|${lines}|${transformed}|${opacity}|${solid}|${displaced}|${clipped}`;
    let pipeline = this.occluders.get(key);
    if (!pipeline) {
      let code = stride === 24 ? coreOccluder : pbrOccluder(transformed);
      if (displaced) code = displacedDepth(code, 1);
      if (instanced) code = instancedDepth(code);
      if (solid) code = solidVertexDepth(code);
      if (opacity) code = opacityDepth(code, 0);
      if (clipped) code = clippedDepth(code, 3, 'materialClip');
      const module = device.createShaderModule({ code }),
        keepNearest = { operation: 'max', srcFactor: 'one', dstFactor: 'one' } as const;
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex', buffers: casterBuffers(stride, displaced, instanced) },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: 'r16float', blend: { color: keepNearest, alpha: keepNearest } }],
        },
        ...(lines ? { primitive: { topology: 'line-list' as const } } : {}),
      });
      this.occluders.set(key, pipeline);
    }
    return pipeline;
  }

  /** Orthographic camera on the ground looking up: x -> clip x, z -> clip y, height above ground -> depth 0..1. */
  private projection(s: Settings): Float32Array {
    const m = this.view;
    m.fill(0);
    m[0] = 2 / s.width;
    m[6] = 1 / s.height;
    m[9] = 2 / s.depth;
    m[12] = -1 - (2 * (s.x - s.width / 2)) / s.width;
    m[13] = -1 - (2 * (s.z - s.depth / 2)) / s.depth;
    m[14] = -s.ground / s.height;
    m[15] = 1;
    return m;
  }

  /** Renders the nearness texture of `draws` and blurs it; returns the view holding the result. */
  private update(c: ContactPassContext, draws: readonly ContactPrimitive[], s: Settings): GPUTextureView {
    const device = c.device,
      views = this.targets!.views,
      projection = this.projection(s);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: views[0], clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
    });
    try {
      draws.forEach((p, i) => {
        // A slot serves whichever caster is at i, so it is replaced when the alpha transform's rows come or go.
        const pipeline = this.occluder(device, p),
          floats = p.alphaTransform ? 44 : 36;
        let slot = this.slots[i];
        if (slot?.values.length !== floats) {
          slot?.uniform.destroy();
          slot = this.slots[i] = {
            uniform: device.createBuffer({ size: floats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
            values: new Float32Array(floats),
          };
        }
        const mask = p.stride === 80 ? (p.alphaTexture ?? this.whiteView) : undefined,
          sampler = p.stride === 80 ? (p.alphaSampler ?? this.sampler) : undefined;
        if (
          !slot.group ||
          slot.pipeline !== pipeline ||
          slot.mask !== mask ||
          slot.sampler !== sampler ||
          slot.opacity !== p.opacity ||
          slot.displacement !== p.displacement ||
          slot.clip !== p.clip?.buffer
        ) {
          slot.group =
            p.opacity || p.clip
              ? device.createBindGroup({
                  layout: pipeline.getBindGroupLayout(0),
                  entries: [
                    { binding: 0, resource: { buffer: slot.uniform } },
                    { binding: 1, resource: mask! },
                    { binding: 2, resource: sampler! },
                    ...(p.clip ? [{ binding: 3, resource: p.clip }] : []),
                    ...(p.opacity ? opacityEntries(p.opacity) : []),
                  ],
                })
              : group(device, pipeline, mask ? [{ buffer: slot.uniform }, mask, sampler!] : [{ buffer: slot.uniform }]);
          slot.pipeline = pipeline;
          slot.mask = mask;
          slot.sampler = sampler;
          slot.opacity = p.opacity;
          slot.displacement = p.displacement;
          slot.displaced = displacementGroup(device, () => pipeline.getBindGroupLayout(1), p.displacement);
          slot.clip = p.clip?.buffer;
        }
        drawCaster(
          pass,
          device,
          pipeline,
          slot.group,
          slot.uniform,
          slot.values,
          projection,
          p,
          p.alphaTransform,
          slot.displaced,
          p.instances,
        );
      });
    } finally {
      pass.end();
    }
    // Slots beyond this frame's draws are released so a shrinking caster list does not hold buffers.
    for (const slot of this.slots.splice(draws.length)) slot.uniform.destroy();
    if (s.blur === 0) return views[0];
    const pipeline = (this.blurPipeline ??= fullscreenPipeline(device, blurShader, 'r16float')),
      texel = 1 / s.resolution;
    this.blurGroups ??= [
      group(device, pipeline, [{ buffer: this.kernels![0] }, views[0], this.sampler!]),
      group(device, pipeline, [{ buffer: this.kernels![1] }, views[1], this.sampler!]),
    ];
    // Per-axis radius in texels keeps the blur round in world units on a non-square plane.
    gaussianKernel((s.blur / s.width) * s.resolution, [texel, 0], this.kernelValues[0]);
    gaussianKernel((s.blur / s.depth) * s.resolution, [0, texel], this.kernelValues[1]);
    for (let axis = 0; axis < 2; axis++) {
      device.queue.writeBuffer(this.kernels![axis], 0, this.kernelValues[axis]);
      const blur = c.encoder.beginRenderPass({
        colorAttachments: [{ view: views[1 - axis], loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      });
      try {
        blur.setPipeline(pipeline);
        blur.setBindGroup(0, this.blurGroups[axis]);
        blur.draw(3);
      } finally {
        blur.end();
      }
    }
    return views[0];
  }

  /** One frame: validate, refresh the shadow texture when needed, draw the plane. */
  private render(c: ContactPassContext): void {
    const engine = this.engine!,
      device = c.device,
      s = this.settings(),
      views = this.ensureTargets(device, s.resolution).views;
    const draws = this.collect(engine),
      changed = this.changed(draws, s);
    let shade = views[0];
    if (this.dirty || !s.cached || changed) {
      this.dirty = false;
      this.stats.updates++;
      shade = this.update(c, draws, s);
    } else this.stats.cacheHits++;
    if (c.camera.position[1] <= s.ground) return;
    const depthFormat = c.descriptor.depthStencil?.format ?? 'depth32float',
      multisample = c.descriptor.multisample ?? {},
      key = `${c.format}|${multisample.count ?? 1}|${depthFormat}`;
    let pipeline = this.planes.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: planeShader }),
        over = { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } as const;
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: c.format, blend: { color: over, alpha: over } }],
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        multisample,
      });
      this.planes.set(key, pipeline);
    }
    if (this.planeGroup?.view !== shade || this.planeGroup.pipeline !== pipeline)
      this.planeGroup = {
        view: shade,
        pipeline,
        group: group(device, pipeline, [{ buffer: this.planeUniform! }, shade, this.sampler!]),
      };
    const p = this.planeValues;
    p.set(c.camera.matrix);
    p.set(s.color, 16);
    p[19] = s.opacity;
    p[20] = s.x - s.width / 2;
    p[21] = s.ground + PLANE_LIFT * Math.max(s.width, s.depth);
    p[22] = s.z - s.depth / 2;
    p[24] = s.width;
    p[25] = s.depth;
    device.queue.writeBuffer(this.planeUniform!, 0, p);
    const stencil = depthFormat.includes('stencil');
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: c.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(stencil ? { stencilLoadOp: 'load' as const, stencilStoreOp: 'store' as const } : {}),
      },
    });
    try {
      applyView(pass, c);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.planeGroup.group);
      pass.draw(4);
    } finally {
      pass.end();
    }
  }

  private releaseTargets(): void {
    for (const t of this.targets?.textures ?? []) t.destroy();
    this.targets = this.blurGroups = this.planeGroup = undefined;
  }

  /** Destroys every buffer and texture and forgets cached pipelines (they belong to the old device). */
  private release(): void {
    this.releaseTargets();
    for (const slot of this.slots.splice(0)) slot.uniform.destroy();
    for (const b of this.kernels ?? []) b.destroy();
    this.planeUniform?.destroy();
    this.white?.destroy();
    this.kernels = this.planeUniform = this.white = this.whiteView = this.sampler = this.blurPipeline = undefined;
    this.occluders.clear();
    this.planes.clear();
    this.signature.length = 0;
    this.dirty = true;
  }
}
