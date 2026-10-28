// Built-in functions of WGSL (W3C WGSL specification, section 17): overload resolution and result types. Arguments
// arrive as value types (the Load Rule already applied) except the pointer arguments of atomics, arrayLength,
// workgroupUniformLoad, modf and frexp. Returns the result type, or a string that names the fault and its fix.
import {
  AFLOAT,
  AINT,
  BOOL,
  conversionRank,
  elementOf,
  F32,
  I32,
  isAbstract,
  isFloat,
  isInteger,
  isNumeric,
  isSigned,
  layoutStruct,
  type ScalarType,
  STORAGE_FORMATS,
  type StructType,
  type TextureType,
  type Type,
  typeName,
  U32,
  VOID,
  vector,
  withElement,
} from './types.js';

/** The stage a built-in may run in, when it is limited to one. */
type BuiltinStage = 'fragment' | 'compute';

/** Result of resolving a built-in call. */
export interface BuiltinResult {
  /** The result type (`void` for statements such as barriers and textureStore). */
  readonly type: Type;
  /** The types the arguments convert to (abstract arguments become these). */
  readonly params: readonly Type[];
  /** The stage the built-in is limited to, if any. */
  readonly stage?: BuiltinStage;
}

type Shape = 'scalar' | 'vector';
type Class = 'float' | 'numeric' | 'integer' | 'signed' | 'concrete-integer' | 'bool' | 'any' | 'f32';

const inClass = (s: ScalarType, c: Class): boolean => {
  switch (c) {
    case 'float':
      return isFloat(s);
    case 'numeric':
      return isNumeric(s);
    case 'integer':
      return isInteger(s);
    case 'concrete-integer':
      return s.name === 'i32' || s.name === 'u32' || s.name === 'abstract-int';
    case 'signed':
      return isSigned(s);
    case 'bool':
      return s.name === 'bool';
    case 'f32':
      return s.name === 'f32' || isAbstract(s);
    case 'any':
      return true;
  }
};

