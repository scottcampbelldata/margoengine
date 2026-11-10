import { fault, rangeError } from '../../shared/errors.js';
import { openZarr, type ZarrArray } from './formats.js';
import { cloudCounts, openCloudZarr, requireCloudJSON, type CloudZarrOptions } from './cloud-zarr.js';
import { cloudJSON, cloudPath, cloudStore, type CloudInput, type CloudStore } from './cloud-store.js';
import { decodeCloudCodec } from './cloud-codecs.js';
import { precomputedChunk, segmentationBytes } from './cloud-precomputed.js';
import { decodeN5LZ4 } from './cloud-lz4-java.js';
import type { BrickRequest, BrickSource } from './bricks-plan.js';
import type { Bounds } from './layer.js';

type Triple = readonly [number, number, number];
type Metadata = Record<string, unknown>;
type StoredLevel = { path: string; array: ZarrArray; scale: number[]; translation: number[] };
const bad = (why: string) => rangeError(`Cloud volume: ${why}; check metadata and axis selection`, 'sciviz');
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const product = (values: readonly number[]) => values.reduce((a, b) => a * b, 1);
const triple = (values: number[]) => values as unknown as Triple;

/** One named NGFF axis, including its physical unit when provided. */
export interface CloudAxis {
  readonly name: string;
  readonly type?: string;
  readonly unit?: string;
}

/** Common cloud source options. Frames are selected by each BrickRequest; channel defaults to zero. */
export interface CloudVolumeOptions extends CloudZarrOptions {
  readonly channel?: number;
  /** Finite data range for the renderer, if known without scanning the entire cloud. */
  readonly range?: readonly [number, number];
  /** OME multiscale image index, default 0. */
  readonly image?: number;
  /** N5 dataset paths in finest-first order, when not supplied by group multiscales metadata. */
  readonly paths?: readonly string[];
}

/** A stored resolution, with axis transforms retained in source order. */
export interface CloudVolumeLevel {
  readonly path: string;
  readonly array: ZarrArray;
  readonly dims: Triple;
  readonly spacing: Triple;
  readonly origin: Triple;
  readonly scale: readonly number[];
  readonly translation: readonly number[];
  /** A standalone bricked source for this resolution. */
  readonly source: BrickSource;
}

/** A multiscale volume. Opening reads metadata only; source.read loads the requested spatial region. */
export interface CloudVolume {
  readonly format: 'ome-zarr' | 'n5' | 'precomputed';
  readonly axes: readonly CloudAxis[];
  readonly levels: readonly CloudVolumeLevel[];
  readonly bounds: Bounds;
  /** Existing brickedVolume-compatible dyadic LOD adapter using the nearest suitable stored resolution. */
  readonly source: BrickSource;
  readonly caption: string;
}

function transforms(input: unknown, rank: number, scale: number[], translation: number[]): void {
  if (input === undefined) return;
  if (!Array.isArray(input)) throw bad('coordinateTransformations must be a list');
  for (const transform of input as Metadata[]) {
    const type = transform.type;
    if (type !== 'scale' && type !== 'translation')
      throw fault(
        'unsupported',
        `Cloud transform ${String(type)} is not scale or translation; select supported NGFF metadata`,
        'sciviz',
      );
    const values = transform[type];
    if (
      !Array.isArray(values) ||
      values.length !== rank ||
      values.some((n) => typeof n !== 'number' || !Number.isFinite(n) || (type === 'scale' && n <= 0))
    )
      throw bad('invalid coordinate transform');
    for (let d = 0; d < rank; d++) {
      if (type === 'scale') {
        scale[d] *= values[d];
        translation[d] *= values[d];
      } else translation[d] += values[d];
    }
  }
}

