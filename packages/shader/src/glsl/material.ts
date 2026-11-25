// The program core of whole GLSL programs as materials: GLSLMaterial is a RawShaderMaterial whose two stages are GLSL
// ES 1.00 or 3.00 with `void main()`, translated once per source and defines by the GLSL front end that shader/glsl
// and transitions/glsl share. ShaderMaterial (shader/glsl-material) is this core plus the scene options (lights, fog
// and velocity); ShaderPass and Shadertoy draw with the core alone, so they carry none of the scene code. Written clean
// room from the GLSL ES 1.00 and 3.00 specifications, the WebGL and WebGPU specifications and the public documentation
// of other web engines' shader materials (docs/clean-room.md).
import {
  RawMesh,
  RawShaderMaterial,
  type RawAttribute,
  type RawMeshOptions,
  type RawShaderMaterialOptions,
  type RawTexture,
  type RawTextureInput,
  type RawUniform,
} from '../raw.js';
import { isOptionObject } from '../../../shared/borrowed.js';
import {
  linkGLSLProgram,
  type GLSLLinked,
  type GLSLSceneLinker,
  type GLSLProgramSource,
  type GLSLProgramUniform,
  type GLSLProgramWGSL,
} from './program.js';

/**
 * A uniform's value: a number or boolean, the numbers of a vector or column-major matrix (an array, a typed array or
 * an `{x, y, z, w}` object), a `'#rrggbb'` colour for a vec3, or for a sampler a `Texture` of `@margoengine/materials`,
 * a GPUTexture or a GPUTextureView (null reads opaque white; zero for an integer sampler), `(device) => GPUTexture | GPUTextureView`
 * (made once per device, so it is back after a device restore; a plain texture is lost with its device, reads white and is
 * reported once through `engine.onError`, #borrowed-lost), or `{texture, sampler}` to
 * give a GPUTexture its sampler (a shadow sampler's `compare` defaults to `'less-equal'`, GL's LEQUAL). A struct or
 * block takes an object of its fields; an array a list of its elements (numbers of scalar and vector elements may also
 * run on in one flat list); a sampler array a list of textures.
 */
export type ShaderUniformValue =
  | number
  | boolean
  | string
  | ArrayLike<number | boolean>
  | { readonly x: number; readonly y: number; readonly z?: number; readonly w?: number }
  | RawTextureInput
  | { readonly texture: RawTextureInput | null; readonly sampler?: GPUSamplerDescriptor }
  | readonly ShaderUniformValue[]
  | { readonly [field: string]: ShaderUniformValue }
  | null;