/** The one type all arguments convert to, preferring the lowest conversion rank; undefined when there is none. */
export function unify(args: readonly Type[]): Type | undefined {
  let best: Type | undefined,
    bestRank = Infinity;
  for (const candidate of [...args, ...args.map((a) => withElement(a, AFLOAT))]) {
    let rank = 0;
    for (const a of args) {
      const r = conversionRank(a, candidate);
      if (r === undefined) {
        rank = Infinity;
        break;
      }
      rank += r;
    }
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

/** Element-class fit for a component-wise built-in: abstract ints become abstract floats for float classes. */
function fitClass(t: Type, c: Class): Type | undefined {
  const e = elementOf(t);
  if (!e || t.kind === 'matrix') return undefined;
  if (inClass(e, c)) return t;
  if (e.name === 'abstract-int' && (c === 'float' || c === 'f32')) return withElement(t, AFLOAT);
  return undefined;
}

const shapeOf = (t: Type): Shape | undefined =>
  t.kind === 'scalar' ? 'scalar' : t.kind === 'vector' ? 'vector' : undefined;

/** Component-wise: every argument the same scalar or vector type T of class `c`; returns T (or `ret(T)`). */
function componentwise(
  name: string,
  args: readonly Type[],
  arity: number,
  c: Class,
  ret?: (t: Type) => Type,
): BuiltinResult | string {
  if (args.length !== arity) return `${name} takes ${arity} argument${arity === 1 ? '' : 's'}, got ${args.length}`;
  const u = unify(args);
  const t = u && fitClass(u, c);
  if (!t || !shapeOf(t))
    return `${name} cannot take (${args.map(typeName).join(', ')}); it needs ${arity === 1 ? 'a' : 'matching'} ${c} scalar${arity === 1 ? '' : 's'} or vectors`;
  return { type: ret ? ret(t) : t, params: args.map(() => t) };
}

const FLOAT1 = [
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atanh',
  'ceil',
  'cos',
  'cosh',
  'degrees',
  'exp',
  'exp2',
  'floor',
  'fract',
  'inverseSqrt',
  'log',
  'log2',
  'radians',
  'round',
  'saturate',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
];
const DERIVATIVES = [
  'dpdx',
  'dpdxCoarse',
  'dpdxFine',
  'dpdy',
  'dpdyCoarse',
  'dpdyFine',
  'fwidth',
  'fwidthCoarse',
  'fwidthFine',
];
const ATOMIC_RMW = [
  'atomicAdd',
  'atomicSub',
  'atomicMax',
  'atomicMin',
  'atomicAnd',
  'atomicOr',
  'atomicXor',
  'atomicExchange',
];

const resultStructs = new Map<string, StructType>();
function resultStruct(name: string, members: [string, Type][]): StructType {
  let s = resultStructs.get(name);
  if (!s)
    resultStructs.set(
      name,
      (s = layoutStruct(
        name,
        members.map(([n, type]) => ({ name: n, type })),
      )),
    );
  return s;
}
const suffix = (t: Type): string =>
  (t.kind === 'vector' ? `vec${t.size}_` : '') + (elementOf(t)?.name.replace('abstract-float', 'abstract') ?? '');

/** Names of every built-in function this front end resolves. */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  ...FLOAT1,
  ...DERIVATIVES,
  ...ATOMIC_RMW,
  'abs',
  'all',
  'any',
  'arrayLength',
  'atan2',
  'atomicCompareExchangeWeak',
  'atomicLoad',
  'atomicStore',
  'bitcast',
  'clamp',
  'countLeadingZeros',
  'countOneBits',
  'countTrailingZeros',
  'cross',
  'determinant',
  'distance',
  'dot',
  'dot4I8Packed',
  'dot4U8Packed',
  'extractBits',
  'faceForward',
  'firstLeadingBit',
  'firstTrailingBit',
  'fma',
  'frexp',
  'insertBits',
  'ldexp',
  'length',
  'max',
  'min',
  'mix',
  'modf',
  'normalize',
  'pack2x16float',
  'pack2x16snorm',
  'pack2x16unorm',
  'pack4x8snorm',
  'pack4x8unorm',
  'pack4xI8',
  'pack4xI8Clamp',
  'pack4xU8',
  'pack4xU8Clamp',
  'pow',
  'quantizeToF16',
  'reflect',
  'refract',
  'reverseBits',
  'select',
  'sign',
  'smoothstep',
  'step',
  'storageBarrier',
  'textureBarrier',
  'textureDimensions',
  'textureGather',
  'textureGatherCompare',
  'textureLoad',
  'textureNumLayers',
  'textureNumLevels',
  'textureNumSamples',
  'textureSample',
  'textureSampleBaseClampToEdge',
  'textureSampleBias',
  'textureSampleCompare',
  'textureSampleCompareLevel',
  'textureSampleGrad',
  'textureSampleLevel',
  'textureStore',
  'transpose',
  'unpack2x16float',
  'unpack2x16snorm',
  'unpack2x16unorm',
  'unpack4x8snorm',
  'unpack4x8unorm',
  'unpack4xI8',
  'unpack4xU8',
  'workgroupBarrier',
  'workgroupUniformLoad',
]);

/**
 * Resolves a call of built-in `name` with argument types `args` (pointer arguments as `ptr`, the rest as values).
 * `template` is the explicit template argument of `bitcast<T>`.
 */
