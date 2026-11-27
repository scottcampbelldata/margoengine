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
type Vec3 = readonly [number, number, number];

function finiteWord(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(Math.fround(value));
}

function finiteWords(value: unknown, count: number): value is ArrayLike<number> {
  if (typeof value !== 'object' || value === null) return false;
  const words = value as ArrayLike<number>;
  if (words.length !== count) return false;
  for (let i = 0; i < count; i++) if (!finiteWord(words[i])) return false;
  return true;
}

/** State from an accepted wall sample, such as the reflecting edge of a physics wake. */
export interface WaterWallSample {
  /** Surface elevation in metres, in the same frame as the crest. */
  readonly height: number;
  /** Surface velocity in world axes, m/s. */
  readonly velocity: Vec3;
}

/**
 * The launch point and velocity of a visual spray burst when a rising physical surface crosses a wall's crest.
 * Supply consecutive accepted wall samples and the fixed crest position at that sample. The velocity is interpolated
 * at the crossing and can go directly to a VFX burst. A smooth subcrest rise has no airborne emitter. This draws a
 * resolved overtopping crossing; droplet population and nonlinear wave impact are outside the linear wake model.
 */
export function wallOvertoppingSpawn(
  previous: WaterWallSample,
  current: WaterWallSample,
  crest: Vec3,
): { position: Vec3; velocity: Vec3; fraction: number } | undefined {
  if (
    !finiteWord(previous?.height) ||
    !finiteWord(current?.height) ||
    !finiteWords(crest, 3) ||
    !finiteWords(previous.velocity, 3) ||
    !finiteWords(current.velocity, 3)
  )
    throw fault(
      'state',
      'Give wall spray consecutive samples with a finite height and three velocity components, and a finite XYZ crest in world metres.',
    );
  const level = crest[1];
  if (!(previous.height < level && current.height >= level)) return undefined;
  const fraction = (level - previous.height) / (current.height - previous.height);
  const { velocity: before } = previous;
  const { velocity: after } = current;
  const a = before[0],
    b = before[1],
    c = before[2];
  const x = after[0],
    y = after[1],
    z = after[2];
  const velocity: Vec3 = [a + (x - a) * fraction, b + (y - b) * fraction, c + (z - c) * fraction];
  if (!(velocity[1] > 0)) return undefined;
  return { position: [crest[0], level, crest[2]], velocity, fraction };
}

/** A wake Water draws: its grid and its heights (x fastest, then z). `WakeSolver` of `@margoengine/physics/sea` is one. */
export interface WaterWakeSource {
  readonly grid: {
    readonly cells: readonly [number, number];
    readonly cellSize: number;
    readonly origin: readonly [number, number];
  };
  heights(): ArrayLike<number>;
  /**
   * Fixed finite geometry, one byte per cell. Bit 1 means wet, bit 2 an open face toward +X and bit 4 an open face
   * toward +Z. WaterWake copies the mask at attachment. Attach a new wake if the grid or its geometry changes.
   */
  surfaceMask?(): Uint8Array;
}

function fixedMask(wake: WaterWakeSource, nx: number, nz: number): Uint8Array | undefined {
  if (wake.surfaceMask === undefined) return undefined;
  const mask = typeof wake.surfaceMask === 'function' ? wake.surfaceMask() : undefined;
  const invalid = () =>
    fault('state', 'Supply a WaterWake surfaceMask() with one byte per cell and open faces joining wet grid cells.');
  if (!(mask instanceof Uint8Array) || mask.length !== nx * nz) throw invalid();
  for (let i = 0; i < mask.length; i++) {
    const bits = mask[i]!;
    if (
      bits > 7 ||
      (bits !== 0 && !(bits & 1)) ||
      (bits & 2 && (i % nx === nx - 1 || !(mask[i + 1]! & 1))) ||
      (bits & 4 && (i + nx >= mask.length || !(mask[i + nx]! & 1)))
    )
      throw invalid();
  }
  return new Uint8Array(mask);
}

/** Options of {@link WaterWake}. */
export interface WaterWakeOptions {
  /** The Water to draw it on, attached to the same engine. */
  surface: Water;
  /** The wake. */
  wake: WaterWakeSource;
  /** Render only at or above this world Z, for a straight quay with water on its +Z side. Wave queries retain the full grid. */
  minWetZ?: number;
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
  private readonly minWetZ?: number;
  private readonly mask?: Uint8Array;
  private engine?: Engine;
  private grid?: GPUBuffer;
  private field?: GPUBuffer;
  private maskBuffer?: GPUBuffer;
  private heights = new Float32Array(0);
  private readonly header = new Float32Array(8);
  private resources: GPUBindingResource[] = [];
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;

