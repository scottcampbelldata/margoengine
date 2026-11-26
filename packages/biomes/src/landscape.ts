import type { TerrainBed } from '@margoengine/physics/earth';
import type { LandscapeEvolution, LandscapeLoadOptions, LandscapeParams } from '@margoengine/physics/landscape';
import type { PhysicsWorld } from '@margoengine/physics/world';
import type { Relief } from './relief.js';

/** The sampling grid and physical parameters of an evolving relief. */
export interface ReliefLandscapeOptions extends Omit<LandscapeParams, 'grid'> {
  /** Maximum distance between physical terrain vertices, in metres. Default 128 m. */
  readonly step?: number;
  /** Rational rate of the world's frame numbers. Default 60/1. */
  readonly frameRate?: Readonly<{ num: number; den: number }>;
  /** Optional registry forcing and abort signal passed to the landscape loader. */
  readonly forcing?: LandscapeLoadOptions;
}

/** A relief evolving through scheduled frames and sampled on the rigid terrain's triangles. */
export interface ReliefLandscape {
  /** The world timeline. Call advance(frame) and use its snapshot methods to replay. */
  readonly world: PhysicsWorld;
  /** The shared TerrainBed that receives physical changes and supplies collider elevations. */
  readonly terrain: TerrainBed;
  /** Physical landscape model and its runoff, erosion and sediment measurements. */
  readonly landscape: LandscapeEvolution;
  /** Copy the current bed into a millimetre relief for biome maps and terrain meshes. */
  snapshotRelief(): Relief;
}

/**
 * Seeds a physical landscape using a procedural relief. The sampled bed occupies the relief's rectangle;
 * a snapshot of it can be passed to the same biome and terrain APIs as the original relief.
 */
export async function evolveRelief(relief: Relief, options: ReliefLandscapeOptions = {}): Promise<ReliefLandscape> {
  const {
    origin: [ox, oz],
    size: [width, depth],
  } = relief.settings;
  const { step = 128, frameRate, forcing, ...params } = options;
  if (!Number.isFinite(step) || step <= 0)
    throw new RangeError('Invalid landscape grid spacing; supply positive finite metres.');
  const mmPerMetre = 1000;
  const grid = {
    columns: Math.ceil(width / (step * mmPerMetre)),
    rows: Math.ceil(depth / (step * mmPerMetre)),
    width: width / mmPerMetre,
    depth: depth / mmPerMetre,
    centre: [(ox + width * 0.5) / mmPerMetre, (oz + depth * 0.5) / mmPerMetre] as const,
  };
  const [{ PhysicsWorld }, { TerrainBed, bedSurface }, { LandscapeEvolution }] = await Promise.all([
    import('@margoengine/physics/world'),
    import('@margoengine/physics/earth'),
    import('@margoengine/physics/landscape'),
  ]);
  const landscape = await LandscapeEvolution.load(forcing);
  const terrain = new TerrainBed();
  const floor = params.floor;
  const world = new PhysicsWorld({ rate: frameRate ?? { num: 60, den: 1 } })
    .add(terrain, {
      ...grid,
      elevations: (x, z) => relief.height(Math.round(x * mmPerMetre), Math.round(z * mmPerMetre)) / mmPerMetre,
      bedrock: typeof floor === 'number' ? () => floor : floor,
    })
    .add(landscape, { ...params, grid });
  return {
    world,
    terrain,
    landscape,
    snapshotRelief() {
      const bed = bedSurface(grid, terrain.elevations());
      return Object.freeze({
        ...relief,
        height: (x: number, z: number) =>
          x < ox || x > ox + width || z < oz || z > oz + depth
            ? relief.height(x, z)
            : Math.round(bed.sample(x / mmPerMetre, z / mmPerMetre).elevation * mmPerMetre),
      });
    },
  };
}