export function resolveBuiltin(name: string, args: readonly Type[], template?: Type): BuiltinResult | string {
  if (FLOAT1.includes(name)) return componentwise(name, args, 1, 'float');
  if (DERIVATIVES.includes(name)) {
    const r = componentwise(name, args, 1, 'f32');
    return typeof r === 'string'
      ? r
      : { ...r, type: withElement(r.type, F32), params: [withElement(r.type, F32)], stage: 'fragment' };
  }
  switch (name) {
    case 'abs':
      return componentwise(name, args, 1, 'numeric');
    case 'sign':
      return componentwise(name, args, 1, 'signed');
    case 'atan2':
    case 'pow':
    case 'step':
      return componentwise(name, args, 2, 'float');
    case 'min':
    case 'max':
      return componentwise(name, args, 2, 'numeric');
    case 'clamp':
      return componentwise(name, args, 3, 'numeric');
    case 'fma':
    case 'smoothstep':
      return componentwise(name, args, 3, 'float');
    case 'countLeadingZeros':
    case 'countOneBits':
    case 'countTrailingZeros':
    case 'firstLeadingBit':
    case 'firstTrailingBit':
    case 'reverseBits':
      return componentwise(name, args, 1, 'concrete-integer');
    case 'quantizeToF16':
      return componentwise(name, args, 1, 'f32', (t) => withElement(t, F32));
    case 'all':
    case 'any': {
      if (args.length !== 1 || elementOf(args[0])?.name !== 'bool' || args[0].kind === 'matrix')
        return `${name} needs one bool or vector of bool`;
      return { type: BOOL, params: args };
    }
    case 'select': {
      if (args.length !== 3) return `select takes (false value, true value, condition), got ${args.length} arguments`;
      const u = unify([args[0], args[1]]),
        c = args[2];
      if (!u || !shapeOf(u))
        return `select needs two values of one scalar or vector type, got ${args.slice(0, 2).map(typeName).join(' and ')}`;
      if (c.kind === 'scalar' && c.name === 'bool') return { type: u, params: [u, u, c] };
      if (c.kind === 'vector' && c.element.name === 'bool' && u.kind === 'vector' && u.size === c.size)
        return { type: u, params: [u, u, c] };
      return `select's condition must be bool, or a vector of bool the size of the values; got ${typeName(c)}`;
    }
    case 'mix': {
      if (args.length !== 3) return `mix takes 3 arguments, got ${args.length}`;
      if (args[0].kind === 'vector' && args[2].kind === 'scalar') {
        const v = unify([args[0], args[1]]),
          vf = v && fitClass(v, 'float');
        const s = vf && unify([args[2], elementOf(vf) as Type]);
        if (vf && s && s.kind === 'scalar') return { type: vf, params: [vf, vf, elementOf(vf) as Type] };
      }
      return componentwise(name, args, 3, 'float');
    }
    case 'dot': {
      const u = args.length === 2 ? unify(args) : undefined;
      if (!u || u.kind !== 'vector' || !isNumeric(u.element))
        return `dot needs two vectors of one numeric type, got (${args.map(typeName).join(', ')})`;
      return { type: u.element, params: [u, u] };
    }
    case 'cross': {
      const u = args.length === 2 ? unify(args) : undefined,
        f = u && fitClass(u, 'float');
      if (!f || f.kind !== 'vector' || f.size !== 3)
        return `cross needs two vec3 of float, got (${args.map(typeName).join(', ')})`;
      return { type: f, params: [f, f] };
    }
    case 'length':
    case 'normalize': {
      const r = componentwise(name, args, 1, 'float');
      if (typeof r === 'string') return r;
      if (name === 'normalize' && r.type.kind !== 'vector') return 'normalize needs a vector of float';
      return name === 'length' ? { ...r, type: elementOf(r.type) as Type } : r;
    }
    case 'distance': {
      const r = componentwise(name, args, 2, 'float');
      return typeof r === 'string' ? r : { ...r, type: elementOf(r.type) as Type };
    }
    case 'faceForward':
    case 'reflect': {
      const r = componentwise(name, args, name === 'reflect' ? 2 : 3, 'float');
      if (typeof r !== 'string' && r.type.kind !== 'vector') return `${name} needs vectors of float`;
      return r;
    }
    case 'refract': {
      if (args.length !== 3) return `refract takes (incident, normal, eta), got ${args.length} arguments`;
      const v = unify([args[0], args[1]]),
        f = v && fitClass(v, 'float');
      if (!f || f.kind !== 'vector') return 'refract needs two vectors of float and a float ratio';
      return { type: f, params: [f, f, f.element] };
    }
    case 'determinant':
    case 'transpose': {
      const m = args[0];
      if (args.length !== 1 || m.kind !== 'matrix') return `${name} needs one matrix`;
      const e = m.element.name === 'abstract-int' ? AFLOAT : m.element;
      if (name === 'determinant') {
        if (m.columns !== m.rows) return 'determinant needs a square matrix';
        return { type: e, params: [m] };
      }
      return { type: { kind: 'matrix', columns: m.rows, rows: m.columns, element: e }, params: [m] };
    }
    case 'ldexp': {
      if (args.length !== 2) return 'ldexp takes (fraction, exponent)';
      const f = fitClass(args[0], 'float'),
        e = args[1];
      if (!f || !shapeOf(f)) return 'ldexp needs a float scalar or vector fraction';
      const ee = elementOf(e);
      if (!ee || shapeOf(e) !== shapeOf(f) || !(ee.name === 'i32' || ee.name === 'abstract-int'))
        return 'ldexp needs an i32 exponent of the same shape';
      return {
        type: f,
        params: [f, withElement(f, ee.name === 'abstract-int' && !isAbstract(elementOf(f) as ScalarType) ? I32 : ee)],
      };
    }
    case 'modf':
    case 'frexp': {
      const r = componentwise(name, args, 1, 'float');
      if (typeof r === 'string') return r;
      const t = r.type;
      const s =
        name === 'modf'
          ? resultStruct(`__modf_result_${suffix(t)}`, [
              ['fract', t],
              ['whole', t],
            ])
          : resultStruct(`__frexp_result_${suffix(t)}`, [
              ['fract', t],
              ['exp', withElement(t, isAbstract(elementOf(t) as ScalarType) ? AINT : I32)],
            ]);
      return { type: s, params: [t] };
    }
    case 'extractBits': {
      if (args.length !== 3) return 'extractBits takes (e, offset, count)';
      const t = fitClass(args[0], 'concrete-integer');
      if (!t || !shapeOf(t) || !isU32Like(args[1]) || !isU32Like(args[2]))
        return 'extractBits needs an i32 or u32 value and u32 offset and count';
      return { type: t, params: [t, U32, U32] };
    }
    case 'insertBits': {
      if (args.length !== 4) return 'insertBits takes (e, newbits, offset, count)';
      const t = unify([args[0], args[1]]),
        f = t && fitClass(t, 'concrete-integer');
      if (!f || !shapeOf(f) || !isU32Like(args[2]) || !isU32Like(args[3]))
        return 'insertBits needs two i32 or u32 values of one type and u32 offset and count';
      return { type: f, params: [f, f, U32, U32] };
    }
    case 'dot4I8Packed':
    case 'dot4U8Packed':
      if (args.length !== 2 || !isU32Like(args[0]) || !isU32Like(args[1])) return `${name} needs two u32`;
      return { type: name === 'dot4I8Packed' ? I32 : U32, params: [U32, U32] };
    case 'pack4x8snorm':
    case 'pack4x8unorm':
      return packArg(name, args, vector(4, F32));
    case 'pack4xI8':
    case 'pack4xI8Clamp':
      return packArg(name, args, vector(4, I32));
    case 'pack4xU8':
    case 'pack4xU8Clamp':
      return packArg(name, args, vector(4, U32));
    case 'pack2x16snorm':
    case 'pack2x16unorm':
    case 'pack2x16float':
      return packArg(name, args, vector(2, F32));
    case 'unpack4x8snorm':
    case 'unpack4x8unorm':
      return unpackArg(name, args, vector(4, F32));
    case 'unpack4xI8':
      return unpackArg(name, args, vector(4, I32));
    case 'unpack4xU8':
      return unpackArg(name, args, vector(4, U32));
    case 'unpack2x16snorm':
    case 'unpack2x16unorm':
    case 'unpack2x16float':
      return unpackArg(name, args, vector(2, F32));
    case 'bitcast': {
      if (!template) return 'bitcast needs its target type: bitcast<f32>(x)';
      if (args.length !== 1) return 'bitcast takes one argument';
      const from =
        args[0].kind === 'scalar' && args[0].name === 'abstract-int'
          ? template.kind === 'scalar' && template.name === 'u32'
            ? U32
            : I32
          : args[0];
      const fe = elementOf(from),
        te = elementOf(template);
      if (
        !fe ||
        !te ||
        from.kind === 'matrix' ||
        template.kind === 'matrix' ||
        fe.name === 'bool' ||
        te.name === 'bool' ||
        isAbstract(te)
      )
        return `bitcast converts concrete numeric scalars and vectors, not ${typeName(args[0])} to ${typeName(template)}`;
      const bits = (t: Type) =>
        (t.kind === 'vector' ? t.size : 1) * ((elementOf(t) as ScalarType).name === 'f16' ? 16 : 32);
      if (bits(from) !== bits(template))
        return `bitcast needs the same bit count on both sides: ${typeName(from)} to ${typeName(template)}`;
      return { type: template, params: [from] };
    }
    case 'arrayLength': {
      const p = args[0];
      if (
        args.length !== 1 ||
        p.kind !== 'ptr' ||
        p.space !== 'storage' ||
        p.store.kind !== 'array' ||
        p.store.count !== 'runtime'
      )
        return 'arrayLength needs a pointer to a runtime-sized array in storage: arrayLength(&buffer.items)';
      return { type: U32, params: args };
    }
    case 'atomicLoad':
    case 'atomicStore':
    case 'atomicCompareExchangeWeak':
    case 'atomicAdd':
    case 'atomicSub':
    case 'atomicMax':
    case 'atomicMin':
    case 'atomicAnd':
    case 'atomicOr':
    case 'atomicXor':
    case 'atomicExchange': {
      const p = args[0];
      if (!p || p.kind !== 'ptr' || p.store.kind !== 'atomic' || (p.space !== 'storage' && p.space !== 'workgroup'))
        return `${name} needs a pointer to an atomic in storage or workgroup memory: ${name}(&counter${name === 'atomicLoad' ? '' : ', value'})`;
      const t = p.store.element,
        want = name === 'atomicLoad' ? 1 : name === 'atomicCompareExchangeWeak' ? 3 : 2;
      if (args.length !== want) return `${name} takes ${want} argument${want === 1 ? '' : 's'}`;
      for (const a of args.slice(1))
        if (conversionRank(a, t) === undefined)
          return `${name} needs ${t.name} values for an atomic<${t.name}>, got ${typeName(a)}`;
      if (name !== 'atomicLoad' && p.access === 'read')
        return `${name} writes, but the atomic is read-only; declare the buffer read_write`;
      const params = [p, ...args.slice(1).map(() => t)];
      if (name === 'atomicStore') return { type: VOID, params };
      if (name === 'atomicCompareExchangeWeak')
        return {
          type: resultStruct(`__atomic_compare_exchange_result_${t.name}`, [
            ['old_value', t],
            ['exchanged', BOOL],
          ]),
          params,
        };
      return { type: t, params };
    }
    case 'storageBarrier':
    case 'textureBarrier':
    case 'workgroupBarrier':
      if (args.length) return `${name} takes no arguments`;
      return { type: VOID, params: [], stage: 'compute' };
    case 'workgroupUniformLoad': {
      const p = args[0];
      if (args.length !== 1 || p.kind !== 'ptr' || p.space !== 'workgroup')
        return 'workgroupUniformLoad needs a pointer to workgroup memory';
      return { type: p.store.kind === 'atomic' ? p.store.element : p.store, params: args, stage: 'compute' };
    }
  }
  if (name.startsWith('texture')) return texture(name, args);
  return `'${name}' is not a WGSL built-in function`;
}

