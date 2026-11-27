import type { FlowCell, FlowField, SeaSurface } from '@margoengine/math/fields';
import type { LoadWater } from './solver.js';

type Vec3 = [number, number, number];
export type LocatedWater = LoadWater & Partial<Pick<SeaSurface, 'cell' | 'pressure'>>;
type OffsetOf = (cell: FlowCell) => Vec3;

/** Sample a flow in the current rigid-body coordinate frame. */
export function localFlow<Medium extends FlowField['medium']>(
  field: FlowField & { readonly medium: Medium },
  offsetOf: OffsetOf,
): FlowField & { readonly medium: Medium } {
  return {
    get medium() {
      return field.medium;
    },
    get cell() {
      return field.cell;
    },
    sample(x, y, z, t, out) {
      const [dx, dy, dz] = offsetOf(field.cell);
      return field.sample(x + dx, y + dy, z + dz, t, out);
    },
  };
}

/** Adapt height, scalar pressure and velocity across possibly different field cells. */
export function localSea(sea: LocatedWater, offsetOf: OffsetOf): LocatedWater {
  const water = localFlow(sea.water, offsetOf);
  const pressure = typeof sea.pressure === 'function' ? sea.pressure.bind(sea) : undefined;
  return {
    water,
    get density() {
      return sea.density;
    },
    elevation(x, z, t) {
      const [dx, dy, dz] = offsetOf(sea.cell ?? sea.water.cell);
      return sea.elevation(x + dx, z + dz, t) - dy;
    },
    ...(pressure && {
      pressure(x: number, y: number, z: number, t: number) {
        const [dx, dy, dz] = offsetOf(sea.cell ?? sea.water.cell);
        return pressure(x + dx, y + dy, z + dz, t);
      },
    }),
  };
}
