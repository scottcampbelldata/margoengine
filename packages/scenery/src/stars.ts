/// <reference lib="esnext.disposable" preserve="true" />
// The Milky Way's band on the night sky, in its true place for a date and place, to go with the catalogue stars of
// `AstroSky` (`@margoengine/sky/astro`), which this entry does not draw again. The band is worked out per pixel on the
// GPU, so it is sharp at any resolution: a world direction is turned back into J2000 by `skyMatrix`, then into galactic
// longitude and latitude by the Hipparcos rotation (ESA 1997, The Hipparcos and Tycho Catalogues, Vol. 1, section
// 1.5.3), and its surface brightness comes from a Margo model of the band's shape (disc, bulge, the Great Rift's dust),
// shaped after the all-sky photometry of Mellinger (PASP 121, 2009). It is given in V magnitudes per square arcsecond
// and scaled with the same magnitude-0 brightness as AstroSky's stars, so band and stars keep their real ratio.
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { invertMatrixStable } from '@margoengine/math/mat4';
import {
  skyMatrix,
  sunPosition,
  type AstroOptions,
  type AstroSky,
  type AstroSkyTarget,
  type Observer,
} from '@margoengine/sky/astro';
import { Backdrop, backdropVertex } from './backdrop.js';
import { viewSize } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

// The equatorial (ICRS, J2000) to galactic rotation of the Hipparcos catalogue, row-major: the north galactic pole at
// RA 192.85948, Dec 27.12825 and the centre at galactic longitude 0.
const G = [
  -0.0548755604, -0.8734370902, -0.4838350155, 0.4941094279, -0.44482963, 0.7469822445, -0.867666149, -0.1980763734,
  0.4559837762,
];
const rad = Math.PI / 180;
/** Steradians in one square arcsecond. */
const arcsec2 = (Math.PI / 648000) ** 2;

/**
 * Surface brightness of the Milky Way's band, as a share of the galactic centre's before its dust, at galactic
 * longitude `l` and latitude `b` in degrees: a disc that thins away from the galactic plane and fades away from the
 * centre, the bulge around the centre, and the dust of the Great Rift dimming the plane from Aquila to Sagittarius
 * (l -12 to 75). The brightest places are the plane where the rift ends (0.75 at l -12, b 0) and the Sagittarius
 * star cloud just south of the rift (0.67 at l 0, b -4). The same model the GPU draws, without its star clouds.
 * @example milkyWayBrightness(0, -4); // about 0.67
 */
export function milkyWayBrightness(l: number, b: number): number {
  const ld = ((((l + 180) % 360) + 360) % 360) - 180,
    width = 4 + 4 * Math.exp(-((ld / 50) ** 2)),
    disc = Math.exp(-Math.abs(b) / width) * (0.3 + 0.7 * Math.exp(-((ld / 70) ** 2))),
    bulge = 0.7 * Math.exp(-(ld * ld + (1.6 * b) ** 2) / (2 * 81)),
    rift = ld > -12 && ld < 75 ? 0.75 * Math.exp(-((b - 1) ** 2) / (2 * 1.8 ** 2)) * Math.min(1, (ld + 12) / 6) : 0;
  return ((disc + bulge) / 1.7) * (1 - rift);
}

/**
 * Galactic longitude and latitude, in degrees, of a world direction (y up, -z north) seen from `observer` at `date`:
 * `skyMatrix` from `@margoengine/sky/astro` turned back to J2000, then the Hipparcos rotation.
 * @throws TypeError or RangeError for an invalid date, observer or direction.
 * @example galacticCoordinates([0, 1, 0], new Date(), { latitude: degrees(52), longitude: degrees(0) });
 */
