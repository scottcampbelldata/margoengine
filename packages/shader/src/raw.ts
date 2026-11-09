/// <reference lib="esnext.disposable" preserve="true" />
// RawShaderMaterial and RawMesh: the caller's own WGSL stages, vertex layout, uniforms, textures, storage buffers and bind
// groups, drawn by the RawShaders plugin in the scene's colour and depth pass. They also cast shadows, write SSAO's G-buffer,
// are frustum culled and are picked. What a shader can read is declared by a prelude in front of the caller's code;
// `material.code(stage, mesh)` shows the module.
import { MargoError } from '@margoengine/math/errors';
import { parseColor } from '@margoengine/math/color';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { beginPickPass } from '../../shared/pick-base.js';
import { viewMatrix } from '../../shared/view.js';
import { neutralShader } from '../../shared/display.js';
import type { BindableTexture } from './texture.js';
import { alphaBlend } from '../../shared/pass.js';
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
/** One value of a {@link RawUniform}: a number, a colour string or the numbers of a vector or matrix. */
export type RawUniformValue = number | string | ArrayLike<number>;
/**
 * A live uniform: assign `material.uniforms.name.value` any time. A number is an f32 (or the scalar of
 * `type`), 2/3/4/9/16 numbers a vecNf/mat3x3f/mat4x4f, and `'#rrggbb'`/`0xrrggbb` with a vec3f type an sRGB colour
 * decoded to linear. `count` makes an array, whose value is a list of elements or all their numbers in a row. `struct` makes
 * a struct, whose value is an object of fields (with `count`, a list of them). `type`, `count` and `struct` are fixed at
 * construction.
 */
export interface RawUniform {
  value:
    | RawUniformValue
    | readonly RawUniformValue[]
    | Readonly<Record<string, RawUniformValue>>
    | readonly Readonly<Record<string, RawUniformValue>>[];
  readonly type?: RawUniformType;
  /**
   * Elements of an `array<type, count>`, read as `uniforms.<name>[i]`. A uniform array's stride is a multiple of 16 bytes, so
   * the element is a vec3, a vec4, a matrix or a struct; a storage buffer holds tighter arrays.
   */
  readonly count?: number;
  /** Field names and types of a struct, read as `uniforms.<name>.<field>`. A field is not itself an array or a struct. */
  readonly struct?: Readonly<Record<string, RawUniformType>>;
}
/**
 * A storage buffer a raw shader reads, declared `<name>:array<type>`. A `storage()` node of `@margoengine/shader` fits as it
 * is, so a compute pass can fill what a mesh draws.
 */
export interface RawStorage {
  /** A buffer with STORAGE usage on the engine's device, or a function that gives one for a device. Live. */
  buffer: GPUBuffer | ((device: GPUDevice) => GPUBuffer);
  /** WGSL element type: a built-in type, or a struct your code declares in every stage that reads the buffer. */
  readonly type: string;
  /** Default `'read'`, bound to both stages. `'read_write'` is bound to the fragment stage only, as WebGPU requires. */
  readonly access?: 'read' | 'read_write';
}
/**
 * One extra bind group, read at `@group(2)` then `@group(3)` by bindings your WGSL declares. Called once per device, so a
 * restored device gets a new group.
 */
export type RawBindGroup = (device: GPUDevice) => { layout: GPUBindGroupLayout; group: GPUBindGroup };
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
/** Colour blending of a {@link RawShaderMaterial}: a named preset or a WebGPU blend state. */
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
  /** Named storage buffers, read as `<name>[i]` in WGSL. */
  storage?: Record<string, RawStorage>;
  /** At most two extra bind groups, at `@group(2)` and `@group(3)`. */
  groups?: readonly RawBindGroup[];
  /**
   * A `@fragment fn` of the fragment code that returns `margoGBuffer(worldNormal, worldPosition, ambient)`, drawn when the
   * RawShaders is added to SSAO. It gives SSAO the shader's own normals and the ambient light to darken. Without it the mesh's
   * depth still occludes and its pixels are not darkened.
   */
  gbufferEntry?: string;
  /**
   * A `@vertex fn` of the vertex code that returns `margoVelocity(position, positionBefore)`: where the vertex is now and
   * where it was last frame, both before `mesh.world`. Drawn when the RawShaders is added to TAA (`taa.add(raw)`), it gives
   * TAA the motion of a shape the shader moves, so the shape leaves no ghost trail. It reads `margoBefore.time` (last
   * frame's `camera.time`) and `margoBefore.world`; keep last frame's value of any uniform the move reads beside it. A
   * mesh without it gets TAA's camera motion only, from its depth. Default none.
   */
  velocityEntry?: string;
  /** Draw after the opaque scene, sorted back to front, with blending. Default false. */
  transparent?: boolean;
  /** Default `'normal'`, which blends only when `transparent`. */
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
const entry = (code: string, stage: string, skip?: string): string | undefined => {
  for (const found of code.matchAll(new RegExp(`@${stage}\\s+fn\\s+([A-Za-z_]\\w*)`, 'g')))
    if (found[1] !== skip) return found[1];
  return undefined;
};
const uniformType = (t: string): boolean => kinds.test(t) || t === 'mat3x3f' || t === 'mat4x4f';
const roundUp = (x: number, step: number): number => Math.ceil(x / step) * step;

// Colour helpers for the shader: margoDisplay is the scene's display transform (PBR Neutral + sRGB on display targets),
// margoEncode the sRGB encoding alone (unlit colour, as lines and points write it). An HDR capture keeps linear light.
// Sources: Khronos PBR Neutral specification (2024); sRGB encoding IEC 61966-2-1.
const helpers = `${neutralShader.replace('pbrNeutral', 'margoNeutral')}fn margoSRGB(x:vec3f)->vec3f {return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
fn margoDisplay(c:vec4f)->vec4f {if(camera.encoding==0.0){return c;}let x=margoNeutral(max(c.rgb,vec3f(0)));if(camera.encoding==2.0){return vec4f(x,c.a);}return vec4f(margoSRGB(x),c.a);}
fn margoEncode(c:vec4f)->vec4f {if(camera.encoding!=1.0){return c;}return vec4f(margoSRGB(max(c.rgb,vec3f(0))),c.a);}
struct MargoCamera { view:mat4x4f, projection:mat4x4f, viewProjection:mat4x4f, position:vec3f, time:f32, resolution:vec2f, deltaTime:f32, encoding:f32 }
struct MargoMesh { world:mat4x4f, normal:mat3x3f, pickId:u32 }
@group(0) @binding(0) var<uniform> camera:MargoCamera;
@group(0) @binding(1) var<uniform> mesh:MargoMesh;
struct MargoGBuffer { @location(0) normal:vec4f, @location(1) ambient:vec4f }
fn margoGBuffer(normal:vec3f,position:vec3f,ambient:vec3f)->MargoGBuffer {return MargoGBuffer(vec4f(normalize((camera.view*vec4f(normal,0)).xyz),-(camera.view*vec4f(position,1)).z),vec4f(ambient,1));}`;
// A velocity module's additions: last frame's view-projection, world matrix and time, the vertex helper, and the fragment
// that writes TAA's motion (current minus previous position in uv, and the previous depth) as its own pass does.
const velocityPrelude = `struct MargoBefore { viewProjection:mat4x4f, world:mat4x4f, time:f32, valid:f32 }
@group(0) @binding(2) var<uniform> margoBefore:MargoBefore;
struct MargoVelocity { @builtin(position) clip:vec4f, @location(0) previous:vec4f }
fn margoVelocity(position:vec3f,before:vec3f)->MargoVelocity {return MargoVelocity(camera.viewProjection*mesh.world*vec4f(position,1),margoBefore.viewProjection*margoBefore.world*vec4f(before,1));}
`;
const velocityFragment = `
struct MargoMotion { @location(0) velocity:vec2f, @location(1) depth:f32 }
@fragment fn margoVelocityFragment(i:MargoVelocity)->MargoMotion {var o:MargoMotion;o.velocity=vec2f(0);o.depth=-1;
  if(i.previous.w>0&&margoBefore.valid>0){o.velocity=i.clip.xy/camera.resolution-(i.previous.xy/i.previous.w*vec2f(0.5,-0.5)+0.5);o.depth=i.previous.z/i.previous.w;}return o;}
`;
// The pick pass reads no part of the caller's fragment stage: a mesh's ID covers its whole shape.
const pickFragment = '@fragment fn margoPick()->@location(0) u32 {return mesh.pickId;}\n';
/** Byte offset of `pickId` in the object block, and the block's size. */
const PICK_ID = 112,
  OBJECT_BYTES = 128;

