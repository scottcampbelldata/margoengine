// Animated aurora from published auroral physics: curtains of light hung along the magnetic field in arcs running
// magnetic east-west, each glowing in the oxygen green line (557.7 nm, O 1S to 1D, lifetime 0.74 s, so it survives
// collisions down to about 100 km and peaks near 110 km), the oxygen red line (630.0 nm, O 1D to 3P, lifetime about
// 110 s, quenched by collisions below about 150 to 200 km, so it glows above them, broad about 230 km) and the
// nitrogen ion's blue band (427.8 nm, N2+ first negative, following the energy laid down by the electrons, a little
// lower than the green). Vertical shapes after Chamberlain, "Physics of the Aurora and Airglow" (1961), Omholt, "The
// Optical Aurora" (1971), and Rees, "Physics and Chemistry of the Upper Atmosphere" (1989); intensities in rayleighs as
// the International Brightness Coefficient grades them (I to IV: 1, 10, 100, 1000 kR of 557.7 nm). Colours are the
// lines through the CIE 1931 colour-matching functions to linear sRGB; luminance by the V-band rule that sky quality
// meters use (10.8e4 x 10^(-0.4 S) cd/m2 at S V magnitudes per square arcsecond), so the aurora shares the magnitude-0
// `brightness` of AstroSky's stars and MilkyWay's band. Drawn on the GPU by marching each pixel's ray through the
// shell from 80 to 450 km over a round Earth.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { AstroSkyTarget } from '@margoengine/sky/astro';
import { SkyLayer, backdropVertex, type Context } from './backdrop.js';

/** One auroral emission: its wavelength, the height and scale of its vertical shape, and its colour. */
export interface AuroraLine {
  /** Wavelength in nm. */
  readonly wavelength: number;
  /** Height of the brightest emission in km. */
  readonly peak: number;
  /** Scale height of the Chapman-shaped profile in km: the fall above the peak (below it falls far faster). */
  readonly scale: number;
  /** Linear sRGB of the line with luminance (0.2126 R + 0.7152 G + 0.0722 B) 1, out-of-gamut channels clipped. */
  readonly color: readonly [number, number, number];
  /** Luminance in cd/m2 of 1 kR of the line seen face on. */
  readonly luminance: number;
}

// CIE 1931 2 degree colour-matching functions at the tabulated 5 nm wavelengths around each line (CIE 015:2004).
const cmf: Record<number, [number, number, number]> = {
  425: [0.2148, 0.0073, 1.0391],
  430: [0.2839, 0.0116, 1.3856],
  555: [0.5121, 1.0, 0.00575],
  560: [0.5945, 0.995, 0.0039],
  630: [0.6424, 0.265, 0.00005],
};
const line = (wavelength: number, peak: number, scale: number): AuroraLine => {
  const a = Math.floor(wavelength / 5) * 5,
    t = (wavelength - a) / 5,
    [x, y, z] = cmf[a].map((v, i) => v + t * ((cmf[a + 5] ?? cmf[a])[i] - v)),
    // XYZ to linear sRGB (IEC 61966-2-1), negative channels clipped, then scaled back to luminance 1.
    rgb = [
      3.2406 * x - 1.5372 * y - 0.4986 * z,
      -0.9689 * x + 1.8758 * y + 0.0415 * z,
      0.0557 * x - 0.204 * y + 1.057 * z,
    ].map((v) => Math.max(0, v)),
    l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  // 1 kR is 1e9 / (4 pi) photons per second per cm2 per steradian; each of h c / lambda joules, at 683 y-bar lm per W.
  const photons = (1e9 / (4 * Math.PI)) * 1e4,
    energy = (6.62607015e-34 * 299792458) / (wavelength * 1e-9);
  return Object.freeze({
    wavelength,
    peak,
    scale,
    color: Object.freeze(rgb.map((v) => v / l)) as unknown as [number, number, number],
    luminance: photons * energy * 683 * y,
  });
};

/** The three emissions drawn: the oxygen green and red lines and the blue band of the nitrogen ion. */
export const AURORA_LINES = Object.freeze({
  green: line(557.7, 110, 12),
  red: line(630.0, 230, 50),
  blue: line(427.8, 105, 10),
});

