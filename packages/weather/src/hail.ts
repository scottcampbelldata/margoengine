/// <reference lib="esnext.disposable" preserve="true" />
// Hail: stones that fall fast, hit the ground, bounce twice and stop. One instanced draw of stretched quads; every
// position is a closed-form function of time and the particle's index, so nothing is uploaded per frame but one
// uniform block. Depth-tested against the scene.
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { ParticleOverlay } from '../../shared/particle-overlay.js';
import { viewSize } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type HailPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Seconds an ice chip of a splash flies. */
export const SPLASH_SECONDS = 0.35;

/** Gravity in metres per second squared, used for the bounces. */
export const GRAVITY = 9.81;

/** Settings of a {@link Hail}, read every frame from `hail.options`. A value out of range throws RangeError, a wrong type TypeError. */
export interface HailOptions {
  /** Target amount, 0 (none) to 1 (a hailstorm). The visible {@link Hail.amount} eases to it over `fadeSeconds`. Default 0.5. */
  intensity?: number;
  /** Seconds the amount takes to move across its whole range, 0 or more (0 jumps). Default 3. */
  fadeSeconds?: number;
  /** Horizontal wind `[x, z]` in metres per second; stones slant with it. Default `[0, 0]`. */
  wind?: readonly [number, number];
  /** Height of the ground in world metres: stones land and bounce there. Default 0. */
  groundY?: number;
  /** Half-width in metres of the box around the camera that holds the stones, 2..200. Default 20. */
  radius?: number;
  /** Height in metres above the ground where stones start, 2..200. Default 30. */
  height?: number;
  /** Stones at intensity 1, 0..200,000. Default 6,000. */
  particles?: number;
  /** Fall speed in metres per second, 5..60. Default 18. */
  fallSpeed?: number;
  /** Share of the speed kept after a bounce, 0..0.9. Default 0.2. */
  restitution?: number;
  /** Mean stone radius in metres, 0.001..0.1. Default 0.012. */
  stoneRadius?: number;
  /** Stone colour, linear RGB. Default a pale blue-white. */
  color?: readonly [number, number, number];
  /** Scales the colour, 0 or more: lower it at night. Default 1. */
  brightness?: number;
  /** Opacity of one stone, 0..1. Default 0.85. */
  opacity?: number;
  /** Seed of the stone placement; the same seed and times give the same storm. Default 1. */
  seed?: number;
  /**
   * Light the stones as small ice balls by the engine's sun and ambient light (`engine.lighting`): the side toward the
   * sun bright with a glint, the far side in its own shadow. False draws them in flat `color` as before. Default true.
   */
  lit?: boolean;
  /** Ice chips that burst from each stone where it first lands, 0..8; each flies out and falls back in about a third of a second. Default 4. */
  splashes?: number;
}

