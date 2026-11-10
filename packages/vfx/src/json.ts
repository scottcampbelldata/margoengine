import { VFX } from '@margoengine/vfx';
import type { VFX as Base, VFXOptions, FogLike } from './base.js';
import { MargoError } from '@margoengine/math/errors';

/** Current effect document version. Unknown versions reject instead of silently dropping features. */
export const VFX_JSON_VERSION = 1;
/** Decoded authoring preset. Contains configuration and fog, not running particle/GPU state. */
export interface VFXPreset {
  /** Format version, currently 1. */
  version: typeof VFX_JSON_VERSION;
  /** All effect options, including typed array assets and externally resolved bindings. */
  options: VFXOptions;
  /** Fog configuration; default null. */
  fog: FogLike | null;
}
/** Resource and allocation limits shared by JSON operations. */
export interface VFXJSONLimits {
  /** Most UTF-16 code units in serialized text. Default 512 Mi. */
  maxChars?: number;
  /** Most visited values, including typed array elements. Default 100,000,000. */
  maxNodes?: number;
  /** Most nested arrays/objects. Default 64. */
  maxDepth?: number;
}
/** Serialization settings; object/function bindings become stable reference IDs. */
export interface VFXJSONWriteOptions extends VFXJSONLimits {
  /** Explicit external resources, for example a depth supplier, light sink or skinned primitive. Default none. */
  references?: ReadonlyMap<object, string>;
}
/** Deserialization settings; all referenced resources must be supplied explicitly. */
export interface VFXJSONReadOptions extends VFXJSONLimits {
  /** IDs to application-owned objects/functions. Default none; missing IDs reject. */
  bindings?: ReadonlyMap<string, unknown>;
}
/** URL loader settings, with cancellation propagated to fetch and checked before creating the effect. */
export interface VFXJSONLoadOptions extends VFXJSONReadOptions {
  /** Cancels the request and effect creation. Default none. */
  signal?: AbortSignal;
}
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
const keys: Record<keyof VFXOptions, true> = {
  capacity: true,
  initialCount: true,
  rate: true,
  position: true,
  velocity: true,
  spread: true,
  gravity: true,
  color: true,
  size: true,
  lifetime: true,
  ground: true,
  bounce: true,
  turbulence: true,
  frequency: true,
  angularVelocity: true,
  emissionExtent: true,
  intensity: true,
  obstacles: true,
  wrap: true,
  sort: true,
  softness: true,
  depth: true,
  texture: true,
  curves: true,
  emitter: true,
  space: true,
  overLife: true,
  schedule: true,
  ribbons: true,
  mesh: true,
  events: true,
  lit: true,
  depthCollide: true,
  stretch: true,
  fields: true,
  skinned: true,
  flipbook: true,
  shadows: true,
  nodes: true,
};
const constructors = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
};
const forbidden = (key: string) => ['__proto__', 'prototype', 'constructor', '$margo'].includes(key);
const help = 'https://margoengine.com/errors#vfx-json';
function limits(options: VFXJSONLimits): { maxChars: number; visit: (depth: number) => void } {
  const maxChars = options.maxChars ?? 512 * 1024 * 1024,
    maxNodes = options.maxNodes ?? 100_000_000,
    maxDepth = options.maxDepth ?? 64;
  for (const n of [maxChars, maxNodes, maxDepth])
    if (!Number.isSafeInteger(n) || n < 1)
      throw new RangeError('VFX JSON limits must be positive safe integers; choose finite budgets');
  let nodes = 0;
  return {
    maxChars,
    visit(depth) {
      if (++nodes > maxNodes || depth > maxDepth)
        throw new RangeError('VFX JSON exceeds its node/depth budget; simplify the preset or increase the limits');
    },
  };
}
function check(preset: VFXPreset): void {
  if (preset.version !== 1)
    throw new MargoError('version', `VFX JSON version is unsupported; migrate to version 1; see ${help}`);
  if (!preset.options || typeof preset.options !== 'object' || Array.isArray(preset.options))
    throw new TypeError('VFX JSON options must be an object; pass effect settings');
  for (const key of Object.keys(preset.options))
    if (!Object.hasOwn(keys, key)) throw new TypeError(`VFX JSON unknown option ${key}; use a documented VFX option`);
  // Validate through the owner, including every optional feature. No GPU resources are created before attachment.
  const probe = new VFX(preset.options);
  try {
    probe.setFog(preset.fog);
  } finally {
    probe.dispose();
  }
}
/** Save complete authoring settings as stable, versioned JSON; typed arrays and negative zero retain their values.
 * @throws TypeError or RangeError for invalid settings, cycles or limits; MargoError for unbound external resources.
 */