export function galacticCoordinates(
  direction: readonly [number, number, number],
  date: Date,
  observer: Observer,
  options: AstroOptions = {},
): { l: number; b: number } {
  const [x, y, z] = direction ?? [],
    n = Math.hypot(x, y, z);
  if (!(n > 0 && Number.isFinite(n))) throw new TypeError('Pass the direction as three finite numbers, not all 0.');
  const m = skyMatrix(date, observer, options),
    // J2000 = the sky matrix transposed times the world direction.
    ex = (m[0] * x + m[3] * y + m[6] * z) / n,
    ey = (m[1] * x + m[4] * y + m[7] * z) / n,
    ez = (m[2] * x + m[5] * y + m[8] * z) / n,
    gx = G[0] * ex + G[1] * ey + G[2] * ez,
    gy = G[3] * ex + G[4] * ey + G[5] * ez,
    gz = G[6] * ex + G[7] * ey + G[8] * ez,
    l = Math.atan2(gy, gx) / rad;
  return { l: l < 0 ? l + 360 : l, b: Math.asin(Math.max(-1, Math.min(1, gz))) / rad };
}

/** {@link MilkyWay} settings, read every frame from `milkyWay.options`. All optional, given `astro` or an observer. */
export interface MilkyWayOptions extends Partial<Observer>, AstroOptions {
  /**
   * The `AstroSky` to follow: its clock, observer, sky, star `brightness` and `extinction`, unless given here. Without
   * it pass `latitude` and `longitude`; the sky is then held at `date`.
   */
  astro?: AstroSky;
  /** The moment shown without `astro`. Default the moment of attaching. */
  date?: Date;
  /** The sky whose `nightFactor` fades the band in. Default the astro's sky; without one, the sun's depression. */
  sky?: AstroSkyTarget;
  /**
   * V magnitudes per square arcsecond of the galactic centre before its dust, 15 to 30; larger is fainter. Default
   * 20.5, a Margo choice that keeps the band above the natural night sky away from it (about 22, Leinert et al. 1998).
   */
  surfaceBrightness?: number;
  /** Brightness of a magnitude 0 star, the `brightness` of `AstroSky`, 0 to 1000. Default the astro's, or 4. */
  brightness?: number;
  /** Extinction of the air in magnitudes per air mass, 0 to 2. Default the astro's, or 0.2. */
  extinction?: number;
  /** Contrast of the band's star clouds and dark lanes, 0 (smooth) to 1. Default 1. */
  clouds?: number;
  /** Seed of the star clouds, a whole number from 0 to 65535. Default 1. */
  seed?: number;
}

const number = (value: unknown, name: string, low: number, high: number) => {
  if (value !== undefined && !(typeof value === 'number' && value >= low && value <= high))
    throw new RangeError(`Invalid MilkyWay ${name} ${String(value)}; use a number from ${low} to ${high}.`);
};
const validate = (o: MilkyWayOptions) => {
  if (typeof o !== 'object' || o === null) throw new TypeError('Pass MilkyWay options as an object.');
  if (o.astro === undefined && (o.latitude === undefined || o.longitude === undefined))
    throw new TypeError('Pass MilkyWay an astro (AstroSky) or a latitude and longitude, as degrees(..).');
  if (o.astro !== undefined && !(o.astro && typeof o.astro === 'object' && o.astro.date instanceof Date))
    throw new TypeError('MilkyWay astro must be an AstroSky.');
  if (o.date !== undefined && !(o.date instanceof Date && Number.isFinite(o.date.getTime())))
    throw new TypeError('Pass the MilkyWay date as a valid Date.');
  number(o.surfaceBrightness, 'surfaceBrightness', 15, 30);
  number(o.brightness, 'brightness', 0, 1000);
  number(o.extinction, 'extinction', 0, 2);
  number(o.clouds, 'clouds', 0, 1);
  if (o.seed !== undefined && !(Number.isInteger(o.seed) && o.seed >= 0 && o.seed <= 65535))
    throw new RangeError(`Invalid MilkyWay seed ${String(o.seed)}; use a whole number from 0 to 65535.`);
};

