// Fragment flight (FIRE-05): the TypeScript twin of the explosive kernel's `fly` (explosive-kernel/src/lib.rs). The same
// operations in the same order, so the kernel and this give the same bits: a waiting fragment whose launch time is before
// the step's end starts flying; a flying one loses speed s to s / (1 + k s dt) along its velocity (quadratic drag alone,
// exactly over the step), gains gravity, moves, and lands where it passes below the ground or the terrain bed.

/** A bed's grid for landing: its f32 vertex elevations (columns + 1 by rows + 1, row-major down each column) and shape. */
export interface FlightBed {
  readonly elevations: Float32Array;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly depth: number;
  readonly centre: readonly [number, number];
}

const WORDS = 8;
const WAITING = 0;
const FLYING = 1;
const LANDED = 2;

/** The bed's elevation at (x, z), as `BedSurface.sample` computes it. */
export function bedHeight(bed: FlightBed, x: number, z: number): number {
  const { columns, rows, width, depth, centre } = bed,
    h = bed.elevations,
    u = Math.min(columns, Math.max(0, ((x - centre[0]) / width + 0.5) * columns)),
    v = Math.min(rows, Math.max(0, ((z - centre[1]) / depth + 0.5) * rows)),
    c = Math.min(columns - 1, Math.floor(u)),
    r = Math.min(rows - 1, Math.floor(v)),
    s = u - c,
    t = v - r,
    stride = rows + 1,
    a = h[r + stride * c]!,
    b = h[r + 1 + stride * c]!,
    d = h[r + stride * (c + 1)]!,
    e = h[r + 1 + stride * (c + 1)]!;
  return s + t <= 1 ? a + s * (d - a) + t * (b - a) : e + (1 - s) * (b - e) + (1 - t) * (d - e);
}

/** Steps the fragments; returns [flying after the step, fragment steps taken]. */
export function flyFragments(
  f: Float64Array,
  drag: Float64Array,
  launch: Float64Array,
  count: number,
  dt: number,
  end: number,
  g: readonly [number, number, number],
  ground: number,
  bed: FlightBed | null,
): [number, number] {
  let flying = 0,
    steps = 0;
  const gx = g[0] * dt,
    gy = g[1] * dt,
    gzdt = g[2] * dt;
  for (let i = 0; i < count; i++) {
    const o = i * WORDS;
    let state = f[o + 7]!;
    if (state === WAITING && launch[i]! < end) state = FLYING;
    if (state !== FLYING) {
      f[o + 7] = state;
      continue;
    }
    const vx = f[o + 3]!,
      vy = f[o + 4]!,
      vz = f[o + 5]!;
    const s = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const keep = 1 / (1 + drag[i]! * s * dt);
    const nx = vx * keep + gx,
      ny = vy * keep + gy,
      nz = vz * keep + gzdt;
    const x = f[o]! + nx * dt,
      y = f[o + 1]! + ny * dt,
      z = f[o + 2]! + nz * dt;
    steps++;
    const height = bed ? bedHeight(bed, x, z) : ground;
    f[o] = x;
    f[o + 2] = z;
    if (y < height) {
      f[o + 1] = height;
      f[o + 3] = f[o + 4] = f[o + 5] = 0;
      f[o + 7] = LANDED;
    } else {
      f[o + 1] = y;
      f[o + 3] = nx;
      f[o + 4] = ny;
      f[o + 5] = nz;
      f[o + 7] = FLYING;
      flying++;
    }
  }
  return [flying, steps];
}