export function serializeEffect(
  source: VFXOptions | Pick<Base, 'options' | 'fog'>,
  options: VFXJSONWriteOptions = {},
): string {
  if (!source || typeof source !== 'object')
    throw new TypeError('VFX JSON source must be an effect or options object; pass its authoring settings');
  const budget = limits(options),
    active = new Set<object>(),
    ids = new Set<string>();
  for (const id of options.references?.values() ?? []) {
    if (typeof id !== 'string' || !id || ids.has(id))
      throw new TypeError('VFX JSON reference IDs must be nonempty and unique; give each resource its own ID');
    ids.add(id);
  }
  const encode = (value: unknown, depth: number, path: string): JSONValue => {
    budget.visit(depth);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError(`VFX JSON ${path} must be finite; replace NaN or Infinity`);
      return Object.is(value, -0) ? { $margo: 'negative-zero' } : value;
    }
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      const id = options.references?.get(value as object);
      if (id !== undefined) return { $margo: 'reference', id };
    }
    if (typeof value !== 'object' || value === null)
      throw new MargoError(
        'unsupported',
        `VFX JSON ${path} cannot be embedded; provide an explicit resource reference; see ${help}`,
      );
    if (active.has(value))
      throw new TypeError(`VFX JSON ${path} is cyclic; use a resource reference or remove the cycle`);
    active.add(value);
    try {
      if (value instanceof ArrayBuffer)
        return { $margo: 'ArrayBuffer', data: encode(Array.from(new Uint8Array(value)), depth + 1, path) };
      if (ArrayBuffer.isView(value)) {
        const name = value.constructor.name;
        if (!Object.hasOwn(constructors, name))
          throw new MargoError(
            'unsupported',
            `VFX JSON ${name} is unsupported; use a numeric typed array or resource reference; see ${help}`,
          );
        return { $margo: name, data: encode(Array.from(value as unknown as ArrayLike<number>), depth + 1, path) };
      }
      if (Array.isArray(value)) return Array.from(value, (v, i) => encode(v, depth + 1, `${path}[${i}]`));
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw new MargoError(
          'unsupported',
          `VFX JSON ${path} is an external object; bind it by reference; see ${help}`,
        );
      const out: { [key: string]: JSONValue } = {};
      for (const key of Object.keys(value).sort()) {
        if (forbidden(key)) throw new TypeError(`VFX JSON reserved key ${key}; rename the authoring property`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor))
          throw new TypeError(`VFX JSON ${path}.${key} is an accessor; supply a data value or reference`);
        if (descriptor.value !== undefined) out[key] = encode(descriptor.value, depth + 1, `${path}.${key}`);
      }
      return out;
    } finally {
      active.delete(value);
    }
  };
  const isEffect = 'options' in source,
    preset: VFXPreset = { version: 1, options: isEffect ? source.options : source, fog: isEffect ? source.fog : null };
  if (preset.fog && !options.references?.has(preset.fog)) {
    const fog: Record<string, unknown> = {};
    for (const key of ['color', 'near', 'far', 'density', 'heightFalloff', 'height', 'enabled'] as const)
      if (preset.fog[key] !== undefined) fog[key] = preset.fog[key];
    preset.fog = fog as FogLike;
  }
  const data = encode({ format: 'margo-vfx', version: 1, options: preset.options, fog: preset.fog }, 0, 'effect');
  check(preset);
  const text = JSON.stringify(data);
  if (text.length > budget.maxChars)
    throw new RangeError('VFX JSON exceeds maxChars; reduce assets or increase the text limit');
  return text;
}
/** Decode and validate an effect document, including typed arrays, fog and explicit resource bindings.
 * @throws TypeError or RangeError for malformed data/settings; MargoError for unknown versions or unresolved bindings.
 */