/**
 * Volume emission of each line at height `h` km, per km, each integrating to 1 over height: the Chapman shape
 * exp(1 - z - e^-z) / (e H), z = (h - peak) / H, sharp below the peak and falling by H above it.
 * @example auroraProfile(110); // [green, red, blue]: green at its peak, 1 / (e x 12)
 */
export function auroraProfile(h: number): [number, number, number] {
  const f = (l: AuroraLine) => {
    const z = (h - l.peak) / l.scale;
    return z < -6 ? 0 : Math.exp(1 - z - Math.exp(-z)) / (Math.E * l.scale);
  };
  return [f(AURORA_LINES.green), f(AURORA_LINES.red), f(AURORA_LINES.blue)];
}

/** {@link Aurora} settings, read every frame from `aurora.options`. All optional. */
export interface AuroraOptions {
  /** 557.7 nm column along the field (straight up) through the brightest curtain's middle, in kR, 0 to 10000. Default 30. */
  intensity?: number;
  /** 630.0 nm over 557.7 nm, 0 to 10. Default 0.2: a green aurora; 1 and more for a red, high one. */
  red?: number;
  /** 427.8 nm over 557.7 nm, 0 to 2. Default 0.3. */
  blue?: number;
  /** North distance of the first arc from the world origin in km, -2000 to 2000. Default 150. North is -Z. */
  distance?: number;
  /** Number of arcs, each further north and fainter, 1 to 8. Default 3. */
  arcs?: number;
  /** Km between arcs, 5 to 500. Default 40. */
  spacing?: number;
  /** East-west length of the arcs in km, 50 to 5000. Default 1500. */
  length?: number;
  /** Half-thickness of a curtain (its Gaussian 1/e) in km, 0.1 to 50. Default 1.5. */
  thickness?: number;
  /** Speed of the folds and rays, times real, 0 to 100. Default 1; 0 holds the shape. */
  speed?: number;
  /** Brightness of a magnitude 0 star, the `brightness` of `AstroSky`, 0 to 1000. Default 4. */
  brightness?: number;
  /** The sky whose `nightFactor` fades the aurora in. Default none: always shown. */
  sky?: AstroSkyTarget;
  /** Seed of the folds and rays, a whole number from 0 to 65535. Default 1. */
  seed?: number;
}

const number = (value: unknown, name: string, low: number, high: number) => {
  if (value !== undefined && !(typeof value === 'number' && value >= low && value <= high))
    throw new RangeError(`Invalid Aurora ${name} ${String(value)}; use a number from ${low} to ${high}.`);
};
const validate = (o: AuroraOptions) => {
  if (typeof o !== 'object' || o === null) throw new TypeError('Pass Aurora options as an object.');
  number(o.intensity, 'intensity', 0, 10000);
  number(o.red, 'red', 0, 10);
  number(o.blue, 'blue', 0, 2);
  number(o.distance, 'distance', -2000, 2000);
  number(o.spacing, 'spacing', 5, 500);
  number(o.length, 'length', 50, 5000);
  number(o.thickness, 'thickness', 0.1, 50);
  number(o.speed, 'speed', 0, 100);
  number(o.brightness, 'brightness', 0, 1000);
  for (const [k, low, high] of [
    ['arcs', 1, 8],
    ['seed', 0, 65535],
  ] as const) {
    const v = o[k];
    if (v !== undefined && !(Number.isInteger(v) && v >= low && v <= high))
      throw new RangeError(`Invalid Aurora ${k} ${String(v)}; use a whole number from ${low} to ${high}.`);
  }
};

/** Radius of the Earth in km (IUGG mean). */
const earth = 6371.0088;
/** Steradians in one square arcsecond. */
const arcsec2 = (Math.PI / 648000) ** 2;
const tau = 2 * Math.PI;
// The folds: two waves along each arc, 300 km and 70 km long, travelling at 1 and 3 km/s (a Margo choice within the
// speeds of folds seen moving along curtains), 20 and 5 km deep; [depth, wavenumber, angular speed, phase multiple].
const fold = [
  [20, tau / 300, tau / 300, 1],
  [5, tau / 70, (-3 * tau) / 70, 2],
] as const;