interface Field {
  name: string;
  type: RawUniformType;
  offset: number;
}
interface Member {
  name: string;
  /** A uniform type, or the generated struct's name. */
  type: string;
  offset: number;
  /** Elements of an array, and the bytes from one to the next (a struct's size when it is not an array). */
  count?: number;
  stride?: number;
  fields?: Field[];
}
/** Which pipeline of a material: the colour pass, a shadow cascade, SSAO's G-buffer or a pick. */
type RawPass = 'color' | 'shadow' | 'gbuffer' | 'pick' | 'velocity';
interface PipelineEntry {
  state: 'pending' | 'ready' | 'failed';
  pipeline?: GPURenderPipeline;
}
interface MaterialGpu {
  layout?: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  /** The velocity pass's: group 0 also holds last frame's block. Made on first use. */
  velocityLayout?: GPUPipelineLayout;
  /** Groups 1 and up of `pipelineLayout`. */
  groupLayouts: GPUBindGroupLayout[];
  buffer?: GPUBuffer;
  written?: Uint8Array;
  group?: GPUBindGroup;
  bound: unknown[];
  /** The groups of `groups`, bound after `group`. */
  extras: GPUBindGroup[];
  pass?: number;
  modules: Map<string, GPUShaderModule>;
  pipelines: Map<string, PipelineEntry>;
}
const frameLayouts = new WeakMap<GPUDevice, GPUBindGroupLayout>(),
  velocityLayouts = new WeakMap<GPUDevice, GPUBindGroupLayout>(),
  samplers = new WeakMap<GPUDevice, Map<string, GPUSampler>>(),
  views = new WeakMap<GPUTexture, Map<string, GPUTextureView>>(),
  owners = new WeakMap<object, GPUDevice>(),
  fallbacks = new WeakMap<GPUDevice, Map<string, GPUTextureView>>();
