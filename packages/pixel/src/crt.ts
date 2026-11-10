/// <reference lib="esnext.disposable" preserve="true" />
// A CRT look for low-res pictures, worked out per output pixel from the source texels: the glass bends (each axis by
// the square of the other, so edges bow out and corners pull in), each source row is drawn as a beam bright at its
// middle and dimmer toward the rows' edges, an aperture grille passes red, green and blue in turn across the output
// columns, and glow adds a soft blur of the source on top.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { rangeError } from '../../shared/errors.js';
import { ScreenPass, type ScreenPassOptions, VERTEX } from './blit.js';

export { fitRect, type PixelFit, type ScreenPassOptions, type TextureSource } from './blit.js';

/** Horizontal source-pixel offset, or [horizontal, vertical], each finite in [-32,32]. */
export type ChromaticOffset = number | readonly [number, number];

/** Settings of {@link CRT}; every look setting is also a field read each frame. */
export interface CRTOptions extends ScreenPassOptions {
  /** How much the glass bends, 0 (flat) to 0.5. Default 0.08. */
  curvature?: number;
  /** How dark the gaps between source rows get, 0 to 1. Default 0.5. */
  scanlines?: number;
  /** How much the grille dims the two colours a column does not pass, 0 to 1. Default 0.2. */
  mask?: number;
  /** How much of a blurred copy of the source is added, 0 to 1. Default 0.25. */
  glow?: number;
  /** Multiplies the beam, to win back what the lines and grille take, 0 to 4. Default 1.2. */
  brightness?: number;
  /** NTSC-style horizontal YIQ chroma bleed, 0 to 1. Default 0 (off). Luma stays sharp. */
  colorBleed?: number;
  /** Red samples at +offset and blue at -offset, in source pixels. Default 0. */
  chromaticOffset?: ChromaticOffset;
  /** Extra independent red-channel source-pixel offset, added to chromaticOffset. Default 0. */
  redOffset?: ChromaticOffset;
  /** Independent green-channel source-pixel offset. Default 0. */
  greenOffset?: ChromaticOffset;
  /** Extra independent blue-channel source-pixel offset, added to -chromaticOffset. Default 0. */
  blueOffset?: ChromaticOffset;
}

const shader = /* wgsl */ `
struct S{rect:vec4i,curvature:f32,scanlines:f32,mask:f32,glow:f32,brightness:f32,
bleed:f32,offset:vec2f,red:vec2f,green:vec2f,blue:vec2f}
@group(0) @binding(0) var<uniform> s:S;
@group(0) @binding(1) var image:texture_2d<f32>;
${VERTEX}
fn at(t:vec2i)->vec4f{
return textureLoad(image,clamp(t,vec2i(0),vec2i(textureDimensions(image))-1),0);
}
fn signal(t:vec2i)->vec4f{
let e=at(t);
if(s.bleed==0){return e;}
let near1=at(t-vec2i(1,0)).rgb+at(t+vec2i(1,0)).rgb;
let near2=at(t-vec2i(2,0)).rgb+at(t+vec2i(2,0)).rgb;
let near3=at(t-vec2i(3,0)).rgb+at(t+vec2i(3,0)).rgb;
let near4=at(t-vec2i(4,0)).rgb+at(t+vec2i(4,0)).rgb;
// SMPTE 170M YIQ matrix. Unequal normalized binomial chroma bands, with unfiltered luma.
let di=dot((6*e.rgb+4*near1+near2)/16-e.rgb,vec3f(0.5959,-0.2746,-0.3213));
let dq=dot((70*e.rgb+56*near1+28*near2+8*near3+near4)/256-e.rgb,vec3f(0.2115,-0.5227,0.3112));
let rgb=e.rgb+s.bleed*(di*vec3f(0.956050226,-0.272052344,-1.106704315)
  +dq*vec3f(0.620754941,-0.647205713,1.704421284));
return vec4f(clamp(rgb,vec3f(0),vec3f(e.a)),e.a);
}
fn shifted(t:vec2i,offset:vec2f)->vec4f{
let p=vec2f(t)+offset;
let lo=vec2i(floor(p)); let f=fract(p);
var top=signal(lo);
if(f.x!=0){top=mix(top,signal(lo+vec2i(1,0)),f.x);}
if(f.y==0){return top;}
var bottom=signal(lo+vec2i(0,1));
if(f.x!=0){bottom=mix(bottom,signal(lo+vec2i(1,1)),f.x);}
return mix(top,bottom,f.y);
}
fn composite(t:vec2i)->vec4f{
let red=shifted(t,s.offset+s.red);
let green=shifted(t,s.green);
let blue=shifted(t,-s.offset+s.blue);
return vec4f(red.r,green.g,blue.b,max(red.a,max(green.a,blue.a)));
}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{
let o=floor(p.xy)-vec2f(s.rect.xy);
let w=vec2f(s.rect.zw);
let n=vec2f(textureDimensions(image));
// Flat coordinates never round-trip through [-1,1]. The integer quotient fixes the exact-boundary convention.
var t=(o+0.5)*n/w;
var i=clamp((vec2i(o)*2+1)*vec2i(n)/(s.rect.zw*2),vec2i(0),vec2i(n)-1);
if(s.curvature!=0){
let c=(o+0.5)/w*2-1;
let b=c*(1+s.curvature*c.yx*c.yx);
if(any(abs(b)>vec2f(1))){return vec4f(0,0,0,1);}
t=(b*0.5+0.5)*n;
i=vec2i(min(floor(t),n-1));
}
let f=t.y-floor(t.y);
let beam=1-s.scanlines*(1-sin(3.14159265*f)*sin(3.14159265*f));
let column=u32(o.x)%3u;
var grille=vec3f(1-s.mask);
grille[column]=1;
let e=composite(i);
var blur=4*at(i);
blur+=2*(at(i+vec2i(1,0))+at(i-vec2i(1,0))+at(i+vec2i(0,1))+at(i-vec2i(0,1)));
blur+=at(i+vec2i(1,1))+at(i+vec2i(-1,1))+at(i+vec2i(1,-1))+at(i+vec2i(-1,-1));
blur/=16;
let rgb=e.rgb*beam*grille*s.brightness+s.glow*blur.rgb;
let a=clamp(e.a+s.glow*blur.a,0,1);
return vec4f(min(rgb,vec3f(a)),a);
}`;

