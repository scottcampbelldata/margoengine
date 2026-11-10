import { PbrMaterial as CoreMaterial } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { Material, Texture, CubeTexture, loadTexture, loadCubeTexture, type TextureSource } from './built-material.js';
import * as kinds from './material-classes.js';
import { WgslMaterial } from './wgsl-material.js';
import { alphaHash } from './alpha-hash.js';
import { objectNormal } from './object-normal.js';
import { hair } from './hair.js';
import { eye } from './eye.js';
import { skin } from './skin.js';
import { layered } from './layered.js';
import { stochasticTiling } from './stochastic.js';

/** Serialized reference or primitive. Non-JSON numeric values retain their exact meaning. */
export type MaterialValue = null | boolean | string | number | { ref: number } | { special: string };
/** Versioned material and resource graph. Sharing is retained across all named materials. */
export interface MaterialLibrary {
  version: 1;
  materials: Record<string, MaterialValue>;
  objects: { type: string; data: MaterialValue | MaterialValue[] | Record<string, MaterialValue> }[];
}
/** Owner-provided encoding for a runtime type. Data can contain shared textures or other registered values. */
export interface MaterialValueCodec {
  type: string;
  test(value: object): boolean;
  capture(value: never): unknown | Promise<unknown>;
  restore(data: never): object | Promise<object>;
}
/** Portable material capture. URL sources and external resource keys are explicit, never inferred from GPU handles. */
export interface MaterialCaptureOptions {
  codecs?: readonly MaterialValueCodec[];
  /** Load a type owner's codecs only when an unknown runtime type is reached. Default none. */
  loadCodecs?(value: object): Promise<readonly MaterialValueCodec[]>;
  /** A texture stored by address instead of embedded pixels. Default embed its source. */
  textureURL?(texture: Texture): string | readonly string[] | undefined;
  /** Key for app-owned resources, callbacks or custom types. Default reject unsupported values. */
  externalKey?(value: object | ((...args: never[]) => unknown)): string | undefined;
  signal?: AbortSignal;
}
/** Restoration resolves optional type owners, URL textures and explicitly named external resources. */
export interface MaterialRestoreOptions {
  codecs?: readonly MaterialValueCodec[];
  loadCodecs?(type: string): Promise<readonly MaterialValueCodec[]>;
  resolveExternal?(key: string, options: { signal?: AbortSignal }): object | Promise<object>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}
const fail = (message: string): never => {
  throw new MargoError('state', message + '; use matching owner codecs and a version 1 material library');
};
const classes = { Material, ...kinds };
const constructors = new Map(Object.entries(classes).map(([name, Class]) => [Class, name]));
const featureFactories = { alphaHash, objectNormal, hair, eye, skin, layered, stochasticTiling };
const typed = {
  Uint8Array,
  Uint8ClampedArray,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};
