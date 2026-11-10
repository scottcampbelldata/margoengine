import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { overlayBlend } from '../../shared/pass.js';
import { SkyLayer, backdropVertex, type Context } from './backdrop.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
/** North-first, east-right, 0-longitude-centred equirectangular sRGB RGBA8 pixels. */
export interface MoonAlbedo {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>;
}
/** Decode a caller-hosted lunar map. No network access occurs on import or construction. */
export async function loadMoonAlbedo(url: string | URL, options: { signal?: AbortSignal } = {}): Promise<MoonAlbedo> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new MargoError('failed', `Moon albedo HTTP ${response.status}: ${url}; use a reachable lunar map URL; see https://margoengine.com/errors#failed`);
  const image = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
  try {
    options.signal?.throwIfAborted();
    const canvas = new OffscreenCanvas(image.width, image.height),
      context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    return { width: image.width, height: image.height, data };
  } finally {
    image.close();
  }
}
type Direction = readonly [number, number, number];
/** Mutable moon settings; the centre always shows lunar longitude/latitude 0, with no libration. */
export interface MoonOptions {
  /** Required lunar map; replace the object to upload a new map. */
  albedo: MoonAlbedo;
  /** World direction to the Moon. Default [0, 0, -1]. */
  direction?: Direction;
  /** Lunar north projected onto the sky; independent of camera roll. Default world +Y. Must not parallel direction. */
  north?: Direction;
  /** World direction from the Moon to the Sun. Default [1, 0, 0]. */
  sunDirection?: Direction;
  /** Angular radius in degrees, greater than 0 and at most 30. Default 0.2725. */
  angularRadius?: number;
  /** Sunlit albedo multiplier, 0 to 1000. Default 1. */
  intensity?: number;
  /** Full-Earth illumination relative to sunlight, 0 to 1. Default 0.001. Scaled by Earth's Lambert phase. */
  earthshine?: number;
}
const unit = (v: Direction, name: string): number[] => {
  if (!v || v.length !== 3 || !v.every(Number.isFinite) || !(Math.hypot(...v) > 0))
    throw new TypeError(`Moon ${name} must be three finite numbers, not all zero.`);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
/** Earth's Lambert phase, where cosine is Moon-to-observer dot Moon-to-Sun. */
export function moonEarthshine(cosine: number): number {
  if (!Number.isFinite(cosine) || Math.abs(cosine) > 1) throw new RangeError('Moon phase cosine must be from -1 to 1.');
  const angle = Math.acos(-cosine);
  return Math.max(0, (Math.sin(angle) + (Math.PI - angle) * Math.cos(angle)) / Math.PI);
}
const basis = (o: MoonOptions) => {
  if (!o || typeof o !== 'object') throw new TypeError('Pass Moon options with an albedo map.');
  const a = o.albedo;
  if (
    !a ||
    !Number.isSafeInteger(a.width) ||
    !Number.isSafeInteger(a.height) ||
    a.width < 1 ||
    a.height < 1 ||
    !(a.data instanceof Uint8Array || a.data instanceof Uint8ClampedArray) ||
    a.data.length !== a.width * a.height * 4
  )
    throw new TypeError('Moon albedo must contain width * height * 4 RGBA8 bytes.');
  for (const [key, value, low, high] of [
    ['angularRadius', o.angularRadius ?? 0.2725, Number.MIN_VALUE, 30],
    ['intensity', o.intensity ?? 1, 0, 1000],
    ['earthshine', o.earthshine ?? 0.001, 0, 1],
  ] as const)
    if (!(Number.isFinite(value) && value >= low && value <= high)) throw new RangeError(`Invalid Moon ${key}; use the documented finite range.`);
  const d = unit(o.direction ?? [0, 0, -1], 'direction'),
    n = unit(o.north ?? [0, 1, 0], 'north');
  const e = cross(d, n);
  if (Math.hypot(...e) < 1e-8) throw new RangeError('Moon north must not be parallel to direction.');
  const east = unit(e as unknown as Direction, 'east');
  return { d, east, north: cross(east, d), sun: unit(o.sunDirection ?? [1, 0, 0], 'sunDirection') };
};
const shader = `struct U {inverse:mat4x4f,eye:vec4f,direction:vec4f,east:vec4f,north:vec4f,sun:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var albedo:texture_2d<f32>;
@group(0) @binding(2) var filtering:sampler;
${backdropVertex}
@fragment fn fragment(i:O)->@location(0) vec4f {
 let p=u.inverse*vec4f(i.ndc,0.000001,1.0);let ray=normalize(p.xyz/p.w-u.eye.xyz);
 let t=dot(ray,u.direction.xyz);let r=u.direction.w;let q=r*r-(1.0-t*t);
 if(t<=0.0||q<=0.0){discard;}
 let n=normalize((t-sqrt(q))*ray-u.direction.xyz);
 let x=dot(n,u.east.xyz);let y=dot(n,u.north.xyz);let z=dot(n,-u.direction.xyz);
 let uv=vec2f(0.5+atan2(x,z)/6.28318530718,0.5-asin(clamp(y,-1.0,1.0))/3.14159265359);
 let base=textureSampleLevel(albedo,filtering,uv,0.0).rgb;
 let direct=max(0.0,dot(n,u.sun.xyz));let earth=u.params.y*max(0.0,z);
 return vec4f(base*u.params.x*(direct+earth*vec3f(0.8,0.9,1.0)),1.0);
}`;
/** A spherical textured lunar disc at infinity, with a real terminator and earthshine, masked by scene depth. */
export class Moon extends SkyLayer {
  readonly name = 'scenery:moon';
  private texture?: GPUTexture;
  private sampler?: GPUSampler;
  private source?: MoonAlbedo;
  private entries: GPUBindGroupEntry[] = [];
  constructor(readonly options: MoonOptions) {
    super('Moon', 2.6, new Float32Array(40), shader, overlayBlend);
    basis(options);
  }
  static attach(engine: EngineKernel, options: MoonOptions): Moon {
    const moon = new Moon(options);
    engineRuntime(engine).use(moon);
    return moon;
  }
  onPreUpdate(): void {
    basis(this.options);
  }
  protected frame(c: Context): boolean {
    const o = this.options,
      { d, east, north, sun } = basis(o),
      v = this.values;
    v.set(c.camera.position, 16);
    v.set(d, 20);
    v[23] = Math.sin(((o.angularRadius ?? 0.2725) * Math.PI) / 180);
    v.set(east, 24);
    v.set(north, 28);
    v.set(sun, 32);
    v[36] = o.intensity ?? 1;
    v[37] = (o.earthshine ?? 0.001) * moonEarthshine(Math.max(-1, Math.min(1, -dot(d, sun))));
    if (this.source !== o.albedo) {
      this.texture?.destroy();
      const a = o.albedo;
      this.texture = c.device.createTexture({
        size: [a.width, a.height],
        format: 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      c.device.queue.writeTexture({ texture: this.texture }, a.data, { bytesPerRow: a.width * 4 }, [a.width, a.height]);
      this.source = a;
      this.entries = [];
    }
    this.sampler ??= c.device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    });
    return true;
  }
  protected override bindings(): GPUBindGroupEntry[] {
    if (!this.entries.length)
      this.entries = [
        { binding: 1, resource: this.texture!.createView() },
        { binding: 2, resource: this.sampler! },
      ];
    return this.entries;
  }
  private releaseMap(): void {
    this.texture?.destroy();
    this.texture = undefined;
    this.source = undefined;
    this.sampler = undefined;
  }
  override onDeviceRestored(engine: Parameters<SkyLayer['onDeviceRestored']>[0]): void {
    this.releaseMap();
    super.onDeviceRestored(engine);
  }
  override dispose(): void {
    super.dispose();
    this.releaseMap();
  }
}