function finish(
  format: CloudVolume['format'],
  axes: CloudAxis[],
  raw: { path: string; array: ZarrArray; scale: number[]; translation: number[] }[],
  options: CloudVolumeOptions,
): CloudVolume {
  if (
    axes.length < 2 ||
    new Set(axes.map((a) => a.name)).size !== axes.length ||
    !axes.some((a) => a.name === 'x') ||
    !axes.some((a) => a.name === 'y')
  )
    throw bad('axes must have distinct names including x and y');
  const xyz = ['x', 'y', 'z'].map((name) => axes.findIndex((a) => a.name === name));
  const ti = axes.findIndex((a) => a.name === 't'),
    ci = axes.findIndex((a) => a.name === 'c');
  const channel = options.channel ?? 0;
  if (!Number.isInteger(channel) || channel < 0 || (ci < 0 && channel !== 0)) throw bad('invalid channel');
  for (const value of raw) {
    if (value.array.shape.length !== axes.length || (ci >= 0 && channel >= value.array.shape[ci]))
      throw bad('array rank/channel differs from axes');
    axes.forEach((axis, d) => {
      if (!['x', 'y', 'z', 'c', 't'].includes(axis.name) && value.array.shape[d] !== 1)
        throw bad(`select singleton unknown axis ${axis.name}`);
    });
  }
  const frames = ti < 0 ? 1 : raw[0].array.shape[ti];
  if (raw.some((r) => ti >= 0 && r.array.shape[ti] !== frames)) throw bad('time dimensions differ across scales');
  const max = options.maxDecodedBytes ?? 64 * 1024 * 1024;
  const levels: CloudVolumeLevel[] = raw.map((r) => ({
    ...r,
    dims: triple(xyz.map((d) => (d < 0 ? 1 : r.array.shape[d]))),
    spacing: triple(xyz.map((d) => (d < 0 ? 1 : r.scale[d]))),
    origin: triple(xyz.map((d) => (d < 0 ? 0 : r.translation[d]))),
    source: undefined as unknown as BrickSource,
  }));
  const makeSource = (available: readonly CloudVolumeLevel[]): BrickSource => {
    const base = available[0];
    return {
      dims: base.dims,
      frames,
      range: options.range,
      async read(request: BrickRequest) {
        request.signal.throwIfAborted();
        if (
          !Number.isInteger(request.level) ||
          request.level < 0 ||
          request.level > 30 ||
          !Number.isInteger(request.frame) ||
          request.frame < 0 ||
          request.frame >= frames
        )
          throw bad('invalid brick level or frame');
        const factor = 2 ** request.level;
        if (
          request.size.length !== 3 ||
          request.origin.length !== 3 ||
          request.size.some(
            (n, d) =>
              !Number.isSafeInteger(n) ||
              n < 1 ||
              !Number.isSafeInteger(request.origin[d]) ||
              request.origin[d] < 0 ||
              request.origin[d] + n > Math.ceil(base.dims[d] / factor),
          )
        )
          throw bad('brick lies outside its level');
        if (product(request.size) * 4 > max) throw bad('brick output exceeds maxDecodedBytes');
        let selected = base;
        for (const level of available)
          if (level.spacing.every((n, d) => n <= base.spacing[d] * factor)) selected = level;
        const positions = request.size.map((n, d) =>
          Array.from({ length: n }, (_, i) =>
            Math.max(
              0,
              Math.min(
                selected.dims[d] - 1,
                Math.round(
                  (base.origin[d] + (request.origin[d] + i) * factor * base.spacing[d] - selected.origin[d]) /
                    selected.spacing[d],
                ),
              ),
            ),
          ),
        );
        const start = selected.array.shape.map(() => 0),
          stop = selected.array.shape.map(() => 1);
        xyz.forEach((axis, d) => {
          if (axis >= 0) {
            start[axis] = positions[d][0];
            stop[axis] = positions[d].at(-1)! + 1;
          }
        });
        if (ti >= 0) {
          start[ti] = request.frame;
          stop[ti] = request.frame + 1;
        }
        if (ci >= 0) {
          start[ci] = channel;
          stop[ci] = channel + 1;
        }
        const read = await selected.array.read({
          start,
          stop,
          signal: request.signal,
          maxSamples: Math.floor(max / 8),
        });
        const strides: number[] = new Array(axes.length);
        let stride = 1;
        for (let d = axes.length - 1; d >= 0; d--) {
          strides[d] = stride;
          stride *= read.shape[d];
        }
        const out = new Float32Array(product(request.size));
        for (let z = 0, w = 0; z < request.size[2]; z++)
          for (let y = 0; y < request.size[1]; y++)
            for (let x = 0; x < request.size[0]; x++, w++) {
              const coordinates = [x, y, z];
              let at = 0;
              xyz.forEach((axis, d) => {
                if (axis >= 0) at += (positions[d][coordinates[d]] - start[axis]) * strides[axis];
              });
              out[w] = read.data[at];
            }
        request.signal.throwIfAborted();
        return out;
      },
    };
  };
  for (let i = 0; i < levels.length; i++) (levels[i] as { source: BrickSource }).source = makeSource(levels.slice(i));
  const first = levels[0];
  const bounds = first.dims.flatMap((n, d) => [
    first.origin[d],
    first.origin[d] + (n - 1) * first.spacing[d],
  ]) as Bounds;
  return {
    format,
    axes,
    levels,
    bounds,
    source: makeSource(levels),
    caption:
      'Opening loads metadata only. Moving or zooming requests visible bricks at a suitable stored resolution; missing chunks use the fill value. Range reads fetch shard indexes and selected payloads. Decoded chunks are bounded; the renderer evicts bricks at its memory budget.',
  };
}

