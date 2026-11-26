import { retire } from '../../shared/frame-resources.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Axes = readonly [number, number, number];

/** A Cartesian cell-centred air temperature field in world coordinates. */
export interface HeatHazeVolume {
  /** Lower grid corner in world metres, half a cell before the centre of the first cell. */
  readonly origin: Axes;
  /** Positive integer counts of cells in x, y and z. */
  readonly dimensions: Axes;
  /** Full cell width in metres along each axis. */
  readonly cellSize: Axes;
  /** One positive temperature in kelvin per cell, ordered x fastest, then y, then z. */
  readonly kelvin: ArrayLike<number>;
  /** Uniform local gas pressure in Pa. Defaults to sea-level pressure, 101325 Pa. */
  readonly pressure?: number;
}

function triple(value: Axes): boolean {
  return Array.isArray(value) && value.length === 3;
}

/** Owns the GPU copy. A changed shape is published only after the replacement texture has been written. */
export class HeatHazeVolumeTexture {
  private texture?: GPUTexture;
  private textureView?: GPUTextureView;
  private metadata?: GPUBuffer;
  private values = new Float32Array(0);
  private readonly coordinates = new Float32Array(8);
  private shape?: Axes;

  constructor(private readonly device: GPUDevice) {}

  get resources(): readonly [GPUTextureView, GPUBuffer] {
    return [this.textureView!, this.metadata!];
  }

  update(volume: HeatHazeVolume, ambient: number, refractivity: number): void {
    const { cellSize, dimensions, kelvin, origin } = volume;
    const limit = this.device.limits.maxTextureDimension3D;
    if (!triple(dimensions) || !dimensions.every((n) => Number.isInteger(n) && n > 0 && n <= limit))
      throw new RangeError(
        'Heat haze volume dimensions must be positive integers within the device’s 3D texture limit; pass a smaller grid',
      );
    if (!triple(origin) || !triple(cellSize))
      throw new TypeError('Heat haze volume coordinates need three axes; pass an origin and a cell size in metres');
    for (let axis = 0; axis < 3; axis++) {
      const width = cellSize[axis];
      const start = Math.fround(origin[axis]);
      const inverse = Math.fround(1 / width);
      const lower = Math.fround(start - 0.5 * width);
      const upper = Math.fround(start + (dimensions[axis] + 0.5) * width);
      if (
        !(
          inverse > 0 &&
          Number.isFinite(inverse) &&
          Number.isFinite(lower) &&
          Number.isFinite(upper) &&
          lower < start &&
          start < upper
        )
      )
        throw new RangeError(
          'Heat haze volume coordinates exceed the available float precision; use a local origin and positive cell sizes',
        );
      this.coordinates[axis] = start;
      this.coordinates[axis + 4] = inverse;
    }

    const [width, height, depth] = dimensions;
    const count = width * height * depth;
    if (!kelvin || kelvin.length !== count)
      throw new RangeError('Heat haze volume temperature data has the wrong length; pass one kelvin value per cell');
    if (this.values.length !== count) this.values = new Float32Array(count);
    this.coordinates[3] = 1 / (1 + refractivity);
    for (let i = 0; i < count; i++) {
      const temperature = kelvin[i]!;
      const relative = Math.fround(refractivity * ((ambient - temperature) / temperature));
      if (!(temperature > 0 && Number.isFinite(temperature) && Number.isFinite(relative)))
        throw new RangeError('Heat haze volume has an invalid temperature; pass positive finite kelvin values');
      this.values[i] = relative;
    }

    const resized = !this.shape || dimensions.some((n, i) => n !== this.shape![i]);
    const device = this.device;
    const size = [width, height, depth];
    const texture = resized
      ? device.createTexture({
          label: 'heat haze refractivity',
          size,
          dimension: '3d',
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        })
      : this.texture!;
    try {
      const view = resized ? texture.createView() : this.textureView!;
      this.metadata ??= device.createBuffer({
        label: 'heat haze volume coordinates',
        size: this.coordinates.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture }, this.values, { bytesPerRow: 4 * width, rowsPerImage: height }, size);
      device.queue.writeBuffer(this.metadata, 0, this.coordinates);
      if (resized) {
        retire(device, this.texture);
        this.texture = texture;
        this.textureView = view;
        this.shape = [width, height, depth];
      }
    } catch (error) {
      if (resized) retire(device, texture);
      throw error;
    }
  }

  dispose(): void {
    retire(this.device, this.texture);
    retire(this.device, this.metadata);
    this.texture = this.textureView = this.metadata = this.shape = undefined;
    this.values = new Float32Array(0);
  }
}