const isU32Like = (t: Type) => t.kind === 'scalar' && (t.name === 'u32' || t.name === 'abstract-int');
const isIntLike = (t: Type, size?: number) => {
  const e = elementOf(t);
  if (!e || !(e.name === 'i32' || e.name === 'u32' || e.name === 'abstract-int')) return false;
  return size === undefined ? t.kind === 'scalar' : t.kind === 'vector' && t.size === size;
};
const isFloatLike = (t: Type, size?: number) => {
  const e = elementOf(t);
  if (!e || !(e.name === 'f32' || e.name === 'abstract-float' || e.name === 'abstract-int')) return false;
  return size === undefined ? t.kind === 'scalar' : t.kind === 'vector' && t.size === size;
};
const concreteInt = (t: Type): Type => withElement(t, elementOf(t)?.name === 'u32' ? U32 : I32);
const floatOf = (t: Type): Type => withElement(t, F32);

function packArg(name: string, args: readonly Type[], want: Type): BuiltinResult | string {
  if (args.length !== 1 || conversionRank(args[0], want) === undefined) return `${name} needs one ${typeName(want)}`;
  return { type: U32, params: [want] };
}
function unpackArg(name: string, args: readonly Type[], result: Type): BuiltinResult | string {
  if (args.length !== 1 || !isU32Like(args[0])) return `${name} needs one u32`;
  return { type: result, params: [U32] };
}

