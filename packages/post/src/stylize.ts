import type { EngineKernel } from '@margoengine/core';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';

/** Expanding annular refraction, in viewport-height units. */
export interface ShockWaveOptions {
  /** Screen centre [u,v], y down. Default [0.5,0.5]. */
  center?: readonly [number, number];
  /** Optional world position, projected with this frame's camera, overrides center. */
  position?: readonly [number, number, number];
  /** Explicit radius for scrubbing. Otherwise explode() animates it. */
  radius?: number;
  /** Speed in view heights/second, 0..100. Default 2. */
  speed?: number;
  /** Maximum radius, positive up to 100. Default 1. */
  maxRadius?: number;
  /** Annulus half width, positive up to 10. Default 0.2. */
  waveSize?: number;
  /** Refraction displacement, 0..1 view heights. Default 0.05. */
  amplitude?: number;
}
/** One deterministic retro screen pass; options are read each frame. */
export interface StylizeOptions {
  /** Scanline strength 0..1. Default 0.15. */
  scanlines?: number;
  /** Cycles per drawing-buffer row, positive up to 8. Default 0.5. */
  density?: number;
  /** Scanline scroll in cycles/second, -100..100. Default 0. */
  scrollSpeed?: number;
  /** Noise strength, 0..1. Default 0.03. */
  noise?: number;
  /** Monochrome noise. Default true. */
  monochrome?: boolean;
  /** Noise seed, integer 0..2^32-1. Default 1. */
  seed?: number;
  /** Bits per RGB channel, integer 1..8, or an RGB tuple (e.g. [5,6,5]). Default 8. Alpha is unchanged. */
  colorDepth?: number | readonly [number, number, number];
  /** Shock-wave controls; false disables it. Default normal wave settings, inactive until explode(). */
  shockWave?: ShockWaveOptions | false;
  /** Explicit clock in seconds, 0..10,000,000, for deterministic seeking. Default engine update time. */
  time?: number;
  /** Default true. */
  enabled?: boolean;
}
const shader = `${fullscreen}
struct U{scan:vec4f,wave:vec4f,light:vec4f,bits:vec4u}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var<uniform> u:U;
// Existing Margo PCG hash, documented against Jarzynski and Olano (JCGT 2020).
fn pcg(v:u32)->u32{let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn random(v:u32)->f32{return f32(pcg(v)>>8u)/16777216.0-0.5;}
fn tap(p:vec2i)->vec4f{return textureLoad(scene,clamp(p,vec2i(0),vec2i(textureDimensions(scene))-1),0);}
fn bilinear(p:vec2f)->vec4f{let q=p-0.5;let a=vec2i(floor(q));let t=fract(q);return mix(mix(tap(a),tap(a+vec2i(1,0)),t.x),mix(tap(a+vec2i(0,1)),tap(a+vec2i(1,1)),t.x),t.y);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 var s=textureLoad(scene,vec2i(p.xy),0);if(u.light.z<0.0){return s;}let size=vec2f(textureDimensions(scene));let aspect=size.x/size.y;
 if(u.light.x>0.0){
  let d=(p.xy/size-u.wave.xy)*vec2f(aspect,1.0);let distance=length(d);let t=(distance-u.wave.z)/u.wave.w;
  if(abs(t)<1.0){let shift=sin(t*3.14159265359)*(1.0-abs(t))*u.light.x*max(1.0-u.wave.z/u.light.y,0.0);s=bilinear(p.xy+d/max(distance,1e-6)*shift*size/vec2f(aspect,1.0));}
 }
 var rgb=s.rgb/max(s.a,1e-6);
 if(u.scan.x>0.0){rgb*=1.0-u.scan.x*(0.5+0.5*cos(6.28318530718*((p.y-0.5)*u.scan.y+u.scan.w*u.scan.z)));}
 if(u.light.w>0.0){
  let seed=u.bits.w^pcg(u32(p.x)^pcg(u32(p.y)))^pcg(u32(u.scan.w*60.0));
  var n=vec3f(random(seed),random(seed^0x6d2b79f5u),random(seed^0x3c6ef372u));
  if(u.light.z>0.0){n=vec3f(n.x);}rgb=clamp(rgb+n*u.light.w,vec3f(0),vec3f(1));
 }
 let levels=vec3f(u.bits.xyz);rgb=round(rgb*levels)/levels;
 return vec4f(clamp(rgb,vec3f(0),vec3f(1))*s.a,s.a);
}`;