const shader = `struct U {inverse:mat4x4f,sky0:vec4f,sky1:vec4f,sky2:vec4f,eye:vec4f,params:vec4f,extra:vec4f}
@group(0) @binding(0) var<uniform> u:U;
${backdropVertex}fn hash(p:vec3i,s:u32)->f32 {
 var h=(bitcast<u32>(p.x)*374761393u)^(bitcast<u32>(p.y)*668265263u)^(bitcast<u32>(p.z)*2147483647u)^(s*144665u);
 h=(h^(h>>13u))*1274126177u;return f32(h^(h>>16u))*2.3283064e-10;
}
// Value noise on the galactic unit vector, so the clouds have no seam.
fn noise(q:vec3f,s:u32)->f32 {
 let i=vec3i(floor(q));let f=fract(q);let w=f*f*(3.0-2.0*f);var t=0.0;
 for(var k=0;k<8;k++){let c=vec3i(k&1,(k>>1)&1,k>>2);let a=mix(1.0-w,w,vec3f(c));t+=hash(i+c,s)*a.x*a.y*a.z;}
 return t;
}
// The band's share of the galactic centre's brightness before its dust (milkyWayBrightness in stars.ts).
fn band(lr:f32,b:f32)->f32 {
 let l=lr-360.0*floor((lr+180.0)/360.0);
 let width=4.0+4.0*exp(-(l/50.0)*(l/50.0));
 let disc=exp(-abs(b)/width)*(0.3+0.7*exp(-(l/70.0)*(l/70.0)));
 let bulge=0.7*exp(-(l*l+(1.6*b)*(1.6*b))/162.0);
 var rift=0.0;if(l>-12.0&&l<75.0){rift=0.75*exp(-(b-1.0)*(b-1.0)/6.48)*min(1.0,(l+12.0)/6.0);}
 return (disc+bulge)/1.7*(1.0-rift);
}
fn ray(n:vec2f)->vec3f {let p=u.inverse*vec4f(n,0.000001,1.0);return normalize(p.xyz/p.w-u.eye.xyz);}
@fragment fn fragment(i:O)->@location(0) vec4f {
 let d=ray(i.ndc);
 if(d.y<=0.0){discard;}
 // The pixel's solid angle from the rays through the middles of its edges, so the band is a radiance: the same at
 // any resolution and field of view. extra.zw is one pixel in NDC.
 let h2=0.5*u.extra.zw;
 let omega=length(cross(ray(i.ndc+vec2f(h2.x,0.0))-ray(i.ndc-vec2f(h2.x,0.0)),ray(i.ndc+vec2f(0.0,h2.y))-ray(i.ndc-vec2f(0.0,h2.y))));
 // World to J2000 (the sky matrix transposed), then galactic.
 let e=d.x*u.sky0.xyz+d.y*u.sky1.xyz+d.z*u.sky2.xyz;
 let g=vec3f(dot(vec3f(-0.0548755604,-0.8734370902,-0.4838350155),e),dot(vec3f(0.4941094279,-0.44482963,0.7469822445),e),dot(vec3f(-0.867666149,-0.1980763734,0.4559837762),e));
 let l=degrees(atan2(g.y,g.x));let b=degrees(asin(clamp(g.z,-1.0,1.0)));
 let s=u32(u.extra.y);
 let clouds=1.0+u.params.w*(1.2*(noise(g*9.0,s)-0.5)+0.6*(noise(g*31.0,s+7u)-0.5));
 // Air mass of Kasten and Young (1989) and the extinction it brings.
 let h=degrees(asin(d.y));let air=1.0/(d.y+0.50572*pow(h+6.07995,-1.6364));
 let k=u.params.x*u.params.y*omega*band(l,b)*max(clouds,0.0)*pow(10.0,-0.4*u.params.z*air);
 // Old stars of the bulge are warmer than the disc's.
 let warm=exp(-(l*l+b*b)/450.0);
 // Added to the sky's light (the alpha is kept).
 return vec4f(k*vec3f(1.0+0.09*warm,1.0-0.04*warm,1.0-0.21*warm),0.0);
}
`;

