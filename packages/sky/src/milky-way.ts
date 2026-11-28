// The Milky Way's band on the night sky, in its true place for a date and place, to go with the catalogue stars of
// `AstroSky` (`@margoengine/sky/astro`), which this entry does not draw again. The band is worked out per pixel on the
// GPU, so it is sharp at any resolution: a world direction is turned back into J2000 by `skyMatrix`, then into galactic
// longitude and latitude by the Hipparcos rotation (ESA 1997, The Hipparcos and Tycho Catalogues, Vol. 1, section
// 1.5.3), and its surface brightness comes from a Margo model of the band's shape (disc, bulge, the Great Rift's dust),
// shaped after the all-sky photometry of Mellinger (PASP 121, 2009). It is given in V magnitudes per square arcsecond
// and scaled with the same magnitude-0 brightness as AstroSky's stars, so band and stars keep their real ratio.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import {
  skyMatrix,
  starColor,
  sunPosition,
  type AstroOptions,
  type AstroSky,
  type AstroSkyTarget,
  type Observer,
} from './astro.js';
import { SkyLayer, backdropRay, backdropVertex, type Context } from './night-backdrop.js';

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

/**
 * The direction of a J2000 right ascension and declination (degrees) in the galactic display frame, as a unit vector:
 * y toward the north galactic pole, -z toward the galactic centre (l 0, b 0) and -x toward l 90, so a viewer at the
 * origin looking down -z with y up sees the sky as it stands overhead, longitude rising to the left. The Hipparcos
 * rotation, as {@link galacticCoordinates}; no observer, date or refraction: the frame of a survey, not of a site.
 * @throws TypeError for a non-finite angle.
 * @example galacticDirection(266.405, -28.936); // about [0, 0, -1], Sagittarius A*
 */
export function galacticDirection<T extends number[] | Float32Array = number[]>(
  ra: number,
  dec: number,
  out: T = [0, 0, 0] as T,
  offset = 0,
): T {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) throw new TypeError('Pass the RA and Dec as finite degrees.');
  const a = ra * rad,
    d = dec * rad,
    c = Math.cos(d),
    ex = c * Math.cos(a),
    ey = c * Math.sin(a),
    ez = Math.sin(d);
  out[offset] = -(G[3] * ex + G[4] * ey + G[5] * ez);
  out[offset + 1] = G[6] * ex + G[7] * ey + G[8] * ez;
  out[offset + 2] = -(G[0] * ex + G[1] * ey + G[2] * ez);
  return out;
}

/**
 * Galactic longitude and latitude, in degrees, of a direction in the frame of {@link galacticDirection}.
 * @throws TypeError for a zero or non-finite direction.
 * @example galacticOfDirection([0, 0, -1]); // { l: 0, b: 0 }
 */
export function galacticOfDirection(direction: readonly [number, number, number]): { l: number; b: number } {
  const [x, y, z] = direction ?? [],
    n = Math.hypot(x, y, z);
  if (!(n > 0 && Number.isFinite(n))) throw new TypeError('Pass the direction as three finite numbers, not all 0.');
  const l = Math.atan2(-x, -z) / rad;
  return { l: l < 0 ? l + 360 : l + 0, b: Math.asin(Math.max(-1, Math.min(1, y / n))) / rad };
}

// The main-sequence J-K against B-V of Bessell and Brett (PASP 100, 1988, table II), B0 to M5.
const dwarfJK = [-0.16, -0.1, 0, 0.16, 0.31, 0.5, 0.72, 0.84, 0.9],
  dwarfBV = [-0.3, -0.17, 0, 0.3, 0.58, 0.81, 1.15, 1.4, 1.64];

/**
 * Linear RGB of a star, peak 1, from its near-infrared J-Ks index: B-V read off the dwarf sequence of Bessell and
 * Brett (1988), then the Planck colour of `starColor` from `@margoengine/sky/astro`. A J-Ks past the sequence's M5 end
 * (0.9) is read as an M5 star behind dust: the excess E(J-K) gives A_V = 5.9 E(J-K) (Rieke and Lebofsky, ApJ 288,
 * 1985) and each channel is dimmed by A_V (550 nm / wavelength)^1.3, a power law close to the optical extinction curve
 * of Cardelli, Clayton and Mathis (ApJ 345, 1989), so dust-hidden sources turn deep red. `saturation` (0 to 3, default
 * 1) scales each channel's distance from the Rec. 709 luminance, clipped at 0. The 2MASS and Bessell-Brett systems
 * differ by under 0.05 mag in J-K (Carpenter, AJ 121, 2001), which this ignores.
 * @throws RangeError for a saturation outside 0 to 3.
 * @example nearInfraredColor(0.31); // a Sun-like G0, near white
 */
