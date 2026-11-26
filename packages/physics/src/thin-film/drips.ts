import { pow } from '@margoengine/math/pinned';

/** A wetted circular rim fed by one cell at an open edge. */
export interface ThinFilmDripOutlet {
  /** Outlet edge in the film's local UV plane. */
  readonly edge: 'u0' | 'u1' | 'v0' | 'v1';
  /** Zero-based cell along the selected edge. */
  readonly index: number;
  /** Outside contact-line radius in metres. */
  readonly radius: number;
}

/** A detached-drop record: position XYZ, initial velocity XYZ, m³ per drop, first offset and period in seconds, count. */
export const FILM_DROP_WORDS = 10;

interface DripSurface {
  readonly nx: number;
  readonly ny: number;
  readonly spacing: number;
  readonly drains: readonly boolean[];
  readonly density: number;
  readonly surfaceTension: number;
  readonly gravity: number;
}

export interface PreparedOutlet {
  readonly cell: number;
  readonly u: number;
  readonly v: number;
  readonly volume: number;
}

function invalidOutlet(message: string): RangeError {
  return Object.assign(new RangeError(message), { code: 'PHYSICS_INPUT_RANGE' });
}

function dropVolume(diameter: number, surface: DripSurface): number {
  const ideal = (Math.PI * diameter * surface.surfaceTension) / (surface.density * surface.gravity);
  const ratio = diameter / pow(ideal, 1 / 3);
  if (!(ideal > 0 && Number.isFinite(ideal) && ratio <= 1.4))
    throw invalidOutlet(
      'Invalid thin-film outlet scale. Use positive gravity and surface tension with a rim in the quasistatic drop range.',
    );
  // Mori (1990), eq. 7 uses the ideal volume in the diameter ratio.
  return ideal * (0.6 + 0.4 * pow(1 - ratio / 1.4, 2.2));
}

export function prepareOutlets(outlets: readonly ThinFilmDripOutlet[], surface: DripSurface): PreparedOutlet[] {
  if (!Array.isArray(outlets))
    throw Object.assign(new TypeError('Invalid thin-film outlets. Pass an array of circular rims.'), {
      code: 'PHYSICS_INPUT_TYPE',
    });
  const { nx, ny, spacing, drains } = surface;
  const edges = ['u0', 'u1', 'v0', 'v1'];
  const used = new Set<number>();
  return outlets.map((outlet) => {
    if (!outlet || typeof outlet !== 'object')
      throw Object.assign(new TypeError('Invalid film outlet. Pass its edge, index and radius.'), {
        code: 'PHYSICS_INPUT_TYPE',
      });
    const { edge, index, radius } = outlet;
    const edgeIndex = edges.indexOf(edge);
    const acrossU = edgeIndex < 2;
    if (
      !drains[edgeIndex] ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= (acrossU ? ny : nx) ||
      !Number.isFinite(radius) ||
      radius <= 0
    )
      throw invalidOutlet('Invalid thin-film outlet. Use an open edge, a valid edge cell and a positive rim radius.');
    const upper = (edgeIndex & 1) !== 0;
    const x = acrossU ? (upper ? nx - 1 : 0) : index;
    const y = acrossU ? index : upper ? ny - 1 : 0;
    const cell = x + nx * y;
    if (used.has(cell))
      throw invalidOutlet('A film cell feeds two outlets. Keep one circular rim for each drainage cell.');
    used.add(cell);
    return {
      cell,
      u: spacing * (acrossU ? (upper ? nx : 0) : x + 0.5),
      v: spacing * (acrossU ? y + 0.5 : upper ? ny : 0),
      volume: dropVolume(2 * radius, surface),
    };
  });
}

/** Count events without emitting one extra drop when the division rounded up to a whole number. */
export function completeDrips(water: number, drop: number): number {
  const count = Math.floor(water / drop);
  return count * drop > water ? count - 1 : count;
}