const visibility = () => GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
function frameLayout(device: GPUDevice, velocity = false): GPUBindGroupLayout {
  const cache = velocity ? velocityLayouts : frameLayouts;
  let layout = cache.get(device);
  if (!layout) {
    layout = device.createBindGroupLayout({
      label: velocity ? 'shader:raw:velocity' : 'shader:raw:frame',
      entries: (velocity ? [0, 1, 2] : [0, 1]).map((binding) => ({
        binding,
        visibility: visibility(),
        buffer: { type: 'uniform' as const },
      })),
    });
    cache.set(device, layout);
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
  normal: alphaBlend,
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
 * Raw shader material for WebGPU: your own WGSL vertex and fragment entry points, drawn by {@link RawShaders} in
 * the scene's colour and depth pass. A prelude in front of your code declares what you can read: `camera` (view,
 * projection, viewProjection, position, time, resolution, deltaTime), `mesh` (world, normal), `uniforms.<name>`, each
 * texture `<name>` with `<name>Sampler`, each storage buffer `<name>`, the `Attributes` struct of the drawn RawMesh, and
 * `margoDisplay(c)` / `margoEncode(c)` to output linear colour like the rest of the scene. Fragment output is written as
 * returned.
 * WGSL errors are reported (`error`, `onError`, else console.error) and that draw is skipped; other draws continue.
 */
export class RawShaderMaterial {
  readonly name: string;
  /** Live values; names and types are fixed at construction. */
  readonly uniforms: Record<string, RawUniform>;
  /** Live `texture` and `sampler`; names, dimension and sample type are fixed at construction. */
  readonly textures: Record<string, RawTexture>;
  /** Live `buffer`; names, types and access are fixed at construction. */
  readonly storage: Record<string, RawStorage>;
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
  /** @internal Pipelines finished so far: a static shadow map redraws when a caster's pipeline arrives. */ compiled = 0;
  private readonly groups: readonly RawBindGroup[];
  private readonly gbufferName?: string;
  /** @internal The `velocityEntry`, when the material draws its own motion for TAA. */ readonly velocityName?: string;
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
    this.gbufferName = options.gbufferEntry;
    this.velocityName = options.velocityEntry;
    this.groups = options.groups ?? [];
    if (this.groups.length > 2 || this.groups.some((g) => typeof g !== 'function'))
      throw new TypeError(
        'RawShaderMaterial groups must be at most two functions of the device, for @group(2) and @group(3)',
      );
    this.setCode(options.vertexShader, options.fragmentShader);
    const members: Member[] = [];
    let end = 0;
    this.uniforms = {};
    for (const [name, u] of Object.entries(options.uniforms ?? {})) {
      identifier(name, 'RawShaderMaterial uniform');
      if (!u || typeof u !== 'object' || !('value' in u))
        throw new TypeError(`RawShaderMaterial uniform ${name} must be {value, type?}`);
      const { count } = u;
      if (count !== undefined && (!Number.isInteger(count) || count < 1))
        throw new RangeError(`RawShaderMaterial uniform ${name} count must be a positive integer`);
      if (u.struct) {
        const fields: Field[] = [];
        let at = 0;
        for (const [field, fieldType] of Object.entries(u.struct)) {
          identifier(field, `RawShaderMaterial uniform ${name} field`);
          if (!uniformType(fieldType))
            throw new TypeError(
              `RawShaderMaterial uniform ${name} field ${field} needs a type from 'f32' to 'vec4f', their i32/u32 variants, 'mat3x3f' or 'mat4x4f'`,
            );
          const offset = roundUp(at, alignOf(fieldType));
          fields.push({ name: field, type: fieldType, offset });
          at = offset + bytesOf(fieldType);
        }
        if (!fields.length) throw new TypeError(`RawShaderMaterial uniform ${name} struct needs at least one field`);
        // Every struct is aligned to 16 bytes, so it is a legal uniform member and array element whatever its fields.
        const stride = roundUp(at, 16),
          offset = roundUp(end, 16);
        members.push({ name, type: 'Raw_' + name, offset, count, stride, fields });
        end = offset + stride * (count ?? 1);
        this.uniforms[name] = u;
        continue;
      }
      if (count !== undefined) {
        const element = u.type;
        if (!element || !uniformType(element))
          throw new TypeError(
            `RawShaderMaterial uniform ${name} is an array, so it needs type ('f32' to 'vec4f', i32/u32 variants, 'mat3x3f' or 'mat4x4f')`,
          );
        const stride = roundUp(bytesOf(element), alignOf(element));
        if (stride % 16)
          throw new TypeError(
            `RawShaderMaterial uniform ${name}: elements of a uniform array sit 16 bytes apart, so ${element} does not fit; use vec3, vec4, a matrix or a struct, or put it in a storage buffer`,
          );
        const offset = roundUp(end, 16);
        members.push({ name, type: element, offset, count, stride });
        end = offset + stride * count;
        this.uniforms[name] = u;
        continue;
      }
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
      if (!type || !uniformType(type))
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
    this.storage = {};
    for (const [name, s] of Object.entries(options.storage ?? {})) {
      identifier(name, 'RawShaderMaterial storage');
      if (!s || typeof s !== 'object' || !s.buffer || typeof s.type !== 'string' || !s.type)
        throw new TypeError(`RawShaderMaterial storage ${name} must be {buffer, type, access?} or a storage() node`);
      if (s.access !== undefined && s.access !== 'read' && s.access !== 'read_write')
        throw new TypeError(`RawShaderMaterial storage ${name} access must be read or read_write`);
      this.storage[name] = s;
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
      f = this.entries.fragment ?? entry(fragment ?? vertex, 'fragment', this.gbufferName);
    if (!v) throw new TypeError(`RawShaderMaterial ${this.name} has no @vertex fn; add one or pass vertexEntry`);
    if (!f)
      throw new TypeError(
        `RawShaderMaterial ${this.name} has no @fragment fn; add one to fragmentShader (or vertexShader) or pass fragmentEntry`,
      );
    if (this.gbufferName && !new RegExp(`@fragment\\s+fn\\s+${this.gbufferName}\\b`).test(fragment ?? vertex))
      throw new TypeError(
        `RawShaderMaterial ${this.name} has no @fragment fn ${this.gbufferName}; add it beside the colour fragment or drop gbufferEntry`,
      );
    if (this.velocityName && !new RegExp(`@vertex\\s+fn\\s+${this.velocityName}\\b`).test(vertex))
      throw new TypeError(
        `RawShaderMaterial ${this.name} has no @vertex fn ${this.velocityName}; add it to vertexShader or drop velocityEntry`,
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
    for (const m of this.members)
      if (m.fields)
        out.push(
          `struct ${m.type} {\n${m.fields.map((f, i) => `  ${i ? '' : '@align(16) '}${f.name}:${f.type},`).join('\n')}\n}`,
        );
    // Every stage of a material with a velocity entry declares what that entry reads; unused, it binds nothing.
    if (this.velocityName) out.push(velocityPrelude);
    if (this.members.length)
      out.push(
        `struct Uniforms {\n${this.members.map((m) => `  ${m.name}:${m.count === undefined ? m.type : `array<${m.type},${m.count}>`},`).join('\n')}\n}\n@group(1) @binding(0) var<uniform> uniforms:Uniforms;`,
      );
    Object.entries(this.textures).forEach(([name, t], i) => {
      const s = { float: 'f32', 'unfilterable-float': 'f32', sint: 'i32', uint: 'u32' }[t.sampleType ?? 'float'];
      out.push(
        `@group(1) @binding(${1 + 2 * i}) var ${name}:texture_${(t.dimension ?? '2d').replace('-', '_')}<${s}>;\n@group(1) @binding(${2 + 2 * i}) var ${name}Sampler:sampler;`,
      );
    });
    const first = 1 + 2 * Object.keys(this.textures).length;
    Object.entries(this.storage).forEach(([name, s], i) =>
      out.push(`@group(1) @binding(${first + i}) var<storage,${s.access ?? 'read'}> ${name}:array<${s.type}>;`),
    );
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
      Object.values(this.storage).forEach((s, i) => {
        const read = (s.access ?? 'read') === 'read';
        entries.push({
          binding: 1 + 2 * textures.length + i,
          visibility: read ? visibility() : GPUShaderStage.FRAGMENT,
          buffer: { type: read ? 'read-only-storage' : 'storage' },
        });
      });
      const extras = this.groups.map((g) => g(device)),
        // Extra groups sit at 2 and up, so group 1 exists even when it binds nothing.
        layout =
          entries.length || extras.length
            ? device.createBindGroupLayout({ label: 'shader:raw:' + this.name, entries })
            : undefined;
      const groupLayouts = layout ? [layout, ...extras.map((e) => e.layout)] : [];
      gpu = {
        layout,
        groupLayouts,
        pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout(device), ...groupLayouts] }),
        bound: [],
        extras: extras.map((e) => e.group),
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
      const textures = Object.values(this.textures);
      for (const t of textures) bound.push(...bindTexture(device, t));
      const storage = Object.values(this.storage);
      for (const s of storage) bound.push(typeof s.buffer === 'function' ? s.buffer(device) : s.buffer);
      if (!gpu.group || bound.some((x, i) => x !== gpu!.bound[i])) {
        gpu.bound = bound;
        const entries: GPUBindGroupEntry[] = [];
        let k = 0;
        if (this.size) entries.push({ binding: 0, resource: { buffer: bound[k++] as GPUBuffer } });
        for (let i = 0; i < textures.length; i++)
          entries.push(
            { binding: 1 + 2 * i, resource: bound[k++] as GPUTextureView },
            { binding: 2 + 2 * i, resource: bound[k++] as GPUSampler },
          );
        for (let i = 0; i < storage.length; i++)
          entries.push({ binding: 1 + 2 * textures.length + i, resource: { buffer: bound[k++] as GPUBuffer } });
        gpu.group = device.createBindGroup({ layout: gpu.layout, entries });
      }
    }
    return gpu;
  }
  private write(m: Member): void {
    const v = this.uniforms[m.name]?.value;
    if (m.count === undefined && !m.fields) return this.put(m.type, m.offset, v, m.name);
    const size = components(m.type),
      list = v as ArrayLike<unknown>,
      flat = m.count !== undefined && !m.fields && typeof list?.[0] === 'number',
      count = m.count ?? 1,
      length = m.count === undefined ? 1 : flat ? list.length / size : list?.length;
    if (length !== count)
      throw new RangeError(
        `RawShaderMaterial ${this.name} uniform ${m.name} needs ${count} element${count > 1 ? 's' : ''}; assign a matching value`,
      );
    for (let i = 0; i < count; i++) {
      const item =
          m.count === undefined ? v : flat ? Array.prototype.slice.call(list, i * size, (i + 1) * size) : list[i],
        at = m.offset + i * m.stride!,
        name = m.count === undefined ? m.name : `${m.name}[${i}]`;
      if (!m.fields) this.put(m.type, at, item, name);
      else
        for (const f of m.fields)
          this.put(f.type, at + f.offset, (item as Record<string, unknown>)?.[f.name], `${name}.${f.name}`);
    }
  }
  private put(type: string, offset: number, v: unknown, name: string): void {
    const n = components(type),
      values =
        typeof v === 'number' && n === 1
          ? [v]
          : (typeof v === 'string' || typeof v === 'number') && type === 'vec3f'
            ? Array.from(parseColor(v))
            : v !== null && typeof v === 'object'
              ? Array.from(v as ArrayLike<number>)
              : [];
    if (values.length !== n || values.some((x) => !Number.isFinite(x)))
      throw new RangeError(
        `RawShaderMaterial ${this.name} uniform ${name} needs ${n} finite number${n > 1 ? 's' : ''} for ${type}; assign a matching value`,
      );
    const s = scalar(type),
      rows = type === 'mat3x3f' ? 3 : 0;
    values.forEach((x, i) => {
      const at = offset + (rows ? Math.floor(i / 3) * 16 + (i % 3) * 4 : i * 4);
      s === 'f'
        ? this.data.setFloat32(at, x, true)
        : s === 'i'
          ? this.data.setInt32(at, x, true)
          : this.data.setUint32(at, x, true);
    });
  }
  /** @internal True when the G-buffer pass has a fragment to draw. */
  get writesGBuffer(): boolean {
    return !!this.gbufferName;
  }
  /** @internal What differs between the pipelines of one material: the fragment, its targets and the depth state. */
  private target(
    kind: RawPass,
    c: RawPassContext | undefined,
    compare: GPUCompareFunction,
  ): { entry?: string; targets: GPUColorTargetState[]; depthStencil: GPUDepthStencilState } {
    const format = c?.descriptor.depthStencil!.format as GPUTextureFormat;
    if (kind === 'shadow')
      return {
        // A fragment only matters to a shadow when it can cut the shape, and its outputs then go nowhere.
        entry: /\bdiscard\b/.test(this.fragmentCode ?? this.vertexCode) ? this.fragmentName : undefined,
        targets: [],
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      };
    if (kind === 'pick')
      return {
        entry: 'margoPick',
        targets: [{ format: 'r32uint' }],
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: this.depthTest ? 'greater-equal' : 'always',
        },
      };
    if (kind === 'velocity')
      return {
        entry: 'margoVelocityFragment',
        targets: [{ format: 'rg16float' }, { format: 'r32float' }],
        depthStencil: { format, depthWriteEnabled: false, depthCompare: 'equal' },
      };
    if (kind === 'gbuffer')
      return {
        entry: this.gbufferName,
        targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }],
        depthStencil: { format, depthWriteEnabled: false, depthCompare: compare },
      };
    const blend = this.blend();
    return {
      entry: this.fragmentName,
      targets: [{ format: c!.format, ...(blend ? { blend } : {}), writeMask: this.colorWrite ? 0xf : 0 }],
      depthStencil: {
        format,
        depthWriteEnabled: this.depthWrite,
        depthCompare: this.depthTest ? 'greater-equal' : 'always',
      },
    };
  }
  /** @internal The pipeline for `key`, compiling it on first use; undefined while pending or after a failure. */
  pipeline(
    plugin: RawShaders,
    gpu: MaterialGpu,
    device: GPUDevice,
    mesh: RawMesh,
    kind: RawPass,
    c?: RawPassContext,
    compare: GPUCompareFunction = 'equal',
  ): GPURenderPipeline | undefined {
    const strip = mesh.topology.endsWith('strip') && mesh.indexFormat,
      samples = c?.descriptor.multisample?.count ?? 1,
      depth = c?.descriptor.depthStencil!.format,
      key = `${kind}|${mesh.layoutKey}|${mesh.topology}|${strip || ''}|${c?.format}|${samples}|${depth}|${compare}|${this.state()}`;
    let e = gpu.pipelines.get(key);
    if (e) return e.pipeline;
    e = { state: 'pending' };
    gpu.pipelines.set(key, e);
    const module = (stage: 'vertex' | 'fragment' | 'pick' | 'velocity') => {
      const k = stage + '|' + mesh.layoutKey;
      let m = gpu.modules.get(k);
      if (!m) {
        const code =
          stage === 'pick'
            ? this.prelude(mesh) + pickFragment
            : stage === 'velocity'
              ? this.code('vertex', mesh) + velocityFragment
              : this.code(stage, mesh);
        m = device.createShaderModule({ label: `shader:raw:${this.name}:${stage}`, code });
        gpu.modules.set(k, m);
        // Asked now, for the error report: a request made later, on an idle device, can stay pending (Chromium).
        compilations.set(m, m.getCompilationInfo?.().catch(() => undefined) ?? Promise.resolve(undefined));
      }
      return m;
    };
    device.pushErrorScope?.('validation');
    const { entry: fragmentEntry, targets, depthStencil } = this.target(kind, c, compare),
      velocity = kind === 'velocity',
      vertex = module(velocity ? 'velocity' : 'vertex'),
      fragment =
        kind === 'pick' ? module('pick') : velocity || this.fragmentCode === undefined ? vertex : module('fragment'),
      scope = device.popErrorScope?.(),
      descriptor: GPURenderPipelineDescriptor = {
        label: 'shader:raw:' + this.name,
        layout: velocity
          ? (gpu.velocityLayout ??= device.createPipelineLayout({
              bindGroupLayouts: [frameLayout(device, true), ...gpu.groupLayouts],
            }))
          : gpu.pipelineLayout,
        vertex: {
          module: vertex,
          entryPoint: velocity ? this.velocityName! : this.vertexName,
          buffers: mesh.buffers(),
        },
        ...(fragmentEntry ? { fragment: { module: fragment, entryPoint: fragmentEntry, targets } } : {}),
        primitive: {
          topology: mesh.topology,
          // A light sees either side, as in the depth pipeline of `Shadows`; TAA's velocity draws both, as its own do.
          cullMode: kind === 'shadow' || velocity ? 'none' : this.cull,
          ...(strip ? { stripIndexFormat: strip } : {}),
        },
        depthStencil,
        multisample: { count: samples },
      };
    const entry = e;
    if (typeof device.createRenderPipelineAsync !== 'function') {
      entry.pipeline = device.createRenderPipeline(descriptor);
      entry.state = 'ready';
      this.compiled++;
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
          const info = await compilations.get(m),
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
        this.compiled++;
      })
      .catch(fail);
    plugin.track(job);
    return undefined;
  }
}

