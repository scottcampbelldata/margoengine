// GLSL ES 3.00 for the two GPU tiers of compute (roadmap "Compute plan", milestone M5), on the render back end's
// emitter: the compute body becomes a fragment shader (fragment tier: one fragment per invocation, its texel is the
// one it stores) or a vertex shader (scatter tier: one point per invocation and store, drawn at the store's address).
// Written clean room from the W3C WGSL specification and the Khronos GLSL ES 3.00 specification.
//
// Uniforms the device sets per draw:
// - `_cn` (uvec4): num_workgroups in xyz; w is the z slice the fragment tier draws.
// - `_ct` (ivec4, scatter tier): the target's width and height in texels (a buffer's word texture: words), z the
//   layer drawn, w the binding's first word (buffers).
// - `_zd<group>_<binding>` (ivec4): a storage texture's level size and layer count (textureDimensions and
//   textureNumLayers read it, so a texture being drawn into is never bound for sampling as well).
import { fault } from '../../../shared/errors.js';
import { encodeName, type FnInstance, type GLSLStage, type Ref, StageEmitter } from '../glsl/emit.js';
import type { IREntryPoint, IRExpr, IRGlobalVar, IRModule } from '../wgsl/ir.js';
import { alignOf, STORAGE_FORMATS, type ScalarType, sizeOf, type TextureType, type Type } from '../wgsl/types.js';
import type { ComputeTarget } from './analyze.js';

const unsupported = (what: string): Error =>
  fault('unsupported', `WebGL2 compatibility cannot translate ${what}`, 'compatibility-layer');

/** A storage texture size uniform. */
interface ComputeDimension {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
}

/** One translated stage of a compute draw. */
interface ComputeStage extends GLSLStage {
  /** Storage texture size uniforms the stage reads. */
  readonly dimensions: readonly ComputeDimension[];
}

/** What {@link emitCompute} makes: the stage the compute body runs in and the matching other stage. */
interface ComputeProgram {
  readonly vertex: ComputeStage;
  readonly fragment: ComputeStage;
}

/** Options for {@link emitCompute}. */
interface ComputeEmitOptions {
  readonly constants?: Readonly<Record<string, number | boolean>>;
  readonly workgroupSize: readonly [number, number, number];
  /** The target this program draws into (its stores are kept; every other store is evaluated and dropped). */
  readonly target: ComputeTarget;
  readonly sharedStorage?: (group: number, binding: number) => boolean;
  /** Bytes a GLSL uniform block holds; a larger uniform buffer reads from a data texture. */
  readonly uniformBlockSize?: number;
}

const SWIZZLE = 'xyzw';

/** The GLSL vector of a storage format's channel type (`vec4`, `ivec4`, `uvec4`). */
const texelType = (format: string): string =>
  ({ f32: 'vec4', i32: 'ivec4', u32: 'uvec4' })[STORAGE_FORMATS[format] ?? 'f32'] as string;

/**
 * A float texel as an 8-bit UNORM storage texture keeps it, rounded in the shader. WebGPU stores a texel straight from
 * f32, rounded to the nearest of the 255 steps (the CPU tier's quantize does the same). A draw into a colour attachment
 * may narrow the shader's output first: the Radeon 680M's D3D11 driver exports it as binary16, truncated to 11
 * significant bits, so 133.52 / 255 stored 133 there, not 134 (docs/known-bugs.md). A value already on the k / 255
 * grid survives any narrowing to 11 or more bits (the error stays under 0.13 of a step), so every GPU stores k.
 */
const storedTexel = (format: string | undefined, value: string): string =>
  /^(r|rg|rgba|bgra)8unorm$/.test(format ?? '') ? `(floor(clamp(${value}, 0.0, 1.0) * 255.0 + 0.5) / 255.0)` : value;

/** Translates a compute entry point for one target in the fragment or scatter tier. */
export function emitCompute(
  module: IRModule,
  entry: IREntryPoint,
  tier: 'fragment' | 'scatter',
  options: ComputeEmitOptions,
): ComputeProgram {
  const emitter = new ComputeEmitter(module, entry, tier, options);
  const stage = emitter.run() as ComputeStage;
  const other = tier === 'fragment' ? fullTriangle() : pointFragment(options.target);
  return tier === 'fragment' ? { vertex: other, fragment: stage } : { vertex: stage, fragment: other };
}

