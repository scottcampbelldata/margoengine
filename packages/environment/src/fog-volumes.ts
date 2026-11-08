/// <reference lib="esnext.disposable" preserve="true" />
// Local fog volumes (`@margoengine/environment/fog-volumes`): boxes and spheres of fog with their own density, colour
// and 3D noise, added to VolumetricFog's froxel grid (its `volumes` option), so they take the fog's sun shafts, shadows,
// clustered lights, reprojection and integration. Mist in a valley, smoke in a room, a cloud of steam over a vent.
import type { Vec3 } from '@margoengine/core/extension';
import type { VolumetricMediumSource } from './volumetric.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** Settings every fog volume shares; invalid values throw RangeError. */
export interface FogVolumeSettings {
  /** Extinction per metre inside the volume (default 0.1, 0 to 1,000). */
  density?: number;
  /** Scattering albedo, linear RGB 0..1 (default [1, 1, 1]: no absorption). */
  color?: Vec3;
  /** Metres inside the boundary over which the density rises from 0 to full (default 0: a hard edge). */
  edge?: number;
  /** Density noise 0..1 (default 0: uniform fog); drifts with the fog's `wind`. */
  noise?: number;
  /** Noise feature size in metres (default 2). */
  noiseScale?: number;
}
/** An axis-aligned box of fog from `min` to `max`. */
export interface FogBox extends FogVolumeSettings {
  shape: 'box';
  min: Vec3;
  max: Vec3;
}
/** A sphere of fog. */
export interface FogSphere extends FogVolumeSettings {
  shape: 'sphere';
  center: Vec3;
  radius: number;
}
/** One local fog volume: a box or a sphere. */
export type FogVolume = FogBox | FogSphere;

/** Most volumes one {@link FogVolumes} holds: every froxel tests every volume. */
export const MAX_FOG_VOLUMES = 256;

// Volume j: a = box min or sphere centre, w the shape (0 box, 1 sphere); b = box max or (radius, 0, 0), w the edge;
// c = albedo, w the density; d = (noise, 1 / noiseScale, 0, 0). Zero-density entries pad the buffer and are skipped.
// The density at a point is density x smoothstep(0, edge, depth inside), depth from the shape's signed distance (exact
// for a sphere; for a box, the distance to its nearest face), times the fog's two-octave value noise when `noise` > 0.
const wgsl = (group: number) => /* wgsl */ `
struct FogVolume {a:vec4f,b:vec4f,c:vec4f,d:vec4f}
@group(${group}) @binding(0) var<storage,read> fogVolumes:array<FogVolume>;
fn fogMedium(p:vec3f)->vec4f {
  var m=vec4f(0);
  for(var j=0u;j<arrayLength(&fogVolumes);j++){
    let f=fogVolumes[j];if(f.c.w<=0.0){continue;}
    var s=length(p-f.a.xyz)-f.b.x;
    if(f.a.w<0.5){let q=abs(p-(f.a.xyz+f.b.xyz)*0.5)-(f.b.xyz-f.a.xyz)*0.5;s=max(q.x,max(q.y,q.z));}
    if(s>=0.0){continue;}
    var sigma=f.c.w*select(1.0,smoothstep(0.0,f.b.w,-s),f.b.w>0.0);
    if(f.d.x>0.0){let x=(p-volume.wind.xyz)*f.d.y;sigma*=max(0.0,1.0+f.d.x*(1.3333*noise(x)+0.6667*noise(x*2.11+vec3f(23.7,-11.3,5.9))-1.0));}
    m+=vec4f(sigma*f.c.rgb,sigma);
  }
  return m;
}
`;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(Math.fround(v));
const vec3 = (v: unknown, min = -Infinity, max = Infinity): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => finite(x) && x >= min && x <= max);
const range = (v: unknown, fallback: number, min: number, max: number): boolean => {
  const x = v ?? fallback;
  return finite(x) && x >= min && x <= max;
};
function valid(f: FogVolume): boolean {
  if (!f || typeof f !== 'object') return false;
  const shape =
    f.shape === 'box'
      ? vec3(f.min, -1e9, 1e9) && vec3(f.max, -1e9, 1e9) && f.min.every((x, i) => x < f.max[i])
      : f.shape === 'sphere' && vec3(f.center, -1e9, 1e9) && finite(f.radius) && f.radius > 0 && f.radius <= 1e9;
  return (
    shape &&
    range(f.density, 0.1, 0, 1e3) &&
    (f.color === undefined || vec3(f.color, 0, 1)) &&
    range(f.edge, 0, 0, 1e9) &&
    range(f.noise, 0, 0, 1) &&
    range(f.noiseScale, 2, 1e-3, 1e6) &&
    (f.noiseScale === undefined || f.noiseScale > 0)
  );
}