/** A live uniform in the `{value}` form web engines use: assign `value` any time. */
export interface ShaderUniform {
  value: ShaderUniformValue;
}
/** Which faces draw, by GL's counter-clockwise front: `'front'`, `'back'` or `'double'`. */
export type ShaderSide = 'front' | 'back' | 'double';
/** A depth comparison in GL's sense (nearer is less), mapped onto Margo's reversed Z. */
export type ShaderDepthFunc = GPUCompareFunction;
/** Options for `new ShaderMaterial(options)`. Render state fields stay live on the material, as on RawShaderMaterial. */
export interface ShaderMaterialOptions
  extends Omit<GLSLProgramSource, 'uniformNames'>,
    Omit<
      RawShaderMaterialOptions,
      | 'vertexShader'
      | 'fragmentShader'
      | 'vertexEntry'
      | 'fragmentEntry'
      | 'uniforms'
      | 'textures'
      | 'storage'
      | 'groups'
      | 'gbufferEntry'
      | 'velocityEntry'
      | 'blending'
      | 'depthCompare'
    > {
  /**
   * Live values by GLSL name; the types come from the GLSL. A uniform the program declares and this omits starts at
   * zero, unless it is a built-in of `builtins`: the engine fills those, and a name given here is yours instead.
   */
  uniforms?: Record<string, ShaderUniform>;
  /** Faces to draw. Default `'front'`. Give this or `cull`, not both. */
  side?: ShaderSide;
  /**
   * A preset (`'none'`, `'normal'`, `'additive'`, `'subtractive'`, `'multiply'`, `'premultiplied'`), a GPUBlendState,
   * or `'custom'`, built from `blendSrc`, `blendDst`, `blendEquation` and their alpha forms. Default `'normal'`.
   */
  blending?: RawShaderMaterialOptions['blending'] | 'custom';
  /** Source factor of `'custom'` blending. Default `'src-alpha'`. */
  blendSrc?: GPUBlendFactor;
  /** Destination factor of `'custom'` blending. Default `'one-minus-src-alpha'`. */
  blendDst?: GPUBlendFactor;
  /** Operation of `'custom'` blending. Default `'add'`. */
  blendEquation?: GPUBlendOperation;
  /** Alpha source factor of `'custom'` blending. Default `blendSrc`. */
  blendSrcAlpha?: GPUBlendFactor;
  /** Alpha destination factor of `'custom'` blending. Default `blendDst`. */
  blendDstAlpha?: GPUBlendFactor;
  /** Alpha operation of `'custom'` blending. Default `blendEquation`. */
  blendEquationAlpha?: GPUBlendOperation;
  /** The depth test in GL's sense (`'less'` passes nearer fragments). Default `'less-equal'`. */
  depthFunc?: ShaderDepthFunc;
  /** Offset depth by `polygonOffsetFactor` times the slope plus `polygonOffsetUnits` steps, as GL's polygon offset. Default false. */
  polygonOffset?: boolean;
  /** Default 0; positive moves away from the camera, as in GL. */
  polygonOffsetFactor?: number;
  /** Default 0; positive moves away from the camera, as in GL. */
  polygonOffsetUnits?: number;
}
// GL's comparisons on near-is-less depth, as Margo's reversed-Z (near-is-greater) ones.
const flipped: Record<string, GPUCompareFunction> = {
  never: 'never',
  less: 'greater',
  equal: 'equal',
  'less-equal': 'greater-equal',
  greater: 'less',
  'not-equal': 'not-equal',
  'greater-equal': 'less-equal',
  always: 'always',
};
const depthFuncOf = (f: string): GPUCompareFunction => {
  const v = flipped[f];
  if (!v) throw new TypeError(`ShaderMaterial depthFunc must be one of ${Object.keys(flipped).join(', ')}`);
  return v;
};

