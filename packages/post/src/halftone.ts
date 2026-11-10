import type { EngineKernel } from '@margoengine/core';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';

/** Procedural screen geometry and mixing, read every frame. */
export interface HalftoneOptions {
  /** Drawing-buffer pixels per screen cell, 2..256. Default 8. */
  cellSize?: number;
  /** Screen frequency multiplier, >0 up to 16. Default 1; larger makes smaller dots. */
  scale?: number;
  /** Dot shape. Default dot. */
  shape?: 'dot' | 'ellipse' | 'line' | 'square';
  /** RGB screen rotations in degrees. Default [15,45,75]. */
  angles?: readonly [number, number, number];
  /** Monochrome screen rotation in degrees. DotScreen default 45. */
  angle?: number;
  /** Screen origin in drawing-buffer pixels. Default [0,0]. */
  center?: readonly [number, number];
  /** Deterministic cell-centre jitter, 0..1. Default 0. */
  scatter?: number;
  /** Grayscale screening. Default false for Halftone, always true for DotScreen. */
  grayscale?: boolean;
  /** Blend operation before intensity interpolation. Default normal. */
  blend?: 'normal' | 'multiply' | 'add' | 'lighten' | 'darken';
  /** Screen opacity, 0..1. Default 1. */
  intensity?: number;
  /** Default true. */
  enabled?: boolean;
}
const shapes = ['dot', 'ellipse', 'line', 'square'] as const;
const blends = ['normal', 'multiply', 'add', 'lighten', 'darken'] as const;
const shader = `${fullscreen}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var<uniform> u:array<vec4f,4>;
fn rotate(p:vec2f,a:f32)->vec2f{return vec2f(cos(a)*p.x-sin(a)*p.y,sin(a)*p.x+cos(a)*p.y);}
fn hash(p:vec2f)->vec2f{return fract(sin(vec2f(dot(p,vec2f(127.1,311.7)),dot(p,vec2f(269.5,183.3))))*43758.5453);}
fn screen(p:vec2f,a:f32,channel:i32)->f32{
 let size=u[0].x;let cell=floor(rotate(p-u[1].xy,a)/size);
 let centre=(cell+0.5+(hash(cell)-0.5)*u[0].z*0.5)*size;
 let d=abs(rotate(p-u[1].xy,a)-centre)/size;
 let q=clamp(vec2i(rotate(centre,-a)+u[1].xy),vec2i(0),vec2i(textureDimensions(scene))-1);
 let s=textureLoad(scene,q,0);let rgb=s.rgb/max(s.a,1e-6);
 var tone=rgb[channel];if(u[0].w>0.0){tone=dot(rgb,vec3f(0.2126,0.7152,0.0722));}
 var distance=length(d)*1.41421356237;
 if(u[1].z==1.0){distance=length(d*vec2f(1.5,0.6))/0.807774721;}
 if(u[1].z==2.0){distance=d.y*2.0;}
 if(u[1].z==3.0){distance=max(d.x,d.y)*2.0;}
 let radius=sqrt(1.0-clamp(tone,0.0,1.0));let aa=0.75/size;
 var v=smoothstep(radius-aa,radius+aa,distance);
 if(tone<=0.0){v=0.0;}if(tone>=1.0){v=1.0;}return v;
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let s=textureLoad(scene,vec2i(p.xy),0);if(u[0].y==0.0){return s;}
 var rgb=vec3f(screen(p.xy,u[2].x,0),screen(p.xy,u[2].y,1),screen(p.xy,u[2].z,2))*s.a;
 if(u[0].w>0.0){rgb=vec3f(screen(p.xy,u[2].x,0))*s.a;}
 if(u[1].w==1.0){rgb*=s.rgb;}
 if(u[1].w==2.0){rgb=min(rgb+s.rgb,vec3f(s.a));}
 if(u[1].w==3.0){rgb=max(rgb,s.rgb);}
 if(u[1].w==4.0){rgb=min(rgb,s.rgb);}
 return vec4f(mix(s.rgb,rgb,u[0].y),s.a);
}`;

/** Full-screen RGB print screening on any scene colour captured by PostStack. An LDR stage. */
export class Halftone extends ScreenEffect {
  readonly name: string = 'halftone';
  protected readonly kind = 'ldr';
  protected readonly monochrome: boolean = false;
  private readonly values = new Float32Array(16);
  constructor(readonly options: HalftoneOptions = {}) {
    super();
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: HalftoneOptions = {}): Halftone {
    const e = new Halftone(options);
    e.stack = PostStack.attach(engine, [e]);
    return e;
  }
  protected check(): void {
    const o = this.options;
    if (!(Number.isFinite(o.cellSize ?? 8) && (o.cellSize ?? 8) >= 2 && (o.cellSize ?? 8) <= 256))
      throw new RangeError('Use Halftone cellSize from 2 to 256');
    if (!(Number.isFinite(o.scale ?? 1) && (o.scale ?? 1) > 0 && (o.scale ?? 1) <= 16))
      throw new RangeError('Use Halftone scale above 0 up to 16');
    for (const k of ['intensity', 'scatter'] as const)
      if (o[k] !== undefined && !(Number.isFinite(o[k]) && o[k]! >= 0 && o[k]! <= 1))
        throw new RangeError(`Use Halftone ${k} from 0 to 1`);
    if (!shapes.includes(o.shape ?? 'dot') || !blends.includes(o.blend ?? 'normal'))
      throw new RangeError('Use a documented Halftone shape and blend operation');
    for (const k of ['grayscale', 'enabled'] as const)
      if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new TypeError(`Use Halftone ${k} as true or false`);
    if (
      (o.angle !== undefined && !Number.isFinite(o.angle)) ||
      (o.angles !== undefined && (o.angles.length !== 3 || !o.angles.every(Number.isFinite))) ||
      (o.center !== undefined && (o.center.length !== 2 || !o.center.every(Number.isFinite)))
    )
      throw new RangeError('Use finite Halftone angles and a two-number centre');
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      mono = this.monochrome || (o.grayscale ?? false),
      angles = mono ? [o.angle ?? 45, o.angle ?? 45, o.angle ?? 45] : (o.angles ?? [15, 45, 75]);
    this.values.set([
      (o.cellSize ?? 8) / (o.scale ?? 1),
      o.enabled === false ? 0 : (o.intensity ?? 1),
      o.scatter ?? 0,
      +mono,
      ...(o.center ?? [0, 0]),
      shapes.indexOf(o.shape ?? 'dot'),
      blends.indexOf(o.blend ?? 'normal'),
      ...angles.map((a) => (a * Math.PI) / 180),
      0,
      0,
      0,
      0,
      0,
    ]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    this.draw(c, shader, output, [input, { buffer: this.uniform! }]);
  }
}
/** Monochrome dot screening with live origin, angle, frequency, shape and mixing controls. */
export class DotScreen extends Halftone {
  override readonly name = 'dot-screen';
  protected override readonly monochrome = true;
  /** Runs alone in an owned PostStack. */
  static override attach(engine: EngineKernel, options: HalftoneOptions = {}): DotScreen {
    const e = new DotScreen(options);
    e.stack = PostStack.attach(engine, [e]);
    return e;
  }
}