export function nearInfraredColor(jk: number, saturation = 1): readonly [number, number, number] {
  if (!(saturation >= 0 && saturation <= 3)) throw new RangeError('Pass saturation from 0 to 3.');
  if (!Number.isFinite(jk)) return [1, 1, 1];
  let bv = dwarfBV[8];
  if (jk <= dwarfJK[0]) bv = dwarfBV[0];
  else if (jk < dwarfJK[8]) {
    let i = 1;
    while (jk > dwarfJK[i]) i++;
    const t = (jk - dwarfJK[i - 1]) / (dwarfJK[i] - dwarfJK[i - 1]);
    bv = dwarfBV[i - 1] + t * (dwarfBV[i] - dwarfBV[i - 1]);
  }
  const av = 5.9 * Math.max(0, jk - dwarfJK[8]),
    c = starColor(bv).map((v, k) => v * 10 ** (-0.4 * av * (550 / [610, 550, 465][k]) ** 1.3)),
    top = Math.max(...c),
    y = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / top;
  return [0, 1, 2].map((k) => Math.max(0, y + (c[k] / top - y) * saturation)) as unknown as readonly [
    number,
    number,
    number,
  ];
}

/** Point sources read by {@link parsePointSources}, in record order. */
export interface PointSources {
  readonly count: number;
  /** xyz per source in the frame of {@link galacticDirection}, times `radius`. */
  readonly positions: Float32Array;
  /** J-Ks colour index per source, magnitudes. */
  readonly colorIndex: Float32Array;
  /** Ks magnitude per source. */
  readonly magnitude: Float32Array;
}

/**
 * Reads packed point sources, 12 bytes each, little-endian: float32 RA and Dec (J2000 degrees), int16 J-Ks and int16
 * Ks in thousandths of a magnitude (a 2MASS Point Source Catalog extract, Skrutskie et al., AJ 131, 2006), and places
 * each on a sphere of `radius` (default 1) in the galactic display frame.
 * @throws MargoError `'failed'` for a partial record or a direction off the sky; RangeError for a bad radius.
 * @example parsePointSources(new Float32Array([266.4, -28.9, 0]).buffer, { radius: 40 }).count; // 1
 */
export function parsePointSources(
  bytes: ArrayBuffer | ArrayBufferView,
  options: { radius?: number } = {},
): PointSources {
  const radius = options.radius ?? 1;
  if (!(radius > 0 && Number.isFinite(radius))) throw new RangeError('Pass the radius as a finite number above 0.');
  const view = ArrayBuffer.isView(bytes)
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
  if (view.byteLength % 12)
    throw new MargoError('failed', `Point sources take 12 bytes each; ${view.byteLength} bytes leave a partial record`);
  const count = view.byteLength / 12,
    positions = new Float32Array(count * 3),
    colorIndex = new Float32Array(count),
    magnitude = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 12,
      ra = view.getFloat32(o, true),
      dec = view.getFloat32(o + 4, true);
    if (!(ra >= 0 && ra <= 360 && dec >= -90 && dec <= 90))
      throw new MargoError('failed', `Point source ${i + 1} lies off the sky (RA ${ra}, Dec ${dec})`);
    galacticDirection(ra, dec, positions, i * 3);
    positions[i * 3] *= radius;
    positions[i * 3 + 1] *= radius;
    positions[i * 3 + 2] *= radius;
    colorIndex[i] = view.getInt16(o + 8, true) / 1000;
    magnitude[i] = view.getInt16(o + 10, true) / 1000;
  }
  return { count, positions, colorIndex, magnitude };
}

/**
 * Fetches and reads packed point sources ({@link parsePointSources}), gzip or plain.
 * @throws MargoError `'failed'` for an HTTP error or bad records; the signal's reason on abort.
 */
export async function fetchPointSources(
  url: string | URL,
  options: { signal?: AbortSignal; radius?: number } = {},
): Promise<PointSources> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok)
    throw new MargoError('failed', `Point sources ${String(url)} answered HTTP ${response.status}; check the URL`);
  let bytes: ArrayBuffer = await response.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b)
    bytes = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  options.signal?.throwIfAborted();
  return parsePointSources(bytes, options);
}

/** How {@link pointSourceLook} turns magnitudes into light. */
export interface PointSourceLookOptions {
  /** Ks magnitude drawn at `brightness`. Default 6. */
  referenceMagnitude?: number;
  /** Exponent on the flux, 0.2 to 1: 1 keeps true flux ratios, lower lifts the faint ones. Default 0.45. */
  compression?: number;
  /** Linear light of a source at the reference magnitude. Default 4. */
  brightness?: number;
  /** Size of the faintest source, in the cloud's size unit. Default 1. */
  minSize?: number;
  /** Extra size of a source at the reference magnitude or brighter. Default 2. */
  sizeRange?: number;
  /** Saturation about each colour's Rec. 709 luminance, 0 to 3: 0 is grey, 1 the Planck colour. Default 1. */
  saturation?: number;
}