const zero = (glsl: string): ShaderUniformValue => {
  const array = /^(.*)\[(\d+)\]$/.exec(glsl);
  if (array) return Array.from({ length: +array[2]! }, () => zero(array[1]!));
  const m = /^mat([234])(?:x([234]))?$/.exec(glsl);
  if (m) return new Array(+m[1]! * +(m[2] ?? m[1])!).fill(0);
  return /sampler/.test(glsl)
    ? null
    : glsl === 'bool'
      ? false
      : /^[ibu]?vec(\d)$/.test(glsl)
        ? new Array(Number(glsl.at(-1))).fill(0)
        : 0;
};
// The value of a leaf of a struct or array uniform: its root's value, then field names and [element, numbers per
// element] steps (a flat list of numbers holds its elements one after another).
function leaf(value: unknown, path: GLSLProgramUniform['path'] = []): ShaderUniformValue {
  let v = value as Record<string, unknown> & ArrayLike<unknown>;
  for (const step of path) {
    if (v === null || typeof v !== 'object') return null;
    if (typeof step === 'string') v = v[step] as typeof v;
    else {
      const [k, n] = step;
      v = (
        n && typeof v[0] !== 'object' ? (n === 1 ? v[k] : Array.prototype.slice.call(v, k * n, k * n + n)) : v[k]
      ) as typeof v;
    }
  }
  return (v ?? null) as ShaderUniformValue;
}
// A zero value for a struct or array root, shaped by its leaves' paths, so `uniforms.lights.value[0].color` exists.
function rootZero(leaves: readonly GLSLProgramUniform[]): ShaderUniformValue {
  const out: Record<string, unknown> = {};
  for (const u of leaves) {
    let at: Record<string | number, unknown> = out,
      key: string | number = 'v';
    for (const step of u.path ?? []) {
      at = (at[key] ??= typeof step === 'string' ? {} : []) as typeof at;
      key = typeof step === 'string' ? step : step[0];
    }
    at[key] = zero(u.glsl);
  }
  return out.v as ShaderUniformValue;
}
// The numbers a raw uniform stores for `value` of GLSL type `glsl` (booleans as 0 or 1, as GL converts them).
function stored(value: ShaderUniformValue, u: GLSLProgramUniform): number | string | number[] | number[][] {
  if (u.count) {
    // An array held as it is: its elements, or all their numbers in a row.
    const list =
      value === null || typeof value !== 'object' || !('length' in value)
        ? (zero(u.glsl) as ShaderUniformValue[])
        : (value as ArrayLike<ShaderUniformValue>);
    const element = { ...u, glsl: u.glsl.replace(/\[\d+\]$/, ''), count: undefined };
    return typeof list[0] === 'number'
      ? Array.from(list as ArrayLike<number>)
      : Array.from(list, (e) => [stored(e, element)].flat(2) as number[]);
  }
  const rect = /^mat([234])x([234])$/.exec(u.glsl);
  if (rect) {
    // A non-square matrix sits in the columns of a mat4x4f.
    const [c, r] = [+rect[1]!, +rect[2]!],
      v = stored(value, { ...u, glsl: 'vec4' }) as number[],
      out = new Array(16).fill(0);
    for (let i = 0; i < c; i++) for (let j = 0; j < r; j++) out[i * 4 + j] = v[i * r + j] ?? 0;
    return out;
  }
  const bool = /^b/.test(u.glsl);
  const one = (x: unknown, at: string): number => {
    if (typeof x === 'boolean') return +x;
    if (typeof x === 'number') return bool ? +(x !== 0) : x;
    throw new RangeError(
      `ShaderMaterial uniform ${u.name}${at} needs numbers or booleans for ${u.glsl}; assign a matching value`,
    );
  };
  if (value === null || value === undefined) return stored(zero(u.glsl), u);
  if (typeof value === 'number' || typeof value === 'boolean') return one(value, '');
  if (typeof value === 'string') return u.glsl === 'vec3' ? value : one(value, '');
  const v = value as Record<string, unknown> & ArrayLike<unknown>;
  const list =
    typeof v.length === 'number' ? Array.from(v) : 'x' in v ? [v.x, v.y, v.z, v.w].filter((x) => x !== undefined) : [];
  return list.map((x, i) => one(x, `[${i}]`));
}

/**
 * @internal What ShaderMaterial adds to the program core: the scene part of linking, and a {value} for each scene
 * uniform the program reads (read through `holder.material`, the material once made).
 */
export interface GLSLMaterialScene {
  readonly link: GLSLSceneLinker;
  /** Replaces the scene uniforms in `values` with the ones `linked` reads, unless the caller gave that name. */
  uniforms(linked: GLSLLinked, values: Record<string, ShaderUniform>, holder: { material?: GLSLMaterial }): void;
}

/**
 * A material from a whole GLSL program, as a web engine's `RawShaderMaterial` takes one: GLSL ES 1.00 or 3.00 vertex and
 * fragment stages with `void main()`, live `uniforms` by GLSL name, `defines` and the render state of
 * RawShaderMaterial. Draw it with a RawMesh in a RawShaders plugin; attributes match by name. The GLSL is translated
 * here, once per source and defines (syntax and link errors throw here, with `stage`, `line` and `column`), and
 * `material.code(stage, mesh)` shows the WGSL each stage becomes. Use ShaderMaterial of shader/glsl-material, which is this
 * with the scene options `lights`, `fog` and `velocity`; ShaderPass and Shadertoy draw with this core alone.
 */
