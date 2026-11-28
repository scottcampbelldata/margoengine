// Clean-room implementation of NAIF's DAF and SPK format specifications. See docs/clean-room.md, SPACE-02.
import { celestialError } from './errors.js';

const RECORD_BYTES = 1024;
const WORD_BYTES = 8;
const SUMMARY_BYTES = 40;
const MAX_SUMMARIES = (RECORD_BYTES - 3 * WORD_BYTES) / SUMMARY_BYTES;
const J2000_FRAME = 1;

type Vector = [number, number, number];

/** Simultaneous geometric position and velocity in ICRF/J2000 axes, in SI units. */
export interface EphemerisState {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
}

interface Segment {
  target: number;
  center: number;
  frame: number;
  type: number;
  start: number;
  end: number;
  firstWord: number;
  lastWord: number;
}

interface Directory {
  epoch: number;
  interval: number;
  recordWords: number;
  records: number;
  coefficients: number;
}

function invalidKernel(reason: string): never {
  throw celestialError(reason + '. Use an unmodified IEEE DAF/SPK astronomy kernel.', 'failed');
}

function readSummary(view: DataView, offset: number, littleEndian: boolean): Segment {
  return {
    start: view.getFloat64(offset, littleEndian),
    end: view.getFloat64(offset + 8, littleEndian),
    target: view.getInt32(offset + 16, littleEndian),
    center: view.getInt32(offset + 20, littleEndian),
    frame: view.getInt32(offset + 24, littleEndian),
    type: view.getInt32(offset + 28, littleEndian),
    firstWord: view.getInt32(offset + 32, littleEndian),
    lastWord: view.getInt32(offset + 36, littleEndian),
  };
}

function readSegments(view: DataView, littleEndian: boolean): ReadonlyMap<number, readonly Segment[]> {
  if (view.getInt32(8, littleEndian) !== 2 || view.getInt32(12, littleEndian) !== 6)
    invalidKernel('The file has an invalid SPK summary length');
  const first = view.getInt32(76, littleEndian);
  const last = view.getInt32(80, littleEndian);
  const freeWord = view.getInt32(84, littleEndian);
  const firstDataWord = ((first + 1) * RECORD_BYTES) / WORD_BYTES + 1;
  const physicalRecords = view.byteLength / RECORD_BYTES;
  if (
    first < 2 ||
    last < first ||
    last >= physicalRecords ||
    freeWord > view.byteLength / WORD_BYTES + 1 ||
    freeWord < firstDataWord
  )
    invalidKernel('The DAF file record points outside the file');

  const byTarget = new Map<number, Segment[]>();
  let previous = 0;
  for (let record = first; record !== 0; ) {
    const offset = (record - 1) * RECORD_BYTES;
    const next = view.getFloat64(offset, littleEndian);
    const back = view.getFloat64(offset + WORD_BYTES, littleEndian);
    const summaries = view.getFloat64(offset + 2 * WORD_BYTES, littleEndian);
    if (back !== previous || !Number.isInteger(next) || (next === 0 ? record !== last : next <= record || next > last))
      invalidKernel('The DAF summary chain is broken');
    if (!Number.isInteger(summaries) || summaries < 0 || summaries > MAX_SUMMARIES)
      invalidKernel('The DAF summary count does not fit in a record');

    for (let i = 0; i < summaries; i++) {
      const segment = readSummary(view, offset + 3 * WORD_BYTES + i * SUMMARY_BYTES, littleEndian);
      if (
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.end < segment.start ||
        segment.firstWord < firstDataWord ||
        segment.lastWord < segment.firstWord ||
        segment.lastWord >= freeWord
      )
        invalidKernel('An SPK segment has invalid coverage or addresses');

      const segments = byTarget.get(segment.target);
      if (segments) segments.push(segment);
      else byTarget.set(segment.target, [segment]);
    }
    previous = record;
    record = next;
  }
  return byTarget;
}

