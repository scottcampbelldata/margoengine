import type { ColorInput, Vec3 } from '@margoengine/math';
import { parseColor } from '@margoengine/math/color';
import { useCommit, useScene } from './internal.js';

/** Props of `<Sun>`: the directional light every mesh and model is lit by (core's sun). */
export interface SunProps {
  /** Direction towards the light (need not be unit length). Default [3, 5, 4]. */
  direction?: Vec3;
  /** Hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  color?: ColorInput;
  /** Default 3. */
  intensity?: number;
}
/**
 * Sets the scene's sun (core's `lighting`): the light core meshes, models and shadows use. Inside a `<Scene>` it lights
 * that scene. Restores the previous sun on unmount. Works on WebGPU and WebGL2.
 */
export function Sun({ direction = [3, 5, 4], color = '#ffffff', intensity = 3 }: SunProps): null {
  const { engine, world } = useScene(),
    key = typeof color === 'object' ? color.join() : color;
  useCommit(() => {
    if (!Number.isFinite(intensity) || intensity < 0)
      throw new RangeError('Sun intensity must be a finite number of 0 or more');
    const lighting = (world ?? engine).lighting,
      saved = { direction: lighting.direction.slice(), radiance: lighting.radiance.slice() };
    lighting.direction.set([direction[0], direction[1], direction[2], intensity]);
    lighting.radiance.set(parseColor(color, [0, 0, 0]) as ArrayLike<number>);
    return () => {
      lighting.direction.set(saved.direction);
      lighting.radiance.set(saved.radiance.subarray(0, 3));
    };
  }, [engine, world, direction[0], direction[1], direction[2], key, intensity]);
  return null;
}
