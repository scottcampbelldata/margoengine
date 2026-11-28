import { MargoError } from '@margoengine/math/errors';
import { exp, ln } from '@margoengine/math/pinned';

/** Cartesian acoustic position or direction, X/Y/Z. Y is up. */
export type RoomSoundPoint = readonly [number, number, number];
/** Pressure reflection for representative low, middle and high frequency bands. */
export type RoomReflectionBands = readonly [number, number, number];

/** A finite, convex, planar reflector. Sound can hit either face. */
export interface AcousticReflector {
  readonly vertices: readonly [RoomSoundPoint, RoomSoundPoint, RoomSoundPoint, ...RoomSoundPoint[]];
  /** Angle-independent pressure coefficients, scalar or [low, middle, high]. Default 0.85. */
  readonly reflection?: number | RoomReflectionBands;
}

/** A ray path from a point source, through each reflection if any, to the receiver. */
export interface RoomArrival {
  /** Absolute travel time in seconds. */
  readonly delay: number;
  /** Metres along the path. */
  readonly distance: number;
  /** Signed pressure relative to a direct source at one metre. */
  readonly gains: RoomReflectionBands;
  /** Direction the listener faces to see the origin of the arriving sound. */
  readonly direction: RoomSoundPoint;
  /** Points including the source and listener. Use this polyline for a visual cutaway. */
  readonly points: readonly RoomSoundPoint[];
  /** Index of each reflecting surface. The direct arrival has an empty list. */
  readonly reflections: readonly number[];
}

/** Bounded early image-source search. */
export interface RoomArrivalsOptions {
  readonly source: RoomSoundPoint;
  readonly listener: RoomSoundPoint;
  readonly surfaces?: readonly AcousticReflector[];
  /** Largest number of reflections per path. Default 2. */
  readonly order?: number;
  /** Maximum travel time for both direct and reflected arrivals, seconds. Default 0.25. */
  readonly seconds?: number;
  /** Maximum candidate images examined. Default 100,000. */
  readonly imageBudget?: number;
  /** Uniform speed of sound, m/s. Default 343. */
  readonly speedOfSound?: number;
}

interface Surface {
  vertices: AcousticReflector['vertices'];
  normal: RoomSoundPoint;
  position: number;
  reflection: RoomReflectionBands;
  tolerance: number;
}

const dot = (a: RoomSoundPoint, b: RoomSoundPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: RoomSoundPoint, b: RoomSoundPoint): RoomSoundPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: RoomSoundPoint, b: RoomSoundPoint): RoomSoundPoint => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const addScaled = (a: RoomSoundPoint, b: RoomSoundPoint, f: number): RoomSoundPoint => [
  a[0] + f * b[0],
  a[1] + f * b[1],
  a[2] + f * b[2],
];
function length(vector: RoomSoundPoint): number {
  const square = dot(vector, vector);
  if (square > 0 && Number.isFinite(square)) return Math.sqrt(square);
  const scale = Math.max(Math.abs(vector[0]), Math.abs(vector[1]), Math.abs(vector[2]));
  if (!(scale > 0 && Number.isFinite(scale))) return scale;
  const x = vector[0] / scale;
  const y = vector[1] / scale;
  const z = vector[2] / scale;
  return scale * Math.sqrt(x * x + y * y + z * z);
}

function inputError(message: string): MargoError {
  return new MargoError('state', message);
}