function readDirectory(view: DataView, segment: Segment, littleEndian: boolean): Directory {
  if (segment.frame !== J2000_FRAME || (segment.type !== 2 && segment.type !== 3))
    throw celestialError(
      'Use a kernel with J2000-frame type 2 or type 3 segments for the requested bodies.',
      'unsupported',
    );
  const words = segment.lastWord - segment.firstWord + 1;
  if (words <= 4) invalidKernel('The SPK segment lacks a polynomial directory');
  const offset = (segment.lastWord - 4) * WORD_BYTES;
  const epoch = view.getFloat64(offset, littleEndian);
  const interval = view.getFloat64(offset + WORD_BYTES, littleEndian);
  const recordWords = view.getFloat64(offset + 2 * WORD_BYTES, littleEndian);
  const records = view.getFloat64(offset + 3 * WORD_BYTES, littleEndian);
  const coefficients = (recordWords - 2) / (segment.type === 2 ? 3 : 6);
  const end = epoch + interval * records;
  if (
    !Number.isFinite(epoch) ||
    !Number.isFinite(end) ||
    !(interval > 0) ||
    !Number.isInteger(records) ||
    records < 1 ||
    !Number.isInteger(coefficients) ||
    coefficients < 1 ||
    recordWords * records !== words - 4 ||
    segment.start < epoch ||
    segment.end > end
  )
    invalidKernel('The SPK polynomial directory is inconsistent with the segment');
  return { epoch, interval, recordWords, records, coefficients };
}

// Clenshaw recurrence for a Chebyshev series, NIST DLMF 3.11.15. For type 2 velocity the recurrence
// is also differentiated with respect to x; dividing by the interval radius converts that to d/dt.
function chebyshev(
  view: DataView,
  offset: number,
  count: number,
  x: number,
  littleEndian: boolean,
  differentiate: boolean,
): readonly [number, number] {
  let next = 0;
  let after = 0;
  let derivativeNext = 0;
  let derivativeAfter = 0;
  for (let i = count - 1; i >= 1; i--) {
    if (differentiate) {
      const derivative = 2 * (next + x * derivativeNext) - derivativeAfter;
      derivativeAfter = derivativeNext;
      derivativeNext = derivative;
    }
    const value = 2 * x * next - after + view.getFloat64(offset + i * WORD_BYTES, littleEndian);
    after = next;
    next = value;
  }
  return [view.getFloat64(offset, littleEndian) + x * next - after, next + x * derivativeNext - derivativeAfter];
}

function addSegment(
  view: DataView,
  littleEndian: boolean,
  segment: Segment,
  tdbSeconds: number,
  position: Vector,
  velocity: Vector,
  sign: 1 | -1,
): void {
  const { epoch, interval, recordWords, records, coefficients } = readDirectory(view, segment, littleEndian);
  // The final boundary belongs to the final record. Internal boundaries belong to the following record.
  const record = Math.min(Math.floor((tdbSeconds - epoch) / interval), records - 1);
  const offset = (segment.firstWord - 1 + record * recordWords) * WORD_BYTES;
  const midpoint = view.getFloat64(offset, littleEndian);
  const radius = view.getFloat64(offset + WORD_BYTES, littleEndian);
  const x = (tdbSeconds - midpoint) / radius;
  if (!Number.isFinite(radius) || !(radius > 0) || !(Math.abs(x) <= 1 + Number.EPSILON * 4))
    invalidKernel('An SPK record does not cover the requested epoch');

  const separateVelocity = segment.type === 3;
  const coordinateBytes = coefficients * WORD_BYTES;
  for (const axis of [0, 1, 2] as const) {
    const start = offset + 2 * WORD_BYTES + axis * coordinateBytes;
    const [distance, derivative] = chebyshev(view, start, coefficients, x, littleEndian, !separateVelocity);
    const speed = separateVelocity
      ? chebyshev(view, start + 3 * coordinateBytes, coefficients, x, littleEndian, false)[0]
      : derivative / radius;
    if (!Number.isFinite(distance) || !Number.isFinite(speed)) invalidKernel('An SPK polynomial is not finite');
    position[axis] += sign * distance;
    velocity[axis] += sign * speed;
  }
}