const coordSize = (d: TextureType['dimension']): number | undefined =>
  d === '1d' ? undefined : d === '2d' || d === '2d_array' ? 2 : 3;
const arrayed = (d: TextureType['dimension']) => d === '2d_array' || d === 'cube_array';

/** Texture built-ins (WGSL section 17.7). */
function texture(name: string, args: readonly Type[]): BuiltinResult | string {
  const params: Type[] = [];
  let k = 0;
  // textureGather's leading component index for non-depth textures.
  let component: Type | undefined;
  if (name === 'textureGather' && args[0] && args[0].kind !== 'texture') {
    component = args[0];
    if (!isIntLike(component)) return 'textureGather takes a component index 0 to 3 first';
    params.push(concreteInt(component));
    k = 1;
  }
  const t = args[k];
  if (!t || t.kind !== 'texture') return `${name} needs a texture as its ${k ? 'second' : 'first'} argument`;
  params.push(t);
  k++;
  const rest = args.slice(k),
    texel = t.shape === 'depth' || t.shape === 'depth_multisampled' ? F32 : (t.sampled ?? F32),
    vec4 = vector(4, texel.name === 'abstract-float' ? F32 : texel),
    size = coordSize(t.dimension);
  const fail = (how: string) => `${name}(${args.map(typeName).join(', ')}): ${how}`;
  const need = (ok: boolean, how: string) => (ok ? undefined : fail(how));
  const take = (test: (a: Type) => boolean, as: (a: Type) => Type, what: string): string | undefined => {
    const a = rest.shift();
    if (!a || !test(a)) return fail(`expected ${what}`);
    params.push(as(a));
    return undefined;
  };
  const coords = (float: boolean) =>
    take(
      (a) => (float ? isFloatLike(a, size) : isIntLike(a, size)),
      float ? floatOf : concreteInt,
      `${float ? 'float' : 'integer'} coordinates (${size ? `vec${size}` : 'scalar'})`,
    );
  const arrayIndex = () =>
    arrayed(t.dimension) ? take((a) => isIntLike(a), concreteInt, 'an integer array index') : undefined;
  const sampler = (comparison: boolean) =>
    take(
      (a) => a.kind === 'sampler' && a.comparison === comparison,
      (a) => a,
      comparison ? 'a sampler_comparison' : 'a sampler',
    );
  const offset = () => {
    if (!rest.length) return undefined;
    if (t.dimension === 'cube' || t.dimension === 'cube_array') return fail('cube textures take no offset');
    return take(
      (a) => isIntLike(a, size) && elementOf(a)?.name !== 'u32',
      (a) => withElement(a, I32),
      'an i32 offset vector',
    );
  };
  const done = (type: Type, stage?: BuiltinStage): BuiltinResult | string =>
    rest.length ? fail('too many arguments') : { type, params, ...(stage ? { stage } : {}) };
  const isSampled = t.shape === 'sampled',
    isDepth = t.shape === 'depth';

  switch (name) {
    case 'textureDimensions': {
      if (t.shape === 'external') return done(vector(2, U32));
      if (rest.length) {
        const e = take((a) => isIntLike(a), concreteInt, 'an integer mip level');
        if (e) return e;
        if (t.shape === 'storage' || t.shape === 'multisampled' || t.shape === 'depth_multisampled')
          return fail('this texture has no mip levels');
      }
      return done(t.dimension === '1d' ? U32 : vector(t.dimension === '3d' ? 3 : 2, U32));
    }
    case 'textureNumLayers':
      return need(arrayed(t.dimension), 'needs an array texture') ?? done(U32);
    case 'textureNumLevels':
      return need(isSampled || isDepth, 'needs a sampled or depth texture') ?? done(U32);
    case 'textureNumSamples':
      return (
        need(t.shape === 'multisampled' || t.shape === 'depth_multisampled', 'needs a multisampled texture') ??
        done(U32)
      );
    case 'textureLoad': {
      if (t.shape === 'external') return coords(false) ?? done(vector(4, F32));
      const e = coords(false) ?? arrayIndex();
      if (e) return e;
      if (t.shape === 'storage') {
        if (t.access === 'write') return fail('the storage texture is write-only; declare it read or read_write');
        return done(vector(4, scalarOf(STORAGE_FORMATS[t.format ?? ''] ?? 'f32')));
      }
      const last = take(
        (a) => isIntLike(a),
        concreteInt,
        t.shape.includes('multisampled') ? 'an integer sample index' : 'an integer mip level',
      );
      return last ?? done(isDepth || t.shape === 'depth_multisampled' ? F32 : vec4);
    }
    case 'textureStore': {
      if (t.shape !== 'storage') return fail('needs a storage texture');
      if (t.access === 'read') return fail('the storage texture is read-only; declare it write or read_write');
      const e = coords(false) ?? arrayIndex();
      if (e) return e;
      const want = vector(4, scalarOf(STORAGE_FORMATS[t.format ?? ''] ?? 'f32'));
      return (
        take(
          (a) => conversionRank(a, want) !== undefined,
          () => want,
          `a ${typeName(want)} value`,
        ) ?? done(VOID)
      );
    }
    case 'textureSample':
    case 'textureSampleBias':
    case 'textureSampleLevel':
    case 'textureSampleGrad': {
      if (!(isSampled || isDepth) || (isSampled && texel.name !== 'f32'))
        return fail('needs a texture_* of f32 or a depth texture');
      if (name !== 'textureSample' && name !== 'textureSampleLevel' && isDepth)
        return fail('depth textures need textureSample, textureSampleLevel or a compare variant');
      const e = sampler(false) ?? coords(true) ?? arrayIndex();
      if (e) return e;
      let x: string | undefined;
      if (name === 'textureSampleBias') x = take((a) => isFloatLike(a), floatOf, 'an f32 bias');
      if (name === 'textureSampleLevel')
        x = isDepth
          ? take((a) => isIntLike(a), concreteInt, 'an integer mip level')
          : take((a) => isFloatLike(a), floatOf, 'an f32 level');
      if (name === 'textureSampleGrad')
        x = take((a) => isFloatLike(a, size), floatOf, 'ddx') ?? take((a) => isFloatLike(a, size), floatOf, 'ddy');
      return (
        x ??
        offset() ??
        done(isDepth ? F32 : vec4, name === 'textureSample' || name === 'textureSampleBias' ? 'fragment' : undefined)
      );
    }
    case 'textureSampleCompare':
    case 'textureSampleCompareLevel': {
      if (!isDepth) return fail('needs a depth texture');
      const e =
        sampler(true) ?? coords(true) ?? arrayIndex() ?? take((a) => isFloatLike(a), floatOf, 'an f32 depth reference');
      return e ?? offset() ?? done(F32, name === 'textureSampleCompare' ? 'fragment' : undefined);
    }
    case 'textureGather': {
      if (t.dimension === '1d' || t.dimension === '3d') return fail('needs a 2d or cube texture');
      if (isDepth === !!component)
        return fail(isDepth ? 'depth textures take no component index' : 'needs a component index first');
      const e = sampler(false) ?? coords(true) ?? arrayIndex();
      return e ?? offset() ?? done(vec4);
    }
    case 'textureGatherCompare': {
      if (!isDepth || t.dimension === '1d' || t.dimension === '3d') return fail('needs a 2d or cube depth texture');
      const e =
        sampler(true) ?? coords(true) ?? arrayIndex() ?? take((a) => isFloatLike(a), floatOf, 'an f32 depth reference');
      return e ?? offset() ?? done(vector(4, F32));
    }
    case 'textureSampleBaseClampToEdge': {
      if (!((isSampled && t.dimension === '2d' && texel.name === 'f32') || t.shape === 'external'))
        return fail('needs a texture_2d<f32> or texture_external');
      return sampler(false) ?? take((a) => isFloatLike(a, 2), floatOf, 'vec2 coordinates') ?? done(vector(4, F32));
    }
  }
  return `'${name}' is not a WGSL built-in function`;
}

const scalarOf = (n: 'f32' | 'i32' | 'u32'): ScalarType => (n === 'f32' ? F32 : n === 'i32' ? I32 : U32);
