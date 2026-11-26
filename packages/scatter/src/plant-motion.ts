/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { ScatterStateSource } from './index.js';
import type { PlantStateSource } from './states.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** One rooted instance slot. Entries follow the source solver's plant order. */
export interface PlantMotionRoot {
  /** Root position in the scatter's X/Z coordinates, in metres. */
  readonly xz: readonly [number, number];
  /** Height of the solver's tip above the root, in metres. */
  readonly height: number;
}

/** Options for binding solved plant poses to scatter instances. */
export interface PlantMotionOptions {
  /** Exactly one solver plant in each occupied X/Z cell. Instances in empty cells keep their usual posing. */
  readonly roots: readonly PlantMotionRoot[];
  /** Spatial cell width in metres. Place the scatter root and corresponding solver root in the same cell. */
  readonly cellSize: number;
  /** Grid origin before binning roots, in metres on X and Z. Defaults to [0, 0]. */
  readonly origin?: readonly [number, number];
  /** Copies `PlantSway.readSway()` pose records in the order of `roots`. */
  readonly readSway: () => Float64Array;
  /** Hide the standing instance on rupture or uprooting if detached geometry is drawn separately. Defaults to false. */
  readonly hideFailed?: boolean;
  /** Optional preceding burn, moisture or flood treatment in the scatter pose. */
  readonly states?: PlantStateSource;
}

const BEND =
  'let bend=windBend(world.y-position.y,position.xz,wind,vec4f(sway.x*position.w,sway.yzw));world+=vec3f(bend.x,-bend.w,bend.y);';
const NORMAL = 'windNormal(scatterTurn(n,c,s,up),bend,wind)';
const STRIDE = 13;
const RECORD = 8;

// Each cell key and coefficient record lives in a sorted array, identically for every pass and LOD. plantMode is the
// tip-normalized clamped/free mode and its derivative on dimensionless height.
const shader = (
  group: number,
  binding: number,
  cells: number,
  size: number,
  origin: readonly number[],
): string => /* wgsl */ `
struct PlantMotionRecord {cell:vec2f, inverseHeight:f32, height:f32, motion:vec4f}
@group(${group}) @binding(${binding}) var<storage,read> plantMotion:array<PlantMotionRecord>;
const plantCellSize:f32=${size};
fn plantCellIndex(root:vec2f)->i32 {
 let key=floor((root-vec2f(${origin[0]},${origin[1]}))/plantCellSize);
 var lo=0u; var hi=${cells}u;
 while(lo<hi){
  let i=lo+(hi-lo)/2u; let cell=plantMotion[i].cell;
  if(all(cell==key)){return i32(i);}
  if(cell.x<key.x||(cell.x==key.x&&cell.y<key.y)){lo=i+1u;}else{hi=i;}
 }
 return -1;
}
fn plantMode(h:f32,beta:f32,c:f32,tip:f32)->vec2f {
 let x=h*beta; let e=exp(x); let ch=(e+1.0/e)*0.5; let sh=(e-1.0/e)*0.5;
 let sn=sin(x); let cs=cos(x);
 return vec2f(select((ch-cs-c*(sh-sn))/tip,1.0,h==1.0),
              beta*(sh+sn-c*(ch-cs))/tip);
}
fn plantShape(record:PlantMotionRecord,height:f32)->vec4f {
 if(height<=0.0){return vec4f(0.0);}
 let h=min(height*record.inverseHeight,1.0);
 let a=plantMode(h,1.875104068711961,0.7340955137589128,2.0);
 let b=plantMode(h,4.694091132974175,1.018467318759219,-2.0);
 let offset=record.motion.xy*a.x+record.motion.zw*b.x;
 let slope=(record.motion.xy*a.y+record.motion.zw*b.y)*record.inverseHeight;
 return vec4f(offset,select(slope,vec2f(0.0),height>record.height));
}
fn plantNormal(normal:vec3f,slope:vec2f)->vec3f {
 return vec3f(normal.x,normal.y-dot(normal.xz,slope),normal.z);
}
`;

/** Uses solved plant motion in the colour, depth and shadow passes of a Scatter. */
export class PlantMotion implements ScatterStateSource, Disposable {
  readonly #size: number;
  readonly #origin: readonly number[];
  readonly #order: readonly number[];
  readonly #data: Float32Array<ArrayBuffer>;
  readonly #readSway: () => Float64Array;
  readonly #hideFailed: boolean;
  readonly #states?: PlantStateSource;
  #device?: GPUDevice;
  #buffer?: GPUBuffer;
  #disposed = false;