/**
 * HDR colours (linear RGBA floats, for a cloud with `colorFormat: 'float'` and additive blending) and sizes for point
 * sources: the {@link nearInfraredColor} of each J-Ks times its Ks flux 10^(-0.4 (Ks - reference)) raised to
 * `compression`, a display stretch of the kind Lupton et al. (PASP 116, 2004) give for survey images, capped at 4 times
 * `brightness`, with `saturation` applied to each colour; brighter sources draw larger, up to `minSize + sizeRange`.
 * @throws RangeError for a compression outside 0.2 to 1 or a saturation outside 0 to 3.
 * @example pointSourceLook(parsePointSources(bytes)).colors.length; // 4 per source
 */
export function pointSourceLook(
  sources: Pick<PointSources, 'count' | 'colorIndex' | 'magnitude'>,
  options: PointSourceLookOptions = {},
): { colors: Float32Array; sizes: Float32Array } {
  const { referenceMagnitude = 6, compression = 0.45, brightness = 4, minSize = 1, sizeRange = 2, saturation = 1 } = options;
  if (!(compression >= 0.2 && compression <= 1)) throw new RangeError('Pass compression from 0.2 to 1.');
  const n = sources.count,
    colors = new Float32Array(n * 4),
    sizes = new Float32Array(n),
    // One colour per 0.02 mag of J-Ks from -1 to 5, so a million sources run no Planck sums of their own.
    table = new Float32Array(301 * 3);
  for (let i = 0; i <= 300; i++) table.set(nearInfraredColor(-1 + i * 0.02, saturation), i * 3);
  for (let i = 0; i < n; i++) {
    const k = Math.max(0, Math.min(300, Math.round((sources.colorIndex[i] + 1) / 0.02))) * 3,
      level = 10 ** (-0.4 * compression * (sources.magnitude[i] - referenceMagnitude)),
      light = brightness * Math.min(level, 4);
    colors[i * 4] = table[k] * light;
    colors[i * 4 + 1] = table[k + 1] * light;
    colors[i * 4 + 2] = table[k + 2] * light;
    colors[i * 4 + 3] = 1;
    sizes[i] = minSize + sizeRange * Math.min(1, level);
  }
  return { colors, sizes };
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
  /**
   * Keep the observer's horizon: no band below it, and the air dims it toward it. Default true. `false` is the view
   * from orbit or space: the whole sphere with no extinction, at full night unless a `sky` gives its `nightFactor`.
   */
  horizon?: boolean;
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
  if (o.horizon !== undefined && typeof o.horizon !== 'boolean')
    throw new TypeError('MilkyWay horizon must be true or false; false shows the whole sphere, as from space.');
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
${backdropRay}@fragment fn fragment(i:O)->@location(0) vec4f {
 let d=ray(i.ndc);
 let space=u.extra.x>0.5;
 if(d.y<=0.0&&!space){discard;}
 // The pixel's solid angle, so the band is a radiance: the same at any resolution and field of view.
 let omega=pixelSolidAngle(i.ndc);
 // World to J2000 (the sky matrix transposed), then galactic.
 let e=d.x*u.sky0.xyz+d.y*u.sky1.xyz+d.z*u.sky2.xyz;
 let g=vec3f(dot(vec3f(-0.0548755604,-0.8734370902,-0.4838350155),e),dot(vec3f(0.4941094279,-0.44482963,0.7469822445),e),dot(vec3f(-0.867666149,-0.1980763734,0.4559837762),e));
 let l=degrees(atan2(g.y,g.x));let b=degrees(asin(clamp(g.z,-1.0,1.0)));
 let s=u32(u.extra.y);
 let clouds=1.0+u.params.w*(1.2*(noise(g*9.0,s)-0.5)+0.6*(noise(g*31.0,s+7u)-0.5));
 // Air mass of Kasten and Young (1989) and the extinction it brings.
 var air=0.0;if(!space){let h=degrees(asin(d.y));air=1.0/(d.y+0.50572*pow(h+6.07995,-1.6364));}
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
export class MilkyWay extends SkyLayer {
  readonly name = 'sky:milky-way';
  private readonly since = new Date();

  constructor(readonly options: MilkyWayOptions) {
    // After the sky (2), before AstroSky's stars (2.5), fog (5) and weather (6).
    super('MilkyWay', 2.4, new Float32Array(40), shader);
    validate(options);
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
    if (o.horizon === false) return 1;
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

  protected frame(c: Context): boolean {
    const o = this.options,
      a = o.astro?.options,
      night = this.night();
    if (night <= 0) return false;
    const v = this.values,
      observer = this.observer(),
      m = skyMatrix(this.date, observer, observer);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) v[16 + r * 4 + k] = m[r * 3 + k];
    v.set(c.camera.position, 28);
    // A magnitude-0 star's brightness times 10^(-0.4 S) is the radiance of one square arcsecond: per steradian here.
    v[32] = ((o.brightness ?? a?.brightness ?? 4) * 10 ** (-0.4 * (o.surfaceBrightness ?? 20.5))) / arcsec2;
    v[33] = night;
    v[34] = o.extinction ?? a?.extinction ?? 0.2;
    v[35] = o.clouds ?? 1;
    v[37] = o.seed ?? 1;
    v[36] = o.horizon === false ? 1 : 0;
    return true;
  }
}
