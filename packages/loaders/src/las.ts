// ASPRS LAS and LAZ point clouds, as the shared output of this package. The reading is `@margoengine/points/las`, the
// one LAS reader of the engine; this entry shapes its result and names its failures as a `LoaderError`.
import {
  parseLAS as readPoints,
  readLASHeader,
  type LASCrs,
  type LASHeader as PointsHeader,
  type LASPoints,
  type LASRecord,
} from '@margoengine/points/las';
import { LoaderError, type LoadedGeometry, type LoaderErrorCode, type ParseLimits } from './types.js';
import { limits, throwIfAborted, toBytes, type BinaryInput } from './util.js';

export type { LASCrs, LASPoints, LASRecord, LASWaveDescriptor, LASWavePackets } from '@margoengine/points/las';

const F = 'LAS';

/** The public header of a LAS file. */
export interface LASHeader {
  /** `[major, minor]`. */
  version: [number, number];
  pointFormat: number;
  pointRecordLength: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** The software that wrote the file. */
  generator: string;
  /** True when the points are LAZ compressed. */
  compressed: boolean;
}

/** What a LAZ decompressor is given: the whole file with its header read. */
export interface LAZSource {
  bytes: Uint8Array;
  header: LASHeader;
  /** Where the compressed points start. */
  pointOffset: number;
  records: LASRecord[];
}

/** Options of {@link parseLAS}. `maxVertices` counts points. */
export interface LASOptions extends ParseLimits {
  /**
   * Turns LAZ points into plain point records, `pointRecordLength` bytes each and `pointCount` of them, in place of the
   * built-in decoder. Only for a decoder of your own: LAZ files open without it.
   */
  decompress?: (source: LAZSource) => Uint8Array | Promise<Uint8Array>;
  /** Keep every `step`th point. Default 1, all of them. */
  step?: number;
  signal?: AbortSignal;
}

/** What {@link parseLAS} returns: a point cloud with the survey's own attributes. */
export interface LASCloud extends LoadedGeometry {
  kind: 'points';
  header: LASHeader;
  /**
   * The header's minimum corner, or the first point when the header's box misses the points. `positions` hold each point
   * less this, so survey coordinates stay exact in 32 bits.
   */
  origin: [number, number, number];
  /** Pulse return strength per point, as stored. */
  intensity: Uint16Array;
  /** ASPRS class per point, such as 2 for ground. */
  classification: Uint8Array;
  /** Which return this point is, from 1. */
  returnNumber: Uint8Array;
  /** How many returns its pulse gave. */
  returnCount: Uint8Array;
  /** GPS time per point, in the formats that have it. */
  gpsTime?: Float64Array;
  records: LASRecord[];
  /** Extra bytes attributes, scaled and offset, by name. */
  extra: Readonly<Record<string, Float64Array>>;
  /** The coordinate reference system, when the file names one. */
  crs?: LASCrs;
  /** Everything else the file stores per point: flags, scan angle, user data, source id, channel, NIR, wave packets. */
  points: LASPoints;
}

const CODES: readonly string[] = ['header', 'truncated', 'range', 'unsupported'];

/** The `LoaderError` for a failure of the points reader. A LAZ stream that fails is damaged or cut short. */
function named(error: unknown, signal: AbortSignal | undefined): unknown {
  if (error instanceof LoaderError) return error;
  if (signal?.aborted) return new LoaderError(F, 'aborted', 'aborted');
  if (!(error instanceof Error)) return error;
  const code = (error as { code?: unknown }).code,
    known = typeof code === 'string' && CODES.includes(code);
  if (!known && !(error instanceof RangeError || error instanceof TypeError)) return error;
  const kind = known ? (code as LoaderErrorCode) : error instanceof RangeError ? 'truncated' : 'header';
  return Object.assign(new LoaderError(F, kind, error.message), { cause: error });
}

