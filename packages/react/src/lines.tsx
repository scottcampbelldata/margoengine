import { forwardRef, useEffect, useRef } from 'react';
import type { ColorInput, Vec3 } from '@margoengine/math';
import type { Line as NativeLine, LineOptions } from '@margoengine/lines';
import { report, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { attachBinding, detachBinding } from './package-binding.js';

/** A polyline's vertices, either flat xyz or triples. Other options are the native line material and transform. */
export interface LineProps extends Omit<LineOptions, 'positions'> {
  points: ArrayLike<number> | readonly Vec3[];
  /** Alias for width, in CSS pixels (or world units with worldUnits). Default 1. */
  lineWidth?: number;
  /** Draw independent pairs instead of a connected strip. Default false. */
  segments?: boolean;
  onError?: (error: unknown) => void;
}
/** A native, antialiased line. The ref exposes setPositions/setMatrix/material for frame-loop updates. */
export const Line = forwardRef<NativeLine, LineProps>(function Line(
  { points, lineWidth, segments = false, onError, ...options },
  ref,
) {
  const scene = useScene(),
    latest = useRef(options);
  const { mesh, material, matrix, ...style } = options;
  latest.current = options;
  useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/lines', () => import('@margoengine/lines')),
      create: (api) => {
        const positions =
          typeof points[0] === 'number' ? (points as ArrayLike<number>) : (points as readonly Vec3[]).flat();
        const line = new api.Line({
          ...latest.current,
          mesh: latest.current.mesh === undefined && !matrix ? scene.registry?.current : latest.current.mesh,
          positions,
          width: lineWidth ?? latest.current.width,
          mode: segments ? 'segments' : latest.current.mode,
        });
        const plugin = new api.Lines({ name: `react-line:${++serial}` });
        plugin.add(line);
        attachBinding(scene, plugin);
        owners.set(line, () => detachBinding(scene, plugin));
        return line;
      },
      dispose: (line) => {
        owners.get(line)?.();
        line.dispose();
      },
      ref,
      onError,
    },
    [scene.world, scene.registry, points, lineWidth, segments, mesh, material, matrix, JSON.stringify(style)],
  );
  return null;
});
const owners = new WeakMap<NativeLine, () => void>();

/** Props of `<Grid>`; every prop is optional. */
export interface GridProps {
  /** Width and depth in world units. Default 10. */
  size?: number;
  /** Cells along each side, 1 to 10000. Default 10. */
  divisions?: number;
  /** Colour of the two lines through the centre, with even `divisions`. Default '#8f8f8f'. */
  centerColor?: ColorInput;
  /** Colour of the other lines. Default '#5e5e5e'. */
  color?: ColorInput;
  /** Centre of the grid. Default [0, 0, 0]. */
  position?: Vec3;
  /** Called when `@margoengine/lines` fails to load or a prop is out of range. The Canvas's onError hears it too. */
  onError?: (error: unknown) => void;
}
let serial = 0;
/** A ground grid in the XZ plane, drawn as lines by `@margoengine/lines`. */
export function Grid({ size, divisions, centerColor, color, position, onError }: GridProps) {
  const scene = useScene(),
    latest = useRef({ centerColor, color, onError }),
    colors = JSON.stringify([centerColor, color]),
    at = JSON.stringify(position);
  latest.current = { centerColor, color, onError };
  useEffect(() => {
    let active = true,
      dispose: (() => void) | undefined;
    optionalPeer('@margoengine/lines', () => import('@margoengine/lines'))
      .then(({ Lines, GridHelper }) => {
        if (!active || scene.engine.disposed) return;
        const [x = 0, y = 0, z = 0] = (at ? JSON.parse(at) : []) as number[],
          grid = new GridHelper({
            size,
            divisions,
            color1: latest.current.centerColor,
            color2: latest.current.color,
          });
        grid.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
        // Each grid has its own plugin, so several can share a Canvas.
        const lines = new Lines({ name: `grid:${++serial}` });
        scene.engine.use(lines);
        lines.add(grid);
        dispose = () => {
          scene.engine.removePlugin(lines.name);
          lines.dispose();
        };
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      dispose?.();
    };
  }, [scene, size, divisions, colors, at]);
  return null;
}