/**
 * The Milky Way's band drawn on the sky where nothing else was drawn, in its real place for the moment and the
 * observer, faded in with the night and dimmed by the air toward the horizon. Pair it with `AstroSky` for the stars.
 * WebGPU only.
 * @throws TypeError or RangeError for invalid options (on attach and each frame); MargoError `'unsupported'` on a
 * WebGL engine, `'disposed'` after `dispose()`.
 * @example
 * const astro = AstroSky.attach(engine, { latitude: degrees(35), longitude: degrees(-110), sky, catalog });
 * const band = MilkyWay.attach(engine, { astro });
 */
export class MilkyWay implements EnginePlugin {
  readonly name = 'scenery:milky-way';
  private readonly backdrop = new Backdrop();
  private readonly values = new Float32Array(40);
  private readonly scratch = new Float64Array(52);
  private readonly inverse = new Float32Array(16);
  private readonly since: Date;
  private uniform?: GPUBuffer;
  private engine?: Engine;
  private disposed = false;

  constructor(readonly options: MilkyWayOptions) {
    validate(options);
    this.since = new Date();
  }

  static attach(engine: EngineKernel, options: MilkyWayOptions): MilkyWay {
    const band = new MilkyWay(options);
    engineRuntime(engine).use(band);
    return band;
  }

  /** The moment shown: the astro's clock, or `date`. */
  get date(): Date {
    return this.options.astro?.date ?? this.options.date ?? this.since;
  }

  /** Night blend from 0 by day to 1 at night: the sky's `nightFactor`, or the sun's depression to 12 degrees. */
  night(): number {
    const o = this.options,
      a = o.astro?.options,
      sky = o.sky ?? a?.sky;
    if (typeof sky?.nightFactor === 'number') return sky.nightFactor;
    const e = sunPosition(this.date, this.observer(), this.observer()).elevation.degrees,
      s = Math.max(0, Math.min(1, -e / 12));
    return s * s * (3 - 2 * s);
  }

  private observer(): Observer & AstroOptions {
    const o = this.options,
      a = o.astro?.options;
    return {
      latitude: o.latitude ?? a!.latitude,
      longitude: o.longitude ?? a!.longitude,
      deltaT: o.deltaT ?? a?.deltaT,
      refraction: o.refraction ?? a?.refraction,
    };
  }

  onPreUpdate(): void {
    validate(this.options);
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'MilkyWay requires WebGPU; attach a new MilkyWay to a WebGPU engine',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'scenery:milky-way',
      // After the sky (2), before AstroSky's stars (2.5), fog (5) and weather (6).
      order: 2.4,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  private draw(c: Context): void {
    const o = this.options,
      a = o.astro?.options,
      night = this.night();
    if (night <= 0) return;
    if (!invertMatrixStable(c.camera.matrix, this.inverse, this.scratch))
      throw new MargoError('state', 'Invalid MilkyWay camera; give the camera a finite, invertible projection');
    const v = this.values,
      observer = this.observer(),
      m = skyMatrix(this.date, observer, observer);
    v.set(this.inverse, 0);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) v[16 + r * 4 + k] = m[r * 3 + k];
    v.set(c.camera.position, 28);
    // A magnitude-0 star's brightness times 10^(-0.4 S) is the radiance of one square arcsecond: per steradian here.
    v[32] = ((o.brightness ?? a?.brightness ?? 4) * 10 ** (-0.4 * (o.surfaceBrightness ?? 20.5))) / arcsec2;
    v[33] = night;
    v[34] = o.extinction ?? a?.extinction ?? 0.2;
    v[35] = o.clouds ?? 1;
    v[37] = o.seed ?? 1;
    const [width, tall] = viewSize(c) as [number, number];
    v[38] = 2 / width;
    v[39] = 2 / tall;
    this.backdrop.draw(c, shader, this.uniform!, v as Float32Array<ArrayBuffer>);
  }

  private release(): void {
    this.uniform?.destroy();
    this.uniform = undefined;
    this.backdrop.release();
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