  /** @throws MargoError `state` without a Water, a valid wake grid and heights(), or a finite wet-side boundary. */
  constructor(options: WaterWakeOptions) {
    const { surface, wake, minWetZ } = options ?? ({} as WaterWakeOptions);
    if (!surface || typeof (surface as { onDispose?: unknown }).onDispose !== 'function')
      throw fault('state', 'WaterWake needs the Water it draws on; pass options.surface.');
    const grid = wake?.grid;
    if (!grid || typeof wake.heights !== 'function')
      throw fault('state', 'WaterWake needs a wake with grid and heights(); pass a WakeSolver.');
    const { cells, cellSize, origin } = grid;
    if (
      !finiteWords(cells, 2) ||
      !Number.isInteger(cells[0]) ||
      cells[0] < 4 ||
      !Number.isInteger(cells[1]) ||
      cells[1] < 4 ||
      !finiteWord(cellSize) ||
      Math.fround(cellSize) <= 0 ||
      !finiteWords(origin, 2)
    )
      throw fault(
        'state',
        'Give WaterWake a grid of at least 4 x 4 cells with a positive finite cell size and a finite XZ origin.',
      );
    if (minWetZ !== undefined && !finiteWord(minWetZ))
      throw fault('state', 'Set the WaterWake wet-side boundary to a finite world Z in metres.');
    this.surface = surface;
    this.wake = wake;
    this.minWetZ = minWetZ;
    this.mask = fixedMask(wake, cells[0], cells[1]);
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
    if (this.mask) {
      this.maskBuffer = device.createBuffer({
        size: this.mask.length * Uint32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.maskBuffer, 0, Uint32Array.from(this.mask));
      this.resources.push({ buffer: this.maskBuffer });
    }
    const key = this.mask ? 'wake-finite' : 'wake';
    this.remove = addSurfaceEffect(this.surface, {
      key: this.minWetZ === undefined ? key : key + '-wet-side',
      vertex: true,
      count: this.resources.length,
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
    if (source?.length !== this.heights.length)
      throw fault(
        'state',
        `The wake returned ${source?.length ?? 'no'} heights for a grid of ${this.heights.length}; supply one height per cell or attach a new WaterWake.`,
      );
    for (let i = 0; i < source.length; i++) this.heights[i] = source[i]!;
    this.header.set([origin[0], origin[1], cellSize, this.minWetZ ?? 0, cells[0], cells[1], 0, 0]);
    c.device.queue.writeBuffer(this.grid!, 0, this.header);
    c.device.queue.writeBuffer(this.field!, 0, this.heights as Float32Array<ArrayBuffer>);
  }

  private shader(code: string, binding: number): string {
    const prefix = `
@group(0) @binding(${binding}) var<uniform> wakeGrid:array<vec4f,2>;
@group(0) @binding(${binding + 1}) var<storage,read> wakeField:array<f32>;
`;
    const open = `
// Read between cell centres, stopping within one and a half cells of the edge like WakeSolver.sample.
fn wakeAt(p:vec2i)->f32 {let n=vec2i(i32(wakeGrid[1].x),i32(wakeGrid[1].y));if(any(p<vec2i(0))||any(p>=n)){return 0.0;}return wakeField[u32(p.y*n.x+p.x)];}
fn wakeHeight(xz:vec2f)->f32 {let c=wakeGrid[0].z;let n=vec2f(wakeGrid[1].x,wakeGrid[1].y);let p=(xz-wakeGrid[0].xy)/c-0.5;
 if(any(p<vec2f(1.0))||any(p>=n-vec2f(2.0))){return 0.0;}
 let a=vec2i(floor(p));let t=p-floor(p);
 return mix(mix(wakeAt(a),wakeAt(a+vec2i(1,0)),t.x),mix(wakeAt(a+vec2i(0,1)),wakeAt(a+vec2i(1,1)),t.x),t.y);}
`;
    const masked = `
@group(0) @binding(${binding + 2}) var<storage,read> wakeMask:array<u32>;
fn wakeGridPoint(xz:vec2f)->vec2f {return (xz-wakeGrid[0].xy)/wakeGrid[0].z;}
fn wakeInside(p:vec2i)->bool {return all(p>=vec2i(0))&&all(p<vec2i(wakeGrid[1].xy));}
fn wakeIndex(p:vec2i)->u32 {return u32(p.y*i32(wakeGrid[1].x)+p.x);}
fn wakeFlags(p:vec2i)->u32 {if(!wakeInside(p)){return 0u;}return wakeMask[wakeIndex(p)];}
fn wakeWet(p:vec2i)->bool {return (wakeFlags(p)&1u)!=0u;}
fn wakeAcrossX(p:vec2i,step:i32)->bool {return (wakeFlags(p+vec2i(min(step,0),0))&2u)!=0u;}
fn wakeAcrossZ(p:vec2i,step:i32)->bool {return (wakeFlags(p+vec2i(0,min(step,0)))&4u)!=0u;}

// Every interpolation or slope probe is at most one cell away in each axis. Follow the physical ray,
// taking X first on a corner tie, as QuayPotential.reaches does.
fn wakeReach(point:vec2f,to:vec2i)->bool {
 let start=vec2i(floor(point));let step=to-start;
 if(!wakeWet(start)||!wakeWet(to)){return false;}
 if(step.x==0){return step.y==0||wakeAcrossZ(start,step.y);}
 if(step.y==0){return wakeAcrossX(start,step.x);}
 let travel=vec2f(to)+vec2f(0.5)-point;
 let boundary=vec2f(start+max(step,vec2i(0)));
 let hits=(boundary-point)/travel;
 if(hits.x<=hits.y){return wakeAcrossX(start,step.x)&&wakeAcrossZ(start+vec2i(step.x,0),step.y);}
 return wakeAcrossZ(start,step.y)&&wakeAcrossX(start+vec2i(0,step.y),step.x);
}
fn wakeHeight(point:vec2f)->f32 {
 let centered=point-vec2f(0.5);
 let corner=vec2i(floor(centered));let fraction=fract(centered);
 var sum=0.0;var height=0.0;
 for(var x=0;x<2;x++){for(var z=0;z<2;z++){
  let to=corner+vec2i(x,z);
  if(wakeReach(point,to)){
   let weight=select(1.0-fraction.x,fraction.x,x==1)*select(1.0-fraction.y,fraction.y,z==1);
   sum+=weight;height+=weight*wakeField[wakeIndex(to)];
  }
 }}
 if(sum==0.0){return 0.0;}return height/sum;
}
fn wakeSlope(point:vec2f,axis:vec2f,height:f32)->f32 {
 let lower=wakeReach(point,vec2i(floor(point-axis)));
 let upper=wakeReach(point,vec2i(floor(point+axis)));
 var before=height;var after=height;var count=0.0;
 if(lower){before=wakeHeight(point-axis);count+=1.0;}
 if(upper){after=wakeHeight(point+axis);count+=1.0;}
 return (after-before)/(wakeGrid[0].z*max(1.0,count));
}
fn wakeDry(xz:vec2f)->bool {
 let cell=vec2i(floor(wakeGridPoint(xz)));
 return wakeInside(cell)&&!wakeWet(cell);
}
`;
    const displacement = this.mask
      ? `
 let point=wakeGridPoint(xz);
 if(wakeWet(vec2i(floor(point)))){
  let height=wakeHeight(point);
  p.y+=height;tangent.y+=wakeSlope(point,vec2f(1,0),height);
  binormal.y+=wakeSlope(point,vec2f(0,1),height);
 }`
      : `
 let wh=wakeHeight(xz);let wc=wakeGrid[0].z;
 p.y+=wh;tangent.y+=(wakeHeight(xz+vec2f(wc,0))-wakeHeight(xz-vec2f(wc,0)))/(2.0*wc);
 binormal.y+=(wakeHeight(xz+vec2f(0,wc))-wakeHeight(xz-vec2f(0,wc)))/(2.0*wc);`;
    const surface =
      prefix +
      (this.mask ? masked : open) +
      code.replace(
        'return Surface(p,normalize(cross(binormal,tangent)),crest);',
        displacement + '\n return Surface(p,normalize(cross(binormal,tangent)),crest);',
      );
    // An infinite mirror still supplies its full derivatives at the clip plane.
    const clipped = this.minWetZ === undefined ? '' : '||i.world.z<wakeGrid[0].w';
    if (!this.mask) return surface.replace('if(dry){discard;}', `if(dry${clipped}){discard;}`);
    // Clip after the shared shader's derivatives. Keep its dry marker available to other surface effects.
    const view = 'let v=normalize(frame.eye.xyz-i.world);';
    return surface.replace(view, `if(wakeDry(i.xz)${clipped}){discard;}\n ${view}`);
  }

  /** Stops drawing the wake and releases its buffers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.remove?.();
    this.removeDispose?.();
    this.grid?.destroy();
    this.field?.destroy();
    this.maskBuffer?.destroy();
    this.grid = this.field = this.maskBuffer = undefined;
    this.resources = [];
    this.engine?.sceneOf(this)?.removePlugin(this.name);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
