/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { planeGeometry, computeVertexNormals, type GeometryData } from '@margoengine/geometry';
import type { HeightField } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
export type { HeightField };
/** Area and sampling of `heightfieldGeometry` and `TerrainHeightmap`. */
export interface HeightfieldOptions {
  /** World XZ extent, each 0-100,000 (exclusive of 0). */
  size: readonly [number, number];
  /** Minimum world XZ corner. Default: centred on the origin (`-size / 2`). */
  origin?: readonly [number, number];
  /** Segments (mesh) or texels (heightmap) per side, an integer 1-1024. Default 192 (mesh) / 256 (heightmap). */
  resolution?: number;
}

function validate(
  height: HeightField,
  size: readonly [number, number],
  resolution: number,
  origin: readonly [number, number],
): void {
  if (
    typeof height !== 'function' ||
    size.length !== 2 ||
    !Number.isFinite(size[0]) ||
    !Number.isFinite(size[1]) ||
    size[0] <= 0 ||
    size[1] <= 0 ||
    size[0] > 100000 ||
    size[1] > 100000 ||
    origin.length !== 2 ||
    !Number.isFinite(Math.fround(origin[0])) ||
    !Number.isFinite(Math.fround(origin[1])) ||
    !Number.isInteger(resolution) ||
    resolution < 1 ||
    resolution > 1024
  )
    throw new RangeError('Invalid terrain heightfield');
}
function sample(height: HeightField, x: number, z: number): number {
  const value = height(x, z);
  if (!Number.isFinite(Math.fround(value))) throw new RangeError('Terrain height must be finite');
  return value;
}

/** Y-up mesh with recomputed slope normals; origin is the minimum world XZ corner. */
export function heightfieldGeometry(height: HeightField, options: HeightfieldOptions): GeometryData {
  const { size, resolution = 192, origin = [-size[0] / 2, -size[1] / 2] } = options;
  validate(height, size, resolution, origin);
  const data = planeGeometry(size[0], size[1], resolution, resolution);
  for (let i = 0; i < data.positions.length; i += 3) {
    const x = data.positions[i] + origin[0] + size[0] / 2,
      z = -data.positions[i + 1] + origin[1] + size[1] / 2;
    data.positions[i] = x;
    data.positions[i + 1] = sample(height, x, z);
    data.positions[i + 2] = z;
  }
  return computeVertexNormals(data);
}

let serial = 0;
/** Owns a sampled height texture and regenerates it on device restoration. */
export class TerrainHeightmap implements EnginePlugin {
  readonly name = 'terrain-heightmap:' + ++serial;
  texture?: GPUTexture;
  private engine?: Engine;
  private disposed = false;
  constructor(
    private readonly height: HeightField,
    private readonly options: HeightfieldOptions,
  ) {
    const { size, resolution = 256, origin = [-size[0] / 2, -size[1] / 2] } = options;
    validate(height, size, resolution, origin);
    this.options = { size: [size[0], size[1]], resolution, origin: [origin[0], origin[1]] };
  }
  static attach(engine: EngineKernel, height: HeightField, options: HeightfieldOptions): TerrainHeightmap {
    const map = new TerrainHeightmap(height, options);
    engineRuntime(engine).use(map);
    return map;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain heightmap requires WebGPU; attach a new TerrainHeightmap to a WebGPU engine',
      );
    const device = engine.gpu,
      { size, resolution = 256, origin = [-size[0] / 2, -size[1] / 2] } = this.options;
    if (resolution > device.limits.maxTextureDimension2D) throw new RangeError('Heightmap exceeds GPU texture limit');
    const heights = new Float32Array(resolution * resolution);
    for (let z = 0; z < resolution; z++)
      for (let x = 0; x < resolution; x++)
        heights[z * resolution + x] = sample(
          this.height,
          origin[0] + ((x + 0.5) / resolution) * size[0],
          origin[1] + ((z + 0.5) / resolution) * size[1],
        );
    this.engine = engine;
    this.texture = device.createTexture({
      size: [resolution, resolution],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.texture }, heights, { bytesPerRow: resolution * 4 }, [
      resolution,
      resolution,
    ]);
  }
  onDeviceRestored(engine: Engine): void {
    this.texture?.destroy();
    this.texture = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture?.destroy();
    this.texture = undefined;
    const engine = this.engine;
    this.engine = undefined;
    engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