function finitePoint(value: RoomSoundPoint): boolean {
  return value?.length === 3 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

function point(value: RoomSoundPoint, label: string): RoomSoundPoint {
  if (!finitePoint(value)) throw inputError(`Provide three finite metre coordinates for the acoustic ${label}.`);
  return [value[0], value[1], value[2]];
}

function pressure(value: number | RoomReflectionBands = 0.85): RoomReflectionBands {
  const band: RoomReflectionBands = typeof value === 'number' ? [value, value, value] : value;
  if (!finitePoint(band) || Math.abs(band[0]) > 1 || Math.abs(band[1]) > 1 || Math.abs(band[2]) > 1)
    throw inputError('Set acoustic reflection to a pressure coefficient in [-1, 1] for each band.');
  return [band[0], band[1], band[2]];
}

function prepare(desc: AcousticReflector): Surface {
  if (!Array.isArray(desc?.vertices) || desc.vertices.length < 3)
    throw inputError('Provide at least three ordered vertices for each acoustic reflector.');
  const vertices = Array.from(desc.vertices, (v) => point(v, 'vertex')) as unknown as AcousticReflector['vertices'];
  const anchor = vertices[0];
  const axis = cross(minus(vertices[1], anchor), minus(vertices[2], anchor));
  const normalLength = length(axis);
  if (!(normalLength > 0 && Number.isFinite(normalLength)))
    throw inputError('Provide an acoustic reflector with noncollinear first vertices and representable edges.');
  const normal = axis.map((c) => c / normalLength) as unknown as RoomSoundPoint;
  let coordinateScale = 1;
  for (const vertex of vertices)
    coordinateScale = Math.max(coordinateScale, Math.abs(vertex[0]), Math.abs(vertex[1]), Math.abs(vertex[2]));
  const tolerance = 32 * Number.EPSILON * coordinateScale;
  const position = dot(normal, anchor);
  if (!Number.isFinite(position) || vertices.some((v) => !(Math.abs(dot(normal, minus(v, anchor))) <= tolerance)))
    throw inputError('Use finite local acoustic reflector coordinates on one plane.');
  const surface = { vertices, normal, position, tolerance, reflection: pressure(desc.reflection) };
  if (vertices.some((v) => !inside(surface, v)))
    throw inputError('Provide each reflector as a convex planar polygon with ordered vertices.');
  return surface;
}

function inside({ vertices, normal, tolerance }: Surface, p: RoomSoundPoint): boolean {
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const edge = minus(vertices[(i + 1) % vertices.length]!, a);
    const side = dot(normal, cross(edge, minus(p, a)));
    if (!Number.isFinite(side))
      throw inputError(
        'The acoustic reflector exceeds numeric range. Move it near the room origin or reduce its extent.',
      );
    if (side < -tolerance * length(edge)) return false;
  }
  return true;
}

function intersection(s: Surface, a: RoomSoundPoint, b: RoomSoundPoint): RoomSoundPoint | undefined {
  const delta = minus(b, a);
  const divisor = dot(s.normal, delta);
  if (!Number.isFinite(divisor))
    throw inputError('The acoustic segment exceeds numeric range. Use finite local room coordinates.');
  const ends = s.tolerance / Math.abs(divisor);
  if (!Number.isFinite(ends) || ends >= 0.5) return;
  const u = (s.position - dot(s.normal, a)) / divisor;
  if (u <= ends || u >= 1 - ends) return;
  const p = addScaled(a, delta, u);
  if (!finitePoint(p))
    throw inputError('The acoustic intersection exceeds numeric range. Use finite local room coordinates.');
  return inside(s, p) ? p : undefined;
}

function trace(
  faces: readonly Surface[],
  reflections: readonly number[],
  images: readonly RoomSoundPoint[],
  source: RoomSoundPoint,
  listener: RoomSoundPoint,
  speed: number,
  maxDistance: number,
): RoomArrival | undefined {
  const points: RoomSoundPoint[] = [source];
  points.length = reflections.length + 2;
  points[points.length - 1] = listener;
  const gains: [number, number, number] = [1, 1, 1];
  for (let j = reflections.length - 1; j >= 0; j--) {
    const s = faces[reflections[j]!]!;
    const p = intersection(s, points[j + 2]!, images[j]!);
    if (!p) return;
    points[j + 1] = p;
    for (let band = 0; band < 3; band++) gains[band]! *= s.reflection[band]!;
  }
  let distance = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (faces.some((face) => intersection(face, a, b))) return;
    distance += length(minus(b, a));
  }
  if (!Number.isFinite(distance)) throw inputError('The acoustic path exceeds numeric range. Reduce the room extent.');
  if (distance > maxDistance || distance === 0) return;
  const incident = minus(points[points.length - 2]!, listener);
  const last = length(incident);
  const inverseDistance = 1 / last;
  const direction = Number.isFinite(inverseDistance)
    ? addScaled([0, 0, 0], incident, inverseDistance)
    : ([incident[0] / last, incident[1] / last, incident[2] / last] as const);
  const amplitudes = [gains[0] / distance, gains[1] / distance, gains[2] / distance] as const;
  const delay = distance / speed;
  if (!finitePoint(direction) || !finitePoint(amplitudes) || !(delay > 0 && Number.isFinite(delay)))
    throw inputError(
      'The acoustic delay or gain exceeds numeric range. Use a representable path length and wave speed.',
    );
  return {
    distance,
    delay,
    direction,
    points,
    reflections: [...reflections],
    gains: amplitudes,
  };
}