export class GLSLMaterial extends RawShaderMaterial<ShaderUniform> {
  /** True on every ShaderMaterial, for code that tells materials apart without importing the class. */
  readonly isShaderMaterial = true;
  /** Live values by GLSL name: `material.uniforms.time.value = 1`. */
  declare readonly uniforms: Record<string, ShaderUniform>;
  private linked: GLSLLinked;
  private source: GLSLProgramSource;
  /** @param scene The scene options' code (ShaderMaterial passes it). */
  constructor(options: ShaderMaterialOptions, scene?: GLSLMaterialScene) {
    if (!options || typeof options !== 'object')
      throw new TypeError('ShaderMaterial needs {vertexShader, fragmentShader}');
    const {
      uniforms: given = {},
      builtins,
      defines,
      glslVersion,
      flipY,
      clipSpace,
      strict,
      attributes,
      defaultAttributeValues,
      includes,
      outputColorSpace,
      unfilterable,
      lights,
      fog,
      velocity,
      side,
      blending,
      blendSrc = 'src-alpha',
      blendDst = 'one-minus-src-alpha',
      blendEquation = 'add',
      blendSrcAlpha,
      blendDstAlpha,
      blendEquationAlpha,
      depthFunc,
      polygonOffset = false,
      polygonOffsetFactor = 0,
      polygonOffsetUnits = 0,
      vertexShader: _v,
      fragmentShader: _f,
      ...state
    } = options;
    if (!given || typeof given !== 'object')
      throw new TypeError('ShaderMaterial uniforms must be an object of {value}');
    if (side !== undefined && state.cull !== undefined)
      throw new TypeError('ShaderMaterial takes side or cull, not both; pass only one of them');
    const source: GLSLProgramSource = {
      vertexShader: options.vertexShader,
      fragmentShader: options.fragmentShader,
      defines: { ...defines },
      glslVersion,
      flipY,
      clipSpace,
      strict,
      builtins,
      uniformNames: Object.keys(given),
      attributes,
      defaultAttributeValues,
      includes,
      outputColorSpace,
      unfilterable,
      lights,
      fog,
      velocity,
    };
    const linked = linkGLSLProgram(source, scene?.link),
      values: Record<string, ShaderUniform> = {},
      holder: { material?: GLSLMaterial } = {};
    for (const [name, u] of Object.entries(given)) {
      if (!u || typeof u !== 'object' || !('value' in u))
        throw new TypeError(`ShaderMaterial uniform ${name} must be {value}`);
      values[name] = u;
    }
    scene?.uniforms(linked, values, holder);
    super({
      ...state,
      ...(blending === 'custom'
        ? {
            blending: {
              color: { srcFactor: blendSrc, dstFactor: blendDst, operation: blendEquation },
              alpha: {
                srcFactor: blendSrcAlpha ?? blendSrc,
                dstFactor: blendDstAlpha ?? blendDst,
                operation: blendEquationAlpha ?? blendEquation,
              },
            },
          }
        : blending !== undefined
          ? { blending }
          : {}),
      ...(depthFunc !== undefined ? { depthCompare: depthFuncOf(depthFunc) } : {}),
      ...GLSLMaterial.parts(linked, values),
      vertexEntry: 'margoGLSLVertex',
      fragmentEntry: 'margoGLSLFragment',
      ...(linked.velocity ? { velocityEntry: 'margoGLSLVelocity' } : {}),
    });
    holder.material = this;
    this.holder = holder;
    this.scene = scene;
    this.linked = linked;
    this.source = source;
    this.publish(values);
    if (side !== undefined) this.side = side;
    this.offset = [polygonOffset, polygonOffsetFactor, polygonOffsetUnits];
    this.applyOffset();
  }
  private offset: [boolean, number, number] = [false, 0, 0];
  // GL adds factor x slope + units x step to depth; with reversed Z that is a negative WebGPU depth bias.
  private applyOffset(): void {
    const [on, factor, units] = this.offset;
    if (!Number.isFinite(factor) || !Number.isFinite(units))
      throw new RangeError('ShaderMaterial polygonOffsetFactor and polygonOffsetUnits must be finite');
    this.depthBias = on ? -units : 0;
    this.depthBiasSlopeScale = on ? -factor : 0;
  }
  /** Faces drawn: `'front'` (cull back), `'back'` (cull front) or `'double'`. Live. */
  get side(): ShaderSide {
    return this.cull === 'none' ? 'double' : this.cull === 'front' ? 'back' : 'front';
  }
  set side(side: ShaderSide) {
    const cull = ({ front: 'back', back: 'front', double: 'none' } as const)[side];
    if (!cull) throw new TypeError("ShaderMaterial side must be 'front', 'back' or 'double'");
    this.cull = cull;
  }
  /** The depth test in GL's sense; reads and writes `depthCompare` (reversed Z). Live. */
  get depthFunc(): ShaderDepthFunc {
    return depthFuncOf(this.depthCompare);
  }
  set depthFunc(f: ShaderDepthFunc) {
    this.depthCompare = depthFuncOf(f);
  }
  /** GL's polygon offset; sets `depthBias` and `depthBiasSlopeScale`. Live. */
  get polygonOffset(): boolean {
    return this.offset[0];
  }
  set polygonOffset(on: boolean) {
    this.offset[0] = !!on;
    this.applyOffset();
  }
  get polygonOffsetFactor(): number {
    return this.offset[1];
  }
  set polygonOffsetFactor(v: number) {
    this.offset[1] = v;
    this.applyOffset();
  }
  get polygonOffsetUnits(): number {
    return this.offset[2];
  }
  set polygonOffsetUnits(v: number) {
    this.offset[2] = v;
    this.applyOffset();
  }
  /** The linked program's tables: uniforms, textures, attributes (with what each holds), varyings and the convention. */
  get program(): GLSLProgramWGSL {
    const { vertexFor: _, display: __, ...linked } = this.linked;
    return linked;
  }
  private holder: { material?: GLSLMaterial };
  private scene?: GLSLMaterialScene;
  // The raw uniforms and textures of `linked`, each reading the live value of its GLSL name in `values`.
  private static parts(linked: GLSLLinked, values: Record<string, ShaderUniform>) {
    const uniforms: Record<string, RawUniform> = {},
      textures: Record<string, RawTexture> = {};
    const roots = new Map<string, GLSLProgramUniform[]>();
    for (const u of linked.uniforms) {
      if (u.root) roots.set(u.root, [...(roots.get(u.root) ?? []), u]);
      else values[u.name] ??= { value: zero(u.glsl) };
      uniforms[u.member] = {
        type: u.type as RawUniform['type'],
        ...(u.count ? { count: u.count } : {}),
        get value() {
          return stored(u.root ? leaf(values[u.root]?.value, u.path) : values[u.name]?.value, u);
        },
      } as RawUniform;
    }
    for (const [root, leaves] of roots) values[root] ??= { value: rootZero(leaves) };
    for (const t of linked.textures) {
      const name = t.root ?? t.name;
      values[name] ??= { value: t.root ? [] : null };
      // The value, an element of an array's list, or the texture of a {texture, sampler} pair.
      const given = () => {
        const v = values[name]?.value as unknown;
        return (t.index === undefined ? v : (v as ArrayLike<unknown> | null)?.[t.index]) as {
          texture?: unknown;
          sampler?: GPUSamplerDescriptor;
        } | null;
      };
      const pair = () => {
        const v = given();
        return isOptionObject(v) && 'texture' in v ? v : undefined;
      };
      textures[t.binding] = {
        dimension: t.dimension,
        ...(t.sampleType ? { sampleType: t.sampleType } : {}),
        get texture() {
          return ((pair() ? pair()!.texture : given()) ?? null) as RawTextureInput | null;
        },
        get sampler() {
          return pair()?.sampler;
        },
      } as RawTexture;
    }
    return { vertexShader: linked.vertex, fragmentShader: linked.fragment, uniforms, textures };
  }
  // The uniforms record shows the GLSL names; the raw members it also holds are hidden from enumeration.
  private publish(values: Record<string, ShaderUniform>): void {
    const record = this.uniforms as Record<string, unknown>;
    for (const key of Object.keys(record)) Object.defineProperty(record, key, { enumerable: false });
    Object.assign(record, values);
    // The getters read through `values`; a name reassigned on the record (`material.uniforms.t = {value: 1}`) is read too.
    for (const name of Object.keys(values))
      Object.defineProperty(values, name, {
        get: () => record[name] as ShaderUniform,
        set: (v) => (record[name] = v),
        enumerable: true,
        configurable: true,
      });
  }
  /** The GLSL of the vertex stage; assigning translates it again. */
  override get vertexShader(): string {
    return this.source.vertexShader;
  }
  override set vertexShader(code: string) {
    this.relink({ ...this.source, vertexShader: code });
  }
  /** The GLSL of the fragment stage; assigning translates it again. */
  override get fragmentShader(): string {
    return this.source.fragmentShader;
  }
  override set fragmentShader(code: string) {
    this.relink({ ...this.source, fragmentShader: code });
  }
  /** The macros defined before both stages. Assigning a new object translates again; after editing it, set `needsUpdate`. */
  get defines(): Record<string, string | number | boolean> {
    return this.source.defines as Record<string, string | number | boolean>;
  }
  set defines(defines: Record<string, string | number | boolean>) {
    this.relink({ ...this.source, defines: { ...defines } });
  }
  /** Setting true translates the program again with the current `defines`. */
  set needsUpdate(value: boolean) {
    if (value) this.relink({ ...this.source, defines: { ...this.source.defines } });
  }
  /** The WGSL of `stage` for `mesh`: the prelude, the translated GLSL and the entry for the mesh's attributes. */
  override code(stage: 'vertex' | 'fragment', mesh?: RawMesh): string {
    return (
      this.prelude(mesh) + (stage === 'fragment' ? this.linked.fragment : this.linked.vertexFor(mesh?.layout ?? []))
    );
  }
  private relink(source: GLSLProgramSource): void {
    const linked = linkGLSLProgram(source, this.scene?.link),
      self = this as unknown as Record<string, unknown>,
      record = this.uniforms as Record<string, ShaderUniform>,
      values: Record<string, ShaderUniform> = {};
    for (const key of Object.keys(record)) values[key] = record[key]!;
    this.scene?.uniforms(linked, values, this.holder);
    const parts = GLSLMaterial.parts(linked, values);
    const signature = (l: GLSLLinked) => JSON.stringify([l.uniforms, l.textures]);
    if (signature(linked) !== signature(this.linked)) {
      // New uniforms or textures: the block layout and bindings of a fresh material replace this one's.
      const fresh = new RawShaderMaterial({
        ...parts,
        vertexEntry: 'margoGLSLVertex',
        fragmentEntry: 'margoGLSLFragment',
      }) as unknown as Record<string, unknown>;
      this.dispose();
      for (const key of ['members', 'size', 'bytes', 'data', 'textures', 'uniforms'])
        Object.defineProperty(self, key, { value: fresh[key], writable: true, configurable: true });
      this.publish(values);
    }
    this.linked = linked;
    this.source = source;
    (self.setCode as (v: string, f: string) => void).call(this, linked.vertex, linked.fragment);
  }
}

