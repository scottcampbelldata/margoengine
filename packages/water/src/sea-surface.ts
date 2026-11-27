// The drawn water as the physics framework's sea (docs/physics-framework.md, "sea surface"): a `Water`, an `FFTOcean` or
// a `Ripples` turned into a `SeaSurface`, so `LoadSolver` (`@margoengine/physics/loads`, SEA-12) floats rigid bodies on
// the surface the camera sees. Each source answers its height query on the CPU, so nothing waits on the GPU.
import type { FlowSample, SeaSurface, SeaSurfaceSample, SeaWater } from '@margoengine/math/fields';
import { fault } from '../../shared/errors.js';

/** Anything with a CPU height query at world XZ: `Water`, `FFTOcean`, or `Ripples` made with `cpu: true`. */
export interface SurfaceSource {
  /** The surface at world `(x, z)` now: world-Y height, unit normal and the surface water's velocity. */
  sample(
    x: number,
    z: number,
  ): { height: number; normal: readonly number[]; velocity: readonly number[] };
}
/** Settings of {@link seaSurface}. */
export interface SeaSurfaceOptions {
  /** Density of the water, 0 excluded to 2000 kg/m^3. Default 1025 (sea water); 1000 for a lake or river. */
  density?: number;
  /** Water temperature, K, 0 excluded to 400. Default 288.15. */
  temperature?: number;
}

const G = 9.81;

/**
 * The drawn water as a `SeaSurface` for the physics framework, so a body floats on what is drawn:
 * `world.add(new LoadSolver(), {sea: seaSurface(ocean), bodies})`. Heights are world Y. The surface is the source's as it
 * stands (its own clock), whatever time the solver asks for, so the water's acceleration reads as zero; the water's
 * velocity under the surface is the surface's own, not decaying with depth (right for floating bodies, too fast for deep
 * ones). Above the surface the water's density is 0.
 * @throws MargoError `unsupported` (errors#ocean) for a source with no `sample` or an option out of range.
 */
export function seaSurface(source: SurfaceSource, options: SeaSurfaceOptions = {}): SeaSurface {
  if (!source || typeof source.sample !== 'function')
    throw fault('unsupported', 'seaSurface needs a Water, an FFTOcean or a Ripples with cpu: true', 'ocean');
  const density = options.density ?? 1025,
    temperature = options.temperature ?? 288.15;
  if (typeof density !== 'number' || !(density > 0 && density <= 2000))
    throw fault('unsupported', 'Invalid sea density; pass kg/m^3 above 0 and up to 2000', 'ocean');
  if (typeof temperature !== 'number' || !(temperature > 0 && temperature <= 400))
    throw fault('unsupported', 'Invalid sea temperature; pass kelvin above 0 and up to 400', 'ocean');
  const water: SeaWater = {
    medium: 'water',
    cell: [0, 0, 0],
    sample(x: number, y: number, z: number, _t: number, out?: FlowSample): FlowSample {
      const s = source.sample(x, z),
        wet = y <= s.height,
        result = out ?? { velocity: [0, 0, 0], density: 0, temperature };
      result.velocity[0] = wet ? s.velocity[0]! : 0;
      result.velocity[1] = wet ? s.velocity[1]! : 0;
      result.velocity[2] = wet ? s.velocity[2]! : 0;
      result.density = wet ? density : 0;
      result.temperature = temperature;
      return result;
    },
  };
  return {
    cell: [0, 0, 0],
    water,
    density,
    sample(x: number, z: number, _t: number, out?: SeaSurfaceSample): SeaSurfaceSample {
      const s = source.sample(x, z),
        result = out ?? {
          height: 0,
          normal: [0, 1, 0],
          velocity: [0, 0, 0],
          current: [0, 0, 0],
          depth: Infinity,
          density,
        };
      result.height = s.height;
      for (let i = 0; i < 3; i++) {
        result.normal[i] = s.normal[i]!;
        result.velocity[i] = s.velocity[i]!;
        result.current[i] = 0;
      }
      result.depth = Infinity;
      result.density = density;
      return result;
    },
    elevation: (x: number, z: number) => source.sample(x, z).height,
    pressure: (x: number, y: number, z: number) => density * G * Math.max(0, source.sample(x, z).height - y),
  };
}