export function parseEffect(text: string, options: VFXJSONReadOptions = {}): VFXPreset {
  const budget = limits(options);
  if (typeof text !== 'string' || text.length > budget.maxChars)
    throw new RangeError('VFX JSON needs text within maxChars; pass a smaller JSON string');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new TypeError('VFX JSON syntax is invalid; correct the JSON text', { cause });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new TypeError('VFX JSON document must be an object; provide a saved effect');
  const raw = document as Record<string, unknown>;
  if (raw.format !== 'margo-vfx') throw new TypeError('VFX JSON format must be margo-vfx; provide a saved effect');
  if (raw.version !== 1)
    throw new MargoError('version', `VFX JSON version is unsupported; migrate to version 1; see ${help}`);
  if (Object.keys(raw).some((k) => !['format', 'version', 'options', 'fog'].includes(k)))
    throw new TypeError('VFX JSON has unknown document fields; use format, version, options and fog');
  const decode = (value: unknown, depth: number): unknown => {
    budget.visit(depth);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError('VFX JSON numbers must be finite; correct the value');
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => decode(v, depth + 1));
    if (!value || typeof value !== 'object') throw new TypeError('VFX JSON value is invalid; use supported JSON data');
    const record = value as Record<string, unknown>,
      tag = record.$margo;
    if (tag !== undefined) {
      if (tag === 'negative-zero' && Object.keys(record).length === 1) return -0;
      if (tag === 'reference' && Object.keys(record).length === 2 && typeof record.id === 'string') {
        if (!options.bindings?.has(record.id))
          throw new MargoError('state', `VFX JSON resource ${record.id} is missing; supply its binding; see ${help}`);
        return options.bindings.get(record.id);
      }
      if (
        typeof tag === 'string' &&
        (tag === 'ArrayBuffer' || Object.hasOwn(constructors, tag)) &&
        Object.keys(record).length === 2 &&
        Array.isArray(record.data)
      ) {
        const data = decode(record.data, depth + 1) as number[];
        if (!data.every((v) => typeof v === 'number' && Number.isFinite(v)))
          throw new TypeError('VFX JSON typed data needs finite numbers; correct the array');
        const Ctor = tag === 'ArrayBuffer' ? Uint8Array : constructors[tag as keyof typeof constructors],
          out = new Ctor(data);
        if (data.some((v, i) => !Object.is(v, out[i])))
          throw new RangeError('VFX JSON typed data is out of range or loses precision; use exact values for its type');
        return tag === 'ArrayBuffer' ? out.buffer : out;
      }
      throw new TypeError('VFX JSON contains an invalid typed/reference tag; use a supported saved value');
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (forbidden(key)) throw new TypeError(`VFX JSON reserved key ${key}; remove it`);
      out[key] = decode(record[key], depth + 1);
    }
    return out;
  };
  const preset: VFXPreset = {
    version: 1,
    options: decode(raw.options, 0) as VFXOptions,
    fog: raw.fog === undefined ? null : (decode(raw.fog, 0) as FogLike | null),
  };
  check(preset);
  return preset;
}
/** Make an unattached effect from saved JSON or an already decoded preset. The caller owns and disposes it.
 * @throws TypeError, RangeError or MargoError for invalid presets, versions, bindings or limits.
 */
export function createEffect(source: string | VFXPreset, options: VFXJSONReadOptions = {}): VFX {
  const preset = typeof source === 'string' ? parseEffect(source, options) : source;
  check(preset);
  return new VFX(preset.options).setFog(preset.fog);
}
/** Fetch a saved effect and create it unattached. Uses the platform fetch; AbortSignal cancels all creation.
 * @throws MargoError on a failed HTTP response; propagates fetch/abort and document validation errors.
 */
export async function loadEffect(url: string | URL, options: VFXJSONLoadOptions = {}): Promise<VFX> {
  options.signal?.throwIfAborted();
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok)
    throw new MargoError('failed', `VFX JSON request returned ${response.status}; check the URL; see ${help}`);
  const text = await response.text();
  options.signal?.throwIfAborted();
  return createEffect(text, options);
}