const shader = /* wgsl */ `
struct Hail {
 camera:mat4x4f, eye:vec4f, volume:vec4f, motion:vec4f, colour:vec4f, screen:vec4f, params:vec4f, extra:vec4f,
 light:vec4f, radiance:vec4f, ambient:vec4f, splash:vec4f,
}
@group(0) @binding(0) var<uniform> h:Hail;
struct Out {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32,@location(2) across:vec3f,@location(3) view:vec3f}
fn pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let x=((s>>((s>>28u)+4u))^s)*277803737u;return (x>>22u)^x;}
fn rnd(i:u32,cycle:u32,k:u32)->f32 {return f32(pcg(pcg(i*4u+k+bitcast<u32>(h.params.y))^(cycle*2654435761u))>>8u)*5.9604645e-8;}
const corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
const culled=Out(vec4f(2,2,2,1),vec2f(0),0.0,vec3f(0),vec3f(0));
// A stone's place in the box around the camera: its start drifted by the wind and wrapped to the box; .y is how near
// the box's edge it is (0 at the centre, 0.5 at the edge).
fn place(start:vec2f,drift:f32)->vec3f {
 let size=h.volume.xyz;let wind=vec2f(h.motion.x,h.motion.z);
 let rel=fract((start+wind*drift-h.eye.xz)/size.xz)-0.5;
 return vec3f(h.eye.x+rel.x*size.x,max(abs(rel.x),abs(rel.y)),h.eye.z+rel.y*size.z);
}
@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) index:u32)->Out {
 let corner=corners[vi];
 let size=h.volume.xyz;
 let ground=h.volume.w;
 let fall=h.motion.y;
 let e=h.motion.w;
 let g=h.params.w;
 let L=h.params.z;
 let stones=u32(h.splash.x);
 let chips=max(1u,u32(h.splash.y));
 // Instances past the stones are the chips: chip j of stone ii.
 let chip=index>=stones;
 let ii=select(index,(index-stones)/chips,chip);
 // Each stone repeats a cycle of L seconds (fall, two bounces, a short rest) at its own phase; a new cycle takes a new place.
 let x=rnd(ii,0u,0u)+h.params.x/L;
 let cyc=u32(floor(x));
 let tau=fract(x)*L;
 let tf=size.y/fall;
 let start=vec2f(rnd(ii,cyc,1u),rnd(ii,cyc,2u))*size.xz;
 var q:vec3f;var velocity:vec3f;var radius:f32;var edge:f32;var life=1.0;
 if(chip){
  // A chip flies out from where its stone first lands and falls back under gravity for h.splash.z seconds.
  let j=(index-stones)%chips;
  let s=tau-tf;
  if(s<0.0||s>h.splash.z){return culled;}
  let angle=6.2831853*(f32(j)+rnd(ii,cyc,8u+j))/f32(chips);
  let out=(0.6+1.2*rnd(ii,cyc,16u+j))*vec2f(cos(angle),sin(angle));
  let up=1.0+1.5*rnd(ii,cyc,24u+j);
  let y=ground+up*s-0.5*g*s*s;
  if(y<ground){return culled;}
  let p=place(start,tf);
  q=vec3f(p.x+out.x*s,y,p.z+out.y*s);
  velocity=vec3f(out.x,up-g*s,out.y);
  edge=p.y;
  radius=h.screen.w*0.4*(0.6+0.8*rnd(ii,cyc,32u+j));
  life=1.0-s/h.splash.z;
 }else{
  let vb1=e*fall;
  let tb1=2.0*vb1/g;
  let vb2=e*vb1;
  let tb2=2.0*vb2/g;
  var y=ground;
  var vy=0.0;
  var drift=min(tau,tf);
  if(tau<tf){y=ground+size.y-fall*tau;vy=-fall;}
  else{
   let s1=tau-tf;
   drift+=0.3*(tau-tf);
   if(s1<tb1){y=ground+vb1*s1-0.5*g*s1*s1;vy=vb1-g*s1;}
   else{
    let s2=s1-tb1;
    if(s2<tb2){y=ground+vb2*s2-0.5*g*s2*s2;vy=vb2-g*s2;}
    else{return culled;}
   }
  }
  let p=place(start,drift);
  q=vec3f(p.x,y,p.z);
  edge=p.y;
  let moving=select(0.3,1.0,tau<tf);
  velocity=vec3f(h.motion.x*moving,vy,h.motion.z*moving);
  radius=h.screen.w*(0.6+0.8*rnd(ii,0u,3u));
 }
 let nearDistance=length(q-h.eye.xyz);
 let fade=(1.0-smoothstep(0.7,1.0,edge*2.0))*smoothstep(0.5,2.5,nearDistance)*life;
 let tail=q-velocity*h.extra.x;
 let vp=h.screen.xy;
 let a=h.camera*vec4f(q,1);
 let b=h.camera*vec4f(tail,1);
 if(a.w<0.1||b.w<0.1){return culled;}
 let halfWidth=max(radius*h.screen.z/a.w,h.extra.y);
 let pa=a.xy/a.w*vp*0.5;
 let pb=b.xy/b.w*vp*0.5;
 let d=pb-pa;
 let len=length(d);
 let dir=select(vec2f(0,1),d/len,len>0.0001);
 let normal=vec2f(-dir.y,dir.x);
 let head=corner.y>0.0;
 // Both ends reach out by half a width, so a stone that is not moving is still a round dot.
 let base=select(pb+dir*halfWidth,pa-dir*halfWidth,head);
 let ndc=(base+normal*corner.x*halfWidth)*2.0/vp;
 let c=select(b,a,head);
 var o:Out;
 o.position=vec4f(ndc*c.w,c.z,c.w);
 o.uv=vec2f(corner.x,select(0.0,1.0,head));
 // A stone smaller than a pixel fades instead of sparkling.
 o.alpha=fade*min(1.0,radius*h.screen.z/a.w/h.extra.y)*(0.7+0.3*rnd(ii,0u,3u));
 // The ball's normal across the streak: the world direction of the quad's width, and toward the eye.
 let toEye=normalize(h.eye.xyz-q);
 let side=cross(toEye,select(vec3f(0,1,0),velocity/max(length(velocity),1e-6),length(velocity)>0.001));
 o.across=select(normalize(cross(toEye,vec3f(1,0,0))),side/max(length(side),1e-6),length(side)>0.001);
 o.view=toEye;
 return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 let a=i.alpha*h.colour.w*(1.0-i.uv.x*i.uv.x);
 var shade=vec3f(1.0+h.extra.z*6.0);
 if(h.extra.w>0.5){
  // Lit: the ball's normal from the place across the streak; Lambert diffuse from the sun plus the ambient light, so the
  // side away from the sun lies in the stone's own shadow, and a Blinn-Phong glint of the sun on the ice.
  let n=normalize(i.across*i.uv.x+i.view*sqrt(max(0.0,1.0-i.uv.x*i.uv.x)));
  let l=normalize(h.light.xyz);
  let sun=h.radiance.rgb*h.light.w;
  let diffuse=max(dot(n,l),0.0);
  let glint=pow(max(dot(n,normalize(l+i.view)),0.0),40.0)*0.6;
  shade=h.ambient.rgb*h.radiance.w+sun*(diffuse/3.14159265+glint)+vec3f(h.extra.z*6.0);
 }
 return vec4f(h.colour.rgb*shade,a);
}`;

