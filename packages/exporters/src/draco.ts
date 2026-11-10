// compressDraco: a GLB in, the same GLB with KHR_draco_mesh_compression geometry out.
// The optional Rust/Wasm encoder loads on the first compression call.
import {
  encodeDracoMesh,
  type DracoEncoded,
  type DracoEncoderModule,
  type DracoJob,
  type DracoJobAttribute,
  type DracoKind,
} from './draco-encode.js';
import { encoderFile, inProcess, inWorker, loadInNode, type EncoderRequest, type ModuleBox } from './encoder-host.js';
import { joinGLB, readAccessor, splitGLB, type AccessorValues } from './glb.js';
import { addView, packGLB, useExtension, type JSONObject, type NewViews } from './glb-pack.js';

const EXTENSION = 'KHR_draco_mesh_compression';

/** Options for {@link compressDraco}. Bits of 0 keep an attribute exact; integer attributes are always exact. */
export interface CompressDracoOptions {
  /** Quantization bits of POSITION, on one grid for all the primitives of a mesh, so their seams stay closed. Default 14. */
  positionBits?: number;
  /** Quantization bits of NORMAL, on Draco's octahedron. Default 10. */
  normalBits?: number;
  /** Quantization bits of float TEXCOORD_n. Default 12. */
  texcoordBits?: number;
  /** Quantization bits of float COLOR_n. Default 8. */
  colorBits?: number;
  /** Quantization bits of TANGENT. Default 12. */
  tangentBits?: number;
  /** Quantization bits of float WEIGHTS_n. Default 0: quantized weights no longer add up to 1. */
  weightBits?: number;
  /** From 0, the smallest file, to 10, the fastest encode. Default 5. */
  encodeSpeed?: number;
  /** From 0, the smallest file, to 10, the fastest decode. Default 5. */
  decodeSpeed?: number;
  /** Override with a folder holding a compatible draco_encoder_wrapper.js and draco_encoder.wasm. Default: bundled clean-room Wasm. */
  encoderPath?: string;
  /** Stops the encode. A browser ends the worker at once; Node stops between meshes. */
  signal?: AbortSignal;
}

/** A primitive {@link compressDraco} left as it was, and why. */
export interface DracoSkippedPrimitive {
  /** Index in `meshes`. */
  mesh: number;
  /** Index in the mesh's `primitives`. */
  primitive: number;
  reason: 'not-triangles' | 'morph-targets' | 'no-position' | 'already-compressed';
}

/** What {@link compressDraco} returns. */
export interface CompressDracoResult {
  /** The compressed file. The input bytes when no primitive could be compressed. */
  glb: Uint8Array;
  /** Primitives now held in Draco streams. */
  compressed: number;
  /** Primitives left uncompressed. */
  skipped: DracoSkippedPrimitive[];
}

const BITS: Record<string, [keyof CompressDracoOptions, number]> = {
  POSITION: ['positionBits', 14],
  NORMAL: ['normalBits', 10],
  TEXCOORD: ['texcoordBits', 12],
  COLOR: ['colorBits', 8],
  TANGENT: ['tangentBits', 12],
  WEIGHTS: ['weightBits', 0],
};

function bitsOf(options: CompressDracoOptions, name: keyof CompressDracoOptions, fallback: number): number {
  const bits = options[name] ?? fallback;
  if (!Number.isInteger(bits) || (bits as number) < 0 || (bits as number) > 30)
    throw new RangeError(`compressDraco ${name} must be a whole number from 0 to 30; 0 keeps the attribute exact`);
  return bits as number;
}

function speedOf(options: CompressDracoOptions, name: 'encodeSpeed' | 'decodeSpeed'): number {
  const speed = options[name] ?? 5;
  if (!Number.isInteger(speed) || speed < 0 || speed > 10)
    throw new RangeError(`compressDraco ${name} must be a whole number from 0 to 10`);
  return speed;
}

/** The Draco kind and option family of a glTF semantic; `_CUSTOM` and unknown data has no family and stays exact. */
function classify(semantic: string): { kind: DracoKind; family?: string } {
  const family = semantic.replace(/_\d+$/, '');
  if (semantic === 'POSITION' || semantic === 'NORMAL') return { kind: semantic, family };
  if (family === 'TEXCOORD') return { kind: 'TEX_COORD', family };
  if (family === 'COLOR') return { kind: 'COLOR', family };
  return { kind: 'GENERIC', family: family === 'TANGENT' || family === 'WEIGHTS' ? family : undefined };
}

