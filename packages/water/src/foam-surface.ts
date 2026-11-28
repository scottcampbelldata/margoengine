/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { fault } from '../../shared/errors.js';
import type { Water } from './index.js';
import { addSurfaceEffect } from './surface-effects.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** The latest accepted coverage of a solver's X-fast, cell-centred surface grid. Coverage is a unitless area fraction. */
export interface SeaFoamGridSource {
  /** Number of cells along X and Z. */
  readonly cells: readonly [number, number];
  /** Outer low-X, low-Z corner in the Water mesh's coordinates, metres. */
  readonly origin: readonly [number, number];
  /** Cell width and depth, metres. */
  readonly spacing: number;
  /** Copies every cell's total foam fraction, in [0, 1], from the latest accepted publication. */
  copyCoverage(out: Float32Array): void;
}

/** What `SeaFoamSurface` needs to light a Water surface with accepted foam. */
export interface SeaFoamSurfaceOptions {
  /** The Water surface on the same engine to light with the accepted foam. */
  readonly surface: Water;
  /** The latest published grid. Advance or restore its simulation before rendering. */
  readonly source: SeaFoamGridSource;
}

const show = 'var shown=foam;if(frame.foam.z>0.0){shown=pow(foam,1.0-0.4*frame.foam.z);}';
const shadow = 'if(foam>0.002||max(glint';
const attached = new WeakSet<Water>();

function foamShader(code: string, binding: number): string {
  if (!code.includes(show) || !code.includes(shadow))
    throw fault('failed', 'SeaFoamSurface needs the matching Water foam shader. Build both from the same package.');
  const map = `
struct SeaFoamGrid { origin:vec2f, spacing:f32, pad:f32 }
@group(0) @binding(${binding}) var<uniform> seaFoamGrid:SeaFoamGrid;
@group(0) @binding(${binding + 1}) var seaFoamMap:texture_2d<f32>;
fn seaFoamCell(i:vec2i,n:vec2i)->f32 {
 if(any(i<vec2i(0))||any(i>=n)){return 0.0;}
 return textureLoad(seaFoamMap,i,0).x;
}
fn acceptedSeaFoam(xz:vec2f)->f32 {
 let n=vec2i(textureDimensions(seaFoamMap));
 let p=(xz-seaFoamGrid.origin)/seaFoamGrid.spacing-0.5;
 if(any(p<=vec2f(-1))||any(p>=vec2f(n))){return 0.0;}
 let base=floor(p);let t=p-base;let i=vec2i(base);
 let a=mix(seaFoamCell(i,n),seaFoamCell(i+vec2i(1,0),n),t.x);
 let b=mix(seaFoamCell(i+vec2i(0,1),n),seaFoamCell(i+vec2i(1,1),n),t.x);
 return mix(a,b,t.y);
}
`;
  // The solver owns foam history. Only the optical fraction and its shadow test need the latest solve.
  return code
    .replace('struct Result', map + '\nstruct Result')
    .replace(show, show + 'shown=max(shown,acceptedSeaFoam(i.world.xz));')
    .replace(shadow, 'if(shown>0.002||max(glint');
}

interface FoamBinding {
  device: GPUDevice;
  columns: number;
  rows: number;
  uniform: GPUBuffer;
  texture: GPUTexture;
  resources: GPUBindingResource[];
}

/** Lights Water with the last accepted foam fractions, independently of Water's own foam history. */
export class SeaFoamSurface implements EnginePlugin {
  readonly name: string;
  private engine?: Engine;
  private binding?: FoamBinding;
  private coverage = new Float32Array(0);
  private readonly extent = new Float32Array(4);
  private releaseEffect?: () => void;
  private releaseWater?: () => void;
  private disposed = false;

  constructor(readonly options: SeaFoamSurfaceOptions) {
    if (typeof options?.surface?.onDispose !== 'function' || typeof options?.source?.copyCoverage !== 'function')
      throw fault('state', 'SeaFoamSurface needs an attached Water surface and a grid with copyCoverage. Pass both.');
    this.name = options.surface.name + ':sea-foam-surface';
  }