/** Opens OME-NGFF 0.4/v2 and 0.5/v3 groups, composing dataset transforms before group transforms. */
export async function openOMEZarr(
  input: CloudInput,
  path = '',
  options: CloudVolumeOptions = {},
): Promise<CloudVolume> {
  const store = cloudStore(input, options),
    root = cloudPath(path),
    prefix = root ? `${root}/` : '';
  const group = await cloudJSON(store, `${prefix}zarr.json`, options.signal);
  const attrs = group
    ? (group.attributes as Metadata)
    : await requireCloudJSON(store, `${prefix}.zattrs`, options.signal);
  const ome = (attrs?.ome ?? attrs) as Metadata;
  const multiscales = ome?.multiscales;
  const image = options.image ?? 0;
  if (!Array.isArray(multiscales) || !Number.isInteger(image) || image < 0 || image >= multiscales.length)
    throw bad('OME group has no selected multiscale image');
  const multi = multiscales[image] as Metadata,
    version = ome.version ?? multi.version;
  if (version !== '0.4' && version !== '0.5') throw bad('OME version must be 0.4 or 0.5');
  if ((version === '0.5') !== Boolean(group)) throw bad('OME version does not match Zarr storage version');
  if (!Array.isArray(multi.axes) || !Array.isArray(multi.datasets) || !multi.datasets.length)
    throw bad('OME axes/datasets are missing');
  const axes = multi.axes as CloudAxis[];
  if (axes.some((a) => !a || typeof a.name !== 'string')) throw bad('invalid OME axes');
  const raw: StoredLevel[] = [];
  for (const dataset of multi.datasets as Metadata[]) {
    if (typeof dataset.path !== 'string') throw bad('dataset has no path');
    const key = prefix + cloudPath(dataset.path),
      array = await openCloudZarr(store, key, options);
    const scale = axes.map(() => 1),
      translation = axes.map(() => 0);
    transforms(dataset.coordinateTransformations, axes.length, scale, translation);
    transforms(multi.coordinateTransformations, axes.length, scale, translation);
    raw.push({ path: key, array, scale, translation });
  }
  return finish('ome-zarr', axes, raw, options);
}

const types: Record<string, string> = {
  uint8: '|u1',
  int8: '|i1',
  uint16: '>u2',
  int16: '>i2',
  uint32: '>u4',
  int32: '>i4',
  uint64: '>u8',
  int64: '>i8',
  float32: '>f4',
  float64: '>f8',
};

async function virtualArray(
  store: CloudStore,
  shape: number[],
  chunks: number[],
  dtype: string,
  get: (index: number[], signal?: AbortSignal) => Promise<Uint8Array | undefined>,
  options: CloudVolumeOptions,
): Promise<ZarrArray> {
  const metadata = jsonBytes({
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
  });
  return openZarr(
    async (key, signal) =>
      key === '.zarray'
        ? metadata
        : key === 'zarr.json' || key === '.zattrs'
          ? undefined
          : get(key.split('.').map(Number), signal),
    '',
    options,
  );
}