const empty = {
  uniforms: [],
  textures: [],
  storage: [],
  inputs: [],
  outputs: [],
  varyings: [],
  fragDepth: false,
  notes: [],
  dimensions: [],
} as const;

/** The vertex stage of the fragment tier: one triangle over the whole target. */
function fullTriangle(): ComputeStage {
  return {
    ...empty,
    stage: 'vertex',
    source:
      '#version 300 es\nvoid main() { gl_Position = vec4(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0, 0.0, 1.0); }\n',
  };
}

/** The fragment stage of the scatter tier: the point's value, as the target stores it. */
function pointFragment(target: ComputeTarget): ComputeStage {
  const t = target.kind === 'buffer' ? 'uvec4' : texelType(target.format as string);
  const value =
    t === 'uvec4' ? '_sv' : t === 'ivec4' ? 'ivec4(_sv)' : storedTexel(target.format, 'uintBitsToFloat(_sv)');
  return {
    ...empty,
    stage: 'fragment',
    source: `#version 300 es\nprecision highp float;\nprecision highp int;\nflat in highp uvec4 _sv;\nlayout(location = 0) out highp ${t} _o0;\nvoid main() { _o0 = ${value}; }\n`,
    varyings: [{ location: 0, glslType: 'uvec4', interpolation: 'flat' }],
    outputs: [{ location: 0, kind: t === 'vec4' ? 'float' : t === 'ivec4' ? 'sint' : 'uint', components: 4 }],
  };
}

class ComputeEmitter extends StageEmitter {
  private readonly tier: 'fragment' | 'scatter';
  private readonly target: ComputeTarget;
  private readonly workgroupSize: readonly [number, number, number];
  private readonly dims = new Map<string, ComputeDimension>();

  constructor(module: IRModule, entry: IREntryPoint, tier: 'fragment' | 'scatter', options: ComputeEmitOptions) {
    super(
      module,
      entry,
      {
        constants: options.constants,
        prefix: 'c',
        sharedStorage: options.sharedStorage,
        uniformBlockSize: options.uniformBlockSize,
      },
      tier === 'fragment' ? 'fragment' : 'vertex',
    );
    this.tier = tier;
    this.target = options.target;
    this.workgroupSize = options.workgroupSize;
    this.storageTextures = true;
  }

  override run(): ComputeStage {
    const stage = super.run();
    return { ...stage, dimensions: [...this.dims.values()] };
  }

  private isTarget(v: IRGlobalVar): boolean {
    return v.group === this.target.group && v.binding === this.target.binding;
  }

  // ---------------------------------------------------------------- stores

  protected override storeBuffer(r: Extract<Ref, { kind: 'buffer' }>, code: string): void {
    const t = this.temp();
    this.line(`${this.type(r.type)} ${t} = ${code};`);
    if (r.v.space !== 'storage') throw unsupported(`a store to uniform buffer '${r.v.name}'`);
    if (!this.isTarget(r.v) || this.tier !== 'scatter') return;
    // The word address: the binding's first word, the constant byte offset, rows and dynamic words.
    const address = [`_ct.w`, String(r.base >> 2), ...r.rows.map((x) => `(${x}) * 4`), ...r.dyn].join(' + ');
    const a = this.temp();
    this.line(`int ${a} = ${address};`);
    this.words(r.type, t, a, '0');
  }

  /** Word stores of every scalar of a value (padding is not written, as in WGSL). */
  private words(t: Type, code: string, address: string, offset: string): void {
    const at = (o: number) => (offset === '0' ? `${address} + ${o}` : `${address} + ${offset} + ${o}`);
    switch (t.kind) {
      case 'scalar':
        this.line(`_sw(${at(0)}, ${this.bits(code, t)});`);
        return;
      case 'vector':
        for (let i = 0; i < t.size; i++) this.line(`_sw(${at(i)}, ${this.bits(`${code}.${SWIZZLE[i]}`, t.element)});`);
        return;
      case 'matrix': {
        const step = t.rows === 2 ? 2 : 4;
        for (let c = 0; c < t.columns; c++)
          for (let r = 0; r < t.rows; r++)
            this.line(`_sw(${at(c * step + r)}, ${this.bits(`${code}[${c}][${r}]`, t.element)});`);
        return;
      }
      case 'struct':
        for (const m of t.members)
          this.words(m.type, `${code}.q${encodeName(m.name)}`, address, sum(offset, m.offset / 4));
        return;
      case 'array': {
        if (typeof t.count !== 'number') throw unsupported('a store of a runtime-sized array');
        const stride = Math.ceil(sizeOf(t.element) / alignOf(t.element)) * alignOf(t.element);
        const i = this.temp();
        this.line(`for (int ${i} = 0; ${i} < ${t.count}; ${i}++) {`);
        this.depth++;
        const el = t.element.kind === 'array' ? `${code}[${i}].v` : `${code}[${i}]`;
        this.words(t.element, el, address, sum(offset, `${i} * ${stride / 4}`));
        this.depth--;
        this.line('}');
        return;
      }
    }
    throw unsupported(`a store of ${t.kind} values`);
  }

