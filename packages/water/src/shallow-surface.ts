import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { fault, rangeError } from '../../shared/errors.js';
import type { Water } from './index.js';
import { waterSolvers, type WaterSolver, type WaterSolverInput } from './query-state.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number };
declare const GPUBufferUsage: { STORAGE: number; COPY_SRC: number };

/** Depth and free-surface height in metres, and depth-averaged X/Z velocity in m/s. */
export interface ShallowWaterSurfaceSample {
  depth: number;
  surface: number;
  velocity: [number, number];
}

/** A synchronous, cell-centred shallow-water source, such as ShallowWaterSolver. */
export interface ShallowWaterSurfaceSource {
  readonly shape: {
    readonly columns: number;
    readonly rows: number;
    readonly width: number;
    readonly depth: number;
    /** Grid centre [x,z] in the Water terrain's coordinate frame. */
    readonly centre: readonly [number, number];
  };
  sample(x: number, z: number, out: ShallowWaterSurfaceSample): ShallowWaterSurfaceSample;
}

export interface ShallowWaterSurfaceOptions {
  /** Flowing Water with a terrain heightmap in the source grid's dimensions and coordinate frame. */
  readonly surface: Water;
  readonly source: ShallowWaterSurfaceSource;
}

/**
 * Draws the last synchronous shallow-water state with Water's coastal renderer.
 * Advance the source using its own clock before rendering.
 */
export class ShallowWaterSurface implements EnginePlugin {
  readonly name: string;
  private engine?: Engine;
  private unwatch?: () => void;
  private disposed = false;

  constructor(readonly options: ShallowWaterSurfaceOptions) {
    const water = options?.surface;
    if (!water?.options?.terrain || water.options.still || typeof options.source?.sample !== 'function')
      throw fault(
        'state',
        'ShallowWaterSurface needs flowing Water with terrain and a synchronous grid source; supply both',
      );
    this.name = water.name + ':shallow-surface';
  }

  static attach(engine: EngineKernel, options: ShallowWaterSurfaceOptions): ShallowWaterSurface {
    const mirror = new ShallowWaterSurface(options);
    engine.use(mirror);
    return mirror;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'ShallowWaterSurface is disposed; create another mirror');
    const { surface } = this.options;
    if (this.engine || waterSolvers.has(surface))
      throw fault('attached', 'This Water already has a flood solver or mirror; dispose it before attaching a mirror');
    if (!engine.gpu || !engine.hasPlugin(surface.name))
      throw fault('state', 'Attach flowing Water to the same WebGPU or WebGL2 compatibility engine before its mirror');
    this.engine = engine;
    this.unwatch = surface.onDispose(() => this.dispose());
    waterSolvers.set(surface, this.makeMirror);
  }

  private readonly makeMirror = ({ device, terrain }: WaterSolverInput): WaterSolver => {
    const { surface, source } = this.options;
    const { origin, size } = surface.options.terrain!;
    const shape = source.shape;
    if (!shape) throw fault('state', 'ShallowWaterSurface needs a source grid; initialise the source before rendering');
    const { columns, rows, width, depth, centre } = shape;
    if (
      columns !== terrain.width ||
      rows !== terrain.height ||
      width !== size[0] ||
      depth !== size[1] ||
      centre?.[0] !== origin[0] + width / 2 ||
      centre?.[1] !== origin[1] + depth / 2
    )
      throw rangeError(
        'ShallowWaterSurface grid differs from the Water terrain; match its texel dimensions, extent and centre',
        'geometry',
      );

    const dims: [number, number] = [columns, rows];
    const cells = columns * rows;
    const state = new Float32Array(cells * 4);
    const flux = new Float32Array(cells * 4);
    const sample: ShallowWaterSurfaceSample = { depth: 0, surface: 0, velocity: [0, 0] };
    const layout = { bytesPerRow: columns * 16, rowsPerImage: rows };
    const resources: (GPUTexture | GPUBuffer)[] = [];
    const dispose = () => {
      for (const resource of resources) resource.destroy();
      resources.length = 0;
    };
    const texture = (label: string) => {
      const result = device.createTexture({
        label,
        size: dims,
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      resources.push(result);
      return result;
    };
    try {
      const surfaceTexture = texture('shallow water surface');
      const fluxTexture = texture('shallow water discharge');
      const view = surfaceTexture.createView();
      const connected = device.createBuffer({
        size: (cells + 1) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
      });
      resources.push(connected);
      // Keep offshore blending, surf forcing and wall spray inactive across the inland grid.
      new Uint32Array(connected.getMappedRange()).fill(1);
      connected.unmap();
      const dx = width / columns;
      const dz = depth / rows;
      return {
        terrain,
        // Water builds two coast bindings. Both use the same textures because there is no GPU time integration.
        states: [surfaceTexture, surfaceTexture],
        views: [view, view],
        fluxes: [fluxTexture, fluxTexture],
        connected,
        current: 0,
        step() {
          let at = 0;
          for (let j = 0; j < rows; j++) {
            const z = origin[1] + (j + 0.5) * dz;
            for (let i = 0; i < columns; i++, at += 4) {
              const value = source.sample(origin[0] + (i + 0.5) * dx, z, sample);
              if (!value?.velocity)
                throw fault(
                  'state',
                  'ShallowWaterSurface sample must return depth, surface and two velocity components',
                );
              const h = Math.fround(value.depth);
              const bed = Math.fround(value.surface - value.depth);
              const qx = Math.fround(value.depth * value.velocity[0]);
              const qz = Math.fround(value.depth * value.velocity[1]);
              if (!(h >= 0 && Number.isFinite(h) && Number.isFinite(bed) && Number.isFinite(qx) && Number.isFinite(qz)))
                throw rangeError(
                  'Invalid shallow-water surface sample; give finite heights and velocities and nonnegative depth',
                  'geometry',
                );
              state[at] = h;
              state[at + 1] = bed;
              // The channels store outward discharge per unit edge length.
              flux[at] = Math.max(0, -qx);
              flux[at + 1] = Math.max(0, qx);
              flux[at + 2] = Math.max(0, -qz);
              flux[at + 3] = Math.max(0, qz);
            }
          }
          device.queue.writeTexture({ texture: surfaceTexture }, state, layout, dims);
          device.queue.writeTexture({ texture: fluxTexture }, flux, layout, dims);
        },
        dispose,
      };
    } catch (error) {
      dispose();
      throw error;
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { surface } = this.options;
    if (waterSolvers.get(surface) === this.makeMirror) waterSolvers.delete(surface);
    this.unwatch?.();
    this.unwatch = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
