/// <reference lib="esnext.disposable" preserve="true" />
// RawShaderMaterial and RawMesh: the caller's own WGSL stages, vertex layout, uniforms and textures, drawn by the RawShaders
// plugin in the scene's colour and depth pass (three.js RawShaderMaterial / ShaderMaterial with BufferGeometry). What a
// shader can read is declared by a prelude in front of the caller's code; `material.code(stage, mesh)` shows the module.
import { MargoError } from '@margoengine/math/errors';
import { parseColor } from '@margoengine/math/color';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { viewMatrix } from '../../shared/view.js';
import { neutralShader } from '../../shared/display.js';
import type { BindableTexture } from './texture.js';
declare const GPUBufferUsage: { UNIFORM: number; VERTEX: number; INDEX: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type RawPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** WGSL types of a {@link RawMesh} attribute: 32-bit scalars and 2-4 component vectors of f32, i32 or u32. */
export type RawAttributeType =
  | 'f32'
  | 'vec2f'
  | 'vec3f'
  | 'vec4f'
  | 'i32'
  | 'vec2i'
  | 'vec3i'
  | 'vec4i'
  | 'u32'
  | 'vec2u'
  | 'vec3u'
  | 'vec4u';
/** WGSL types of a {@link RawShaderMaterial} uniform: every attribute type plus `mat3x3f` and `mat4x4f` (column-major). */
export type RawUniformType = RawAttributeType | 'mat3x3f' | 'mat4x4f';
/** One named vertex input. `data` holds `count x components` numbers; `step: 'instance'` advances once per instance. */
export interface RawAttribute {
  data: ArrayLike<number>;
  type: RawAttributeType;
  /** Default `'vertex'`. */
  step?: 'vertex' | 'instance';
}
/**
 * A live uniform, three.js style: assign `material.uniforms.name.value` any time. A number is an f32 (or the scalar of
 * `type`), 2/3/4/9/16 numbers a vecNf/mat3x3f/mat4x4f, and `'#rrggbb'`/`0xrrggbb` with a vec3f type an sRGB colour
 * decoded to linear. `type` is fixed at construction.
 */
export interface RawUniform {
  value: number | string | ArrayLike<number>;
  readonly type?: RawUniformType;
}
/** A texture a raw shader samples: a GPUTexture or view on the engine's device, or a `@margoengine/materials` Texture. */
export type RawTextureSource = GPUTexture | GPUTextureView | BindableTexture;
/** A named texture binding: `<name>` and `<name>Sampler` in WGSL. `texture` and `sampler` are live; the rest is fixed. */
export interface RawTexture {
  /** Opaque white (zero for integer textures) while null. */
  texture: RawTextureSource | null;
  /** Sampler for a GPUTexture or view (default linear, clamp to edge); a materials Texture brings its own unless this is set. */
  sampler?: GPUSamplerDescriptor;
  /** Default `'2d'`. */
  dimension?: '2d' | '2d-array' | 'cube' | '3d';
  /** Default `'float'` (filterable). Integer textures read with textureLoad. */
  sampleType?: 'float' | 'unfilterable-float' | 'sint' | 'uint';
}
/** Colour blending of a {@link RawShaderMaterial}: a three.js-style preset or a WebGPU blend state. */
export type RawBlending = 'none' | 'normal' | 'additive' | 'multiply' | 'premultiplied' | GPUBlendState;
/** Options for `new RawShaderMaterial(options)`. Render state fields stay live on the material. */
export interface RawShaderMaterialOptions {
  /** WGSL with a `@vertex fn` (and the `@fragment fn` too when `fragmentShader` is omitted). */
  vertexShader: string;
  /** WGSL with a `@fragment fn`, compiled as its own module (both may then use `main`). */
  fragmentShader?: string;
  /** Vertex entry point name; default the first `@vertex fn` found. */
  vertexEntry?: string;
  /** Fragment entry point name; default the first `@fragment fn` found. */
  fragmentEntry?: string;
  /** Named live uniforms, read as `uniforms.<name>` in WGSL. */
  uniforms?: Record<string, RawUniform>;
  /** Named textures, read as `<name>` with `<name>Sampler` in WGSL. */
  textures?: Record<string, RawTextureSource | RawTexture | null>;
  /** Draw after the opaque scene, sorted back to front, with blending. Default false. */
  transparent?: boolean;
  /** Default `'normal'`, which (as in three.js) blends only when `transparent`. */
  blending?: RawBlending;
  /** Reversed-Z `greater-equal` test against the scene depth. Default true. */
  depthTest?: boolean;
  /** Default true. */
  depthWrite?: boolean;
  /** Faces to cull, counter-clockwise front. Default `'back'`. */
  cull?: 'back' | 'front' | 'none';
  /** Write colour (false: depth only, e.g. an occluder). Default true. */
  colorWrite?: boolean;
  /** Debug and error-message name. Default `'raw:<n>'`. */
  name?: string;
}

const kinds = /^(f32|i32|u32|vec[234][fiu])$/,
  components = (t: string): number => (t === 'mat3x3f' ? 9 : t === 'mat4x4f' ? 16 : +(/^vec(\d)/.exec(t)?.[1] ?? 1)),
  scalar = (t: string): 'f' | 'i' | 'u' =>
    t === 'i32' || t.endsWith('i') ? 'i' : t === 'u32' || t.endsWith('u') ? 'u' : 'f',
  alignOf = (t: string): number => (t.startsWith('mat') ? 16 : [4, 8, 16, 16][components(t) - 1]),
  bytesOf = (t: string): number => (t === 'mat3x3f' ? 48 : components(t) * 4),
  vertexFormat = (t: RawAttributeType): GPUVertexFormat => {
    const n = components(t);
    return `${{ f: 'float', i: 'sint', u: 'uint' }[scalar(t)]}32${n > 1 ? 'x' + n : ''}` as GPUVertexFormat;
  };
// WGSL keywords, common reserved words and the prelude's own names.
const reserved =
  /^(alias|array|atomic|bitcast|bool|break|case|const|const_assert|continue|continuing|default|diagnostic|discard|else|enable|f16|f32|false|fn|for|i32|if|let|loop|mat\d\w*|override|ptr|requires|return|sampler\w*|struct|switch|texture\w*|true|u32|var|vec\d\w*|while|module|target|type|self|this|camera|mesh|uniforms|Attributes|Uniforms|margo\w*|Margo\w*)$/;
function identifier(name: string, what: string): string {
  if (!/^[A-Za-z]\w*$/.test(name) || reserved.test(name))
    throw new TypeError(
      `${what} name ${JSON.stringify(name)} is not a usable WGSL identifier; use letters, digits and _, not a WGSL keyword or a prelude name (camera, mesh, uniforms, margo*)`,
    );
  return name;
}
const entry = (code: string, stage: string): string | undefined =>
  new RegExp(`@${stage}\\s+fn\\s+([A-Za-z_]\\w*)`).exec(code)?.[1];

// Colour helpers for the shader: margoDisplay is the scene's display transform (PBR Neutral + sRGB on display targets),
// margoEncode the sRGB encoding alone (unlit colour, as lines and points write it). An HDR capture keeps linear light.
const helpers = `${neutralShader.replace('pbrNeutral', 'margoNeutral')}fn margoSRGB(x:vec3f)->vec3f {return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
fn margoDisplay(c:vec4f)->vec4f {if(camera.encoding==0.0){return c;}let x=margoNeutral(max(c.rgb,vec3f(0)));if(camera.encoding==2.0){return vec4f(x,c.a);}return vec4f(margoSRGB(x),c.a);}
fn margoEncode(c:vec4f)->vec4f {if(camera.encoding!=1.0){return c;}return vec4f(margoSRGB(max(c.rgb,vec3f(0))),c.a);}
struct MargoCamera { view:mat4x4f, projection:mat4x4f, viewProjection:mat4x4f, position:vec3f, time:f32, resolution:vec2f, deltaTime:f32, encoding:f32 }
struct MargoMesh { world:mat4x4f, normal:mat3x3f }
@group(0) @binding(0) var<uniform> camera:MargoCamera;
@group(0) @binding(1) var<uniform> mesh:MargoMesh;`;

interface Member {
  name: string;
  type: RawUniformType;
  offset: number;
}
interface PipelineEntry {
  state: 'pending' | 'ready' | 'failed';
  pipeline?: GPURenderPipeline;
}
interface MaterialGpu {
  layout?: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  buffer?: GPUBuffer;
  written?: Uint8Array;
  group?: GPUBindGroup;
  bound: unknown[];
  pass?: number;
  modules: Map<string, GPUShaderModule>;
  pipelines: Map<string, PipelineEntry>;
}
const frameLayouts = new WeakMap<GPUDevice, GPUBindGroupLayout>(),
  samplers = new WeakMap<GPUDevice, Map<string, GPUSampler>>(),
  views = new WeakMap<GPUTexture, Map<string, GPUTextureView>>(),
  owners = new WeakMap<object, GPUDevice>(),
  fallbacks = new WeakMap<GPUDevice, Map<string, GPUTextureView>>();
const visibility = () => GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
function frameLayout(device: GPUDevice): GPUBindGroupLayout {
  let layout = frameLayouts.get(device);
  if (!layout) {
    layout = device.createBindGroupLayout({
      label: 'shader:raw:frame',
      entries: [0, 1].map((binding) => ({ binding, visibility: visibility(), buffer: { type: 'uniform' as const } })),
    });
    frameLayouts.set(device, layout);
  }
  return layout;
}
function sampler(device: GPUDevice, descriptor: GPUSamplerDescriptor = {}): GPUSampler {
  let cache = samplers.get(device);
  if (!cache) samplers.set(device, (cache = new Map()));
  const d = { magFilter: 'linear', minFilter: 'linear', ...descriptor } as GPUSamplerDescriptor,
    key = JSON.stringify(d);
  let s = cache.get(key);
  if (!s) cache.set(key, (s = device.createSampler(d)));
  return s;
}
function fallback(device: GPUDevice, t: RawTexture): GPUTextureView {
  let cache = fallbacks.get(device);
  if (!cache) fallbacks.set(device, (cache = new Map()));
  const dimension = t.dimension ?? '2d',
    type = t.sampleType ?? 'float',
    key = dimension + type;
  let view = cache.get(key);
  if (!view) {
    const layers = dimension === 'cube' ? 6 : 1,
      integer = type === 'sint' || type === 'uint',
      texture = device.createTexture({
        label: 'shader:raw:white',
        size: [1, 1, layers],
        dimension: dimension === '3d' ? '3d' : '2d',
        format: integer ? (type === 'sint' ? 'rgba8sint' : 'rgba8uint') : 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    if (!integer)
      device.queue.writeTexture(
        { texture },
        new Uint8Array(4 * layers).fill(255),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1, layers],
      );
    cache.set(key, (view = texture.createView({ dimension })));
  }
  return view;
}
let warned = false;
function bindTexture(device: GPUDevice, t: RawTexture): [GPUTextureView, GPUSampler] {
  const source = t.texture,
    filter = (t.sampleType ?? 'float') === 'float';
  // Integer and unfilterable textures need a non-filtering sampler whatever the descriptor or the Texture says.
  const own = (s?: GPUSampler) =>
    !filter
      ? sampler(device, { ...t.sampler, magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest' })
      : t.sampler || !s
        ? sampler(device, t.sampler)
        : s;
  if (source && typeof (source as BindableTexture).bind === 'function') {
    const bound = (source as BindableTexture).bind(device, true);
    return bound ? [bound[0], own(bound[1])] : [fallback(device, t), own()];
  }
  if (!source) return [fallback(device, t), own()];
  const owner = owners.get(source);
  if (owner && owner !== device) {
    if (!warned) {
      warned = true;
      console.warn(
        '@margoengine/shader/raw: a texture belongs to a lost GPU device; assign one made on engine.gpu after onDeviceRestored. Drawing white.',
      );
    }
    return [fallback(device, t), own()];
  }
  owners.set(source, device);
  let view = source as GPUTextureView;
  if (typeof (source as GPUTexture).createView === 'function') {
    const texture = source as GPUTexture,
      dimension = t.dimension ?? '2d';
    let cache = views.get(texture);
    if (!cache) views.set(texture, (cache = new Map()));
    view = cache.get(dimension) ?? texture.createView({ dimension });
    cache.set(dimension, view);
  }
  return [view, own()];
}
const blends: Record<string, GPUBlendState | undefined> = {
  normal: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
  additive: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  },
  multiply: {
    color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'src-alpha', operation: 'add' },
  },
  premultiplied: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
};

let materials = 0;
/**
 * three.js RawShaderMaterial for WebGPU: your own WGSL vertex and fragment entry points, drawn by {@link RawShaders} in
 * the scene's colour and depth pass. A prelude in front of your code declares what you can read: `camera` (view,
 * projection, viewProjection, position, time, resolution, deltaTime), `mesh` (world, normal), `uniforms.<name>`, each
 * texture `<name>` with `<name>Sampler`, the `Attributes` struct of the drawn RawMesh, and `margoDisplay(c)` /
 * `margoEncode(c)` to output linear colour like the rest of the scene. Fragment output is written as returned.
 * WGSL errors are reported (`error`, `onError`, else console.error) and that draw is skipped; other draws continue.
 */
export class RawShaderMaterial {
  readonly name: string;
  /** Live values; names and types are fixed at construction. */
  readonly uniforms: Record<string, RawUniform>;
  /** Live `texture` and `sampler`; names, dimension and sample type are fixed at construction. */
  readonly textures: Record<string, RawTexture>;
  transparent: boolean;
  blending: RawBlending;
  depthTest: boolean;
  depthWrite: boolean;
  cull: 'back' | 'front' | 'none';
  colorWrite: boolean;
  /** Called with a MargoError `'failed'` naming the stage, line and WGSL message when a pipeline does not compile. */
  onError?: (error: Error) => void;
  /** The latest compile error, or undefined. */
  error?: Error;
  /** @internal Uniform block members with byte offsets; `size` is the block size in bytes. */
  readonly members: readonly Member[];
  /** @internal */ readonly size: number;
  /** @internal */ readonly gpu = new Map<GPUDevice, MaterialGpu>();
  /** @internal Bumped when the shader code changes. */ revision = 0;
  private vertexCode = '';
  private fragmentCode?: string;
  private vertexName = '';
  private fragmentName = '';
  private readonly entries: { vertex?: string; fragment?: string };
  private readonly data: DataView;
  private readonly bytes: Uint8Array;
  constructor(options: RawShaderMaterialOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('RawShaderMaterial needs {vertexShader, ...}');
    this.name = options.name ?? 'raw:' + materials++;
    this.entries = { vertex: options.vertexEntry, fragment: options.fragmentEntry };
    this.transparent = options.transparent ?? false;
    this.blending = options.blending ?? 'normal';
    this.depthTest = options.depthTest ?? true;
    this.depthWrite = options.depthWrite ?? true;
    this.cull = options.cull ?? 'back';
    this.colorWrite = options.colorWrite ?? true;
    this.setCode(options.vertexShader, options.fragmentShader);
    const members: Member[] = [];
    let end = 0;
    this.uniforms = {};
    for (const [name, u] of Object.entries(options.uniforms ?? {})) {
      identifier(name, 'RawShaderMaterial uniform');
      if (!u || typeof u !== 'object' || !('value' in u))
        throw new TypeError(`RawShaderMaterial uniform ${name} must be {value, type?}`);
      const v = u.value,
        n = typeof v === 'number' ? 1 : typeof v === 'string' ? 3 : (v as ArrayLike<number>)?.length,
        type =
          u.type ??
          (
            { 1: 'f32', 2: 'vec2f', 3: 'vec3f', 4: 'vec4f', 9: 'mat3x3f', 16: 'mat4x4f' } as Record<
              number,
              RawUniformType
            >
          )[n];
      if (!type || !(kinds.test(type) || type === 'mat3x3f' || type === 'mat4x4f'))
        throw new TypeError(
          `RawShaderMaterial uniform ${name} has no WGSL type; give type ('f32' to 'vec4f', i32/u32 variants, 'mat3x3f' or 'mat4x4f')`,
        );
      const offset = Math.ceil(end / alignOf(type)) * alignOf(type);
      members.push({ name, type, offset });
      end = offset + bytesOf(type);
      this.uniforms[name] = u.type ? u : Object.assign(u, { type });
    }
    this.members = members;
    this.size = members.length ? Math.ceil(end / 16) * 16 : 0;
    this.bytes = new Uint8Array(this.size);
    this.data = new DataView(this.bytes.buffer);
    this.textures = {};
    for (const [name, t] of Object.entries(options.textures ?? {})) {
      identifier(name, 'RawShaderMaterial texture');
      const value: RawTexture =
        t && typeof t === 'object' && 'texture' in t ? (t as RawTexture) : { texture: t as RawTextureSource | null };
      if (value.dimension !== undefined && !['2d', '2d-array', 'cube', '3d'].includes(value.dimension))
        throw new TypeError(`RawShaderMaterial texture ${name} dimension must be 2d, 2d-array, cube or 3d`);
      if (value.dimension && value.dimension !== '2d' && typeof (value.texture as BindableTexture)?.bind === 'function')
        throw new TypeError(
          `RawShaderMaterial texture ${name}: a materials Texture is 2d; pass a GPUTexture for ${value.dimension}`,
        );
      if (value.sampleType !== undefined && !['float', 'unfilterable-float', 'sint', 'uint'].includes(value.sampleType))
        throw new TypeError(
          `RawShaderMaterial texture ${name} sampleType must be float, unfilterable-float, sint or uint`,
        );
      this.textures[name] = value;
    }
  }
  /** WGSL of the vertex stage (assigning recompiles on the next frame). */
  get vertexShader(): string {
    return this.vertexCode;
  }
  set vertexShader(code: string) {
    this.setCode(code, this.fragmentCode);
  }
  /** WGSL of the fragment stage, or undefined when the vertex code holds both entry points. */
  get fragmentShader(): string | undefined {
    return this.fragmentCode;
  }
  set fragmentShader(code: string | undefined) {
    this.setCode(this.vertexCode, code);
  }
  private setCode(vertex: string, fragment: string | undefined): void {
    if (typeof vertex !== 'string' || !vertex.trim())
      throw new TypeError('RawShaderMaterial vertexShader must be WGSL source with a @vertex fn');
    if (fragment !== undefined && typeof fragment !== 'string')
      throw new TypeError('RawShaderMaterial fragmentShader must be WGSL source or undefined');
    const v = this.entries.vertex ?? entry(vertex, 'vertex'),
      f = this.entries.fragment ?? entry(fragment ?? vertex, 'fragment');
    if (!v) throw new TypeError(`RawShaderMaterial ${this.name} has no @vertex fn; add one or pass vertexEntry`);
    if (!f)
      throw new TypeError(
        `RawShaderMaterial ${this.name} has no @fragment fn; add one to fragmentShader (or vertexShader) or pass fragmentEntry`,
      );
    this.vertexCode = vertex;
    this.fragmentCode = fragment;
    this.vertexName = v;
    this.fragmentName = f;
    this.error = undefined;
    this.revision++;
    for (const gpu of this.gpu.values()) {
      gpu.modules.clear();
      gpu.pipelines.clear();
    }
  }
  /** The declarations added in front of each stage for `mesh` (its `Attributes` struct) or for no attributes. */
  prelude(mesh?: RawMesh): string {
    const out = [helpers],
      attributes = mesh?.layout ?? [];
    if (attributes.length)
      out.push(
        `struct Attributes {\n${attributes.map((a, i) => `  @location(${i}) ${a.name}:${a.type},`).join('\n')}\n}`,
      );
    if (this.members.length)
      out.push(
        `struct Uniforms {\n${this.members.map((m) => `  ${m.name}:${m.type},`).join('\n')}\n}\n@group(1) @binding(0) var<uniform> uniforms:Uniforms;`,
      );
    Object.entries(this.textures).forEach(([name, t], i) => {
      const s = { float: 'f32', 'unfilterable-float': 'f32', sint: 'i32', uint: 'u32' }[t.sampleType ?? 'float'];
      out.push(
        `@group(1) @binding(${1 + 2 * i}) var ${name}:texture_${(t.dimension ?? '2d').replace('-', '_')}<${s}>;\n@group(1) @binding(${2 + 2 * i}) var ${name}Sampler:sampler;`,
      );
    });
    return out.join('\n') + '\n';
  }
  /** The whole WGSL module of `stage` for `mesh`: the prelude, then your code. */
  code(stage: 'vertex' | 'fragment', mesh?: RawMesh): string {
    return this.prelude(mesh) + (stage === 'fragment' ? (this.fragmentCode ?? this.vertexCode) : this.vertexCode);
  }
  /** Releases this material's GPU objects; it rebuilds them if drawn again. */
  dispose(): void {
    for (const gpu of this.gpu.values()) gpu.buffer?.destroy();
    this.gpu.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @internal The render-state part of a pipeline key. */
  state(): string {
    const b = this.blending;
    return `${this.transparent}|${typeof b === 'string' ? b : JSON.stringify(b)}|${this.depthTest}|${this.depthWrite}|${this.cull}|${this.colorWrite}|${this.revision}`;
  }
  /** @internal */
  blend(): GPUBlendState | undefined {
    const b = this.blending;
    if (typeof b !== 'string') return b;
    if (!(b in blends) && b !== 'none')
      throw new TypeError(
        `RawShaderMaterial ${this.name} blending must be none, normal, additive, multiply, premultiplied or a GPUBlendState`,
      );
    return b === 'normal' && !this.transparent ? undefined : blends[b];
  }
  /** @internal Uploads changed uniforms and (re)builds the material bind group, once per plugin pass. */
  prepare(device: GPUDevice, pass: number): MaterialGpu {
    let gpu = this.gpu.get(device);
    if (!gpu) {
      const textures = Object.values(this.textures),
        entries: GPUBindGroupLayoutEntry[] = [];
      if (this.size) entries.push({ binding: 0, visibility: visibility(), buffer: { type: 'uniform' } });
      textures.forEach((t, i) => {
        const type = t.sampleType ?? 'float';
        entries.push(
          {
            binding: 1 + 2 * i,
            visibility: visibility(),
            texture: { sampleType: type, viewDimension: t.dimension ?? '2d' },
          },
          {
            binding: 2 + 2 * i,
            visibility: visibility(),
            sampler: { type: type === 'float' ? 'filtering' : 'non-filtering' },
          },
        );
      });
      const layout = entries.length
        ? device.createBindGroupLayout({ label: 'shader:raw:' + this.name, entries })
        : undefined;
      gpu = {
        layout,
        pipelineLayout: device.createPipelineLayout({
          bindGroupLayouts: layout ? [frameLayout(device), layout] : [frameLayout(device)],
        }),
        bound: [],
        modules: new Map(),
        pipelines: new Map(),
      };
      this.gpu.set(device, gpu);
    }
    if (gpu.pass === pass) return gpu;
    gpu.pass = pass;
    if (this.size) {
      for (const m of this.members) this.write(m);
      if (!gpu.buffer)
        gpu.buffer = device.createBuffer({
          label: 'shader:raw:uniforms',
          size: this.size,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      if (!gpu.written || gpu.written.some((b, i) => b !== this.bytes[i])) {
        device.queue.writeBuffer(gpu.buffer, 0, this.bytes as Uint8Array<ArrayBuffer>);
        (gpu.written ??= new Uint8Array(this.size)).set(this.bytes);
      }
    }
    if (gpu.layout) {
      const bound: unknown[] = this.size ? [gpu.buffer] : [];
      for (const t of Object.values(this.textures)) bound.push(...bindTexture(device, t));
      if (!gpu.group || bound.some((x, i) => x !== gpu!.bound[i])) {
        gpu.bound = bound;
        const entries: GPUBindGroupEntry[] = [];
        let k = 0;
        if (this.size) entries.push({ binding: 0, resource: { buffer: bound[k++] as GPUBuffer } });
        for (let i = 0; k < bound.length; i++)
          entries.push(
            { binding: 1 + 2 * i, resource: bound[k++] as GPUTextureView },
            { binding: 2 + 2 * i, resource: bound[k++] as GPUSampler },
          );
        gpu.group = device.createBindGroup({ layout: gpu.layout, entries });
      }
    }
    return gpu;
  }
  private write(m: Member): void {
    const u = this.uniforms[m.name],
      v = u?.value,
      n = components(m.type),
      values =
        typeof v === 'number' && n === 1
          ? [v]
          : (typeof v === 'string' || typeof v === 'number') && m.type === 'vec3f'
            ? Array.from(parseColor(v))
            : v !== null && typeof v === 'object'
              ? Array.from(v)
              : [];
    if (values.length !== n || values.some((x) => !Number.isFinite(x)))
      throw new RangeError(
        `RawShaderMaterial ${this.name} uniform ${m.name} needs ${n} finite number${n > 1 ? 's' : ''} for ${m.type}; assign a matching value`,
      );
    const s = scalar(m.type),
      rows = m.type === 'mat3x3f' ? 3 : 0;
    values.forEach((x, i) => {
      const at = m.offset + (rows ? Math.floor(i / 3) * 16 + (i % 3) * 4 : i * 4);
      s === 'f'
        ? this.data.setFloat32(at, x, true)
        : s === 'i'
          ? this.data.setInt32(at, x, true)
          : this.data.setUint32(at, x, true);
    });
  }
  /** @internal The pipeline for `key`, compiling it on first use; undefined while pending or after a failure. */
  pipeline(
    plugin: RawShaders,
    gpu: MaterialGpu,
    device: GPUDevice,
    mesh: RawMesh,
    c: RawPassContext,
  ): GPURenderPipeline | undefined {
    const strip = mesh.topology.endsWith('strip') && mesh.indexFormat,
      samples = c.descriptor.multisample?.count ?? 1,
      depth = c.descriptor.depthStencil!.format,
      key = `${mesh.layoutKey}|${mesh.topology}|${strip || ''}|${c.format}|${samples}|${depth}|${this.state()}`;
    let e = gpu.pipelines.get(key);
    if (e) return e.pipeline;
    e = { state: 'pending' };
    gpu.pipelines.set(key, e);
    const module = (stage: 'vertex' | 'fragment') => {
      const k = stage + '|' + mesh.layoutKey;
      let m = gpu.modules.get(k);
      if (!m) {
        m = device.createShaderModule({ label: `shader:raw:${this.name}:${stage}`, code: this.code(stage, mesh) });
        gpu.modules.set(k, m);
      }
      return m;
    };
    device.pushErrorScope?.('validation');
    const vertex = module('vertex'),
      fragment = this.fragmentCode === undefined ? vertex : module('fragment'),
      scope = device.popErrorScope?.(),
      blend = this.blend(),
      descriptor: GPURenderPipelineDescriptor = {
        label: 'shader:raw:' + this.name,
        layout: gpu.pipelineLayout,
        vertex: { module: vertex, entryPoint: this.vertexName, buffers: mesh.buffers() },
        fragment: {
          module: fragment,
          entryPoint: this.fragmentName,
          targets: [{ format: c.format, ...(blend ? { blend } : {}), writeMask: this.colorWrite ? 0xf : 0 }],
        },
        primitive: {
          topology: mesh.topology,
          cullMode: this.cull,
          ...(strip ? { stripIndexFormat: strip } : {}),
        },
        depthStencil: {
          format: depth,
          depthWriteEnabled: this.depthWrite,
          depthCompare: this.depthTest ? 'greater-equal' : 'always',
        },
        multisample: { count: samples },
      };
    const entry = e;
    if (typeof device.createRenderPipelineAsync !== 'function') {
      entry.pipeline = device.createRenderPipeline(descriptor);
      entry.state = 'ready';
      return entry.pipeline;
    }
    const lines = this.prelude(mesh).split('\n').length - 1,
      revision = this.revision,
      fail = async (cause: unknown) => {
        entry.state = 'failed';
        if (revision !== this.revision) return; // the code changed while this compiled
        let detail = (cause as Error)?.message ?? String(cause);
        for (const [stage, m] of [
          ['vertex', vertex],
          ['fragment', fragment],
        ] as const) {
          const info = await m.getCompilationInfo?.().catch(() => undefined),
            error = info?.messages.find((x) => x.type === 'error');
          if (error) {
            const line = error.lineNum - lines;
            detail = `${stage}Shader ${line > 0 ? `line ${line}:${error.linePos}` : `prelude line ${error.lineNum}`}: ${error.message}`;
            break;
          }
        }
        const error = new MargoError(
          'failed',
          `RawShaderMaterial ${this.name} did not compile (${detail}); fix the WGSL and assign vertexShader/fragmentShader again`,
        );
        this.error = error;
        if (this.onError) this.onError(error);
        else console.error(error);
      };
    const job = Promise.all([scope, device.createRenderPipelineAsync(descriptor)])
      .then(([error, pipeline]) => {
        if (error) return fail(error);
        entry.pipeline = pipeline;
        entry.state = 'ready';
      })
      .catch(fail);
    plugin.track(job);
    return undefined;
  }
}

interface Attribute {
  name: string;
  type: RawAttributeType;
  step: 'vertex' | 'instance';
  size: number;
  data: Float32Array | Int32Array | Uint32Array;
  count: number;
  offset: number;
}
/** Interleaved CPU copy of one step mode's attributes, uploaded whole or by element range. */
class Stream {
  attributes: Attribute[] = [];
  stride = 0;
  count = 0;
  capacity = 0;
  words = new Uint32Array(0);
  floats = new Float32Array(0);
  ints = new Int32Array(0);
  /** Dirty element range; `full` re-creates the GPU buffer. */
  start = Infinity;
  end = 0;
  full = true;
  constructor(readonly step: 'vertex' | 'instance') {}
  rebuild(): void {
    let words = 0;
    for (const a of this.attributes) {
      a.offset = words;
      words += a.size;
    }
    this.stride = words * 4;
    this.count = this.attributes.length ? Math.min(...this.attributes.map((a) => a.count)) : 0;
    this.capacity = this.attributes.length ? Math.max(...this.attributes.map((a) => a.count)) : 0;
    const buffer = new ArrayBuffer(Math.max(4, this.capacity * this.stride));
    this.words = new Uint32Array(buffer);
    this.floats = new Float32Array(buffer);
    this.ints = new Int32Array(buffer);
    for (const a of this.attributes) this.pack(a, 0, a.count);
    this.full = true;
  }
  pack(a: Attribute, start: number, end: number): void {
    const view = a.data instanceof Float32Array ? this.floats : a.data instanceof Int32Array ? this.ints : this.words,
      w = this.stride / 4;
    for (let e = start; e < end; e++)
      for (let k = 0; k < a.size; k++) view[e * w + a.offset + k] = a.data[e * a.size + k];
    this.start = Math.min(this.start, start);
    this.end = Math.max(this.end, end);
  }
  upload(device: GPUDevice, buffer: GPUBuffer | undefined): GPUBuffer | undefined {
    if (!this.attributes.length) {
      buffer?.destroy();
      return undefined;
    }
    const size = Math.max(4, this.capacity * this.stride);
    if (!buffer || this.full || buffer.size < size) {
      buffer?.destroy();
      buffer = device.createBuffer({
        label: 'shader:raw:' + this.step,
        size,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, this.words.buffer as ArrayBuffer, 0, size);
    } else if (this.end > this.start)
      device.queue.writeBuffer(
        buffer,
        this.start * this.stride,
        this.words.buffer as ArrayBuffer,
        this.start * this.stride,
        (this.end - this.start) * this.stride,
      );
    this.full = false;
    this.start = Infinity;
    this.end = 0;
    return buffer;
  }
}
interface MeshGpu {
  device: GPUDevice;
  object: GPUBuffer;
  written?: Float32Array;
  vertex?: GPUBuffer;
  instance?: GPUBuffer;
  index?: GPUBuffer;
  group?: GPUBindGroup;
  camera?: GPUBuffer;
}
/** Options for `new RawMesh(options)`. */
export interface RawMeshOptions {
  /** The material that draws it; assignable later (`mesh.material = other`). */
  material: RawShaderMaterial;
  /** Named attributes; shader locations follow this order (the prelude's `Attributes` struct names them). At most 16. */
  attributes?: Record<string, RawAttribute>;
  /** Triangle (or line/point) indices; omit to draw vertices in order. */
  index?: Uint16Array | Uint32Array | readonly number[] | null;
  /** Instances to draw; default the per-instance attributes' element count, or 1. */
  instanceCount?: number;
  /** Vertices to draw when there are no per-vertex attributes (vertex pulling). */
  vertexCount?: number;
  /** Default `'triangle-list'`. */
  topology?: GPUPrimitiveTopology;
  /** Model matrix (column-major), live in `mesh.matrix`. Default identity. */
  matrix?: ArrayLike<number>;
  /** Follow a core mesh: world = that mesh's world matrix x `matrix`. Hidden with it. */
  mesh?: Mesh | null;
  /** Lower draws first within the opaque or transparent group. Default 0. */
  renderOrder?: number;
  /** Default true. */
  visible?: boolean;
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/**
 * Geometry for a {@link RawShaderMaterial}: any named attributes (per vertex or per instance), an optional index buffer and
 * an instance count, three.js BufferGeometry + InstancedBufferAttribute. Add it to a {@link RawShaders} plugin to draw it.
 * Per-vertex and per-instance attributes are each interleaved into one vertex buffer; `setAttribute` updates are live.
 */
export class RawMesh {
  material: RawShaderMaterial;
  readonly matrix: Float32Array;
  /** Core mesh to follow, or null. */
  mesh: Mesh | null;
  visible: boolean;
  renderOrder: number;
  instanceCount?: number;
  vertexCount?: number;
  topology: GPUPrimitiveTopology;
  /** First index (or vertex) and count to draw; count is clamped to what exists. */
  readonly drawRange = { start: 0, count: Infinity };
  /** @internal */ owner?: RawShaders;
  /** @internal */ gpu?: MeshGpu;
  private readonly streams = { vertex: new Stream('vertex'), instance: new Stream('instance') };
  private readonly map = new Map<string, Attribute>();
  private indices: Uint16Array | Uint32Array | null = null;
  private indexDirty = true;
  private key = '';
  private disposed = false;
  private readonly world = new Float32Array(16);
  private readonly object = new Float32Array(28);
  constructor(options: RawMeshOptions) {
    if (!(options?.material instanceof RawShaderMaterial))
      throw new TypeError('RawMesh needs {material: new RawShaderMaterial(...)}');
    this.material = options.material;
    this.matrix = Float32Array.from(options.matrix ?? identity);
    if (this.matrix.length !== 16) throw new RangeError('RawMesh matrix needs 16 numbers (column-major)');
    this.mesh = options.mesh ?? null;
    this.visible = options.visible ?? true;
    this.renderOrder = options.renderOrder ?? 0;
    this.instanceCount = options.instanceCount;
    this.vertexCount = options.vertexCount;
    this.topology = options.topology ?? 'triangle-list';
    for (const [name, a] of Object.entries(options.attributes ?? {})) this.define(name, a);
    this.restructure();
    if (options.index) this.setIndex(options.index);
  }
  /** Attributes in location order. */
  get layout(): readonly { name: string; type: RawAttributeType; step: 'vertex' | 'instance' }[] {
    return [...this.map.values()];
  }
  /** @internal Attribute names, types and steps: equal keys share pipelines. */
  get layoutKey(): string {
    return this.key;
  }
  /** @internal */
  get indexFormat(): GPUIndexFormat | undefined {
    return this.indices ? (this.indices instanceof Uint16Array ? 'uint16' : 'uint32') : undefined;
  }
  /** The attribute's current data and layout, or undefined. */
  getAttribute(name: string): RawAttribute | undefined {
    const a = this.map.get(name);
    return a && { data: a.data, type: a.type, step: a.step };
  }
  /**
   * Live attribute update. `{data, type, step?}` adds or redefines `name` (a new layout compiles a new pipeline); plain
   * data replaces the values of an existing attribute. `range` = [first element, element count] uploads only those
   * elements of `data` (vertices or instances), which must then keep its length.
   * @throws TypeError for an unknown name with plain data, a bad type or name; RangeError for a length that is not
   * a whole number of elements, a bad range or more than 16 attributes.
   */
  setAttribute(name: string, data: RawAttribute | ArrayLike<number>, range?: readonly [number, number]): this {
    this.alive();
    const old = this.map.get(name);
    if (isAttribute(data)) {
      if (!old || old.type !== data.type || old.step !== (data.step ?? 'vertex')) {
        if (old) this.streams[old.step].attributes.splice(this.streams[old.step].attributes.indexOf(old), 1);
        this.define(name, data);
        this.restructure();
        return this;
      }
      data = data.data;
    }
    if (!old) throw new TypeError(`RawMesh has no attribute ${name}; pass {data, type, step?} to add one`);
    const values = typed(data, old.type, name),
      count = values.length / old.size,
      stream = this.streams[old.step];
    if (range) {
      const [start, n] = range;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(n) ||
        start < 0 ||
        n < 0 ||
        start + n > count ||
        count !== old.count
      )
        throw new RangeError(
          `RawMesh ${name} range [${start}, ${n}] must lie inside ${old.count} elements, with data of the same length`,
        );
      old.data = values;
      stream.pack(old, start, start + n);
      return this;
    }
    old.data = values;
    if (count !== old.count) {
      old.count = count;
      stream.rebuild();
    } else stream.pack(old, 0, count);
    return this;
  }
  /** Removes an attribute (the layout changes, so the next draw compiles a new pipeline). */
  removeAttribute(name: string): this {
    const a = this.map.get(name);
    if (a) {
      this.map.delete(name);
      this.streams[a.step].attributes.splice(this.streams[a.step].attributes.indexOf(a), 1);
      this.restructure();
    }
    return this;
  }
  /**
   * Replaces the index buffer (Uint16Array, Uint32Array or numbers, which become Uint32Array), or removes it with null.
   * @throws RangeError for a negative or non-integer index.
   */
  setIndex(index: Uint16Array | Uint32Array | readonly number[] | null): this {
    this.alive();
    if (index === null) this.indices = null;
    else if (index instanceof Uint16Array || index instanceof Uint32Array) this.indices = index;
    else {
      const v = Array.from(index);
      if (v.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffffffff))
        throw new RangeError('RawMesh indices must be integers from 0 to 2^32 - 1');
      this.indices = Uint32Array.from(v);
    }
    this.indexDirty = true;
    return this;
  }
  /** Releases the GPU buffers and leaves its RawShaders plugin; the mesh cannot be drawn again. */
  dispose(): void {
    this.release();
    this.owner?.remove(this);
    this.disposed = true;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @internal */
  alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'RawMesh is disposed; create a new RawMesh');
  }
  private define(name: string, a: RawAttribute): void {
    identifier(name, 'RawMesh attribute');
    if (!isAttribute(a) || !kinds.test(a.type))
      throw new TypeError(
        `RawMesh attribute ${name} needs {data, type} with type f32, vec2f-vec4f or their i32/u32 variants`,
      );
    const step = a.step ?? 'vertex';
    if (step !== 'vertex' && step !== 'instance')
      throw new TypeError(`RawMesh attribute ${name} step must be vertex or instance`);
    if (!this.map.has(name) && this.map.size >= 16)
      throw new RangeError('RawMesh supports 16 attributes (the WebGPU vertex attribute limit)');
    const data = typed(a.data, a.type, name),
      size = components(a.type);
    const attribute: Attribute = { name, type: a.type, step, size, data, count: data.length / size, offset: 0 };
    this.map.set(name, attribute);
    this.streams[step].attributes.push(attribute);
  }
  private restructure(): void {
    // Location order is insertion order: rebuild both stream orders from the map.
    for (const s of Object.values(this.streams)) s.attributes = [...this.map.values()].filter((a) => a.step === s.step);
    this.streams.vertex.rebuild();
    this.streams.instance.rebuild();
    this.key = [...this.map.values()].map((a) => `${a.name}:${a.type}:${a.step[0]}`).join(',');
  }
  /** @internal Vertex buffer layouts in slot order (vertex stream, then instance stream). */
  buffers(): GPUVertexBufferLayout[] {
    const locations = [...this.map.values()];
    return Object.values(this.streams)
      .filter((s) => s.attributes.length)
      .map((s) => ({
        arrayStride: s.stride,
        stepMode: s.step,
        attributes: s.attributes.map((a) => ({
          shaderLocation: locations.indexOf(a),
          offset: a.offset * 4,
          format: vertexFormat(a.type),
        })),
      }));
  }
  /** @internal Releases GPU buffers (device restore, plugin or mesh disposal); the next draw re-uploads everything. */
  release(): void {
    const g = this.gpu;
    if (!g) return;
    for (const b of [g.object, g.vertex, g.instance, g.index]) b?.destroy();
    this.gpu = undefined;
    this.streams.vertex.full = this.streams.instance.full = this.indexDirty = true;
  }
  /** @internal The world matrix (null when the followed mesh is hidden or gone). */
  worldMatrix(engine: EngineKernel): Float32Array | null {
    if (!this.mesh) return this.matrix;
    const parent = meshWorldMatrix(engine, this.mesh);
    if (!parent) return null;
    const w = this.world,
      m = this.matrix;
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        w[c * 4 + r] =
          parent[r] * m[c * 4] +
          parent[4 + r] * m[c * 4 + 1] +
          parent[8 + r] * m[c * 4 + 2] +
          parent[12 + r] * m[c * 4 + 3];
    return w;
  }
  /** @internal Uploads changes and returns [first, count, instances], or undefined when there is nothing to draw. */
  upload(device: GPUDevice, camera: GPUBuffer, world: Float32Array): [number, number, number] | undefined {
    let g = this.gpu;
    if (g && g.device !== device) {
      this.release();
      g = undefined;
    }
    if (!g)
      g = this.gpu = {
        device,
        object: device.createBuffer({
          label: 'shader:raw:mesh',
          size: 112,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      };
    const o = this.object;
    o.set(world);
    // Normal matrix: inverse transpose of the upper 3x3, the cofactor columns over the determinant.
    const [a0, a1, a2, , b0, b1, b2, , c0, c1, c2] = world,
      x = [b1 * c2 - b2 * c1, b2 * c0 - b0 * c2, b0 * c1 - b1 * c0],
      y = [c1 * a2 - c2 * a1, c2 * a0 - c0 * a2, c0 * a1 - c1 * a0],
      z = [a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0],
      det = a0 * x[0] + a1 * x[1] + a2 * x[2],
      inv = det ? 1 / det : 0;
    [x, y, z].forEach((col, i) => col.forEach((v, k) => (o[16 + i * 4 + k] = v * inv)));
    if (!g.written || g.written.some((v, i) => !Object.is(v, o[i]))) {
      device.queue.writeBuffer(g.object, 0, o as Float32Array<ArrayBuffer>);
      (g.written ??= new Float32Array(28)).set(o);
    }
    if (g.camera !== camera || !g.group) {
      g.camera = camera;
      g.group = device.createBindGroup({
        layout: frameLayout(device),
        entries: [
          { binding: 0, resource: { buffer: camera } },
          { binding: 1, resource: { buffer: g.object } },
        ],
      });
    }
    g.vertex = this.streams.vertex.upload(device, g.vertex);
    g.instance = this.streams.instance.upload(device, g.instance);
    const index = this.indices;
    if (!index) {
      g.index?.destroy();
      g.index = undefined;
    } else if (this.indexDirty || !g.index) {
      const bytes = Math.ceil(index.byteLength / 4) * 4 || 4;
      if (!g.index || g.index.size < bytes) {
        g.index?.destroy();
        g.index = device.createBuffer({
          label: 'shader:raw:index',
          size: bytes,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
      }
      const padded = new Uint8Array(bytes);
      padded.set(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
      device.queue.writeBuffer(g.index, 0, padded);
    }
    this.indexDirty = false;
    const vs = this.streams.vertex,
      is = this.streams.instance,
      total = index
        ? index.length
        : vs.attributes.length
          ? Math.min(vs.count, this.vertexCount ?? Infinity)
          : (this.vertexCount ?? 0),
      instances = is.attributes.length ? Math.min(is.count, this.instanceCount ?? Infinity) : (this.instanceCount ?? 1),
      start = Math.min(Math.max(0, Math.floor(this.drawRange.start) || 0), total),
      count = Math.min(Math.max(0, Math.floor(this.drawRange.count)), total - start);
    return count > 0 && instances > 0 ? [start, count, Math.floor(instances)] : undefined;
  }
  /** @internal */
  draw(pass: GPURenderPassEncoder, first: number, count: number, instances: number): void {
    const g = this.gpu!;
    let slot = 0;
    if (g.vertex) pass.setVertexBuffer(slot++, g.vertex);
    if (g.instance) pass.setVertexBuffer(slot, g.instance);
    if (g.index) {
      pass.setIndexBuffer(g.index, this.indexFormat!);
      pass.drawIndexed(count, instances, first);
    } else pass.draw(count, instances, first);
  }
}
const isAttribute = (x: unknown): x is RawAttribute =>
  !!x && typeof x === 'object' && 'data' in x && typeof (x as RawAttribute).type === 'string';
function typed(data: ArrayLike<number>, type: RawAttributeType, name: string): Float32Array | Int32Array | Uint32Array {
  const size = components(type),
    kind = scalar(type);
  if (!data || typeof data.length !== 'number' || data.length % size)
    throw new RangeError(`RawMesh attribute ${name} needs a multiple of ${size} numbers for ${type}`);
  const Kind = kind === 'f' ? Float32Array : kind === 'i' ? Int32Array : Uint32Array;
  return data instanceof Kind ? data : Kind.from(data);
}

/** Options for `new RawShaders(options)`. */
export interface RawShadersOptions {
  /** Plugin name, unique per engine. Default `'shader:raw'`. */
  name?: string;
  /** Frame-graph order of opaque raw meshes: after core meshes (0), before gltf-pro and materials meshes (1). Default 0.5. */
  opaqueOrder?: number;
  /** Order of transparent raw meshes: after water (4), sky (5) and particles (6), before OIT (8) and lines (20). Default 7. */
  transparentOrder?: number;
}
/**
 * Engine plugin that draws {@link RawMesh}es in the scene's main colour and depth targets (WebGPU), with the pass's
 * colour format, MSAA sample count and reversed-Z depth; inside a PostStack they land in its scene capture. Opaque
 * meshes draw in one pass, transparent ones (`material.transparent`) in a later pass sorted back to front.
 */
export class RawShaders implements EnginePlugin {
  readonly name: string;
  readonly opaqueOrder: number;
  readonly transparentOrder: number;
  /** Counters of the latest frame; `pending` is pipelines still compiling. */
  readonly stats = { meshes: 0, drawCalls: 0, pending: 0 };
  private readonly meshes = new Set<RawMesh>();
  private readonly jobs = new Set<Promise<void>>();
  private engine?: Engine;
  private device?: GPUDevice;
  private camera?: GPUBuffer;
  private passes = 0;
  private readonly cameraData = new Float32Array(56);
  private readonly view = new Float64Array(16);
  private readonly inverse = new Float64Array(16);
  /** Same as `engine.use(new RawShaders(...))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: RawShadersOptions): RawShaders {
    const value = new RawShaders(options);
    engine.use(value);
    return value;
  }
  constructor(options: RawShadersOptions = {}) {
    this.name = options.name ?? 'shader:raw';
    this.opaqueOrder = options.opaqueOrder ?? 0.5;
    this.transparentOrder = options.transparentOrder ?? 7;
    if (!this.name || typeof this.name !== 'string') throw new TypeError('RawShaders name must be a non-empty string');
    if (!Number.isFinite(this.opaqueOrder) || !Number.isFinite(this.transparentOrder))
      throw new RangeError('RawShaders opaqueOrder and transparentOrder must be finite numbers');
  }
  /**
   * Draws `mesh` from the next frame on; returns it.
   * @throws MargoError `'attached'` when it belongs to another RawShaders, `'disposed'` after `mesh.dispose()`.
   */
  add(mesh: RawMesh): RawMesh {
    if (!(mesh instanceof RawMesh)) throw new TypeError('RawShaders.add needs a RawMesh');
    if (mesh.owner && mesh.owner !== this)
      throw new MargoError('attached', 'RawMesh already belongs to another RawShaders; remove it there first');
    mesh.alive();
    mesh.owner = this;
    this.meshes.add(mesh);
    return mesh;
  }
  /** Stops drawing `mesh` and releases its GPU buffers; true when it was here. */
  remove(mesh: RawMesh): boolean {
    if (!this.meshes.delete(mesh)) return false;
    mesh.release();
    mesh.owner = undefined;
    return true;
  }
  /** Resolves once every pipeline compiling now has finished (or failed); render again to see them. */
  async ready(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
  /** @internal */
  track(job: Promise<void>): void {
    const done = () => {
      this.jobs.delete(job);
    };
    this.jobs.add(job);
    job.then(done, done);
  }
  setup(engine: Engine): void {
    if (this.engine && this.engine !== engine)
      throw new MargoError('attached', `${this.name} is attached to another engine; create a new RawShaders`);
    if (!engine.gpu)
      throw new MargoError('unsupported', 'RawShaders requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    this.device = engine.gpu ?? undefined;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name + ':opaque', order: this.opaqueOrder, execute: (c) => this.execute(c, false) });
    graph.add({
      name: this.name + ':transparent',
      order: this.transparentOrder,
      execute: (c) => this.execute(c, true),
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.device = engine.gpu ?? undefined;
  }
  /** Releases every GPU object; meshes stay registered, so the plugin can be attached again. */
  dispose(): void {
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private release(): void {
    const device = this.device;
    for (const mesh of this.meshes) {
      mesh.release();
      const gpu = device && mesh.material.gpu.get(device);
      gpu?.buffer?.destroy();
      if (device) mesh.material.gpu.delete(device);
    }
    this.camera?.destroy();
    this.camera = undefined;
  }
  private writeCamera(c: RawPassContext): GPUBuffer {
    const device = c.device;
    this.camera ??= device.createBuffer({
      label: 'shader:raw:camera',
      size: 224,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const camera = c.camera,
      f = this.cameraData,
      v = viewMatrix(this.view as unknown as Float32Array, camera),
      m = camera.matrix,
      inv = this.inverse;
    // Inverse of the rigid view, then projection = viewProjection x view^-1 (works for any camera.project).
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 3; k++) inv[k * 4 + r] = v[r * 4 + k];
      inv[12 + r] = -(v[r * 4] * v[12] + v[r * 4 + 1] * v[13] + v[r * 4 + 2] * v[14]);
      inv[r * 4 + 3] = 0;
    }
    inv[15] = 1;
    f.set(v, 0);
    for (let col = 0; col < 4; col++)
      for (let r = 0; r < 4; r++)
        f[16 + col * 4 + r] =
          m[r] * inv[col * 4] +
          m[4 + r] * inv[col * 4 + 1] +
          m[8 + r] * inv[col * 4 + 2] +
          m[12 + r] * inv[col * 4 + 3];
    f.set(m, 32);
    f.set(camera.position, 48);
    f[51] = performance.now() / 1000;
    f[52] = c.width;
    f[53] = c.height;
    f[54] = c.delta;
    f[55] = c.format.includes('float') ? 0 : c.format.endsWith('-srgb') ? 2 : 1;
    device.queue.writeBuffer(this.camera, 0, f);
    return this.camera;
  }
  private execute(c: PassContext, transparent: boolean): void {
    if (!transparent) this.stats.meshes = this.stats.drawCalls = 0;
    if (c.backend !== 'webgpu' || !this.device || !this.engine || c.device !== this.device || !this.meshes.size) return;
    const device = this.device,
      engine = this.engine as unknown as EngineKernel,
      eye = c.camera.position,
      draws: { mesh: RawMesh; pipeline: GPURenderPipeline; group?: GPUBindGroup; call: number[]; distance: number }[] =
        [];
    const token = ++this.passes;
    let camera: GPUBuffer | undefined;
    for (const mesh of this.meshes) {
      const material = mesh.material;
      if (!mesh.visible || material.transparent !== transparent) continue;
      const world = mesh.worldMatrix(engine);
      if (!world) continue;
      camera ??= this.writeCamera(c);
      const call = mesh.upload(device, camera, world);
      if (!call) continue;
      const gpu = material.prepare(device, token),
        pipeline = material.pipeline(this, gpu, device, mesh, c);
      if (!pipeline) continue;
      const dx = world[12] - eye[0],
        dy = world[13] - eye[1],
        dz = world[14] - eye[2];
      draws.push({ mesh, pipeline, group: gpu.group, call, distance: dx * dx + dy * dy + dz * dz });
    }
    this.stats.pending = this.jobs.size;
    if (!draws.length) return;
    draws.sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder || (transparent ? b.distance - a.distance : 0));
    const stencil = c.descriptor.depthStencil!.format.includes('stencil'),
      pass = c.encoder.beginRenderPass({
        label: this.name + (transparent ? ':transparent' : ':opaque'),
        colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: c.depth,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
          ...(stencil ? { stencilReadOnly: true } : {}),
        },
      });
    let current: GPURenderPipeline | undefined;
    for (const d of draws) {
      if (d.pipeline !== current) pass.setPipeline((current = d.pipeline));
      pass.setBindGroup(0, d.mesh.gpu!.group!);
      if (d.group) pass.setBindGroup(1, d.group);
      d.mesh.draw(pass, d.call[0], d.call[1], d.call[2]);
      this.stats.meshes++;
      this.stats.drawCalls++;
    }
    pass.end();
  }
}
