// Reading points, directions and placements from STEP entities (ISO 10303-42), in the file's length unit.
import { Ref, Typed, type STEPFile, type STEPValue } from '../step/file.js';
import { cross, dot, unit, type V3 } from './vec.js';

export const ref = (v: STEPValue | undefined): number | undefined => (v instanceof Ref ? v.id : undefined);
export const num = (v: STEPValue | undefined, fallback = 0): number =>
  typeof v === 'number' ? v : v instanceof Typed && typeof v.value === 'number' ? v.value : fallback;
export const list = (v: STEPValue | undefined): readonly STEPValue[] => (Array.isArray(v) ? v : []);

/** An entity the kernel cannot evaluate yet: a TypeError naming it, so one bad face or edge can be skipped. */
export function unsupported(file: STEPFile, id: number, what: string): TypeError {
  return new TypeError(
    `Unsupported STEP ${what}: #${id} ${file.typeName(id)}; export it as a B-spline from the CAD tool`,
  );
}

/** CARTESIAN_POINT coordinates (missing ones 0). */
export function point(file: STEPFile, id: number | undefined): V3 {
  if (id === undefined || !file.is(id, 'CARTESIAN_POINT'))
    throw new TypeError(`Invalid STEP file: #${id} is not a point`);
  const c = list(file.args(id, 'CARTESIAN_POINT')[1]);
  return [num(c[0]), num(c[1]), num(c[2])];
}
/** DIRECTION as a unit vector. */
export function direction(file: STEPFile, id: number | undefined): V3 {
  if (id === undefined || !file.is(id, 'DIRECTION'))
    throw new TypeError(`Invalid STEP file: #${id} is not a direction`);
  const r = list(file.args(id, 'DIRECTION')[1]),
    d = unit([num(r[0]), num(r[1]), num(r[2])]);
  if (!d) throw new TypeError(`Invalid STEP file: #${id} is a zero direction`);
  return d;
}
/** VECTOR as direction times magnitude. */
export function vector(file: STEPFile, id: number | undefined): V3 {
  if (id === undefined || !file.is(id, 'VECTOR')) throw new TypeError(`Invalid STEP file: #${id} is not a vector`);
  const [, orientation, magnitude] = file.args(id, 'VECTOR'),
    d = direction(file, ref(orientation)),
    m = num(magnitude, 1);
  return [d[0] * m, d[1] * m, d[2] * m];
}

/** An orthonormal frame: origin and axes. */
export interface Frame {
  readonly origin: V3;
  readonly x: V3;
  readonly y: V3;
  readonly z: V3;
}
/** AXIS2_PLACEMENT_3D as a frame (ISO 10303-42 build_axes; a 2D placement lies in z = 0). */
export function frame(file: STEPFile, id: number | undefined): Frame {
  if (id !== undefined && file.is(id, 'AXIS2_PLACEMENT_2D')) {
    const [, location, refDirection] = file.args(id, 'AXIS2_PLACEMENT_2D'),
      o = point(file, ref(location)),
      x = ref(refDirection) !== undefined ? direction(file, ref(refDirection)) : ([1, 0, 0] as V3);
    return { origin: [o[0], o[1], 0], x, y: [-x[1], x[0], 0], z: [0, 0, 1] };
  }
  if (id === undefined || !file.is(id, 'AXIS2_PLACEMENT_3D'))
    throw new TypeError(`Invalid STEP file: #${id} is not an axis placement`);
  const [, location, axis, refDirection] = file.args(id, 'AXIS2_PLACEMENT_3D'),
    origin = point(file, ref(location)),
    z = ref(axis) !== undefined ? direction(file, ref(axis)) : ([0, 0, 1] as V3);
  let x: V3 =
    ref(refDirection) !== undefined
      ? direction(file, ref(refDirection))
      : Math.abs(z[0]) > 1 - 1e-9
        ? [0, 1, 0]
        : [1, 0, 0];
  const along = dot(x, z);
  x = unit([x[0] - along * z[0], x[1] - along * z[1], x[2] - along * z[2]]) ?? [1, 0, 0];
  return { origin, x, y: cross(z, x), z };
}