/** Each shader module's compilation info, requested when the module is created. */
const compilations = new WeakMap<GPUShaderModule, Promise<GPUCompilationInfo | undefined>>();

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
/**
 * A mesh's GPU buffer. Meshes whose packed bytes are equal hold one, counted per device, so draws in a row skip
 * rebinding it. `words` is a copy of those bytes, kept while others may join; a mesh leaves on its first write.
 */
interface HeldBuffer {
  buffer: GPUBuffer;
  users: number;
  usage: number;
  label: string;
  key?: string;
  words?: Uint32Array;
  /** Set by {@link ownBuffer} on a new copy: it already holds the mesh's current bytes. */
  fresh?: boolean;
}
const heldBuffers = new WeakMap<GPUDevice, Map<string, HeldBuffer[]>>();
function newBuffer(device: GPUDevice, usage: number, label: string, words: Uint32Array): GPUBuffer {
  const buffer = device.createBuffer({ label, size: words.byteLength, usage });
  device.queue.writeBuffer(buffer, 0, words as Uint32Array<ArrayBuffer>);
  return buffer;
}
/** A buffer holding `words`: the one already on the device with these bytes, or a new one others can join. */
function holdBuffer(device: GPUDevice, usage: number, label: string, words: Uint32Array): HeldBuffer {
  let pool = heldBuffers.get(device);
  if (!pool) heldBuffers.set(device, (pool = new Map()));
  // FNV-1a over the words picks the candidates; equality is always decided on the bytes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], 0x01000193);
  const key = `${usage}:${words.length}:${hash}`;
  let list = pool.get(key);
  if (!list) pool.set(key, (list = []));
  for (const held of list) {
    const other = held.words!;
    let i = 0;
    while (i < words.length && other[i] === words[i]) i++;
    if (i === words.length) {
      held.users++;
      return held;
    }
  }
  const held = { buffer: newBuffer(device, usage, label, words), users: 1, usage, label, key, words: words.slice() };
  list.push(held);
  return held;
}
/** Takes `held` out of the pool, so nobody joins it. */
function unlist(device: GPUDevice, held: HeldBuffer): void {
  if (held.key === undefined) return;
  const pool = heldBuffers.get(device)!,
    list = pool.get(held.key)!;
  list.splice(list.indexOf(held), 1);
  if (!list.length) pool.delete(held.key);
  held.key = held.words = undefined;
}
function dropBuffer(device: GPUDevice, held: HeldBuffer | undefined): void {
  if (!held || --held.users) return;
  unlist(device, held);
  held.buffer.destroy();
}
/** Copy on write: a buffer only this mesh holds. A new copy is made from `words`, and says so with `fresh`. */
function ownBuffer(device: GPUDevice, held: HeldBuffer, words: Uint32Array): HeldBuffer {
  if (held.users === 1) {
    unlist(device, held);
    held.fresh = false;
    return held;
  }
  held.users--;
  const { usage, label } = held;
  return { buffer: newBuffer(device, usage, label, words), users: 1, usage, label, fresh: true };
}
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
  upload(device: GPUDevice, held: HeldBuffer | undefined): HeldBuffer | undefined {
    if (!this.attributes.length) {
      dropBuffer(device, held);
      return undefined;
    }
    const size = Math.max(4, this.capacity * this.stride);
    if (!held || this.full || held.buffer.size < size) {
      dropBuffer(device, held);
      held = holdBuffer(device, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'shader:raw:' + this.step, this.words);
    } else if (this.end > this.start) {
      held = ownBuffer(device, held, this.words);
      if (!held.fresh)
        device.queue.writeBuffer(
          held.buffer,
          this.start * this.stride,
          this.words.buffer as ArrayBuffer,
          this.start * this.stride,
          (this.end - this.start) * this.stride,
        );
    }
    this.full = false;
    this.start = Infinity;
    this.end = 0;
    return held;
  }
}
interface MeshGpu {
  device: GPUDevice;
  object: GPUBuffer;
  written?: Float32Array;
  vertex?: HeldBuffer;
  instance?: HeldBuffer;
  index?: HeldBuffer;
  /** The group of the latest upload, and one per camera block: colour, each shadow cascade, pick. */
  group?: GPUBindGroup;
  groups: Map<GPUBuffer, GPUBindGroup>;
}
/** What one render pass has bound, so draws in a row that share a buffer do not bind it again. */
interface BoundBuffers {
  slots: (GPUBuffer | undefined)[];
  index?: GPUBuffer;
  format?: GPUIndexFormat;
}
/** A sphere around a {@link RawMesh} in its own space, moved by its world matrix. */
export interface RawBounds {
  center: readonly [number, number, number];
  radius: number;
}
/** What `Shadows` hands a {@link RawMesh} for one cascade. */
export interface RawShadowContext {
  context: RawPassContext;
  /** The cascade's open depth pass. */
  pass: GPURenderPassEncoder;
  /** The cascade's light view-projection matrix. */
  matrix: Float32Array;
  /** Cascade index, 0-3. */
  cascade: number;
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
  /** Skip the mesh when its bounds are out of view. Default true. */
  frustumCulled?: boolean;
  /**
   * The sphere to cull with. Default: the sphere around a per-vertex vec3f `position`. A mesh with neither, or an instanced one
   * with no `bounds`, is never culled. Give `bounds` (or `frustumCulled: false`) when the vertex shader moves points outside.
   */
  bounds?: RawBounds | null;
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/**
 * Geometry for a {@link RawShaderMaterial}: any named attributes (per vertex or per instance), an optional index buffer and
 * an instance count. Add it to a {@link RawShaders} plugin to draw it.
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
  frustumCulled: boolean;
  /** The sphere to cull with; null uses the one around `position`. */
  bounds: RawBounds | null;
  /** First index (or vertex) and count to draw; count is clamped to what exists. */
  readonly drawRange = { start: 0, count: Infinity };
  /** @internal */ owner?: RawShaders;
  /** @internal */ gpu?: MeshGpu;
  private readonly streams = { vertex: new Stream('vertex'), instance: new Stream('instance') };
  private readonly map = new Map<string, Attribute>();
  private indices: Uint16Array | Uint32Array | null = null;
  private indexDirty = true;
  private key = '';
  /** True after `dispose`: `Shadows` drops the mesh. */
  disposed = false;
  private changes = 0;
  private sphere: readonly number[] | null | undefined;
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
    this.frustumCulled = options.frustumCulled ?? true;
    this.bounds = options.bounds ?? null;
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
    this.changed();
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
      this.changed();
    }
    return this;
  }
  /**
   * Replaces the index buffer (Uint16Array, Uint32Array or numbers, which become Uint32Array), or removes it with null.
   * @throws RangeError for a negative or non-integer index.
   */
  setIndex(index: Uint16Array | Uint32Array | readonly number[] | null): this {
    this.alive();
    this.changes++;
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
  /** Bumped when a static shadow map must draw this mesh again; `invalidateShadow` bumps it for a moved mesh. */
  get shadowVersion(): number {
    return this.changes + this.material.compiled;
  }
  /** Redraws a mesh added with `shadows.add(mesh, {static: true})` after its matrix or material changed. */
  invalidateShadow(): void {
    this.changes++;
  }
  /** Draws the mesh into a cascade of `@margoengine/shadows`; pass the mesh to `shadows.add`. */
  drawShadow(context: RawShadowContext): void {
    this.owner?.shadow(this, context);
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
  private changed(): void {
    this.changes++;
    this.sphere = undefined;
  }
  /** The sphere around `position` as [x, y, z, radius], when its points are where the mesh draws. */
  private ownBounds(): readonly number[] | null {
    const a = this.map.get('position');
    if (!a || a.type !== 'vec3f' || a.step !== 'vertex' || !a.count) return null;
    if (this.streams.instance.attributes.length || (this.instanceCount ?? 1) > 1) return null;
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity],
      d = a.data;
    for (let i = 0; i < d.length; i += 3)
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], d[i + k]);
        high[k] = Math.max(high[k], d[i + k]);
      }
    const c = low.map((v, k) => (v + high[k]) / 2);
    let r = 0;
    for (let i = 0; i < d.length; i += 3) r = Math.max(r, Math.hypot(d[i] - c[0], d[i + 1] - c[1], d[i + 2] - c[2]));
    return [c[0], c[1], c[2], r];
  }
  /**
   * @internal True when the mesh's sphere lies wholly outside view-projection `m`. The six planes are sums of the matrix's rows
   * (Gribb and Hartmann 2001). Each is compared unnormalised, as reversed-Z with an infinite far plane has one of zero length.
   */
  culled(world: ArrayLike<number>, m: ArrayLike<number>): boolean {
    if (!this.frustumCulled) return false;
    const b = this.bounds;
    if (!b && this.sphere === undefined) this.sphere = this.ownBounds();
    const s = b ? [...b.center, b.radius] : this.sphere;
    if (!s) return false;
    const x = world[0] * s[0] + world[4] * s[1] + world[8] * s[2] + world[12],
      y = world[1] * s[0] + world[5] * s[1] + world[9] * s[2] + world[13],
      z = world[2] * s[0] + world[6] * s[1] + world[10] * s[2] + world[14],
      r =
        s[3] *
        Math.max(
          Math.hypot(world[0], world[1], world[2]),
          Math.hypot(world[4], world[5], world[6]),
          Math.hypot(world[8], world[9], world[10]),
        );
    for (let i = 0; i < 6; i++) {
      const row = i >> 1,
        sign = i % 2 === 0 ? 1 : -1,
        depth = i === 4,
        a = depth ? m[2] : m[3] + sign * m[row],
        e = depth ? m[6] : m[7] + sign * m[4 + row],
        f = depth ? m[10] : m[11] + sign * m[8 + row],
        g = depth ? m[14] : m[15] + sign * m[12 + row];
      if (a * x + e * y + f * z + g < -r * Math.hypot(a, e, f)) return true;
    }
    return false;
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
      throw new RangeError(
        'RawMesh supports at most 16 attributes (the WebGPU vertex attribute limit); remove an attribute or pack them together.',
      );
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
    this.sphere = undefined;
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
    g.object.destroy();
    for (const held of [g.vertex, g.instance, g.index]) dropBuffer(g.device, held);
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
          size: OBJECT_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        groups: new Map(),
      };
    // The object block (world matrix, then its normal matrix) is rewritten only when the world matrix changed: the
    // normal matrix follows from it, so equal world words mean equal blocks.
    const written = g.written;
    let same = !!written;
    for (let i = 0; same && i < 16; i++) same = Object.is(written![i], world[i]);
    if (!same) {
      const o = this.object;
      o.set(world);
      // Normal matrix: inverse transpose of the upper 3x3, the cofactor columns over the determinant.
      const a0 = world[0],
        a1 = world[1],
        a2 = world[2],
        b0 = world[4],
        b1 = world[5],
        b2 = world[6],
        c0 = world[8],
        c1 = world[9],
        c2 = world[10],
        x0 = b1 * c2 - b2 * c1,
        x1 = b2 * c0 - b0 * c2,
        x2 = b0 * c1 - b1 * c0,
        det = a0 * x0 + a1 * x1 + a2 * x2,
        inv = det ? 1 / det : 0;
      o[16] = x0 * inv;
      o[17] = x1 * inv;
      o[18] = x2 * inv;
      o[20] = (c1 * a2 - c2 * a1) * inv;
      o[21] = (c2 * a0 - c0 * a2) * inv;
      o[22] = (c0 * a1 - c1 * a0) * inv;
      o[24] = (a1 * b2 - a2 * b1) * inv;
      o[25] = (a2 * b0 - a0 * b2) * inv;
      o[26] = (a0 * b1 - a1 * b0) * inv;
      if (!written || written.some((v, i) => !Object.is(v, o[i]))) {
        device.queue.writeBuffer(g.object, 0, o as Float32Array<ArrayBuffer>);
        (g.written ??= new Float32Array(28)).set(o);
      }
    }
    g.group = g.groups.get(camera);
    if (!g.group) {
      g.group = device.createBindGroup({
        layout: frameLayout(device),
        entries: [
          { binding: 0, resource: { buffer: camera } },
          { binding: 1, resource: { buffer: g.object } },
        ],
      });
      g.groups.set(camera, g.group);
    }
    g.vertex = this.streams.vertex.upload(device, g.vertex);
    g.instance = this.streams.instance.upload(device, g.instance);
    const index = this.indices;
    if (!index) {
      dropBuffer(device, g.index);
      g.index = undefined;
    } else if (this.indexDirty || !g.index) {
      const bytes = Math.ceil(index.byteLength / 4) * 4 || 4,
        padded = new Uint8Array(bytes);
      padded.set(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
      const words = new Uint32Array(padded.buffer);
      if (g.index?.users === 1 && g.index.buffer.size >= bytes) {
        g.index = ownBuffer(device, g.index, words);
        device.queue.writeBuffer(g.index.buffer, 0, padded);
      } else {
        dropBuffer(device, g.index);
        g.index = holdBuffer(device, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, 'shader:raw:index', words);
      }
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
  draw(pass: GPURenderPassEncoder, first: number, count: number, instances: number, bound: BoundBuffers): void {
    const g = this.gpu!,
      vertex = g.vertex?.buffer,
      instance = g.instance?.buffer,
      index = g.index?.buffer;
    let slot = 0;
    if (vertex) {
      if (bound.slots[0] !== vertex) pass.setVertexBuffer(0, (bound.slots[0] = vertex));
      slot = 1;
    }
    if (instance && bound.slots[slot] !== instance) pass.setVertexBuffer(slot, (bound.slots[slot] = instance));
    if (index) {
      const format = this.indexFormat!;
      if (bound.index !== index || bound.format !== format)
        pass.setIndexBuffer((bound.index = index), (bound.format = format));
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

/** One mesh's draw in a pass. */
/** One TAA view's velocity state: last frame's time, and per mesh its block of last frame's values. */
interface VelocityState {
  camera: GPUBuffer;
  frame: number;
  time?: number;
  meshes: Map<
    RawMesh,
    { before: GPUBuffer; group: GPUBindGroup; object: GPUBuffer; world: Float32Array; frame: number }
  >;
}
interface Draw {
  mesh: RawMesh;
  pipeline: GPURenderPipeline;
  gpu: MaterialGpu;
  call: number[];
  distance: number;
}
/** Binds and draws `draws` in order, leaving out what the draw before them already bound. */
function drawList(pass: GPURenderPassEncoder, draws: readonly Draw[]): void {
  let current: GPURenderPipeline | undefined, materialGroup: GPUBindGroup | undefined;
  const bound: BoundBuffers = { slots: [] };
  for (const d of draws) {
    const group = d.gpu.group;
    if (d.pipeline !== current) pass.setPipeline((current = d.pipeline));
    pass.setBindGroup(0, d.mesh.gpu!.group!);
    // A bound group stays bound across draws and pipelines of one pass, so meshes of one material bind it once.
    if (group && group !== materialGroup) {
      pass.setBindGroup(1, (materialGroup = group));
      d.gpu.extras.forEach((extra, i) => pass.setBindGroup(2 + i, extra));
    }
    d.mesh.draw(pass, d.call[0], d.call[1], d.call[2], bound);
  }
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
 * `ssao.add(raw)` draws the meshes whose material has `gbufferEntry` into SSAO's G-buffer.
 */
export class RawShaders implements EnginePlugin {
  readonly name: string;
  readonly opaqueOrder: number;
  readonly transparentOrder: number;
  /** Counters of the latest frame; `culled` is meshes out of view, `pending` is pipelines still compiling. */
  readonly stats = { meshes: 0, drawCalls: 0, culled: 0, pending: 0 };
  /** @internal {@link RawPicking}s told when a mesh comes or goes. */ readonly watchers = new Set<RawPicking>();
  private readonly meshes = new Set<RawMesh>();
  private readonly jobs = new Set<Promise<void>>();
  private engine?: Engine;
  private device?: GPUDevice;
  private camera?: GPUBuffer;
  private readonly shadowCameras: GPUBuffer[] = [];
  private shadowEncoder?: GPUCommandEncoder;
  private shadowPass = 0;
  private readonly shadowWritten: (GPUCommandEncoder | undefined)[] = [];
  private passes = 0;
  private readonly cameraData = new Float32Array(56);
  private readonly view = new Float64Array(16);
  private readonly inverse = new Float64Array(16);
  /** TAA velocity state per TAA view: its camera block, last frame's time and each mesh's last world matrix. */
  private readonly velocityStates = new Map<object, VelocityState>();
  private readonly beforeData = new Float32Array(36);
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
    for (const watcher of this.watchers) watcher.added(mesh);
    return mesh;
  }
  /** Stops drawing `mesh` and releases its GPU buffers; true when it was here. */
  remove(mesh: RawMesh): boolean {
    if (!this.meshes.delete(mesh)) return false;
    for (const state of this.velocityStates.values()) {
      state.meshes.get(mesh)?.before.destroy();
      state.meshes.delete(mesh);
    }
    mesh.release();
    mesh.owner = undefined;
    for (const watcher of this.watchers) watcher.removed(mesh);
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
      throw new MargoError('unsupported', 'RawShaders requires WebGPU; see https://margoengine.com/errors#webgpu');
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
    for (const key of [...this.velocityStates.keys()]) this.releaseVelocity(key);
    for (const buffer of this.shadowCameras) buffer.destroy();
    this.shadowCameras.length = this.shadowWritten.length = 0;
    this.shadowEncoder = undefined;
  }
  private cameraBuffer(device: GPUDevice): GPUBuffer {
    return device.createBuffer({
      label: 'shader:raw:camera',
      size: 224,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  private writeCamera(c: RawPassContext): GPUBuffer {
    const device = c.device;
    this.camera ??= this.cameraBuffer(device);
    const encoding = c.format.includes('float') ? 0 : c.format.endsWith('-srgb') ? 2 : 1;
    device.queue.writeBuffer(
      this.camera,
      0,
      this.cameraBlock(c.camera, c.camera.matrix, c.width, c.height, c.delta, encoding),
    );
    return this.camera;
  }
  /** @internal The camera block of `camera` seen through view-projection `m`. */
  cameraBlock(
    camera: PassContext['camera'],
    m: ArrayLike<number>,
    width: number,
    height: number,
    delta: number,
    encoding: number,
  ): Float32Array<ArrayBuffer> {
    const f = this.cameraData,
      v = viewMatrix(this.view as unknown as Float32Array, camera),
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
    f[52] = width;
    f[53] = height;
    f[54] = delta;
    f[55] = encoding;
    return f;
  }
  /** @internal The next pass token: a material uploads its uniforms once per token. */
  nextPass(): number {
    return ++this.passes;
  }
  /** @internal Draws `mesh` into one shadow cascade. Shadow passes run before the colour pass, so it uploads for itself. */
  shadow(mesh: RawMesh, { context: c, pass, matrix, cascade }: RawShadowContext): void {
    const device = this.device,
      engine = this.engine as unknown as EngineKernel,
      material = mesh.material;
    if (!device || !engine || c.device !== device || !mesh.visible || material.transparent) return;
    const world = mesh.worldMatrix(engine);
    if (!world || mesh.culled(world, matrix)) return;
    // Cascades of one frame share an encoder: one uniform upload, and one camera write per cascade.
    if (this.shadowEncoder !== c.encoder) {
      this.shadowEncoder = c.encoder;
      this.shadowPass = this.nextPass();
    }
    const camera = (this.shadowCameras[cascade] ??= this.cameraBuffer(device));
    if (this.shadowWritten[cascade] !== c.encoder) {
      this.shadowWritten[cascade] = c.encoder;
      // The cascade's matrix takes both places, so `viewProjection` and `projection * view` each reach the light.
      const f = this.cameraBlock(c.camera, matrix, c.width, c.height, c.delta, 0);
      f.set(identity, 0);
      f.set(matrix, 16);
      device.queue.writeBuffer(camera, 0, f);
    }
    const call = mesh.upload(device, camera, world);
    if (!call) return;
    const gpu = material.prepare(device, this.shadowPass),
      pipeline = material.pipeline(this, gpu, device, mesh, 'shadow');
    if (pipeline) drawList(pass, [{ mesh, pipeline, gpu, call, distance: 0 }]);
  }
  /**
   * The `SSAOSource` contract of `@margoengine/post`: meshes whose material has `gbufferEntry` write their own normals and
   * ambient light into SSAO's open G-buffer pass, over the depth the colour pass left.
   */
  draw(
    context: PassContext,
    mode: 'gbuffer' | 'ambient' | 'occlusion',
    _color: GPUTextureView,
    _depth: GPUTextureView,
    _phase?: 'all' | 'opaque' | 'blend',
    external?: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction },
  ): void {
    const c = context,
      device = this.device,
      engine = this.engine as unknown as EngineKernel;
    if (mode !== 'occlusion' || !external || c.backend !== 'webgpu' || !device || !engine || c.device !== device)
      return;
    const token = this.nextPass(),
      draws: Draw[] = [];
    let camera: GPUBuffer | undefined;
    for (const mesh of this.meshes) {
      const material = mesh.material;
      if (!mesh.visible || material.transparent || !material.writesGBuffer) continue;
      const world = mesh.worldMatrix(engine);
      if (!world || mesh.culled(world, c.camera.matrix)) continue;
      camera ??= this.writeCamera(c);
      const call = mesh.upload(device, camera, world);
      if (!call) continue;
      const gpu = material.prepare(device, token),
        pipeline = material.pipeline(this, gpu, device, mesh, 'gbuffer', c, external.depthCompare);
      if (pipeline) draws.push({ mesh, pipeline, gpu, call, distance: 0 });
    }
    drawList(external.pass, draws);
  }
  /**
   * The `TAAVelocityPass` contract of `@margoengine/taa` (`taa.add(raw)`): opaque meshes whose material has
   * `velocityEntry` draw their own motion into TAA's object velocity pass, with last frame's view-projection, world
   * matrix and time in `margoBefore`, kept per TAA view.
   */
  drawVelocity(pass: GPURenderPassEncoder, frame: { context: PassContext; camera: Float32Array; key: object }): void {
    const c = frame.context,
      device = this.device,
      engine = this.engine as unknown as EngineKernel;
    // The colour pass drew first (frame-graph order 0.5 before TAA's 9) and made the camera block meshes bind there.
    if (c.backend !== 'webgpu' || !device || !engine || c.device !== device || !this.camera) return;
    let state = this.velocityStates.get(frame.key);
    if (!state)
      this.velocityStates.set(frame.key, (state = { camera: this.cameraBuffer(device), frame: 0, meshes: new Map() }));
    state.frame++;
    const rows = frame.camera,
      now = rows.subarray(0, 16),
      token = this.nextPass(),
      draws: { mesh: RawMesh; pipeline: GPURenderPipeline; gpu: MaterialGpu; call: number[]; group: GPUBindGroup }[] =
        [];
    let time: number | undefined;
    for (const mesh of this.meshes) {
      const material = mesh.material;
      if (!mesh.visible || material.transparent || !material.velocityName) continue;
      const world = mesh.worldMatrix(engine);
      if (!world || mesh.culled(world, now)) continue;
      if (time === undefined) {
        const block = this.cameraBlock(c.camera, now, c.width, c.height, c.delta, 0);
        time = block[51];
        device.queue.writeBuffer(state.camera, 0, block);
      }
      const call = mesh.upload(device, this.camera, world);
      const object = mesh.gpu?.object;
      if (!call || !object) continue;
      let m = state.meshes.get(mesh);
      if (!m || m.object !== object) {
        m?.before.destroy();
        const before = device.createBuffer({
          label: 'shader:raw:before',
          size: 144,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        m = {
          before,
          object,
          world: new Float32Array(16),
          frame: -1,
          group: device.createBindGroup({
            layout: frameLayout(device, true),
            entries: [state.camera, object, before].map((buffer, binding) => ({ binding, resource: { buffer } })),
          }),
        };
        state.meshes.set(mesh, m);
      }
      // Last frame's values when this mesh was drawn then and TAA has history; else this frame's, and no motion.
      const valid = m.frame === state.frame - 1 && rows[34] > 0 && state.time !== undefined,
        d = this.beforeData;
      d.set(rows.subarray(16, 32), 0);
      d.set(valid ? m.world : world, 16);
      d[32] = valid ? state.time! : time!;
      d[33] = +valid;
      device.queue.writeBuffer(m.before, 0, d);
      m.world.set(world);
      m.frame = state.frame;
      const gpu = material.prepare(device, token),
        pipeline = material.pipeline(this, gpu, device, mesh, 'velocity', c);
      if (pipeline) draws.push({ mesh, pipeline, gpu, call, group: m.group });
    }
    if (time !== undefined) state.time = time;
    const bound: BoundBuffers = { slots: [] };
    for (const d of draws) {
      pass.setPipeline(d.pipeline);
      pass.setBindGroup(0, d.group);
      if (d.gpu.group) {
        pass.setBindGroup(1, d.gpu.group);
        d.gpu.extras.forEach((extra, i) => pass.setBindGroup(2 + i, extra));
      }
      d.mesh.draw(pass, d.call[0], d.call[1], d.call[2], bound);
    }
  }
  /** Forgets a TAA view's velocity state (`TAAVelocityPass`): TAA calls it when the view's history goes. */
  releaseVelocity(key: object): void {
    const state = this.velocityStates.get(key);
    if (!state) return;
    state.camera.destroy();
    for (const m of state.meshes.values()) m.before.destroy();
    this.velocityStates.delete(key);
  }
  private execute(c: PassContext, transparent: boolean): void {
    if (!transparent) this.stats.meshes = this.stats.drawCalls = this.stats.culled = 0;
    if (c.backend !== 'webgpu' || !this.device || !this.engine || c.device !== this.device || !this.meshes.size) return;
    const device = this.device,
      engine = this.engine as unknown as EngineKernel,
      eye = c.camera.position,
      draws: Draw[] = [];
    const token = this.nextPass();
    let camera: GPUBuffer | undefined;
    for (const mesh of this.meshes) {
      const material = mesh.material;
      if (!mesh.visible || material.transparent !== transparent) continue;
      const world = mesh.worldMatrix(engine);
      if (!world) continue;
      if (mesh.culled(world, c.camera.matrix)) {
        this.stats.culled++;
        continue;
      }
      camera ??= this.writeCamera(c);
      const call = mesh.upload(device, camera, world);
      if (!call) continue;
      const gpu = material.prepare(device, token),
        pipeline = material.pipeline(this, gpu, device, mesh, 'color', c);
      // A pick's pipeline starts compiling with the colour one, so the first pick after `ready()` finds it.
      if (this.watchers.size) material.pipeline(this, gpu, device, mesh, 'pick');
      if (!pipeline) continue;
      const dx = world[12] - eye[0],
        dy = world[13] - eye[1],
        dz = world[14] - eye[2];
      draws.push({ mesh, pipeline, gpu, call, distance: dx * dx + dy * dy + dz * dz });
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
    drawList(pass, draws);
    this.stats.meshes += draws.length;
    this.stats.drawCalls += draws.length;
    pass.end();
  }
}

/** What `Picking` hands an overlay for one pick. */
export interface RawPickContext {
  encoder: GPUCommandEncoder;
  /** The r32uint pick tile, 3 x 3 pixels around the picked pixel. */
  color: GPUTextureView;
  /** Its depth32float depth, holding the meshes already drawn. */
  depth: GPUTextureView;
  /** The camera's view-projection matrix, cropped to the tile. */
  matrix: Float32Array;
  camera: PassContext['camera'];
  /** The picked view's rectangle in drawing-buffer pixels. */
  rect: readonly number[];
  /** The ID of this overlay's item 0. */
  firstId: number;
}
/** What `RawPicking.attach` needs of `@margoengine/selection`'s Picking. */
export interface RawPickHost {
  addOverlay(overlay: {
    drawPick(context: RawPickContext): void;
    pickHit(index: number): { mesh: Mesh } | null;
  }): () => void;
}
/**
 * Makes the meshes of a {@link RawShaders} pickable by `@margoengine/selection`'s `Picking`, and so by `engine.pick` once
 * Picking is attached. They share the depth test of the scene's meshes, each with its own vertex shader, so what a shader
 * moves is picked where it shows. One ID covers a mesh: a hit names no instance, and a fragment's `discard` does not cut it.
 * `hit.mesh` is the mesh it follows or else an empty stand-in mesh, as `engine.pick` can only answer meshes (`rawOf` maps it
 * back).
 */
export class RawPicking {
  private hits: RawMesh[] = [];
  private camera?: GPUBuffer;
  private device?: GPUDevice;
  private readonly id = new Uint32Array(1);
  private readonly standIns = new Map<RawMesh, Mesh>();
  private readonly owners = new Map<Mesh, RawMesh>();
  private remove?: () => void;
  /**
   * Registers `raw` with `picking`; undo with `dispose`.
   * @throws MargoError `state` when `raw` is not attached to an engine yet.
   */
  static attach(picking: RawPickHost, raw: RawShaders): RawPicking {
    if (!raw['engine']) throw new MargoError('state', 'Attach RawShaders to the engine before RawPicking.attach');
    const value = new RawPicking(raw);
    value.remove = picking.addOverlay(value);
    raw.watchers.add(value);
    for (const mesh of raw['meshes']) value.added(mesh);
    return value;
  }
  private constructor(readonly raw: RawShaders) {}
  /** The RawMesh behind `mesh`, a `hit.mesh` or an `engine.pick` answer; null for any other mesh. */
  rawOf(mesh: Mesh | null): RawMesh | null {
    if (!mesh) return null;
    return this.owners.get(mesh) ?? [...this.raw['meshes']].find((m) => m.mesh === mesh) ?? null;
  }
  /** @internal A mesh joined: its stand-in is made now, because adding a mesh during a pick would void that pick's answer. */
  added(mesh: RawMesh): void {
    if (this.standIns.has(mesh)) return;
    const standIn = (this.raw['engine'] as unknown as EngineKernel).createMesh();
    this.standIns.set(mesh, standIn);
    this.owners.set(standIn, mesh);
  }
  /** @internal A mesh left: its stand-in goes with it. */
  removed(mesh: RawMesh): void {
    const standIn = this.standIns.get(mesh);
    if (!standIn) return;
    this.standIns.delete(mesh);
    this.owners.delete(standIn);
    standIn.dispose();
  }
  /** @internal Picking's turn: draws every visible mesh into the tile, with IDs from `firstId`. */
  drawPick(c: RawPickContext): void {
    const raw = this.raw,
      device = raw['device'],
      engine = raw['engine'] as unknown as EngineKernel;
    this.hits = [];
    if (!device || !engine) return;
    if (this.device !== device) {
      this.camera?.destroy();
      this.device = device;
      this.camera = raw['cameraBuffer'](device);
    }
    const camera = this.camera!,
      token = raw.nextPass(),
      draws: Draw[] = [];
    // A 3 x 3 target under the cropped matrix, as `resolution` says.
    device.queue.writeBuffer(camera, 0, raw.cameraBlock(c.camera, c.matrix, 3, 3, 0, 0));
    for (const mesh of raw['meshes']) {
      const material = mesh.material;
      if (!mesh.visible || material.error) continue;
      const world = mesh.worldMatrix(engine);
      if (!world || mesh.culled(world, c.matrix)) continue;
      const call = mesh.upload(device, camera, world);
      if (!call) continue;
      const gpu = material.prepare(device, token),
        pipeline = material.pipeline(raw, gpu, device, mesh, 'pick');
      if (!pipeline) continue;
      this.id[0] = c.firstId + this.hits.length;
      device.queue.writeBuffer(mesh.gpu!.object, PICK_ID, this.id);
      this.hits.push(mesh);
      draws.push({ mesh, pipeline, gpu, call, distance: 0 });
    }
    if (!draws.length) return;
    const pass = beginPickPass(c, draws[0].mesh.gpu!.group!);
    drawList(pass, draws);
    pass.end();
  }
  /** @internal The hit of ID `index` of the last `drawPick`. */
  pickHit(index: number): { mesh: Mesh } | null {
    const hit = this.hits[index];
    if (!hit) return null;
    const mesh = hit.mesh ?? this.standIns.get(hit);
    return mesh ? { mesh } : null;
  }
  /** Leaves Picking and frees the stand-in meshes and the GPU buffer. */
  dispose(): void {
    this.remove?.();
    this.remove = undefined;
    this.raw.watchers.delete(this);
    for (const mesh of this.standIns.values()) mesh.dispose();
    this.standIns.clear();
    this.owners.clear();
    this.hits = [];
    this.camera?.destroy();
    this.camera = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