  private bits(code: string, s: ScalarType): string {
    if (s.name === 'u32') return code;
    if (s.name === 'i32') return `uint(${code})`;
    if (s.name === 'f32') return `floatBitsToUint(${code})`;
    throw unsupported(`a store of ${s.name} values to a storage buffer`);
  }

  protected override textureStore(args: readonly IRExpr[]): string {
    const tex = this.handleGlobal(args[0]),
      tt = tex.type as TextureType;
    const arrayed = tt.dimension === '2d_array';
    const coord = this.value(args[1]),
      layer = arrayed ? this.value(args[2]) : undefined,
      value = this.value(args[arrayed ? 3 : 2]);
    const vt = texelType(tt.format as string);
    if (!this.isTarget(tex)) {
      this.line(`${vt} ${this.temp()} = ${value};`);
      return '';
    }
    if (this.tier === 'fragment') {
      this.line(`_o0 = ${vt === 'vec4' ? storedTexel(tt.format as string, value) : value}; _w = true;`);
      return '';
    }
    const p =
      tt.dimension === '1d'
        ? `ivec3(int(${coord}), 0, 0)`
        : tt.dimension === '3d'
          ? `ivec3(${coord})`
          : `ivec3(ivec2(${coord}), ${arrayed ? `int(${layer})` : '0'})`;
    const bits = vt === 'uvec4' ? value : vt === 'ivec4' ? `uvec4(${value})` : `floatBitsToUint(${value})`;
    this.line(`_sx(${p}, ${bits});`);
    return '';
  }

  // ---------------------------------------------------------------- storage textures

  private dimension(tex: IRGlobalVar): string {
    const key = `${tex.group}:${tex.binding}`;
    let d = this.dims.get(key);
    if (!d) {
      d = { group: tex.group as number, binding: tex.binding as number, name: `_zd${tex.group}_${tex.binding}` };
      this.dims.set(key, d);
      this.globals.push(`uniform highp ivec4 ${d.name};`);
    }
    return d.name;
  }

  protected override texture(name: string, args: readonly IRExpr[], result: Type): string {
    const tt = args[0]?.type as TextureType | undefined;
    if (tt?.kind !== 'texture' || tt.shape !== 'storage') return super.texture(name, args, result);
    const tex = this.handleGlobal(args[0]);
    if (tt.dimension === 'cube' || tt.dimension === 'cube_array')
      throw unsupported(`a ${tt.dimension} storage texture '${tex.name}'`);
    if (name === 'textureDimensions') {
      const d = this.dimension(tex);
      return tt.dimension === '1d' ? `uint(${d}.x)` : tt.dimension === '3d' ? `uvec3(${d}.xyz)` : `uvec2(${d}.xy)`;
    }
    if (name === 'textureNumLayers') return `uint(${this.dimension(tex)}.z)`;
    if (name === 'textureLoad') {
      const t = this.combined(args[0]);
      const d = this.dimension(tex);
      const arrayed = tt.dimension === '2d_array';
      const c = this.value(args[1]);
      const p =
        tt.dimension === '1d'
          ? `ivec2(clamp(int(${c}), 0, ${d}.x - 1), 0)`
          : tt.dimension === '3d'
            ? `clamp(ivec3(${c}), ivec3(0), ${d}.xyz - 1)`
            : arrayed
              ? `ivec3(clamp(ivec2(${c}), ivec2(0), ${d}.xy - 1), clamp(int(${this.value(args[2])}), 0, ${d}.z - 1))`
              : `clamp(ivec2(${c}), ivec2(0), ${d}.xy - 1)`;
      return `texelFetch(${t.name}, ${p}, 0)`;
    }
    if (name === 'textureStore') return this.textureStore(args);
    throw unsupported(`${name}() on storage texture '${tex.name}'`);
  }

  // ---------------------------------------------------------------- entry point