/**
 * Local fog volumes for `VolumetricFog` (`new VolumetricFog({ volumes })`). Each volume's fog adds to the fog's own
 * (set its `density` to 0 for local fog only) and is lit like it: sun, shafts, ambient, clustered lights.
 * `volumes` is read every frame: change a volume's fields, or replace the array, and the next frame shows it.
 */
export class FogVolumes implements VolumetricMediumSource {
  private buffer?: GPUBuffer;
  private device?: GPUDevice;
  private entries: GPUBindGroupEntry[] = [];
  private data = new Float32Array(16);
  private disposed = false;
  constructor(public volumes: FogVolume[] = []) {
    this.validate();
  }
  private validate(): void {
    const list = this.volumes;
    if (!Array.isArray(list) || list.length > MAX_FOG_VOLUMES || !list.every(valid))
      throw new RangeError(
        `Invalid fog volumes; pass at most ${MAX_FOG_VOLUMES} boxes (min < max) or spheres (radius > 0) with in-range settings (see FogVolume)`,
      );
  }
  /** @internal The volumes as the shader reads them (16 floats each), padded with empty entries to the buffer size. */
  pack(): Float32Array {
    this.validate();
    const list = this.volumes;
    let capacity = this.data.length / 16;
    while (capacity < list.length) capacity *= 2;
    if (capacity * 16 !== this.data.length) this.data = new Float32Array(capacity * 16);
    const d = this.data;
    d.fill(0);
    list.forEach((f, j) => {
      const o = j * 16,
        sphere = f.shape === 'sphere';
      d.set(sphere ? f.center : f.min, o);
      d[o + 3] = sphere ? 1 : 0;
      if (sphere) d[o + 4] = f.radius;
      else d.set(f.max, o + 4);
      d[o + 7] = f.edge ?? 0;
      d.set(f.color ?? [1, 1, 1], o + 8);
      d[o + 11] = f.density ?? 0.1;
      d[o + 12] = f.noise ?? 0;
      d[o + 13] = 1 / (f.noiseScale ?? 2);
    });
    return d;
  }
  /** WGSL for VolumetricFog's froxel pass: `fogMedium(p)`, the volumes' scattering (rgb) and extinction (a) at `p`. */
  medium(group: number): string {
    return wgsl(group);
  }
  /** Uploads the volumes and returns the bind group entries (the same array until the buffer is replaced). */
  bindings(device: GPUDevice): GPUBindGroupEntry[] {
    if (this.disposed) throw new RangeError('FogVolumes is disposed; create a new FogVolumes');
    const data = this.pack();
    if (this.device !== device || !this.buffer || this.buffer.size !== data.byteLength) {
      this.buffer?.destroy();
      this.device = device;
      this.buffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.entries = [{ binding: 0, resource: { buffer: this.buffer } }];
    }
    device.queue.writeBuffer(this.buffer, 0, data as Float32Array<ArrayBuffer>);
    return this.entries;
  }
  /** Frees the GPU buffer; a VolumetricFog still using it must drop its `volumes` first. */
  dispose(): void {
    this.disposed = true;
    this.buffer?.destroy();
    this.buffer = this.device = undefined;
    this.entries = [];
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