function positive(value: number, label: string): number {
  if (!(Number.isFinite(value) && value > 0)) throw inputError(`Provide a finite positive room sound ${label}.`);
  return value;
}

function samePath(a: RoomArrival, b: RoomArrival): boolean {
  if (a.points.length !== b.points.length) return false;
  const threshold = 32 * Number.EPSILON * Math.max(1, a.distance, b.distance);
  return a.points.every((point, i) => length(minus(point, b.points[i]!)) <= threshold);
}

/** Trace direct and finite specular paths. All bounces and unblocked segments are verified against the actual surfaces. */
export function roomArrivals(options: RoomArrivalsOptions): readonly RoomArrival[] {
  if (!options || typeof options !== 'object') throw inputError('Provide acoustic source and listener positions.');
  const source = point(options.source, 'source');
  const listener = point(options.listener, 'listener');
  if (length(minus(source, listener)) === 0)
    throw inputError(
      'Set the acoustic source and listener to different positions to avoid the point-source singularity.',
    );
  const speed = positive(options.speedOfSound ?? 343, 'speed');
  const distance = positive(speed * positive(options.seconds ?? 0.25, 'travel time'), 'travel reach in metres');
  const order = options.order ?? 2;
  const budget = options.imageBudget ?? 100000;
  if (!Number.isSafeInteger(order) || order < 0 || !Number.isSafeInteger(budget) || budget < 1)
    throw inputError('Choose a nonnegative reflection order and positive image budget as integers.');
  const surfaces = options.surfaces ?? [];
  if (!Array.isArray(surfaces)) throw inputError('Provide a list of finite acoustic reflector polygons.');
  const faces = Array.from(surfaces, prepare);
  const output: RoomArrival[] = [];
  const reflections: number[] = [];
  const images: RoomSoundPoint[] = [];
  const candidates = [{ image: source, next: 0 }];
  let tested = 0;
  const add = () => {
    const candidate = trace(faces, reflections, images, source, listener, speed, distance);
    if (candidate) output.push(candidate);
  };
  add();
  while (candidates.length) {
    const entry = candidates[candidates.length - 1]!;
    if (entry.next >= faces.length || reflections.length >= order) {
      candidates.pop();
      reflections.pop();
      images.pop();
      continue;
    }
    const i = entry.next++;
    if (i === reflections[reflections.length - 1]) continue;
    if (++tested > budget)
      throw inputError('Room sound image search exceeded its budget. Increase imageBudget or reduce order.');
    const f = faces[i]!;
    const image = addScaled(entry.image, f.normal, 2 * (f.position - dot(f.normal, entry.image)));
    if (!finitePoint(image))
      throw inputError(
        'The reflected image exceeds numeric range. Shorten the room coordinates or lower reflection order.',
      );
    reflections.push(i);
    images.push(image);
    add();
    candidates.push({ image, next: 0 });
  }
  const times = output.sort((a, b) => a.delay - b.delay);
  return times.filter((arrival, i) => {
    for (
      let j = i - 1;
      j >= 0 && arrival.distance - times[j]!.distance <= 32 * Number.EPSILON * Math.max(1, arrival.distance);
      j--
    )
      if (samePath(arrival, times[j]!)) return false;
    return true;
  });
}

/** Construct the six finite sides of an axis-aligned room. */
export function acousticBox(
  min: RoomSoundPoint,
  max: RoomSoundPoint,
  reflection?: number | RoomReflectionBands,
): readonly AcousticReflector[] {
  const [x, y, z] = point(min, 'box minimum');
  const [X, Y, Z] = point(max, 'box maximum');
  if (!(X > x && Y > y && Z > z)) throw inputError('Provide an acoustic box with positive extent on each axis.');
  const a: RoomSoundPoint = [x, y, z],
    b: RoomSoundPoint = [X, y, z],
    c: RoomSoundPoint = [X, y, Z],
    d: RoomSoundPoint = [x, y, Z];
  const e: RoomSoundPoint = [x, Y, z],
    f: RoomSoundPoint = [X, Y, z],
    g: RoomSoundPoint = [X, Y, Z],
    h: RoomSoundPoint = [x, Y, Z];
  const walls: AcousticReflector['vertices'][] = [
    [a, d, h, e],
    [b, f, g, c],
    [a, b, c, d],
    [e, h, g, f],
    [a, e, f, b],
    [d, c, g, h],
  ];
  return walls.map((vertices) => ({ vertices, reflection }));
}