/** Opens an N5 multiscale group (or explicit finest-first paths), with big-endian block headers and sparse chunks. */
export async function openN5(input: CloudInput, path = '', options: CloudVolumeOptions = {}): Promise<CloudVolume> {
  const store = cloudStore(input, options),
    root = cloudPath(path),
    prefix = root ? `${root}/` : '';
  const group = (await cloudJSON(store, `${prefix}attributes.json`, options.signal)) ?? {};
  const multi = (group.multiscales as Metadata[] | undefined)?.[options.image ?? 0];
  const datasets = multi?.datasets as Metadata[] | undefined;
  const paths = options.paths ?? datasets?.map((d) => String(d.path)) ?? (group.dimensions ? [''] : undefined);
  if (!paths?.length) throw bad('N5 group requires multiscales datasets or paths');
  const raw: StoredLevel[] = [];
  let axes: CloudAxis[] = [];
  for (const dataset of paths) {
    const key = prefix + cloudPath(dataset),
      p = key ? `${key}/` : '';
    const meta = await requireCloudJSON(store, `${p}attributes.json`, options.signal);
    const dimensions = cloudCounts(meta.dimensions),
      blockSize = cloudCounts(meta.blockSize, dimensions.length);
    const dtype = types[String(meta.dataType)];
    if (!dtype) throw bad('N5 scalar dataType is unsupported');
    if (dimensions.length < 2 || dimensions.length > 5) throw bad('N5 image rank must be 2 through 5');
    axes = ['x', 'y', 'z', 'c', 't']
      .slice(0, dimensions.length)
      .reverse()
      .map((name) => ({ name }));
    const shape = [...dimensions].reverse(),
      chunks = [...blockSize].reverse();
    const size = Number(dtype.slice(2)),
      max = options.maxDecodedBytes ?? 64 * 1024 * 1024;
    if (product(chunks) * size > max) throw bad('N5 chunk exceeds maxDecodedBytes');
    const compression = meta.compression as Metadata;
    const array = await virtualArray(
      store,
      shape,
      chunks,
      dtype,
      async (index, signal) => {
        const encoded = await store.get(p + [...index].reverse().join('/'), signal);
        if (!encoded) return undefined;
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength),
          rank = dimensions.length;
        if (encoded.length < 4 + rank * 4 || view.getUint16(0) !== 0 || view.getUint16(2) !== rank)
          throw bad('N5 block header must be fixed-size with matching rank');
        const actual = Array.from({ length: rank }, (_, d) => view.getUint32(4 + d * 4));
        if (actual.some((n, d) => n < 1 || n > blockSize[d])) throw bad('invalid N5 edge-block shape');
        const payload = encoded.subarray(4 + rank * 4),
          method = String(compression?.type ?? 'raw');
        let decoded: Uint8Array;
        if (method === 'bzip2') {
          const { decodeBzip2 } = await import('@margoengine/decoders/bzip2');
          decoded = decodeBzip2(payload, { maxBytes: max });
        } else if (method === 'xz') {
          const { decodeXz } = await import('@margoengine/decoders/xz');
          decoded = decodeXz(payload, { maxBytes: max });
        } else if (method === 'lz4') decoded = decodeN5LZ4(payload, max);
        else decoded = await decodeCloudCodec(method, payload, max, signal);
        if (decoded.length !== product(actual) * size) throw bad('N5 block length differs from header');
        const out = new Uint8Array(product(chunks) * size),
          reversed = [...actual].reverse();
        for (let i = 0; i < product(actual); i++) {
          let n = i,
            dst = 0,
            stride = 1;
          for (let d = rank - 1; d >= 0; d--) {
            dst += (n % reversed[d]) * stride;
            n = Math.floor(n / reversed[d]);
            stride *= chunks[d];
          }
          out.set(decoded.subarray(i * size, (i + 1) * size), dst * size);
        }
        return out;
      },
      options,
    );
    const resolution = (meta.pixelResolution ?? group.pixelResolution) as { dimensions?: number[] } | undefined;
    const factors = (meta.downsamplingFactors ??
      dimensions.map((_, d) =>
        raw.length ? raw[0].array.shape[dimensions.length - 1 - d] / dimensions[d] : 1,
      )) as number[];
    let scale = dimensions.map((_, d) => (resolution?.dimensions?.[d] ?? 1) * factors[d]).reverse();
    let translation = scale.map(() => 0);
    const transform = datasets?.find((d) => d.path === dataset)?.transform as
      | { axes?: string[]; scale?: number[]; translate?: number[]; units?: string[] }
      | undefined;
    if (transform?.axes && transform.scale) {
      scale = axes.map((a) => transform.scale![transform.axes!.indexOf(a.name)] ?? 1);
      translation = axes.map((a) => transform.translate?.[transform.axes!.indexOf(a.name)] ?? 0);
      axes = axes.map((a) => ({ ...a, unit: transform.units?.[transform.axes!.indexOf(a.name)] }));
    }
    if (scale.some((n) => !Number.isFinite(n) || n <= 0)) throw bad('invalid N5 spacing');
    raw.push({ path: key, array, scale, translation });
  }
  return finish('n5', axes, raw, options);
}

