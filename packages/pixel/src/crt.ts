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
}

const shader = /* wgsl */ `
struct S{rect:vec4i,curvature:f32,scanlines:f32,mask:f32,glow:f32,brightness:f32}
@group(0) @binding(0) var<uniform> s:S;
@group(0) @binding(1) var image:texture_2d<f32>;
${VERTEX}
fn at(t:vec2i)->vec4f{
return textureLoad(image,clamp(t,vec2i(0),vec2i(textureDimensions(image))-1),0);
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
let e=at(i);
var blur=4*e;
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
  constructor(options: CRTOptions) {
    super(options, 'CRT', shader, 48, `crt-${++crtCount}`);
    this.curvature = options.curvature ?? 0.08;
    this.scanlines = options.scanlines ?? 0.5;
    this.mask = options.mask ?? 0.2;
    this.glow = options.glow ?? 0.25;
    this.brightness = options.brightness ?? 1.2;
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
    ] as const)
      if (!(this[key] >= 0 && this[key] <= top))
        throw rangeError(`CRT ${key} must be between 0 and ${top}, got ${this[key]}`, 'pixel-options');
  }
  protected fill(values: ArrayBuffer, rect: readonly number[]): void {
    this.#check();
    new Int32Array(values).set(rect, 0);
    new Float32Array(values).set([this.curvature, this.scanlines, this.mask, this.glow, this.brightness], 4);
  }
}