/** Render a causal pressure response as two linear fractional-sample weights per path. */
export function renderRoomImpulse(
  sampleRate: number,
  arrivals: readonly RoomArrival[],
  band: 0 | 1 | 2 = 1,
): Float32Array {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || ![0, 1, 2].includes(band))
    throw inputError('Choose a positive integer audio sample rate and band 0, 1 or 2.');
  if (!Array.isArray(arrivals)) throw inputError('Provide a list of acoustic arrivals with delays and band gains.');
  let size = 1;
  for (const arrival of arrivals) {
    const frame = arrival?.delay * sampleRate;
    if (!(Number.isFinite(frame) && frame >= 0 && frame + 2 <= 0xffffffff))
      throw inputError('Provide a finite nonnegative arrival within a single PCM array.');
    if (!Number.isFinite(arrival.gains?.[band])) throw inputError('Provide a finite gain for each acoustic arrival.');
    size = Math.max(size, Math.floor(frame) + 2);
  }
  let data: Float32Array;
  try {
    data = new Float32Array(size);
  } catch (cause) {
    throw Object.assign(
      inputError('The acoustic response cannot fit in PCM memory. Reduce its duration or sample rate.'),
      {
        cause,
      },
    );
  }
  for (const arrival of arrivals) {
    const frame = arrival.delay * sampleRate;
    const at = Math.floor(frame);
    const remainder = frame - at;
    const gain = arrival.gains[band];
    const first = Math.fround(data[at]! + gain * (1 - remainder));
    const second = Math.fround(data[at + 1]! + gain * remainder);
    if (!Number.isFinite(first) || !Number.isFinite(second))
      throw inputError('Acoustic response exceeds the f32 PCM range. Reduce the arriving pressure gains.');
    data[at] = first;
    data[at + 1] = second;
  }
  return data;
}

/** Load early paths into a Web Audio convolver, preserving signed physical path gains. */
export function createRoomConvolver(
  context: BaseAudioContext,
  arrivals: readonly RoomArrival[],
  band?: 0 | 1 | 2,
): ConvolverNode {
  if (!context || typeof context.createConvolver !== 'function' || typeof context.createBuffer !== 'function')
    throw new MargoError('unsupported', 'Use an AudioContext or OfflineAudioContext to play room acoustics.');
  const data = renderRoomImpulse(context.sampleRate, arrivals, band);
  const buffer = context.createBuffer(1, data.length, context.sampleRate);
  buffer.getChannelData(0).set(data);
  const convolver = context.createConvolver();
  convolver.normalize = false;
  convolver.buffer = buffer;
  return convolver;
}

/**
 * Eyring RT60 for a diffuse room with negligible air attenuation. Wall absorption is a mean energy fraction.
 * Zero absorption produces an infinite decay time. Complete absorption produces zero room reverberation.
 */
export function roomDecayTime(volume: number, area: number, absorption: number, speedOfSound = 343): number {
  positive(volume, 'room volume');
  positive(area, 'wall area');
  positive(speedOfSound, 'speed');
  if (!(Number.isFinite(absorption) && absorption >= 0 && absorption <= 1))
    throw inputError('Choose a mean energy absorption fraction from zero to one.');
  if (absorption === 0) return Infinity;
  if (absorption === 1) return 0;
  const loss =
    absorption < 1e-4
      ? absorption * (1 + absorption * (0.5 + absorption * (1 / 3 + absorption * 0.25)))
      : -ln(1 - absorption);
  const factor = 24 * ln(10);
  const duration = (factor * volume) / (speedOfSound * area * loss);
  if (duration > 0 && Number.isFinite(duration)) return duration;
  const scaled = (factor / speedOfSound) * (volume / area / loss);
  return scaled > 0 && Number.isFinite(scaled)
    ? scaled
    : positive(exp(ln(factor) + ln(volume) - ln(speedOfSound) - ln(area) - ln(loss)), 'representable decay time');
}