let crtCount = 0;

/**
 * Draws a low-res picture to the canvas (or a target) as on a CRT: curved glass, scanlines, an aperture grille and
 * phosphor glow. One frame-graph pass a view. WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, a look setting out of its range.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when the source and the
 * target are the same texture.
 */
export class CRT extends ScreenPass {
  /** Read each frame. */
  curvature: number;
  /** Read each frame. */
  scanlines: number;
  /** Read each frame. */
  mask: number;
  /** Read each frame. */
  glow: number;
  /** Read each frame. */
  brightness: number;
  /** Live NTSC-style chroma bleed amount, 0 to 1. Default 0. */
  colorBleed: number;
  /** Live symmetric red/blue source-pixel displacement. Default 0. */
  chromaticOffset: ChromaticOffset;
  /** Live extra red source-pixel displacement. Default 0. */
  redOffset: ChromaticOffset;
  /** Live green source-pixel displacement. Default 0. */
  greenOffset: ChromaticOffset;
  /** Live extra blue source-pixel displacement. Default 0. */
  blueOffset: ChromaticOffset;
  constructor(options: CRTOptions) {
    super(options, 'CRT', shader, 80, `crt-${++crtCount}`);
    this.curvature = options.curvature ?? 0.08;
    this.scanlines = options.scanlines ?? 0.5;
    this.mask = options.mask ?? 0.2;
    this.glow = options.glow ?? 0.25;
    this.brightness = options.brightness ?? 1.2;
    this.colorBleed = options.colorBleed ?? 0;
    this.chromaticOffset = options.chromaticOffset ?? 0;
    this.redOffset = options.redOffset ?? 0;
    this.greenOffset = options.greenOffset ?? 0;
    this.blueOffset = options.blueOffset ?? 0;
    this.#check();
  }
  /** Creates a pass and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: CRTOptions): CRT {
    const pass = new CRT(options);
    engineRuntime(instance).use(pass);
    return pass;
  }
  #check(): void {
    for (const [key, top] of [
      ['curvature', 0.5],
      ['scanlines', 1],
      ['mask', 1],
      ['glow', 1],
      ['brightness', 4],
      ['colorBleed', 1],
    ] as const)
      if (!(this[key] >= 0 && this[key] <= top))
        throw rangeError(`CRT ${key} must be between 0 and ${top}, got ${this[key]}`, 'pixel-options');
    for (const key of ['chromaticOffset', 'redOffset', 'greenOffset', 'blueOffset'] as const) {
      const pair = offsets(this[key]);
      if (pair.length !== 2 || pair.some(v => !Number.isFinite(v) || Math.abs(v) > 32))
        throw rangeError(`CRT ${key} must be finite source pixels in [-32,32], or an [x,y] pair in that range`, 'pixel-options');
    }
  }
  protected fill(values: ArrayBuffer, rect: readonly number[]): void {
    this.#check();
    new Int32Array(values).set(rect, 0);
    new Float32Array(values).set([this.curvature, this.scanlines, this.mask, this.glow, this.brightness,
      this.colorBleed, ...offsets(this.chromaticOffset), ...offsets(this.redOffset), ...offsets(this.greenOffset),
      ...offsets(this.blueOffset)], 4);
  }
}

const offsets = (value: ChromaticOffset): readonly number[] => typeof value === 'number' ? [value, 0] : value;