/** Every accessor a reader may load without going through a compressed primitive, so its data must stay. */
function pinnedAccessors(json: JSONObject, compressing: ReadonlySet<JSONObject>): Set<number> {
  const pinned = new Set<number>(),
    pin = (index: unknown): void => {
      if (Number.isSafeInteger(index)) pinned.add(index as number);
    };
  for (const mesh of json.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      for (const target of primitive.targets ?? []) Object.values(target).forEach(pin);
      if (compressing.has(primitive)) continue;
      Object.values(primitive.attributes ?? {}).forEach(pin);
      pin(primitive.indices);
    }
  for (const skin of json.skins ?? []) pin(skin.inverseBindMatrices);
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      pin(sampler.input);
      pin(sampler.output);
    }
  // EXT_mesh_gpu_instancing and any other extension: an `attributes` table or a field named for accessors.
  const scan = (value: unknown, inExtension: boolean): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const [key, field] of Object.entries(value)) {
      if (key === EXTENSION) continue;
      if (inExtension && key === 'attributes' && typeof field === 'object' && field) Object.values(field).forEach(pin);
      else if (inExtension && /accessor/i.test(key)) pin(field);
      scan(field, inExtension || key === 'extensions');
    }
  };
  scan(json, false);
  return pinned;
}

/** A primitive's vertices cut down to the ones its triangles use, in first-use order, and the triangles renumbered. */
function compact(
  read: (index: number) => AccessorValues,
  primitive: JSONObject,
  points: number,
): { indices: Uint32Array; order: Uint32Array } {
  const source: ArrayLike<number> | undefined =
      primitive.indices === undefined ? undefined : read(primitive.indices).values,
    length = source ? source.length : points,
    triangles = length - (length % 3),
    next = new Int32Array(points).fill(-1),
    order = new Uint32Array(Math.min(points, triangles)),
    indices = new Uint32Array(triangles);
  let used = 0;
  for (let i = 0; i < triangles; i++) {
    const vertex = source ? source[i] : i;
    if (vertex >= points)
      throw new RangeError(`glTF index ${vertex} is past the ${points} vertices of its primitive; repair the GLB`);
    if (next[vertex] < 0) {
      next[vertex] = used;
      order[used++] = vertex;
    }
    indices[i] = next[vertex];
  }
  return { indices, order: order.subarray(0, used) };
}

const gather = ({ values, width }: AccessorValues, order: Uint32Array): AccessorValues['values'] => {
  const Values = values.constructor as new (length: number) => AccessorValues['values'],
    packed = new Values(order.length * width);
  for (let i = 0; i < order.length; i++)
    for (let c = 0; c < width; c++) packed[i * width + c] = values[order[i] * width + c];
  return packed;
};

/** A position grid: where Draco's quantizer puts the values of a primitive. */
interface Grid {
  origin: number[];
  range: number;
}

/** Where Draco's quantizer puts `value` on a grid, in its own 32-bit float steps. */
function onGrid(value: number, origin: number, range: number, bits: number): number {
  const steps = Math.fround(2 ** bits - 1),
    inverse = Math.fround(steps / range),
    delta = Math.fround(range / steps),
    level = Math.floor(Math.fround(Math.fround(Math.fround(value - origin) * inverse) + 0.5));
  return Math.fround(Math.fround(level * delta) + origin);
}

function bounds(positions: readonly Float32Array[]): { min: number[]; max: number[]; extent: number } {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const values of positions)
    for (let i = 0; i < values.length; i++) {
      const axis = i % 3;
      if (values[i] < min[axis]) min[axis] = values[i];
      if (values[i] > max[axis]) max[axis] = values[i];
    }
  return {
    min,
    max,
    extent: Math.max(Math.fround(max[0] - min[0]), Math.fround(max[1] - min[1]), Math.fround(max[2] - min[2])),
  };
}

/** The grid Draco works out by itself for one primitive: its own minimum and its widest axis. */
function ownGrid(position: Float32Array): Grid {
  const { min, extent } = bounds([position]);
  return { origin: min, range: extent || 1 };
}

/** What a float becomes on its way through Draco's options, which hold it as text with six decimals. */
const asOption = (value: number): number => Math.fround(Number(Math.fround(value).toFixed(6)));

/** The widest mesh a grid given as text would serve badly: its origin and range land on steps of a millionth. */
const SMALLEST_SHARED_GRID = 1e-3;

/**
 * The grid the primitives of a mesh share, so a seam between them rounds the same way on both sides; undefined when
 * they need none (one primitive) or cannot have one. Draco reads an explicit grid from text, so both numbers are chosen
 * to survive that, with the origin at or below the minimum and the range reaching past the maximum.
 */
function sharedGrid(positions: readonly Float32Array[]): Grid | undefined {
  if (positions.length < 2) return undefined;
  const { min, max, extent } = bounds(positions);
  if (extent < SMALLEST_SHARED_GRID) return undefined;
  const below = (value: number): number => {
      let option = asOption(value);
      for (let step = 1; option > value; step++) option = asOption(value - step * 1e-6);
      return option;
    },
    origin = min.map(below),
    needed = Math.max(max[0] - origin[0], max[1] - origin[1], max[2] - origin[2]);
  let range = asOption(needed);
  for (let step = 1; range < needed; step++) range = asOption(needed + step * 1e-6);
  return { origin, range };
}