const number = (value: unknown, name: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Hail ${name} must be a number from ${min} to ${max}; pass a finite value in range`);
};

/** Throws for any invalid field of `o`. Exported for the tests of this package. */
export function validateHail(o: HailOptions): void {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('Hail options must be an object; pass {} for the defaults');
  if (o.intensity !== undefined) number(o.intensity, 'intensity', 0, 1);
  if (o.fadeSeconds !== undefined) number(o.fadeSeconds, 'fadeSeconds', 0, 3600);
  if (o.groundY !== undefined) number(o.groundY, 'groundY', -1e6, 1e6);
  if (o.radius !== undefined) number(o.radius, 'radius', 2, 200);
  if (o.height !== undefined) number(o.height, 'height', 2, 200);
  if (o.particles !== undefined) number(o.particles, 'particles', 0, 200000);
  if (o.fallSpeed !== undefined) number(o.fallSpeed, 'fallSpeed', 5, 60);
  if (o.restitution !== undefined) number(o.restitution, 'restitution', 0, 0.9);
  if (o.stoneRadius !== undefined) number(o.stoneRadius, 'stoneRadius', 0.001, 0.1);
  if (o.brightness !== undefined) number(o.brightness, 'brightness', 0, 1e6);
  if (o.opacity !== undefined) number(o.opacity, 'opacity', 0, 1);
  if (o.seed !== undefined) number(o.seed, 'seed', -2147483648, 4294967295);
  if (o.splashes !== undefined) {
    number(o.splashes, 'splashes', 0, 8);
    if (!Number.isInteger(o.splashes))
      throw new RangeError('Hail splashes must be a whole number from 0 to 8; pass 0 to turn them off');
  }
  if (o.lit !== undefined && typeof o.lit !== 'boolean') throw new TypeError('Hail lit must be true or false');
  if (o.wind !== undefined) {
    if (!Array.isArray(o.wind) || o.wind.length !== 2)
      throw new TypeError('Hail wind needs [x, z] in metres per second; pass an array of two numbers');
    number(o.wind[0], 'wind[0]', -100, 100);
    number(o.wind[1], 'wind[1]', -100, 100);
  }
  if (o.color !== undefined) {
    if (!Array.isArray(o.color) || o.color.length !== 3)
      throw new TypeError('Hail color needs [r, g, b] linear values; pass an array of three numbers');
    for (const v of o.color) number(v, 'color', 0, 1e6);
  }
}

/** Seconds one stone takes to fall, bounce twice and rest. */
export function hailCycle(o: HailOptions = {}): number {
  const height = o.height ?? 30,
    fall = o.fallSpeed ?? 18,
    e = o.restitution ?? 0.2;
  return height / fall + (2 * e * fall) / GRAVITY + (2 * e * e * fall) / GRAVITY + 0.25;
}

/**
 * Height and vertical speed of a stone `tau` seconds into its cycle, the same formulas as the shader: it falls from
 * `groundY + height` at `fallSpeed`, then bounces twice (each bounce keeps `restitution` of the speed) and comes to rest.
 * Returns `null` after the second bounce, when the stone is not drawn until its next cycle.
 */
export function stoneState(tau: number, o: HailOptions = {}): { y: number; vy: number } | null {
  const ground = o.groundY ?? 0,
    height = o.height ?? 30,
    fall = o.fallSpeed ?? 18,
    e = o.restitution ?? 0.2;
  const fallTime = height / fall,
    v1 = e * fall,
    t1 = (2 * v1) / GRAVITY,
    v2 = e * v1,
    t2 = (2 * v2) / GRAVITY;
  if (tau < fallTime) return { y: ground + height - fall * tau, vy: -fall };
  const s1 = tau - fallTime;
  if (s1 < t1) return { y: ground + v1 * s1 - 0.5 * GRAVITY * s1 * s1, vy: v1 - GRAVITY * s1 };
  const s2 = s1 - t1;
  if (s2 < t2) return { y: ground + v2 * s2 - 0.5 * GRAVITY * s2 * s2, vy: v2 - GRAVITY * s2 };
  return null;
}

/**
 * Hail around the camera. `Hail.attach(engine, options)` adds it to a WebGPU engine; change `hail.options` any time.
 * Without an engine it still runs (`new Hail(options)` and `update(delta)`), which is how the amount is tested.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 * @example
 * const hail = Hail.attach(engine, {intensity: 0.7, wind: [6, 2]});
 */
export class Hail implements EnginePlugin {
  readonly name: string = 'hail';
  private readonly overlay = new ParticleOverlay();
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(60);
  private disposed = false;
  private clock = 0;
  private level = 0;
  /** Lightning lift of the stone colour, 0..1; set it from the sky's flash so stones light up with the storm. */
  lift = 0;

  constructor(readonly options: HailOptions = {}) {
    validateHail(options);
  }

  static attach(engine: EngineKernel, options: HailOptions = {}): Hail {
    const effect = new Hail(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  /** Visible amount, 0..1: eases toward `options.intensity` over `options.fadeSeconds`. */
  get amount(): number {
    return this.level;
  }
  /** Seconds of hail time so far. */
  get time(): number {
    return this.clock;
  }
  /** Stones drawn at the current amount. */
  get count(): number {
    return Math.ceil((this.options.particles ?? 6000) * this.level);
  }

  /** Advances time and the amount by `delta` seconds (the engine calls this each frame). */
  update(delta: number): void {
    this.onPreUpdate(delta);
  }

  onPreUpdate(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', 'Hail is disposed; attach a new Hail');
    validateHail(this.options);
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid hail delta; pass a finite delta of 0 or more seconds.');
    const o = this.options,
      target = o.intensity ?? 0.5,
      fade = o.fadeSeconds ?? 3;
    this.clock += delta;
    this.level =
      fade === 0
        ? target
        : Math.max(
            0,
            Math.min(
              1,
              this.level + Math.sign(target - this.level) * Math.min(Math.abs(target - this.level), delta / fade),
            ),
          );
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Hail requires WebGPU; attach a new Hail to a WebGPU engine',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'hail:stones',
      order: 6.2,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  private draw(c: HailPassContext): void {
    const o = this.options,
      count = this.count;
    if (this.level <= 0.001 || count === 0) return;
    const radius = o.radius ?? 20,
      height = o.height ?? 30,
      wind = o.wind ?? [0, 0],
      fall = o.fallSpeed ?? 18,
      color = o.color ?? [0.85, 0.92, 1],
      brightness = o.brightness ?? 1,
      cycle = hailCycle(o),
      [width, tall] = viewSize(c) as [number, number],
      v = this.values;
    v.set(c.camera.matrix, 0);
    v.set(c.camera.position, 16);
    v[20] = radius * 2;
    v[21] = height;
    v[22] = radius * 2;
    v[23] = o.groundY ?? 0;
    v[24] = wind[0];
    v[25] = fall;
    v[26] = wind[1];
    v[27] = o.restitution ?? 0.2;
    for (let i = 0; i < 3; i++) v[28 + i] = color[i] * brightness;
    v[31] = o.opacity ?? 0.85;
    v[32] = width;
    v[33] = tall;
    v[34] = tall / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    v[35] = o.stoneRadius ?? 0.012;
    // The clock wraps every 4096 cycles in double precision so the shader keeps float accuracy; the stone pattern
    // repeats then, hours of play later, with no visible pop (every stone is at the same phase it had).
    v[36] = this.clock % (cycle * 4096);
    new Uint32Array(v.buffer)[37] = (o.seed ?? 1) >>> 0;
    v[38] = cycle;
    v[39] = GRAVITY;
    v[40] = 0.014; // streak: seconds of motion drawn behind a stone
    v[41] = Math.max(0.75, tall / 1080); // smallest half width in pixels
    v[42] = Math.min(1, this.lift);
    v[43] = (o.lit ?? true) ? 1 : 0;
    // Lit stones take the scene's light: core's sun direction and strength, its colour, the ambient strength and colour.
    const light = this.engine?.lighting,
      chips = o.splashes ?? 4;
    v.set(light?.direction ?? [3, 5, 4, 3], 44);
    v.set(light?.radiance ?? [1, 1, 1, 0.15], 48);
    v.set(light?.ambient ?? [1, 1, 1], 52);
    v[55] = 0;
    v[56] = count;
    v[57] = chips;
    v[58] = SPLASH_SECONDS;
    v[59] = 0;
    this.overlay.draw(c, shader, this.uniform!, v as Float32Array<ArrayBuffer>, count * (1 + chips));
  }

  private release(): void {
    this.uniform?.destroy();
    this.uniform = undefined;
    this.overlay.release();
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