/**
 * Geometry for {@link shaderMesh}: plain arrays by stream (a `GeometryData` of `@margoengine/geometry` is one), or a
 * core `Geometry` (its interleaved `vertices` of position and normal, and `indices`).
 */
export interface ShaderGeometry {
  /** xyz per vertex. */
  readonly positions?: ArrayLike<number>;
  /** xyz per vertex. */
  readonly normals?: ArrayLike<number>;
  /** uv per vertex. */
  readonly uvs?: ArrayLike<number>;
  /** A second uv per vertex. */
  readonly uvs1?: ArrayLike<number>;
  /** rgb or rgba per vertex. */
  readonly colors?: ArrayLike<number>;
  /** xyzw per vertex (w the bitangent sign). */
  readonly tangents?: ArrayLike<number>;
  /** A core Geometry's position and normal per vertex, six numbers each. */
  readonly vertices?: ArrayLike<number>;
  readonly indices?: ArrayLike<number>;
}
/** Options for {@link shaderMesh}: RawMesh options plus the streams the geometry lacks, by GLSL attribute name. */
export interface ShaderMeshOptions extends Omit<RawMeshOptions, 'material' | 'attributes' | 'index'> {
  /** Per-vertex data by GLSL attribute name, sized by its GLSL type (a mat4 takes 16 numbers a vertex). */
  attributes?: Record<string, ArrayLike<number>>;
  /**
   * Per-instance data by GLSL attribute name or by what it holds (`instanceMatrix`: 16 numbers an instance, column
   * major; `instanceColor`: 3). The instance count defaults to the number of elements.
   */
  instances?: Record<string, ArrayLike<number>>;
  /** Triangle indices; default the geometry's. */
  index?: RawMeshOptions['index'];
}
const streams: Record<string, [keyof ShaderGeometry, number]> = {
  position: ['positions', 3],
  normal: ['normals', 3],
  uv: ['uvs', 2],
  uv1: ['uvs1', 2],
  tangent: ['tangents', 4],
  color: ['colors', 0],
};
const typeOf = (glsl: string, size: number): RawAttribute['type'] => {
  const k = /^(int|ivec)/.test(glsl) ? 'i' : /^(uint|uvec)/.test(glsl) ? 'u' : 'f';
  return (size === 1 ? { f: 'f32', i: 'i32', u: 'u32' }[k] : `vec${size}${k}`) as RawAttribute['type'];
};
/**
 * A RawMesh for `material` from `geometry`: each attribute the program declares takes the geometry stream it holds
 * (by built-in name, by the material's `attributes` map, or by its own name: position, normal, uv, uv1, color,
 * tangent), or the data in `options.attributes` and `options.instances` under its GLSL name. One the mesh lacks reads
 * its default value (`defaultAttributeValues`). A matrix attribute is split into one vector attribute per column.
 * The mesh is culled by the sphere around its positions, except under `builtins: false` (the program then places
 * points with its own matrices, so `frustumCulled` defaults to false).
 * @throws TypeError or RangeError for data of the wrong length or a stream count that differs between attributes.
 */