const baseKeys = Object.keys(new Material()).filter((key) => key !== 'changes' && key !== 'addedStamp');
/** Complete base-material parameters, including dormant physical values and every UV row. Owner format version 1. */
export function materialParameters(material: Material): Record<string, unknown> {
  return {
    ...Object.fromEntries(baseKeys.map((key) => [key, Reflect.get(material, key)])),
    featureStates: material.features.map((feature) => feature.captureState?.(material)),
  };
}
/** Apply a decoded base snapshot while preserving live colour accessors and invalidating GPU copies. */
export function restoreMaterialParameters(material: Material, parameters: Record<string, unknown>): void {
  if (
    !parameters ||
    Object.keys(parameters).length !== baseKeys.length + 1 ||
    !Array.isArray(parameters.featureStates) ||
    baseKeys.some((key) => !Object.hasOwn(parameters, key))
  )
    fail('Material parameter schema does not match');
  const source = new Material({ shading: parameters.shading as Material['shading'] });
  for (const key of baseKeys) Reflect.set(source, key, parameters[key]);
  material.copy(source);
  // copy preserves live colour arrays; attach restored features to their new owner.
  const features = material.features;
  Reflect.set(material, 'added', []);
  material.features = features;
  const states = parameters.featureStates as unknown[];
  if (states.length !== features.length) fail('Material feature state count does not match');
  features.forEach((feature, index) => feature.restoreState?.(material, states[index]));
}
/** Built-in material codecs. Shader owners supply their additional codecs separately. */
export const materialValueCodecs: readonly MaterialValueCodec[] = [
  {
    type: 'core-material',
    test: (v) => v.constructor === CoreMaterial,
    capture: (m: CoreMaterial) => m.data,
    restore: (data: Float32Array) => {
      const result = new CoreMaterial();
      if (!(data instanceof Float32Array) || data.length !== result.data.length)
        return fail('Invalid core material data');
      result.data.set(data);
      return result;
    },
  },
  {
    type: 'material',
    test: (v) => constructors.has(v.constructor as typeof Material),
    capture: (m: Material) => ({
      kind: constructors.get(m.constructor as typeof Material),
      parameters: materialParameters(m),
    }),
    restore: (data: { kind: keyof typeof classes; parameters: Record<string, unknown> }) => {
      const Class = Object.hasOwn(classes, data.kind) ? classes[data.kind] : undefined;
      if (!Class) return fail('Unknown material kind');
      const result = new Class();
      restoreMaterialParameters(result, data.parameters);
      return result;
    },
  },
  {
    type: 'wgsl-material',
    test: (v) => v.constructor === WgslMaterial,
    capture: (m: WgslMaterial) => ({
      parameters: materialParameters(m),
      wgsl: m.wgsl,
      uniforms: m.uniforms,
      textures: m.textures,
    }),
    restore: (data: { parameters: Record<string, unknown>; wgsl: string; uniforms: never; textures: never }) => {
      const result = new WgslMaterial(data);
      restoreMaterialParameters(result, data.parameters);
      return result;
    },
  },
  {
    type: 'material-feature',
    test: (v) => typeof Reflect.get(v, 'serialization') === 'function',
    capture: (v: { name: string; serialization(): unknown }) => ({ kind: v.name, options: v.serialization() }),
    restore: (data: { kind: keyof typeof featureFactories; options: never }) => {
      if (!Object.hasOwn(featureFactories, data.kind)) return fail('Unknown material feature');
      return featureFactories[data.kind](data.options);
    },
  },
];
const image = (v: object) =>
  [
    'ImageBitmap',
    'HTMLImageElement',
    'HTMLCanvasElement',
    'OffscreenCanvas',
    'HTMLVideoElement',
    'VideoFrame',
    'ImageData',
  ].some((key) => {
    const Class = Reflect.get(globalThis, key);
    return typeof Class === 'function' && v instanceof Class;
  });
