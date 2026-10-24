// Studio lighting presets for the path tracer: named environments an editor can apply in one call.
import type { TraceEnvironment, TraceVec3 } from './types.js';

/** A named lighting setup: pass `environment` as the scene's `environment`. */
export interface LightingPreset {
  /** Stable id, for example 'studio-soft'. */
  id: string;
  /** Short label for a menu. */
  label: string;
  /** Sky, ground and sun. */
  environment: TraceEnvironment;
}

/**
 * The built-in lighting presets for product and scene shots: 'studio-soft', 'studio-hard', 'outdoor-day',
 * 'outdoor-sunset', 'night' and 'product'. Every call returns new objects, so callers may change them.
 */
export function studioPresets(): LightingPreset[] {
  const preset = (
    id: string,
    label: string,
    skyColor: TraceVec3,
    groundColor: TraceVec3,
    sunDirection: TraceVec3,
    sunColor: TraceVec3,
    sunIntensity: number,
    turbidity?: number,
  ): LightingPreset => ({
    id,
    label,
    environment: {
      skyColor,
      groundColor,
      sunDirection,
      sunColor,
      sunIntensity,
      ...(turbidity === undefined ? {} : { physicalSky: { turbidity } }),
    },
  });
  return [
    preset('studio-soft', 'Studio soft', [0.6, 0.65, 0.7], [0.4, 0.4, 0.42], [0.4, 0.8, 0.2], [1, 0.95, 0.85], 2),
    preset('studio-hard', 'Studio hard', [0.3, 0.32, 0.35], [0.15, 0.15, 0.16], [0.6, 0.5, -0.3], [1, 1, 1], 8),
    preset('outdoor-day', 'Outdoor day', [0.4, 0.6, 1], [0.3, 0.35, 0.25], [0.3, 0.7, 0.4], [1, 0.95, 0.85], 5, 2),
    preset('outdoor-sunset', 'Outdoor sunset', [1, 0.5, 0.3], [0.25, 0.2, 0.15], [0.8, 0.2, 0.1], [1, 0.6, 0.3], 3, 4),
    preset('night', 'Night', [0.02, 0.03, 0.06], [0.01, 0.01, 0.02], [0, 0.1, 0], [0.85, 0.9, 1], 0.1),
    preset('product', 'Product', [0.9, 0.9, 0.92], [0.7, 0.7, 0.72], [0.2, 0.9, 0.1], [1, 1, 1], 4),
  ];
}

/** The built-in preset with this id (see {@link studioPresets}), or undefined. */
export function studioPreset(id: string): LightingPreset | undefined {
  return studioPresets().find((p) => p.id === id);
}