/** Opens Neuroglancer image/segmentation scales as bounded brick sources. Raw and JPEG chunk encodings are decoded. */
export async function openPrecomputed(
  input: CloudInput,
  path = '',
  options: CloudVolumeOptions = {},
): Promise<CloudVolume> {
  const store = cloudStore(input, options),
    root = cloudPath(path),
    prefix = root ? `${root}/` : '';
  const info = await requireCloudJSON(store, `${prefix}info`, options.signal);
  const channels = Number(info.num_channels),
    type = String(info.data_type),
    baseType = types[type];
  if (
    !baseType ||
    !Number.isSafeInteger(channels) ||
    channels < 1 ||
    !Array.isArray(info.scales) ||
    !info.scales.length
  )
    throw bad('invalid precomputed type/channels/scales');
  const raw = [];
  for (const scale of info.scales as Metadata[]) {
    const dims = cloudCounts(scale.size, 3),
      chunk = cloudCounts((scale.chunk_sizes as unknown[])?.[0], 3);
    const resolution = scale.resolution as number[],
      offset = (scale.voxel_offset ?? [0, 0, 0]) as number[];
    if (
      !Array.isArray(resolution) ||
      resolution.length !== 3 ||
      resolution.some((n) => !Number.isFinite(n) || n <= 0) ||
      !Array.isArray(offset) ||
      offset.length !== 3 ||
      offset.some((n) => !Number.isSafeInteger(n))
    )
      throw bad('invalid precomputed resolution/offset');
    const key = prefix + cloudPath(String(scale.key)),
      shape = [channels, ...dims.slice().reverse()],
      chunks = [channels, ...chunk.slice().reverse()];
    const size = Number(baseType.slice(2)),
      max = options.maxDecodedBytes ?? 64 * 1024 * 1024;
    if (product(chunks) * size > max) throw bad('precomputed chunk exceeds maxDecodedBytes');
    const array = await virtualArray(
      store,
      shape,
      chunks,
      baseType.replace('>', '<'),
      async (index, signal) => {
        const origin = index
          .slice(1)
          .reverse()
          .map((n, d) => n * chunk[d]);
        const end = origin.map((n, d) => Math.min(dims[d], n + chunk[d])),
          actual = end.map((n, d) => n - origin[d]);
        const name = origin.map((n, d) => `${n + offset[d]}-${end[d] + offset[d]}`).join('_');
        const encoded = scale.sharding
          ? await precomputedChunk(
              store,
              key,
              scale.sharding as Metadata,
              index.slice(1).reverse(),
              dims.map((n, d) => Math.ceil(n / chunk[d])),
              max,
              signal,
            )
          : await store.get(`${key}/${name}`, signal);
        if (!encoded) return undefined;
        let decoded = encoded;
        if (scale.encoding === 'jpeg') {
          const { decodeJPEG } = await import('@margoengine/decoders/jpeg');
          const image = await decodeJPEG(encoded, { maxPixels: product(actual) });
          if (image.width * image.height !== product(actual) || type !== 'uint8' || ![1, 3].includes(channels))
            throw bad('JPEG dimensions/type differ from precomputed chunk');
          decoded = new Uint8Array(product(actual) * channels);
          for (let c = 0; c < channels; c++)
            for (let i = 0; i < product(actual); i++) decoded[c * product(actual) + i] = image.data[i * 4 + c];
        } else if (scale.encoding === 'compressed_segmentation') {
          const block = cloudCounts(scale.compressed_segmentation_block_size, 3);
          decoded = segmentationBytes(encoded, actual, block, channels, size, max);
        } else if (scale.encoding !== 'raw')
          throw fault(
            'unsupported',
            `Precomputed encoding ${String(scale.encoding)} requires a decoder; choose raw or jpeg`,
            'sciviz',
          );
        if (decoded.length !== product(actual) * channels * size) throw bad('precomputed payload length differs');
        const out = new Uint8Array(product(chunks) * size);
        for (let c = 0; c < channels; c++)
          for (let z = 0; z < actual[2]; z++)
            for (let y = 0; y < actual[1]; y++) {
              const src = actual[0] * (y + actual[1] * (z + actual[2] * c)),
                dst = chunk[0] * (y + chunk[1] * (z + chunk[2] * c));
              out.set(decoded.subarray(src * size, (src + actual[0]) * size), dst * size);
            }
        return out;
      },
      options,
    );
    raw.push({
      path: key,
      array,
      scale: [1, ...resolution.slice().reverse()],
      translation: [0, ...offset.map((n, d) => n * resolution[d]).reverse()],
    });
  }
  return finish(
    'precomputed',
    ['c', 'z', 'y', 'x'].map((name) => ({ name, ...(name === 'c' ? {} : { type: 'space', unit: 'nanometer' }) })),
    raw,
    options,
  );
}