/** Capture every named material, shared texture and shader parameter without changing the originals. */
export async function captureMaterialLibrary(
  materials: Readonly<Record<string, object>>,
  options: MaterialCaptureOptions = {},
): Promise<MaterialLibrary> {
  const objects: MaterialLibrary['objects'] = [],
    seen = new Map<object, number>();
  const codecs = [...(options.codecs ?? []), ...materialValueCodecs];
  const encode = async (value: unknown): Promise<MaterialValue> => {
    options.signal?.throwIfAborted();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (value === undefined) return { special: 'undefined' };
    if (typeof value === 'number')
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : { special: String(Object.is(value, -0) ? '-0' : value) };
    if ((typeof value !== 'object' && typeof value !== 'function') || !value)
      return fail('Unsupported material parameter');
    const object = value as object,
      previous = seen.get(object);
    if (previous !== undefined) return { ref: previous };
    const ref = objects.length,
      slot: MaterialLibrary['objects'][number] = { type: '', data: null };
    seen.set(object, ref);
    objects.push(slot);
    const external = options.externalKey?.(object);
    let payload: unknown;
    if (external !== undefined) {
      slot.type = 'external';
      slot.data = external;
      return { ref };
    }
    if (value instanceof Texture) {
      const url = options.textureURL?.(value);
      slot.type = 'texture';
      payload = {
        cube: value instanceof CubeTexture,
        options: value.options,
        source: url === undefined ? value.source : { url },
      };
    } else if (ArrayBuffer.isView(value)) {
      slot.type = 'typed';
      payload = {
        kind: value.constructor.name,
        buffer: value.buffer,
        byteOffset: value.byteOffset,
        byteLength: value.byteLength,
      };
    } else if (value instanceof ArrayBuffer) {
      slot.type = 'buffer';
      slot.data = Array.from(new Uint8Array(value));
      return { ref };
    } else if (image(object)) {
      const src = value as {
        width: number;
        height: number;
        data?: Uint8ClampedArray;
        videoWidth?: number;
        videoHeight?: number;
        displayWidth?: number;
        displayHeight?: number;
      };
      let pixels = src.data;
      const width = src.videoWidth ?? src.displayWidth ?? src.width,
        height = src.videoHeight ?? src.displayHeight ?? src.height;
      if (!pixels) {
        const canvas = new OffscreenCanvas(width, height),
          context = canvas.getContext('2d')!;
        context.drawImage(object as CanvasImageSource, 0, 0);
        pixels = context.getImageData(0, 0, width, height).data;
      }
      slot.type = 'pixels';
      payload = { width, height, data: pixels };
    } else if (Array.isArray(value)) {
      slot.type = 'array';
      slot.data = [];
      for (const item of value) slot.data.push(await encode(item));
      return { ref };
    } else {
      let codec = codecs.find((c) => c.test(object));
      if (!codec && Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) {
        codecs.unshift(...((await options.loadCodecs?.(object)) ?? []));
        codec = codecs.find((c) => c.test(object));
      }
      if (codec) {
        slot.type = codec.type;
        payload = await codec.capture(value as never);
      } else if (Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null) {
        slot.type = 'object';
        slot.data = {};
        for (const [key, item] of Object.entries(object))
          Object.defineProperty(slot.data, key, {
            value: await encode(item),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        return { ref };
      } else return fail('Unsupported material runtime type ' + value.constructor?.name);
    }
    slot.data = await encode(payload);
    return { ref };
  };
  const roots: Record<string, MaterialValue> = {};
  for (const [name, material] of Object.entries(materials))
    Object.defineProperty(roots, name, { value: await encode(material), enumerable: true });
  return { version: 1, materials: roots, objects };
}
/** Restore a detached library. Abort and failure dispose constructed material/texture resources. */
export async function restoreMaterialLibrary(
  library: MaterialLibrary,
  options: MaterialRestoreOptions = {},
): Promise<Record<string, object>> {
  if (
    library?.version !== 1 ||
    !Array.isArray(library.objects) ||
    !library.materials ||
    typeof library.materials !== 'object'
  )
    return fail('Invalid material library');
  const codecs = [...(options.codecs ?? []), ...materialValueCodecs],
    values = new Map<number, object>(),
    pending = new Set<number>(),
    owned: object[] = [];
  const special: Record<string, unknown> = { undefined, Infinity, '-Infinity': -Infinity, NaN, '-0': -0 };
  const decode = async (value: MaterialValue): Promise<unknown> => {
    options.signal?.throwIfAborted();
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return value;
    if (!value || typeof value !== 'object') return fail('Invalid material value');
    if ('special' in value)
      return Object.hasOwn(special, value.special) ? special[value.special] : fail('Invalid special material value');
    const ref = value.ref;
    if (!Number.isInteger(ref) || ref < 0 || ref >= library.objects.length) return fail('Invalid material reference');
    if (values.has(ref)) return values.get(ref);
    if (pending.has(ref)) return fail('Cyclic material owner payload');
    const row = library.objects[ref];
    if (!row || typeof row.type !== 'string') return fail('Invalid material object');
    pending.add(ref);
    let result: object;
    if (row.type === 'array' || row.type === 'object') {
      result = row.type === 'array' ? [] : {};
      values.set(ref, result);
      if (row.type === 'array') {
        if (!Array.isArray(row.data)) return fail('Invalid material array');
        for (const v of row.data) (result as unknown[]).push(await decode(v));
      } else {
        if (!row.data || Array.isArray(row.data) || typeof row.data !== 'object')
          return fail('Invalid material object fields');
        for (const [k, v] of Object.entries(row.data))
          Object.defineProperty(result, k, {
            value: await decode(v),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
    } else if (row.type === 'external') {
      if (typeof row.data !== 'string' || !options.resolveExternal) return fail('Missing external resource resolver');
      result = await options.resolveExternal(row.data, { signal: options.signal });
    } else if (row.type === 'buffer') {
      if (
        !Array.isArray(row.data) ||
        row.data.some((v) => typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255)
      )
        return fail('Invalid material bytes');
      result = new Uint8Array(row.data as number[]).buffer;
    } else {
      const data = (await decode(row.data as MaterialValue)) as Record<string, unknown>;
      if (row.type === 'typed') {
        const Class = Object.hasOwn(typed, data.kind as string) ? typed[data.kind as keyof typeof typed] : undefined;
        if (
          !Class ||
          !(data.buffer instanceof ArrayBuffer) ||
          !Number.isInteger(data.byteOffset) ||
          !Number.isInteger(data.byteLength)
        )
          return fail('Invalid typed material bytes');
        const stride = Reflect.get(Class, 'BYTES_PER_ELEMENT') ?? 1;
        result = new (
          Class as unknown as { new (buffer: ArrayBuffer, offset: number, length: number): ArrayBufferView }
        )(data.buffer, data.byteOffset as number, (data.byteLength as number) / stride);
      } else if (row.type === 'pixels') result = data;
      else if (row.type === 'texture') {
        const source = data.source as { url?: string };
        if (source && (typeof source.url === 'string' || Array.isArray(source.url)))
          result = data.cube
            ? await loadCubeTexture(source.url, {
                ...(data.options as object),
                signal: options.signal,
                fetch: options.fetch,
              })
            : await loadTexture(source.url, {
                ...(data.options as object),
                signal: options.signal,
                fetch: options.fetch,
              });
        else if (data.cube) {
          const cube = data.source as { faces?: never; equirect?: Texture; size?: number };
          result = new CubeTexture(cube.faces ?? cube.equirect ?? (data.source as never), {
            ...(data.options as object),
            ...(cube.size === undefined ? {} : { size: cube.size }),
          });
        } else result = new Texture(data.source as TextureSource, data.options as never);
        owned.push(result);
      } else {
        let codec = codecs.find((c) => c.type === row.type);
        if (!codec) {
          codecs.unshift(...((await options.loadCodecs?.(row.type)) ?? []));
          codec = codecs.find((c) => c.type === row.type);
        }
        if (!codec) return fail('Unknown material type ' + row.type);
        result = await codec.restore(data as never);
        owned.push(result);
      }
    }
    values.set(ref, result);
    pending.delete(ref);
    return result;
  };
  try {
    const result: Record<string, object> = {};
    for (const [name, value] of Object.entries(library.materials))
      Object.defineProperty(result, name, { value: await decode(value), enumerable: true });
    options.signal?.throwIfAborted();
    return result;
  } catch (error) {
    const errors: unknown[] = [error];
    for (const value of owned.reverse()) {
      try {
        const dispose = Reflect.get(value, 'dispose');
        if (typeof dispose === 'function') dispose.call(value);
      } catch (failure) {
        errors.push(failure);
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Material restore and disposal failed');
    throw error;
  }
}