// A 32-bit hash to [0, 1), the same on the CPU (Math.imul) and the GPU (u32 arithmetic).
const hash = (i: number, s: number) => {
  let h = (Math.imul(i, 374761393) ^ Math.imul(s, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const noise = (x: number, s: number) => {
  const i = Math.floor(x),
    f = x - i,
    w = f * f * (3 - 2 * f);
  return hash(i, s) + w * (hash(i + 1, s) - hash(i, s));
};

interface Shape {
  intensity: number;
  north: number;
  arcs: number;
  spacing: number;
  half: number;
  thickness: number;
  seed: number;
}
const shape = (o: AuroraOptions): Shape => ({
  intensity: o.intensity ?? 30,
  north: o.distance ?? 150,
  arcs: o.arcs ?? 3,
  spacing: o.spacing ?? 40,
  half: (o.length ?? 1500) / 2,
  thickness: o.thickness ?? 1.5,
  seed: o.seed ?? 1,
});

/**
 * The curtains' 557.7 nm volume emission, per km, at east `x`, north `n` and height `h` (km), at `time` seconds,
 * before its vertical profile: the sum over the arcs of strength x rays x exp(-(d / thickness)^2), d the distance to
 * the arc's folded line. The same model the GPU marches.
 */
const curtains = (s: Shape, x: number, n: number, time: number, sigma = s.thickness) => {
  let total = 0;
  const end = Math.exp(-((x / s.half) ** 6));
  if (end < 1e-6) return 0;
  for (let i = 0; i < s.arcs; i++) {
    const phase = tau * hash(i, s.seed + 11);
    let line = s.north + i * s.spacing,
      slope = 0;
    for (const [a, k, w, m] of fold) {
      line += a * Math.sin(k * x + w * time + m * phase);
      slope += a * k * Math.cos(k * x + w * time + m * phase);
    }
    const d = (n - line) / Math.sqrt(1 + slope * slope);
    if (Math.abs(d) > 6 * sigma) continue;
    // Rays: striations about 3 km wide drifting along the arc, on patches about 25 km long.
    const r = noise(x / 3 + 0.5 * time + 17 * i, s.seed),
      patch = noise(x / 25 - 0.1 * time + 5 * i, s.seed + 3),
      rays = (0.35 + 0.65 * r * r) * (0.5 + patch);
    total += 0.6 ** i * rays * Math.exp(-((d / sigma) ** 2)) * (s.thickness / sigma);
  }
  return s.intensity * end * total;
};

/**
 * The aurora's column along a ray, in kR of each line ([green 557.7, red 630.0, blue 427.8]): the curtains' emission
 * integrated from `origin` (metres, world space, y up, north -Z) along `direction`, through the shell from 80 to 450
 * km over a round Earth, in `steps` equal steps (default 4000), at `time` seconds. Zero for a ray that meets the Earth.
 * @example auroraColumn([0, 0, 0], [0, 0.6, -0.8], 0); // looking north at 37 degrees
 */
export function auroraColumn(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  time: number,
  options: AuroraOptions = {},
  steps = 4000,
): [number, number, number] {
  validate(options);
  const s = shape(options),
    out: [number, number, number] = [0, 0, 0],
    range = span(origin, direction);
  if (!range) return out;
  const [t0, t1, o, d] = range,
    dt = (t1 - t0) / steps;
  for (let k = 0; k < steps; k++) {
    const t = t0 + (k + 0.5) * dt,
      p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t],
      h = Math.hypot(p[0], p[1] + earth, p[2]) - earth,
      e = curtains(s, p[0], -p[2], time);
    if (e === 0) continue;
    const v = auroraProfile(h);
    out[0] += e * v[0] * dt;
    out[1] += e * v[1] * dt * (options.red ?? 0.2);
    out[2] += e * v[2] * dt * (options.blue ?? 0.3);
  }
  return out;
}

// The stretch of a ray (origin in metres) inside the 80 to 450 km shell, in km, or null when it meets the Earth or
// misses: [from, to, origin km, unit direction].
const span = (origin: readonly number[], direction: readonly number[]) => {
  const n = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(n > 0)) throw new TypeError('Pass the direction as three finite numbers, not all 0.');
  const d = direction.map((v) => v / n),
    o = origin.map((v) => v / 1000),
    c = [o[0], o[1] + earth, o[2]],
    b = c[0] * d[0] + c[1] * d[1] + c[2] * d[2],
    cc = c[0] * c[0] + c[1] * c[1] + c[2] * c[2],
    far = (r: number) => {
      const q = b * b - cc + r * r;
      return q < 0 ? Number.NaN : -b + Math.sqrt(q);
    },
    ground = b * b - cc + earth * earth;
  if (ground > 0 && -b - Math.sqrt(ground) > 0) return null;
  const t0 = Math.max(0, far(earth + 80)),
    t1 = far(earth + 450);
  return Number.isFinite(t1) && t1 > t0 ? ([t0, t1, o, d] as const) : null;
};

const shader = `struct U {inverse:mat4x4f,eye:vec4f,shape0:vec4f,shape1:vec4f,lines:vec4f,green:vec4f,red:vec4f,blue:vec4f,extra:vec4f}
@group(0) @binding(0) var<uniform> u:U;
${backdropVertex}
fn ray(n:vec2f)->vec3f {let p=u.inverse*vec4f(n,0.000001,1.0);return normalize(p.xyz/p.w-u.eye.xyz);}
fn hash(i:i32,s:u32)->f32 {var h=(bitcast<u32>(i)*374761393u)^(s*668265263u);h=(h^(h>>13u))*1274126177u;return f32(h^(h>>16u))*2.3283064e-10;}
fn noise(x:f32,s:u32)->f32 {let i=i32(floor(x));let f=fract(x);let w=f*f*(3.0-2.0*f);return mix(hash(i,s),hash(i+1,s),w);}
fn chapman(h:f32,peak:f32,scale:f32)->f32 {let z=(h-peak)/scale;if(z< -6.0){return 0.0;}return exp(1.0-z-exp(-z))/(2.7182818*scale);}
// shape0: intensity, first arc's north distance, spacing, half length; shape1: thickness, arcs, time, seed.
fn curtains(x:f32,n:f32,sigma:f32)->f32 {
 let q=x/u.shape0.w;let end=exp(-q*q*q*q*q*q);if(end<1e-6){return 0.0;}
 let time=u.shape1.z;let seed=u32(u.shape1.w);var total=0.0;
 for(var i=0;i<i32(u.shape1.y);i++){
  let phase=6.2831853*hash(i,seed+11u);
  let a1=0.020943951*x+0.020943951*time+phase;let a2=0.089759790*x-0.26927937*time+2.0*phase;
  let line=u.shape0.y+f32(i)*u.shape0.z+20.0*sin(a1)+5.0*sin(a2);
  let slope=20.0*0.020943951*cos(a1)+5.0*0.089759790*cos(a2);
  let d=(n-line)/sqrt(1.0+slope*slope);
  if(abs(d)>6.0*sigma){continue;}
  let r=noise(x/3.0+0.5*time+17.0*f32(i),seed);let spots=noise(x/25.0-0.1*time+5.0*f32(i),seed+3u);
  total+=pow(0.6,f32(i))*(0.35+0.65*r*r)*(0.5+spots)*exp(-(d/sigma)*(d/sigma))*(u.shape1.x/sigma);
 }
 return u.shape0.x*end*total;
}
fn far(c:vec3f,d:vec3f,r:f32)->f32 {let b=dot(c,d);let q=b*b-dot(c,c)+r*r;if(q<0.0){return -1.0;}return -b+sqrt(q);}
@fragment fn fragment(i:O)->@location(0) vec4f {
 let d=ray(i.ndc);
 let h2=0.5*u.extra.zw;
 let omega=length(cross(ray(i.ndc+vec2f(h2.x,0.0))-ray(i.ndc-vec2f(h2.x,0.0)),ray(i.ndc+vec2f(0.0,h2.y))-ray(i.ndc-vec2f(0.0,h2.y))));
 let R=6371.0088;let o=u.eye.xyz/1000.0;let c=vec3f(o.x,o.y+R,o.z);
 // Not through the Earth.
 let b=dot(c,d);let g=b*b-dot(c,c)+R*R;if(g>0.0&&-b-sqrt(g)>0.0){discard;}
 var t0=max(0.0,far(c,d,R+80.0));let t1=far(c,d,R+450.0);if(t1<=t0){discard;}
 // Only where the arcs can be: north distances from the first arc's less its folds to the last's plus them.
 let reach=25.0+6.0*u.shape1.x;let lo=u.shape0.y-reach;let hi=u.shape0.y+(u.shape1.y-1.0)*u.shape0.z+reach;
 var a=t0;var e=t1;
 if(abs(d.z)>1e-6){let s0=(-lo-o.z)/d.z;let s1=(-hi-o.z)/d.z;a=max(t0,min(s0,s1));e=min(t1,max(s0,s1));}
 else if(-o.z<lo||-o.z>hi){discard;}
 if(e<=a){discard;}
 // 64 steps, started at a fixed per-pixel offset, so the steps do not band. A curtain thinner than half a step is
 // widened to it with its light kept (its integral across stays thickness x sqrt(pi)), and the range by its reach.
 let steps=64.0;var dt=(e-a)/steps;
 let sigma=max(u.shape1.x,0.5*dt*length(d.xz));
 a=max(t0,a-3.0*dt);e=min(t1,e+3.0*dt);dt=(e-a)/steps;
 let jitter=hash(i32(i.position.x)+i32(i.position.y)*4096,7u);
 var col=vec3f(0.0);
 for(var k=0.0;k<steps;k+=1.0){
  let t=a+(k+jitter)*dt;let p=o+d*t;
  let h=length(vec3f(p.x,p.y+R,p.z))-R;
  let em=curtains(p.x,-p.z,sigma);
  if(em==0.0){continue;}
  col+=em*dt*vec3f(chapman(h,110.0,12.0),u.lines.x*chapman(h,230.0,50.0),u.lines.y*chapman(h,105.0,10.0));
 }
 // Columns in kR to the scene: each line's colour times its scale (lines.z the night).
 let value=(col.x*u.green.xyz*u.green.w+col.y*u.red.xyz*u.red.w+col.z*u.blue.xyz*u.blue.w)*omega*u.lines.z;
 return vec4f(value,0.0);
}
`;

/**
 * Animated aurora: curtains of the oxygen green and red lines and the nitrogen ion's blue, in arcs running east-west
 * north of the world origin, folding and rippling with time, drawn on the sky where nothing else was drawn and added
 * to its light. WebGPU only.
 * @throws TypeError or RangeError for invalid options (on attach and each frame); MargoError `'unsupported'` on a
 * WebGL engine, `'disposed'` after `dispose()`.
 * @example
 * const aurora = Aurora.attach(engine, { intensity: 100, red: 0.5 });
 */
export class Aurora extends SkyLayer {
  readonly name = 'scenery:aurora';
  /** Seconds of aurora time: advanced by `speed` each frame; assign to jump. */
  time = 0;

  constructor(readonly options: AuroraOptions = {}) {
    // After the sky (2), the Milky Way (2.4) and AstroSky's stars (2.5), before fog (5) and weather (6).
    super('Aurora', 2.6, new Float32Array(48), shader);
    validate(options);
  }

  static attach(engine: EngineKernel, options: AuroraOptions = {}): Aurora {
    const aurora = new Aurora(options);
    engineRuntime(engine).use(aurora);
    return aurora;
  }

  onPreUpdate(delta: number): void {
    validate(this.options);
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid Aurora delta; pass seconds, 0 or more.');
    this.time += delta * (this.options.speed ?? 1);
  }

  protected frame(c: Context): boolean {
    const o = this.options,
      night = typeof o.sky?.nightFactor === 'number' ? o.sky.nightFactor : 1,
      s = shape(o);
    if (night <= 0 || s.intensity <= 0) return false;
    // A line's luminance per kR in cd/m2 to V magnitudes per square arcsecond, then to the scene by the stars' scale.
    const v = this.values,
      scale = (o.brightness ?? 4) / 10.8e4 / arcsec2;
    v.set(c.camera.position, 16);
    v.set([s.intensity, s.north, s.spacing, s.half, s.thickness, s.arcs, this.time, s.seed], 20);
    v.set([o.red ?? 0.2, o.blue ?? 0.3, night, 0], 28);
    for (const [k, l] of [AURORA_LINES.green, AURORA_LINES.red, AURORA_LINES.blue].entries()) {
      v.set(l.color, 32 + k * 4);
      v[35 + k * 4] = l.luminance * scale;
    }
    return true;
  }
}