interface Planned {
  primitives: JSONObject[];
  semantics: string[];
  job: DracoJob;
  position: Float32Array;
  grid?: Grid;
  bits: number;
}

let native: Promise<import('./draco-native-encode.js').NativeDracoEncoder> | undefined;

/**
 * Compresses the triangle geometry of a GLB with Draco, as KHR_draco_mesh_compression. Attributes are quantized as
 * {@link CompressDracoOptions} says, so the result is smaller and close to the input, not equal to it; a primitive that
 * shares its vertices and indices with another is stored once. Everything else in the file is kept: materials, images,
 * skins, animations, extensions, extras and any data a compressed primitive no longer needs is dropped.
 *
 * Draco holds no morph targets and may reorder vertices, so a primitive with targets stays uncompressed, as do points,
 * lines, strips and fans. Each one is listed in the result's `skipped`.
 *
 * @example
 * ```ts
 * import { exportGLB } from '@margoengine/exporters';
 * import { compressDraco } from '@margoengine/exporters/draco';
 *
 * const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
 * const { glb } = await compressDraco(exportGLB({ nodes: [{ geometry: { positions, indices: [0, 1, 2, 0, 2, 3] } }] }));
 * ```
 * @throws TypeError when `glb` is not a valid GLB or holds meshopt buffers; RangeError for an option out of range or
 * an index past its vertices; the signal's reason when aborted.
 */
export async function compressDraco(glb: Uint8Array, options: CompressDracoOptions = {}): Promise<CompressDracoResult> {
  const bits = Object.fromEntries(
      Object.entries(BITS).map(([family, [name, fallback]]) => [family, bitsOf(options, name, fallback)]),
    ),
    encodeSpeed = speedOf(options, 'encodeSpeed'),
    decodeSpeed = speedOf(options, 'decodeSpeed'),
    { signal } = options;
  signal?.throwIfAborted();
  const parts = splitGLB(glb),
    json = parts.json as JSONObject;
  if (json.bufferViews?.some((view: JSONObject) => view.extensions?.EXT_meshopt_compression))
    throw new TypeError('compressDraco cannot read meshopt buffers; compress the GLB before EXT_meshopt_compression');
  const skipped: DracoSkippedPrimitive[] = [],
    compressing = new Set<JSONObject>(),
    meshes: JSONObject[] = json.meshes ?? [];
  meshes.forEach((mesh, meshIndex) =>
    (mesh.primitives ?? []).forEach((primitive: JSONObject, primitiveIndex: number) => {
      const reason = primitive.extensions?.[EXTENSION]
        ? 'already-compressed'
        : (primitive.mode ?? 4) !== 4
          ? 'not-triangles'
          : primitive.targets?.length
            ? 'morph-targets'
            : primitive.attributes?.POSITION === undefined
              ? 'no-position'
              : undefined;
      if (reason) skipped.push({ mesh: meshIndex, primitive: primitiveIndex, reason });
      else compressing.add(primitive);
    }),
  );
  if (!compressing.size) return { glb, compressed: 0, skipped };

  // One stream per distinct vertex and index set: primitives that differ only in material share it.
  const planned = new Map<string, Planned>(),
    cache = new Map<number, AccessorValues>(),
    read = (index: number): AccessorValues => {
      let values = cache.get(index);
      if (!values) cache.set(index, (values = readAccessor(parts, index)));
      return values;
    };
  for (const mesh of meshes) {
    const own: Planned[] = [];
    for (const primitive of mesh.primitives ?? []) {
      if (!compressing.has(primitive)) continue;
      const semantics = Object.keys(primitive.attributes).sort(),
        key = JSON.stringify([primitive.indices, semantics.map((name) => [name, primitive.attributes[name]])]),
        known = planned.get(key);
      if (known) {
        known.primitives.push(primitive);
        continue;
      }
      const position = read(primitive.attributes.POSITION),
        { indices, order } = compact(read, primitive, position.count),
        attributes: DracoJobAttribute[] = semantics.map((semantic) => {
          const values = read(primitive.attributes[semantic]),
            { kind, family } = classify(semantic);
          if (values.count !== position.count)
            throw new RangeError(
              `glTF attribute ${semantic} has ${values.count} values for ${position.count} vertices; repair the GLB`,
            );
          return {
            semantic,
            kind,
            values: gather(values, order),
            width: values.width,
            normalized: values.normalized,
            bits: family ? bits[family] : 0,
          };
        }),
        entry: Planned = {
          primitives: [primitive],
          semantics,
          job: { indices, points: order.length, attributes, encodeSpeed, decodeSpeed },
          position: attributes[semantics.indexOf('POSITION')].values as Float32Array,
          bits: bits.POSITION,
        };
      planned.set(key, entry);
      own.push(entry);
    }
    // Integer positions (KHR_mesh_quantization) are stored exactly, so only float ones take a grid.
    const floats = own.filter(({ position }) => position instanceof Float32Array);
    if (!bits.POSITION) continue;
    const shared = sharedGrid(floats.map(({ position }) => position));
    for (const entry of floats) {
      entry.grid = shared ?? ownGrid(entry.position);
      if (shared) entry.job.attributes[entry.semantics.indexOf('POSITION')].grid = shared;
    }
  }

  // Before the encoder runs: a worker takes the arrays with it.
  const entries = [...planned.values()],
    positionBounds = entries.map(({ position, grid, bits: positionBits }) => {
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < position.length; v++) {
        const axis = v % 3,
          value = grid ? onGrid(position[v], grid.origin[axis], grid.range, positionBits) : position[v];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
      return { min, max };
    }),
    results = await encode(
      entries.map(({ job }) => job),
      options,
    ),
    pinned = pinnedAccessors(json, compressing),
    claimed = new Set<number>(),
    views: NewViews = new Map();
  json.accessors ??= [];
  /** The accessor a stream's values fill: the old one when nothing else needs it, else a copy. */
  const slot = (index: number | undefined, fields: JSONObject): number => {
    const fresh = index === undefined || pinned.has(index) || claimed.has(index),
      {
        bufferView: _view,
        byteOffset: _offset,
        sparse: _sparse,
        min: _min,
        max: _max,
        ...kept
      } = index === undefined ? ({} as JSONObject) : json.accessors[index],
      accessor = { ...kept, ...fields };
    if (fresh) {
      json.accessors.push(accessor);
      return json.accessors.length - 1;
    }
    claimed.add(index);
    json.accessors[index] = accessor;
    return index;
  };
  entries.forEach(({ primitives, semantics }, i) => {
    const { data, ids, points, faces } = results[i],
      bufferView = addView(json, views, data),
      first = primitives[0],
      attributes = Object.fromEntries(
        semantics.map((semantic) => [
          semantic,
          slot(first.attributes[semantic], { count: points, ...(semantic === 'POSITION' ? positionBounds[i] : {}) }),
        ]),
      ),
      indices = slot(first.indices, {
        type: 'SCALAR',
        componentType: points > 0xffff ? 5125 : 5123,
        count: faces * 3,
      });
    for (const primitive of primitives) {
      primitive.attributes = { ...attributes };
      primitive.indices = indices;
      primitive.extensions = { ...primitive.extensions, [EXTENSION]: { bufferView, attributes: ids } };
    }
  });
  useExtension(json, EXTENSION, true);
  return { glb: joinGLB(packGLB(parts, views)), compressed: compressing.size, skipped };
}