  static attach(engine: EngineKernel, options: SeaFoamSurfaceOptions): SeaFoamSurface {
    const surface = new SeaFoamSurface(options);
    engine.use(surface);
    return surface;
  }

  setup(engine: Engine): void {
    const { surface } = this.options;
    if (this.disposed) throw fault('disposed', 'SeaFoamSurface is disposed. Attach a new foam surface.');
    if (attached.has(surface))
      throw fault('attached', 'This Water already has resolved foam. Dispose the previous SeaFoamSurface first.');
    if (!engine.gpu || !engine.hasPlugin(surface.name))
      throw fault('state', 'SeaFoamSurface needs Water on the same engine. Attach Water before the foam surface.');
    attached.add(surface);
    this.engine = engine;
    this.releaseWater = surface.onDispose(() => this.dispose());
    this.releaseEffect = addSurfaceEffect(surface, {
      key: 'accepted-sea-foam',
      vertex: false,
      count: 2,
      shader: foamShader,
      prepare: ({ device }) => this.prepare(device),
    });
  }

  private prepare(device: GPUDevice): readonly GPUBindingResource[] {
    const { cells, origin, spacing } = this.options.source;
    const columns = cells?.[0];
    const rows = cells?.[1];
    if (
      !Array.isArray(cells) ||
      cells.length !== 2 ||
      !Array.isArray(origin) ||
      origin.length !== 2 ||
      !cells.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= device.limits.maxTextureDimension2D) ||
      columns * rows * Float32Array.BYTES_PER_ELEMENT > device.limits.maxBufferSize ||
      !(Math.fround(spacing) > 0 && Number.isFinite(Math.fround(spacing))) ||
      !origin.every((value, axis) => {
        const start = Math.fround(value);
        const end = Math.fround(value + cells[axis]! * spacing);
        return Number.isFinite(start) && Number.isFinite(end) && end > start;
      })
    )
      throw fault(
        'state',
        'Invalid sea foam grid. Pass positive cell counts and finite float32 bounds within device limits.',
      );
    const count = columns * rows;
    if (this.coverage.length !== count) this.coverage = new Float32Array(count);
    this.coverage.fill(NaN);
    this.options.source.copyCoverage(this.coverage);
    if (this.coverage.some((value) => !(value >= 0 && value <= 1)))
      throw fault('state', 'Invalid sea foam coverage. Fill every cell with an accepted fraction from zero to one.');
    this.extent.set([...origin, spacing, 0]);

    const previous = this.binding;
    const resize = !previous || previous.device !== device || previous.columns !== columns || previous.rows !== rows;
    const binding = resize ? this.allocate(device, columns, rows) : previous;
    try {
      device.queue.writeTexture(
        { texture: binding.texture },
        this.coverage,
        { bytesPerRow: columns * Float32Array.BYTES_PER_ELEMENT },
        [columns, rows],
      );
      device.queue.writeBuffer(binding.uniform, 0, this.extent);
    } catch (error) {
      if (resize) {
        binding.texture.destroy();
        binding.uniform.destroy();
      }
      throw error;
    }
    if (resize) {
      previous?.texture.destroy();
      previous?.uniform.destroy();
      this.binding = binding;
    }
    return binding.resources;
  }

  private allocate(device: GPUDevice, columns: number, rows: number): FoamBinding {
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    let texture: GPUTexture | undefined;
    try {
      texture = device.createTexture({
        size: [columns, rows],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      return { device, columns, rows, uniform, texture, resources: [{ buffer: uniform }, texture.createView()] };
    } catch (error) {
      uniform.destroy();
      texture?.destroy();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.releaseEffect) attached.delete(this.options.surface);
    this.releaseEffect?.();
    this.releaseWater?.();
    this.releaseEffect = this.releaseWater = undefined;
    this.binding?.texture.destroy();
    this.binding?.uniform.destroy();
    this.binding = undefined;
    this.coverage = new Float32Array(0);
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
