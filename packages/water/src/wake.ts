/// <reference lib="esnext.disposable" preserve="true" />
// Water draws a physics wake (SEA-04; `WakeSolver` of `@margoengine/physics/sea`): the wake's height grid, as the solver
// holds it after each step, goes to the GPU once a frame (its doubles rounded once to f32) and the surface adds it, read
// by the same bilinear rule and the same slope (a central difference one cell wide) as the solver's own `sample`. So the
// camera sees the wake the hull floats on.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import type { Water } from './index.js';
import { addSurfaceEffect } from './surface-effects.js';
import { fault } from '../../shared/errors.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** A wake Water draws: its grid and its heights (x fastest, then z). `WakeSolver` of `@margoengine/physics/sea` is one. */
export interface WaterWakeSource {
  readonly grid: {
    readonly cells: readonly [number, number];
    readonly cellSize: number;
    readonly origin: readonly [number, number];
  };
  heights(): ArrayLike<number>;
}

/** Options of {@link WaterWake}. */
export interface WaterWakeOptions {
  /** The Water to draw it on, attached to the same engine. */
  surface: Water;
  /** The wake. */
  wake: WaterWakeSource;
}

let sequence = 0;

/**
 * Draws a physics wake on a Water: `WaterWake.attach(engine, {surface: water, wake})`. Each frame the wake's heights go to
 * the GPU once, and the surface (its draw, its captures and `WaveQuery`) adds them.
 */
export class WaterWake implements EnginePlugin {
  readonly name = `water:wake-${sequence++}`;
  private readonly surface: Water;
  private readonly wake: WaterWakeSource;
  private engine?: Engine;
  private grid?: GPUBuffer;
  private field?: GPUBuffer;
  private heights = new Float32Array(0);
  private readonly header = new Float32Array(8);
  private resources: GPUBindingResource[] = [];
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;

  /** @throws TypeError without a Water or a wake with a grid and heights(). */
  constructor(options: WaterWakeOptions) {
    const { surface, wake } = options ?? ({} as WaterWakeOptions);
    if (!surface || typeof (surface as { onDispose?: unknown }).onDispose !== 'function')
      throw new TypeError('WaterWake needs the Water it draws on; pass options.surface.');
    if (!wake || typeof wake.heights !== 'function' || !wake.grid)
      throw new TypeError('WaterWake needs a wake with grid and heights(); pass a WakeSolver.');
    const [nx, nz] = wake.grid.cells;
    if (!(Number.isInteger(nx) && Number.isInteger(nz) && nx >= 4 && nz >= 4 && wake.grid.cellSize > 0))
      throw new TypeError('WaterWake needs a wake grid of at least 4 x 4 cells and a cell size above 0.');
    this.surface = surface;
    this.wake = wake;
  }

  /** Attaches a wake to `engine` and to its Water. */
  static attach(engine: Engine | EngineKernel, options: WaterWakeOptions): WaterWake {
    const effect = new WaterWake(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'WaterWake is disposed; attach a new one');
    this.engine = engine;
    const device = engine.gpu,
      [nx, nz] = this.wake.grid.cells;
    if (!device) throw fault('state', "WaterWake needs a WebGPU engine; attach it to the Water's engine.");
    this.heights = new Float32Array(nx * nz);
    this.grid = device.createBuffer({
      size: this.header.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.field = device.createBuffer({
      size: this.heights.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.resources = [{ buffer: this.grid }, { buffer: this.field }];
    this.remove = addSurfaceEffect(this.surface, {
      key: 'wake',
      vertex: true,
      count: 2,
      shader: (code, binding) => this.shader(code, binding),
      prepare: (c) => {
        this.upload(c);
        return this.resources;
      },
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }

  /** The wake's heights as they stand, rounded once to f32, and its grid. */
  private upload(c: Context): void {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'WaterWake and Water must use the same engine; attach both to one engine');
    const { cells, cellSize, origin } = this.wake.grid,
      source = this.wake.heights();
    if (source.length !== this.heights.length)
      throw fault(
        'state',
        `The wake's grid changed size (${source.length} heights for ${this.heights.length}); attach a new WaterWake.`,
      );
    for (let i = 0; i < source.length; i++) this.heights[i] = source[i]!;
    this.header.set([origin[0], origin[1], cellSize, 0, cells[0], cells[1], 0, 0]);
    c.device.queue.writeBuffer(this.grid!, 0, this.header);
    c.device.queue.writeBuffer(this.field!, 0, this.heights as Float32Array<ArrayBuffer>);
  }

  private shader(code: string, binding: number): string {
    const prefix = `
@group(0) @binding(${binding}) var<uniform> wakeGrid:array<vec4f,2>;
@group(0) @binding(${binding + 1}) var<storage,read> wakeField:array<f32>;
// The wake's height at cell (i, j), 0 off its grid; read bilinearly between cell centres, and 0 within a cell and a half
// of the grid's edge, as WakeSolver.sample reads it.
fn wakeAt(p:vec2i)->f32 {let n=vec2i(i32(wakeGrid[1].x),i32(wakeGrid[1].y));if(any(p<vec2i(0))||any(p>=n)){return 0.0;}return wakeField[u32(p.y*n.x+p.x)];}
fn wakeHeight(xz:vec2f)->f32 {let c=wakeGrid[0].z;let n=vec2f(wakeGrid[1].x,wakeGrid[1].y);let p=(xz-wakeGrid[0].xy)/c-0.5;
 if(any(p<vec2f(1.0))||any(p>=n-vec2f(2.0))){return 0.0;}
 let a=vec2i(floor(p));let t=p-floor(p);
 return mix(mix(wakeAt(a),wakeAt(a+vec2i(1,0)),t.x),mix(wakeAt(a+vec2i(0,1)),wakeAt(a+vec2i(1,1)),t.x),t.y);}
`;
    return (
      prefix +
      code.replace(
        'return Surface(p,normalize(cross(binormal,tangent)),crest);',
        `
 let wh=wakeHeight(xz);let wc=wakeGrid[0].z;
 p.y+=wh;tangent.y+=(wakeHeight(xz+vec2f(wc,0))-wakeHeight(xz-vec2f(wc,0)))/(2.0*wc);
 binormal.y+=(wakeHeight(xz+vec2f(0,wc))-wakeHeight(xz-vec2f(0,wc)))/(2.0*wc);
 return Surface(p,normalize(cross(binormal,tangent)),crest);`,
      )
    );
  }

  /** Stops drawing the wake and releases its buffers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.remove?.();
    this.removeDispose?.();
    this.grid?.destroy();
    this.field?.destroy();
    this.grid = this.field = undefined;
    this.resources = [];
    this.engine?.sceneOf(this)?.removePlugin(this.name);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