export function shaderMesh<M extends GLSLMaterial>(
  geometry: ShaderGeometry,
  material: M,
  options: ShaderMeshOptions = {},
): RawMesh<M> {
  if (!(material instanceof GLSLMaterial)) throw new TypeError('shaderMesh needs a ShaderMaterial');
  if (!geometry || typeof geometry !== 'object')
    throw new TypeError('shaderMesh needs geometry: {positions, ...} or a core Geometry');
  const { attributes: extra = {}, instances = {}, index, ...rest } = options,
    program = material.program,
    interleaved = geometry.vertices,
    vertexTotal = interleaved ? interleaved.length / 6 : (geometry.positions?.length ?? 0) / 3,
    out: Record<string, RawAttribute> = {},
    counts = { vertex: new Set<number>(), instance: new Set<number>() };
  const stream = (semantic: string): [ArrayLike<number>, number] | undefined => {
    const s = streams[semantic];
    if (!s) return undefined;
    if (interleaved && (semantic === 'position' || semantic === 'normal')) {
      const at = semantic === 'position' ? 0 : 3,
        data = new Float32Array(vertexTotal * 3);
      for (let i = 0; i < vertexTotal; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = interleaved[i * 6 + at + c]!;
      return [data, 3];
    }
    const data = geometry[s[0]] as ArrayLike<number> | undefined;
    if (!data) return undefined;
    return [data, s[1] || (vertexTotal ? data.length / vertexTotal : 0)];
  };
  let positions: ArrayLike<number> | undefined;
  for (const a of program.attributes) {
    const n = Number(/(?:vec|mat)([234])/.exec(a.glsl)?.[1] ?? 1),
      matrix = a.glsl.startsWith('mat'),
      perInstance = instances[a.name] ?? (a.semantic ? instances[a.semantic] : undefined),
      given = perInstance ?? extra[a.name],
      found = given
        ? ([given, matrix ? n * n : n] as [ArrayLike<number>, number])
        : a.semantic
          ? stream(a.semantic)
          : undefined;
    if (!found) continue;
    const [data, size] = found,
      step = perInstance ? 'instance' : 'vertex';
    if (!(size >= 1) || data.length % size)
      throw new RangeError(`shaderMesh attribute ${a.name} needs a multiple of ${size} numbers for ${a.glsl}`);
    counts[step].add(data.length / size);
    if (a.semantic === 'position' && step === 'vertex' && size === 3) positions = data;
    if (matrix) {
      // Column c of element i is the numbers from i*n*n + c*n, n of them.
      const elements = data.length / (n * n);
      for (let c = 0; c < n; c++) {
        const column = new Float32Array(elements * n);
        for (let i = 0; i < elements; i++) for (let r = 0; r < n; r++) column[i * n + r] = data[i * n * n + c * n + r]!;
        out[a.name + c] = { data: column, type: typeOf('vec', n), step };
      }
    } else out[a.name] = { data, type: typeOf(a.glsl, size), step };
  }
  if (counts.vertex.size > 1)
    throw new RangeError(
      `shaderMesh per-vertex attributes hold ${[...counts.vertex].join(' and ')} vertices; give each one element a vertex`,
    );
  if (counts.instance.size > 1)
    throw new RangeError(
      `shaderMesh per-instance attributes hold ${[...counts.instance].join(' and ')} instances; give each one element an instance`,
    );
  const instanceCount = rest.instanceCount ?? [...counts.instance][0];
  let bounds = rest.bounds;
  if (bounds === undefined && positions && !counts.instance.size && positions.length) {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c]!, positions[i + c]!);
        max[c] = Math.max(max[c]!, positions[i + c]!);
      }
    const center = [0, 1, 2].map((c) => (min[c]! + max[c]!) / 2) as [number, number, number];
    let radius = 0;
    for (let i = 0; i < positions.length; i += 3)
      radius = Math.max(
        radius,
        Math.hypot(positions[i]! - center[0], positions[i + 1]! - center[1], positions[i + 2]! - center[2]),
      );
    // Rounded up so a float32 vertex on the sphere stays inside it.
    bounds = { center, radius: radius * (1 + 1e-6) + 1e-7 };
  }
  let topology = rest.topology ?? 'triangle-list',
    order: number[] | null = index ? Array.from(index) : geometry.indices ? Array.from(geometry.indices) : null,
    instancesDrawn = instanceCount;
  const vertices = [...counts.vertex][0] ?? 0;
  if (program.varyings.some((v) => v.interpolation === 'flat') && topology !== 'point-list') {
    // A flat value comes from a primitive's last vertex in GL (OpenGL ES 3.0.6 2.18) and from its first in WebGPU, so
    // each primitive is listed from its last vertex on, its winding kept; a strip becomes a list.
    const at = (i: number) => (order ? order[i]! : i),
      n = order ? order.length : vertices,
      // The restart index follows the index type given (the index of options, else of the geometry).
      restart = (index ?? geometry.indices) instanceof Uint16Array ? 0xffff : 0xffffffff,
      list: number[] = [];
    const line = topology.startsWith('line'),
      strip = topology.endsWith('strip'),
      size = line ? 2 : 3;
    for (let start = 0, i = 0; i <= n; i++) {
      // Runs between restart indices (a strip restarts its alternation there).
      if (i < n && !(strip && order && at(i) === restart)) continue;
      for (let k = start; k + size <= i; k += strip ? 1 : size) {
        const p = Array.from({ length: size }, (_, j) => at(k + j));
        if (line) list.push(p[1]!, p[0]!);
        // Strip triangle k is (k, k+1, k+2), its odd ones (k+1, k, k+2) to keep the winding: led by k + 2 either way.
        else if (strip && (k - start) % 2) list.push(p[2]!, p[1]!, p[0]!);
        else list.push(p[2]!, p[0]!, p[1]!);
      }
      start = i + 1;
    }
    order = list;
    topology = line ? 'line-list' : 'triangle-list';
  }
  if (topology === 'point-list' && program.points) {
    // A sized point is a square (OpenGL ES 3.0.6 3.4) and WebGPU's points are one pixel: each point is drawn as an
    // instance of six corners, its attributes stepping once per instance.
    if (counts.instance.size)
      throw new RangeError(
        'shaderMesh draws sized points one instance a point; give a point list with gl_PointSize no per-instance attributes',
      );
    const picked = order;
    for (const [name, a] of Object.entries(out)) {
      const n = Number(/vec([234])/.exec(a.type)?.[1] ?? 1),
        data = picked
          ? Float32Array.from(
              picked.flatMap((i) => Array.from({ length: n }, (_, c) => (a.data as ArrayLike<number>)[i * n + c]!)),
            )
          : a.data;
      out[name] = { ...a, data, step: 'instance' };
    }
    out.gl_PointCorner = { data: [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1], type: 'vec2f' };
    instancesDrawn = picked ? picked.length : vertices;
    order = null;
    topology = 'triangle-list';
  }
  return new RawMesh<M>({
    frustumCulled: program.builtins !== false,
    ...rest,
    topology,
    ...(bounds !== undefined ? { bounds } : {}),
    ...(instancesDrawn !== undefined ? { instanceCount: instancesDrawn } : {}),
    material,
    attributes: out,
    index: order,
  });
}