async function encode(jobs: DracoJob[], options: CompressDracoOptions): Promise<DracoEncoded[]> {
  if (options.encoderPath === undefined) {
    const wasmURL = new URL('./draco-native-encoder.wasm', import.meta.url).href;
    if (typeof Worker === 'undefined') {
      const { loadNativeEncoder, encodeNativeMesh } = await import('./draco-native-encode.js');
      native ??= loadNativeEncoder(wasmURL);
      const module = await native;
      return inProcess(jobs, (job) => encodeNativeMesh(module, job), options.signal);
    }
    return inWorker<DracoEncoded>(
      jobs.map((job) => ({ kind: 'draco-native', wrapperURL: '', wasmURL, job })),
      (request: EncoderRequest) => {
        const { indices, attributes } = request.job as DracoJob;
        return [indices.buffer as ArrayBuffer, ...attributes.map(({ values }) => values.buffer as ArrayBuffer)];
      },
      options.signal,
    );
  }
  const { encoderPath, signal } = options,
    wrapper = encoderFile(encoderPath, 'draco_encoder_wrapper.js'),
    wasm = encoderFile(encoderPath, 'draco_encoder.wasm');
  if (typeof Worker === 'undefined') {
    const start = (): Promise<ModuleBox<DracoEncoderModule>> => loadInNode<DracoEncoderModule>(wrapper, wasm);
    const { module } = await start();
    return inProcess(jobs, (job) => encodeDracoMesh(module, job), signal);
  }
  return inWorker<DracoEncoded>(
    jobs.map((job) => ({ kind: 'draco', wrapperURL: wrapper.href, wasmURL: wasm.href, job })),
    (request: EncoderRequest) => {
      const { indices, attributes } = request.job as DracoJob;
      return [indices.buffer as ArrayBuffer, ...attributes.map(({ values }) => values.buffer as ArrayBuffer)];
    },
    signal,
  );
}