/** Shock waves, CRT scanlines, deterministic noise and RGB colour-depth reduction in one optional LDR stage. */
export class Stylize extends ScreenEffect {
  readonly name = 'stylize';
  protected readonly kind = 'ldr';
  private readonly values = new Float32Array(16);
  private readonly words = new Uint32Array(this.values.buffer);
  private elapsed = 0;
  private start = Number.POSITIVE_INFINITY;
  private ended = false;
  constructor(readonly options: StylizeOptions = {}) {
    super();
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: StylizeOptions = {}): Stylize {
    const e = new Stylize(options);
    e.stack = PostStack.attach(engine, [e]);
    return e;
  }
  /** Advance once per engine update, independently of the number of views drawn. */
  onPreUpdate(delta: number): void {
    this.elapsed = Math.min(1e7, this.elapsed + delta);
  }
  /** Emit or restart a wave at the current or explicit clock, for replay and seeking. */
  explode(time = this.options.time ?? this.elapsed): void {
    if (this.ended) throw margoError('disposed', 'Stylize is disposed; create a new Stylize');
    if (!Number.isFinite(time) || time < 0 || time > 1e7)
      throw new RangeError('Use Stylize explode time in 0..10000000 seconds');
    this.start = time;
  }
  protected check(): void {
    const o = this.options;
    for (const k of ['scanlines', 'noise'] as const)
      if (o[k] !== undefined && !(Number.isFinite(o[k]) && o[k]! >= 0 && o[k]! <= 1))
        throw new RangeError(`Use Stylize ${k} from 0 to 1`);
    if (
      !(Number.isFinite(o.density ?? 0.5) && (o.density ?? 0.5) > 0 && (o.density ?? 0.5) <= 8) ||
      !Number.isFinite(o.scrollSpeed ?? 0) ||
      Math.abs(o.scrollSpeed ?? 0) > 100
    )
      throw new RangeError('Use Stylize density above 0 up to 8 and scrollSpeed from -100 to 100');
    for (const k of ['enabled', 'monochrome'] as const)
      if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new TypeError(`Use Stylize ${k} as true or false`);
    if (!Number.isInteger(o.seed ?? 1) || (o.seed ?? 1) < 0 || (o.seed ?? 1) > 0xffffffff)
      throw new RangeError('Use Stylize seed as an unsigned 32-bit integer');
    const bits =
      typeof o.colorDepth === 'number' ? [o.colorDepth, o.colorDepth, o.colorDepth] : (o.colorDepth ?? [8, 8, 8]);
    if (bits.length !== 3 || !bits.every((b) => Number.isInteger(b) && b >= 1 && b <= 8))
      throw new RangeError('Use Stylize colorDepth as 1..8 bits or three RGB bit counts');
    if (o.time !== undefined && !(Number.isFinite(o.time) && o.time >= 0 && o.time <= 1e7))
      throw new RangeError('Use Stylize time in 0..10000000 seconds');
    const w = o.shockWave;
    if (w === undefined || w === false) return;
    if (!w || typeof w !== 'object') throw new TypeError('Use Stylize shockWave as an options object or false');
    for (const [key, value, max, positive] of [
      ['radius', w.radius ?? 0, 100, false],
      ['speed', w.speed ?? 2, 100, false],
      ['maxRadius', w.maxRadius ?? 1, 100, true],
      ['waveSize', w.waveSize ?? 0.2, 10, true],
      ['amplitude', w.amplitude ?? 0.05, 1, false],
    ] as const)
      if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0) || value > max)
        throw new RangeError(`Use a finite Stylize shockWave ${key} in its documented range`);
    for (const [value, length] of [
      [w.center, 2],
      [w.position, 3],
    ] as const)
      if (value && (value.length !== length || !value.every(Number.isFinite)))
        throw new RangeError('Use a finite Stylize screen centre or world position');
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      live = o.enabled !== false,
      time = o.time ?? this.elapsed,
      w = o.shockWave || {};
    let cx = w.center?.[0] ?? 0.5,
      cy = w.center?.[1] ?? 0.5,
      visible = true;
    if (w.position) {
      const [x, y, z] = w.position,
        m = c.camera.matrix,
        clip = m[3] * x + m[7] * y + m[11] * z + m[15],
        depth = m[2] * x + m[6] * y + m[10] * z + m[14];
      visible = clip > 0 && depth >= 0 && depth <= clip;
      cx = 0.5 + (0.5 * (m[0] * x + m[4] * y + m[8] * z + m[12])) / Math.max(clip, 1e-6);
      cy = 0.5 - (0.5 * (m[1] * x + m[5] * y + m[9] * z + m[13])) / Math.max(clip, 1e-6);
    }
    const age = time - this.start,
      radius = w.radius ?? Math.max(0, age) * (w.speed ?? 2),
      active = w.radius !== undefined || age >= 0;
    this.values.set([
      live ? (o.scanlines ?? 0.15) : 0,
      o.density ?? 0.5,
      o.scrollSpeed ?? 0,
      time,
      cx,
      cy,
      Number.isFinite(radius) ? radius : 0,
      w.waveSize ?? 0.2,
      live && active && visible && o.shockWave !== false && radius <= (w.maxRadius ?? 1) ? (w.amplitude ?? 0.05) : 0,
      w.maxRadius ?? 1,
      live ? +(o.monochrome ?? true) : -1,
      live ? (o.noise ?? 0.03) : 0,
    ]);
    const bits =
      typeof o.colorDepth === 'number' ? [o.colorDepth, o.colorDepth, o.colorDepth] : (o.colorDepth ?? [8, 8, 8]);
    this.words.set(
      [2 ** (live ? bits[0] : 8) - 1, 2 ** (live ? bits[1] : 8) - 1, 2 ** (live ? bits[2] : 8) - 1, o.seed ?? 1],
      12,
    );
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    this.draw(c, shader, output, [input, { buffer: this.uniform! }]);
  }
  override dispose(): void {
    this.ended = true;
    super.dispose();
  }
}
