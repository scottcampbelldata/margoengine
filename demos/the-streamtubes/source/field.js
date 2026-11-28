import { mergeGeometries } from '@margoengine/geometry/utils';
import { streamTubeColors, streamTubeGeometry, traceStreamPath } from '@margoengine/sciviz/tubes';

// The wake fills the tunnel from just behind the wing to the end of the deck.
export const flowStart = -2.43,
  flowEnd = 4.66;
export const speedRange = [0.99, 1.9];
// Each wingtip keeps its own palette; brighter is faster.
const palettes = { [-1]: ['#1d5677', '#62e6d8'], [1]: ['#9c3036', '#ffb24e'] };

// One regularised (Gaussian core) vortex in the y-z plane: swirl and how deep inside the core the point is.
function vortex(y, z, cy, cz, gamma, core) {
  const dy = y - cy,
    dz = z - cz,
    q = dy * dy + dz * dz;
  const spin = gamma * (q < 1e-9 ? 1 / (core * core) : -Math.expm1(-q / (core * core)) / q);
  return [-dz * spin, dy * spin, Math.exp(-q / (core * core))];
}

// The illustrative wake: two counter-rotating tip vortices that sink, spread and weaken downstream.
function velocity([x, y, z]) {
  const run = Math.min(1, Math.max(0, x - flowStart) * 0.13);
  const center = 0.57 - 0.18 * run,
    separation = 1.31 - 0.29 * run,
    core = 0.35 + 0.16 * run,
    taper = 1 - 0.29 * run;
  const right = vortex(y, z, center, separation, 0.52 * taper, core),
    left = vortex(y, z, center, -separation, -0.52 * taper, core);
  return [1.4 - 0.35 * (right[2] + left[2]), right[0] + left[0] - 0.014, right[1] + left[1]];
}

// Ten seeds on three rings around each core, traced with Dormand-Prince 5(4) to the end of the tunnel.
export const paths = [-1, 1].flatMap((side) =>
  [0.22, 0.43, 0.62].flatMap((radius, ring) =>
    Array.from({ length: [3, 3, 4][ring] }, (_, sample) => {
      const angle = (2 * Math.PI * sample) / [3, 3, 4][ring] + ring * 0.43 + (side < 0 ? 0.17 : -0.13);
      const seed = [flowStart, 0.57 + Math.sin(angle) * radius, side * 1.31 + Math.cos(angle) * radius];
      return { side, ...traceStreamPath(velocity, seed, { bounds: [flowStart, flowEnd, -4, 4, -4, 4], maxStep: 0.12 }) };
    }),
  ),
);

/** The tubes of one or both wingtips as one coloured mesh; radius swells with speed and toward mid-path. */
export function wake(thickness, side) {
  const tubes = paths
    .filter((path) => !side || path.side === side)
    .map((path) => {
      const n = path.scalar.length;
      const radius = Array.from(path.scalar, (speed, i) =>
        thickness * (0.72 + 0.29 * speed) * (0.81 + 0.21 * Math.sin((Math.PI * i) / (n - 1))));
      const tube = streamTubeGeometry(path, { radius, sides: 14, steps: 96 });
      return { ...tube, colors: streamTubeColors(tube, { range: speedRange, colors: palettes[path.side] }) };
    });
  return mergeGeometries(tubes, false);
}