  protected override builtinInput(name: string): string {
    switch (name) {
      case 'global_invocation_id':
        return '_gid';
      case 'local_invocation_id':
        return '_lid';
      case 'local_invocation_index':
        return '_lix';
      case 'workgroup_id':
        return '_wid';
      case 'num_workgroups':
        return '_cn.xyz';
    }
    throw unsupported(`@builtin(${name}) in a compute shader`);
  }

  protected override mainFunction(main: FnInstance): ReturnType<StageEmitter['mainFunction']> {
    const fn = this.entry.function;
    const [wx, wy, wz] = this.workgroupSize;
    const args = fn.params.map((p) => {
      if (p.type.kind === 'struct' && p.io.builtin === undefined)
        return `${this.type(p.type)}(${p.type.members.map((m) => this.builtinInput(m.builtin as string)).join(', ')})`;
      return this.builtinInput(p.io.builtin as string);
    });
    const declarations = ['uniform highp uvec4 _cn;', `const uvec3 _ws = uvec3(${wx}u, ${wy}u, ${wz}u);`];
    const body: string[] = [];
    if (this.tier === 'fragment') {
      const vt = texelType(this.target.format as string);
      declarations.push(`layout(location = 0) out highp ${vt} _o0;`, 'bool _w = false;');
      body.push(
        'uvec3 _gid = uvec3(uvec2(gl_FragCoord.xy), _cn.w);',
        'uvec3 _wid = _gid / _ws; uvec3 _lid = _gid - _wid * _ws;',
        `uint _lix = _lid.x + _lid.y * ${wx}u + _lid.z * ${wx * wy}u;`,
        `${main.name}(${args.join(', ')});`,
        // Not `if (!_w) discard;`: FXC (ANGLE's Direct3D 11 back end) miscompiles that after a texelFetch behind a
        // uniform-dependent early return and discards every fragment; this equivalent form compiles right (bug 51).
        'if (_w) return;',
        'discard;',
      );
      return {
        declarations,
        main: `void main() {\n${body.map((b) => `  ${b}`).join('\n')}\n}`,
        inputs: [],
        outputs: [{ location: 0, kind: vt === 'vec4' ? 'float' : vt === 'ivec4' ? 'sint' : 'uint', components: 4 }],
        varyings: [],
        fragDepth: false,
      };
    }
    // Scatter: invocation gl_VertexID, store gl_InstanceID of it.
    declarations.push(
      'uniform highp ivec4 _ct;',
      'flat out highp uvec4 _sv;',
      'int _sel; int _cnt = 0; bool _hit = false; ivec2 _at; uvec4 _val;',
      'void _sw(int a, uint w) { if (_cnt == _sel) { _hit = true; _at = ivec2(a % _ct.x, a / _ct.x); _val = uvec4(w, 0u, 0u, 0u); } _cnt++; }',
      'void _sx(ivec3 p, uvec4 v) { if (_cnt == _sel && p.z == _ct.z && all(greaterThanEqual(p.xy, ivec2(0))) && all(lessThan(p.xy, _ct.xy))) { _hit = true; _at = p.xy; _val = v; } _cnt++; }',
    );
    body.push(
      '_sel = gl_InstanceID;',
      'uint _inv = uint(gl_VertexID);',
      `uint _lix = _inv % ${wx * wy * wz}u; uint _wg = _inv / ${wx * wy * wz}u;`,
      'uvec3 _wid = uvec3(_wg % _cn.x, (_wg / _cn.x) % _cn.y, _wg / (_cn.x * _cn.y));',
      `uvec3 _lid = uvec3(_lix % ${wx}u, (_lix / ${wx}u) % ${wy}u, _lix / ${wx * wy}u);`,
      'uvec3 _gid = _wid * _ws + _lid;',
      `${main.name}(${args.join(', ')});`,
      'gl_PointSize = 1.0;',
      '_sv = _val;',
      'gl_Position = _hit ? vec4((vec2(_at) + 0.5) / vec2(_ct.x, max(_ct.y, 1)) * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);',
    );
    return {
      declarations,
      main: `void main() {\n${body.map((b) => `  ${b}`).join('\n')}\n}`,
      inputs: [],
      outputs: [],
      varyings: [{ location: 0, glslType: 'uvec4', interpolation: 'flat' }],
      fragDepth: false,
    };
  }
}

const sum = (a: string, b: number | string): string => (a === '0' ? String(b) : b === 0 ? a : `${a} + ${b}`);