interface Path {
  links: Segment[];
  centers: Map<number, number>;
}

/** A binary NASA/JPL ephemeris supporting type 2 and type 3 geometric states in ICRF/J2000 axes. */
export class SpkEphemeris {
  readonly #bytes: ArrayBuffer;
  readonly #littleEndian: boolean;
  readonly #byTarget: ReadonlyMap<number, readonly Segment[]>;

  /**
   * Index a DAF/SPK file supplied as bytes. The reader makes its own copy so the file remains stable during simulation.
   * @throws MargoError if the input is not an IEEE DAF/SPK file or its segment index is corrupt.
   */
  constructor(bytes: ArrayBuffer | Uint8Array) {
    this.#bytes = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes).buffer : bytes.slice(0);
    if (this.#bytes.byteLength < RECORD_BYTES || this.#bytes.byteLength % RECORD_BYTES !== 0)
      invalidKernel('The file does not contain complete 1024-byte DAF records');
    const view = new DataView(this.#bytes);
    const decoder = new TextDecoder();
    const identity = decoder.decode(new Uint8Array(this.#bytes, 0, 8));
    const format = decoder.decode(new Uint8Array(this.#bytes, 88, 8));
    if (identity !== 'DAF/SPK ' || (format !== 'LTL-IEEE' && format !== 'BIG-IEEE'))
      invalidKernel('The file identification or IEEE byte order is missing');

    this.#littleEndian = format === 'LTL-IEEE';
    this.#byTarget = readSegments(view, this.#littleEndian);
  }

  #segmentFor(target: number, tdbSeconds: number): Segment | undefined {
    const segments = this.#byTarget.get(target);
    if (!segments) return undefined;
    // Later summaries for the same target have priority where their coverage overlaps.
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]!;
      if (segment.start <= tdbSeconds && tdbSeconds <= segment.end) return segment;
    }
    return undefined;
  }

  #path(target: number, tdbSeconds: number, stop?: ReadonlyMap<number, number>): Path {
    const links: Segment[] = [];
    const centers = new Map<number, number>();
    let body = target;
    while (!centers.has(body)) {
      centers.set(body, links.length);
      if (stop?.has(body)) return { links, centers };
      const segment = this.#segmentFor(body, tdbSeconds);
      if (!segment) return { links, centers };
      links.push(segment);
      body = segment.center;
    }
    return invalidKernel('The SPK target and center chain contains a cycle');
  }

  /**
   * Sample the target relative to the observer. Body IDs are NAIF integers; time is TDB seconds since J2000.
   * @throws MargoError if the epoch is outside the available coverage, or a required segment is unsupported or corrupt.
   */
  state(target: number, observer: number, tdbSeconds: number): EphemerisState {
    if (!Number.isInteger(target) || !Number.isInteger(observer) || !Number.isFinite(tdbSeconds))
      throw celestialError('Pass integer NAIF body IDs and a finite epoch in TDB seconds since J2000.');

    const position: Vector = [0, 0, 0];
    const velocity: Vector = [0, 0, 0];
    if (target === observer) return { position, velocity };
    const targetPath = this.#path(target, tdbSeconds, new Map([[observer, 0]]));
    const observerPath = this.#path(observer, tdbSeconds, targetPath.centers);
    let commonCenter = observer;
    for (const segment of observerPath.links) commonCenter = segment.center;
    const targetLinks = targetPath.centers.get(commonCenter);
    if (targetLinks === undefined)
      throw celestialError('Use a kernel and epoch with connected coverage for both requested NAIF body IDs.');

    const view = new DataView(this.#bytes);
    for (let i = 0; i < targetLinks; i++)
      addSegment(view, this.#littleEndian, targetPath.links[i]!, tdbSeconds, position, velocity, 1);
    for (const segment of observerPath.links)
      addSegment(view, this.#littleEndian, segment, tdbSeconds, position, velocity, -1);
    // SPK's position and velocity units are km and km/s.
    for (const axis of [0, 1, 2] as const) {
      position[axis] *= 1000;
      velocity[axis] *= 1000;
    }
    return { position, velocity };
  }
}