// Reconstruct the refractive index on the uniform lattice between cell centres, including one ambient ghost
// centre outside each edge. The grid traversal visits each crossed interpolation cell once. On that interval the
// transverse gradient is quadratic along the ray, and the linear depth weight makes it at most cubic. A
// two-point Gauss–Legendre rule integrates that polynomial exactly (Raffel 2015, equations 1–3 give the optics).
export const heatHazeVolumeWgsl = `
struct HeatVolume { origin:vec4f, invSize:vec4f }
@group(0) @binding(4) var refractivity:texture_3d<f32>;
@group(0) @binding(5) var<uniform> volume:HeatVolume;
fn gridValue(p:vec3i, shape:vec3i)->f32 {
 if(any(p<vec3i(0))||any(p>=shape)){return 0.0;}
 return textureLoad(refractivity,p,0).r;
}
fn gridGradient(lo:vec4f,hi:vec4f,q:vec3f)->vec3f {
 return vec3f(
  mix(mix(lo.y-lo.x,lo.w-lo.z,q.y),mix(hi.y-hi.x,hi.w-hi.z,q.y),q.z),
  mix(mix(lo.z-lo.x,lo.w-lo.y,q.x),mix(hi.z-hi.x,hi.w-hi.y,q.x),q.z),
  mix(mix(hi.x-lo.x,hi.y-lo.y,q.x),mix(hi.z-lo.z,hi.w-lo.w,q.x),q.y)
 );
}
fn gridBend(o:vec3f,dir:vec3f,tb:f32)->vec4f {
 let extent=vec3i(textureDimensions(refractivity,0));
 let q0=(o-volume.origin.xyz)*volume.invSize.xyz-vec3f(0.5);
 let rate=dir*volume.invSize.xyz;
 let moving=abs(dir)>vec3f(1e-12);
 let lower=vec3f(-1.0);let upper=vec3f(extent);
 if(any(select(q0<lower,vec3<bool>(false),moving))||any(select(q0>upper,vec3<bool>(false),moving))){return vec4f(0.0,0.0,0.0,1e30);}
 let inv=1.0/select(vec3f(1.0),rate,moving);
 let face0=(lower-q0)*inv;let face1=(upper-q0)*inv;
 let enter=select(vec3f(-1e30),min(face0,face1),moving);
 let exit=select(vec3f(1e30),max(face0,face1),moving);
 let t0=max(max(enter.x,enter.y),max(enter.z,0.0));
 let t1=min(min(exit.x,exit.y),min(exit.z,tb));
 if(t1<=t0){return vec4f(0.0,0.0,0.0,1e30);}
 let start=clamp(q0+rate*t0,lower,upper);
 let increasing=rate>=vec3f(0.0);
 let step=select(vec3i(-1),vec3i(1),increasing);
 var cell=clamp(select(vec3i(ceil(start))-vec3i(1),vec3i(floor(start)),increasing),vec3i(-1),extent-vec3i(1));
 var next=select(vec3f(1e30),(vec3f(cell)+select(vec3f(0.0),vec3f(1.0),increasing)-q0)*inv,moving);
 var t=t0;var first=1e30;var bend=vec3f(0.0);
 for(var crossed=0;crossed<=extent.x+extent.y+extent.z+3;crossed++){
  let stop=min(t1,min(next.x,min(next.y,next.z)));
  if(stop>t){
   let lo=vec4f(gridValue(cell,extent),gridValue(cell+vec3i(1,0,0),extent),gridValue(cell+vec3i(0,1,0),extent),gridValue(cell+vec3i(1,1,0),extent));
   let hi=vec4f(gridValue(cell+vec3i(0,0,1),extent),gridValue(cell+vec3i(1,0,1),extent),gridValue(cell+vec3i(0,1,1),extent),gridValue(cell+vec3i(1,1,1),extent));
   let mid=(t+stop)*0.5;let radius=(stop-t)*0.5;
   let a=mid-radius*0.57735026919;let b=mid+radius*0.57735026919;
   let qa=clamp(q0+rate*a-vec3f(cell),vec3f(0.0),vec3f(1.0));
   let qb=clamp(q0+rate*b-vec3f(cell),vec3f(0.0),vec3f(1.0));
   let g=(gridGradient(lo,hi,qa)*(1.0-a/tb)+gridGradient(lo,hi,qb)*(1.0-b/tb))*volume.invSize.xyz;
   let transverse=g-dir*dot(dir,g);
   if(any(transverse!=vec3f(0.0))){first=min(first,t);bend+=transverse*radius;}
  }
  if(stop>=t1){break;}
  let hit=next<=vec3f(stop);
  cell+=select(vec3i(0),step,hit);
  next+=select(vec3f(0.0),abs(inv),hit);
  t=max(t,stop);
 }
 return vec4f(bend*volume.origin.w,first);
}`;
