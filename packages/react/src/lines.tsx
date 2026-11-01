import { useEffect, useRef } from 'react';
import type { ColorInput, Vec3 } from '@margoengine/math';
import { report, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

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