  constructor(options: PlantMotionOptions) {
    const size = Math.fround(options.cellSize);
    const origin = (options.origin ?? [0, 0]).map(Math.fround);
    if (!(size > 0 && Number.isFinite(size)) || options.roots.length === 0 || typeof options.readSway !== 'function')
      throw new RangeError(
        'PlantMotion needs roots, a positive cell size and a pose source; see https://margoengine.com/errors#scatter',
      );
    if (origin.length !== 2 || !origin.every(Number.isFinite))
      throw new RangeError(
        'PlantMotion origin needs two finite coordinates; see https://margoengine.com/errors#scatter',
      );
    this.#size = size;
    this.#origin = origin;
    const sorted = options.roots
      .map(({ xz, height }, i) => {
        const key = xz.map((value, axis) =>
          Math.floor(Math.fround(Math.fround(Math.fround(value) - origin[axis]!) / size)),
        );
        const h = Math.fround(height);
        const inverse = Math.fround(1 / h);
        if (
          key.length !== 2 ||
          !key.every((value) => Number.isSafeInteger(value) && Math.fround(value) === value) ||
          !(h > 0) ||
          !Number.isFinite(h) ||
          !Number.isFinite(inverse)
        )
          throw new RangeError(
            'PlantMotion root or stem height cannot be represented by the GPU; see https://margoengine.com/errors#scatter',
          );
        return { x: key[0]!, z: key[1]!, h, inverse, i };
      })
      .sort((a, b) => a.x - b.x || a.z - b.z);
    this.#data = new Float32Array(sorted.length * RECORD);
    this.#order = sorted.map(({ x, z, h, inverse, i }, n) => {
      if (n > 0 && sorted[n - 1]!.x === x && sorted[n - 1]!.z === z)
        throw new RangeError(
          'PlantMotion needs one root per cell; reduce the cell size; see https://margoengine.com/errors#scatter',
        );
      this.#data.set([x, z, inverse, h], n * RECORD);
      return i;
    });
    this.#readSway = options.readSway;
    this.#hideFailed = options.hideFailed ?? false;
    this.#states = options.states;
  }

  /** Adds the shape to all of the existing scatter posing passes. */
  poseCode(code: string, group: number, binding: number): string {
    const base = this.#states?.poseCode(code, group, binding) ?? code;
    const at = base.indexOf('struct ScatterPose ');
    if (at < 0 || !base.includes(BEND) || !base.includes(NORMAL))
      throw new MargoError(
        'state',
        'PlantMotion requires a scatter vertex pose; see https://margoengine.com/errors#scatter',
      );
    const entries = this.#states ? 2 : 0;
    return (
      base.slice(0, at) +
      shader(group, binding + entries, this.#order.length, this.#size, this.#origin) +
      base
        .slice(at)
        .replace(
          BEND,
          `let plantIndex=plantCellIndex(position.xz);var plantDelta=vec4f(0.0);
      if(plantIndex>=0){
        let plant=plantMotion[u32(plantIndex)];
        if(plant.height<0.0){return ScatterPose(position.xyz,vec3f(0,1,0),vec4f(0.0),0.0);}
        plantDelta=plantShape(plant,world.y-position.y);
      }
      let activeWind=select(wind,vec4f(0.0),plantIndex>=0);
      let bend=windBend(world.y-position.y,position.xz,activeWind,vec4f(sway.x*position.w,sway.yzw));
      world+=vec3f(bend.x+plantDelta.x,-bend.w,bend.y+plantDelta.y);`,
        )
        .replace(NORMAL, 'plantNormal(windNormal(scatterTurn(n,c,s,up),bend,activeWind),plantDelta.zw)')
    );
  }

  entries(device: GPUDevice): { buffer: GPUBuffer }[] {
    const buffer = this.#on(device);
    const previous = this.#states?.entries(device) ?? [];
    return [...previous, { buffer }];
  }

  update(context: { device: GPUDevice; encoder: GPUCommandEncoder }): void {
    const device = context.device;
    this.#states?.update(context);
    const buffer = this.#on(device);
    const records = this.#readSway();
    if (!(records instanceof Float64Array) || records.length !== this.#order.length * STRIDE)
      throw new RangeError(
        'PlantMotion pose records do not match its roots; see https://margoengine.com/errors#scatter',
      );
    for (const [n, i] of this.#order.entries()) {
      const source = i * STRIDE;
      const to = n * RECORD + 4;
      if (this.#hideFailed) this.#data[to - 1] = Math.abs(this.#data[to - 1]!) * (records[source + 9] === 0 ? 1 : -1);
      for (let axis = 0; axis < 4; axis++) {
        const value = Math.fround(records[source + axis]!);
        if (!Number.isFinite(value))
          throw new RangeError('PlantMotion pose exceeds GPU precision; see https://margoengine.com/errors#scatter');
        this.#data[to + axis] = value;
      }
    }
    device.queue.writeBuffer(buffer, 0, this.#data);
  }

  #on(device: GPUDevice): GPUBuffer {
    if (this.#disposed)
      throw new MargoError('disposed', 'PlantMotion is disposed; see https://margoengine.com/errors#scatter');
    if (device !== this.#device || !this.#buffer) {
      const size = this.#data.byteLength;
      if (size > device.limits.maxBufferSize || size > device.limits.maxStorageBufferBindingSize)
        throw new RangeError(
          'PlantMotion exceeds the GPU storage limit; split the scatter into tiles; see https://margoengine.com/errors#scatter',
        );
      this.#buffer?.destroy();
      this.#buffer = device.createBuffer({
        label: 'Plant motion',
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#device = device;
    }
    return this.#buffer;
  }

  /** Releases GPU resources. It does not dispose the optional preceding states. */
  dispose(): void {
    this.#disposed = true;
    this.#buffer?.destroy();
    this.#device = this.#buffer = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