const shaped = (header: PointsHeader): LASHeader => ({
  version: [header.versionMajor, header.versionMinor],
  pointFormat: header.pointFormat,
  pointRecordLength: header.pointRecordLength,
  pointCount: header.pointCount,
  scale: [...header.scale],
  offset: [...header.offset],
  min: [...header.min],
  max: [...header.max],
  generator: header.generatingSoftware,
  compressed: header.compressed,
});

/**
 * Reads an ASPRS LAS or LAZ point cloud, versions 1.0 to 1.4 and point formats 0 to 10: positions by the file's scale
 * and offset, intensity, classification, returns, GPS time and colour, with the header and its variable records, extra
 * bytes and the coordinate reference system. Positions are relative to `origin`, because survey coordinates are too
 * large for 32-bit floats; add it back for world coordinates. Colours are scaled to [0,1] from 16 bits, or from 8 for
 * files that fill only the low byte.
 *
 * This is a thin layer over `parseLAS` of `@margoengine/points/las`. A LAZ file opens as it is: the decoder of
 * `@margoengine/points/laz` loads when the first compressed file arrives, so a plain LAS file never pays for it.
 *
 * @param input The file's bytes.
 * @param options The shared size limits, a thinning step, an AbortSignal, and a decoder of your own if you have one.
 * @returns The cloud with its attributes, header and records.
 * @throws LoaderError with code `header`, `truncated`, `range`, `limit`, `aborted` or `unsupported` (an unknown version
 * or point format, or LAZ item version 1 from LASzip 1.0).
 *
 * @example
 * ```ts
 * import { parseLAS } from '@margoengine/loaders/las';
 *
 * const bytes = await (await fetch('/surveys/quarry.laz')).arrayBuffer();
 * const { positions, classification, origin } = await parseLAS(bytes, { step: 4 });
 * console.log(positions.length / 3, classification[0], origin);
 * ```
 */
export async function parseLAS(input: BinaryInput, options: LASOptions = {}): Promise<LASCloud> {
  const bytes = toBytes(input, F),
    { maxVertices } = limits(options, F),
    { signal, decompress } = options,
    step = options.step ?? 1;
  throwIfAborted(signal, F);
  if (!Number.isSafeInteger(step) || step < 1) throw new LoaderError(F, 'range', 'step must be a positive integer');
  try {
    const { header: file } = readLASHeader(bytes),
      header = shaped(file),
      kept = Math.ceil(file.pointCount / step);
    if (kept > maxVertices) throw new LoaderError(F, 'limit', `${kept} points exceed the limit of ${maxVertices}`);
    const points = await readPoints(bytes, {
        origin: 'min',
        stride: step,
        signal,
        laz: decompress
          ? (_file, _header, records) =>
              decompress({ bytes, header, pointOffset: file.pointDataOffset, records: [...records] })
          : undefined,
      });
    const { rgb, intensity, classification, returnNumber, numberOfReturns, gpsTime, extra, crs, records } = points,
      origin: [number, number, number] = [...points.origin];
    const cloud: LASCloud = {
      kind: 'points',
      positions: points.positions,
      header,
      origin,
      intensity,
      classification,
      returnNumber,
      returnCount: numberOfReturns,
      records: [...records],
      extra,
      points,
      attributes: { intensity: Float32Array.from(intensity), classification: Float32Array.from(classification) },
    };
    if (gpsTime) cloud.gpsTime = gpsTime;
    if (crs) cloud.crs = crs;
    if (rgb) {
      let largest = 0;
      for (let i = 0; i < rgb.length; i++) if (rgb[i] > largest) largest = rgb[i];
      const full = largest > 255 ? 65535 : 255,
        colors = new Float32Array(rgb.length);
      for (let i = 0; i < rgb.length; i++) colors[i] = rgb[i] / full;
      cloud.colors = colors;
    }
    return cloud;
  } catch (error) {
    throw named(error, signal);
  }
}
