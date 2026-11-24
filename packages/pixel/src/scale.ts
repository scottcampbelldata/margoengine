/// <reference lib="esnext.disposable" preserve="true" />
// Pixel-art scaling to any size, whole factor or not. 'sharp-bilinear' gives each output pixel the average of the source
// texels it covers, weighted by how much of it each covers: inside a texel the colour is flat, and only the one output
// pixel that straddles a texel edge mixes the two, so pixels stay square and even at 2.4x or 3.7x without the uneven
// rows of nearest sampling. 'edge' first doubles the picture by the Scale2x rule (a corner of a texel takes the colour
// of its two neighbours toward that corner when they match and the other two differ, rounding diagonal steps), then
// covers it the same way.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { rangeError } from '../../shared/errors.js';
import { ScreenPass, type ScreenPassOptions, VERTEX } from './blit.js';

export { fitRect, type PixelFit, type ScreenPassOptions, type TextureSource } from './blit.js';

/** How {@link PixelScale} fills each output pixel. */
export type ScaleFilter = 'nearest' | 'sharp-bilinear' | 'edge' | 'xbr3' | 'xbr4';

/** Settings of {@link PixelScale}. */
export interface PixelScaleOptions extends ScreenPassOptions {
  /** Read each frame. Default `'sharp-bilinear'`. */
  filter?: ScaleFilter;
}

const shader = /* wgsl */ `
struct S{rect:vec4i,mode:u32,grid:i32}
@group(0) @binding(0) var<uniform> s:S;
@group(0) @binding(1) var image:texture_2d<f32>;
${VERTEX}
fn at(t:vec2i)->vec4f{
return textureLoad(image,clamp(t,vec2i(0),vec2i(textureDimensions(image))-1),0);
}
// Integer colour decisions are stable across GPU backends. Alpha participates, so transparent contours count.
fn difference(a:vec4f,b:vec4f)->f32{
let d=abs(vec4i(round(a*255))-vec4i(round(b*255)));
return f32(3*d.r+6*d.g+d.b+10*d.a);
}
fn contour(j:vec2i)->vec4f{
let bounded=clamp(j,vec2i(0),vec2i(textureDimensions(image))*s.grid-1);
let t=bounded/s.grid;
let q=(vec2f(bounded-t*s.grid)+0.5)/f32(s.grid);
let e=at(t);
var sum=vec4f(0);
var coverage=0.0;
// Four rotated corner hypotheses. Compare along-contour continuity to a crossing contour in a 5x5 footprint.
for(var corner=0;corner<4;corner++){
let sign=vec2i(select(-1,1,(corner&1)==1),select(-1,1,corner>=2));
let dx=vec2i(sign.x,0); let dy=vec2i(0,sign.y);
let f=at(t+dx); let h=at(t+dy); let i=at(t+dx+dy);
if(all(e==f)||all(e==h)){continue;}
if(all(f==h)&&all(f==at(t-dx))&&all(f==at(t-dy))){continue;}
let along=4*difference(f,h)+difference(e,at(t+dx-dy))+difference(e,at(t-dx+dy))
  +difference(i,at(t+2*dx))+difference(i,at(t+2*dy));
let across=4*difference(e,i)+difference(h,at(t-dx))+difference(f,at(t-dy))
  +difference(h,at(t+dx+2*dy))+difference(f,at(t+2*dx+dy));
if(along>=across){continue;}
let candidate=select((f+h)*0.5,select(f,h,difference(e,h)<difference(e,f)),difference(e,h)!=difference(e,f));
let u=select(1-q.x,q.x,sign.x>0); let v=select(1-q.y,q.y,sign.y>0);
let horizontal=difference(h,at(t+2*dx+dy));
let vertical=difference(f,at(t+dx+2*dy));
var edge=u+v-1.5;
if(2*horizontal<vertical){edge=0.5*u+v-1.25;}
if(2*vertical<horizontal){edge=u+0.5*v-1.25;}
let weight=clamp(edge*f32(s.grid)+0.5,0,1);
sum+=candidate*weight; coverage+=weight;
}
return (e*max(0,1-coverage)+sum)/max(1,coverage);
}
fn cell(j:vec2i)->vec4f{
if(s.grid==1){return at(j);}
if(s.grid>=3){return contour(j);}
let t=j/2;
let q=j-t*2;
let e=at(t);
let b=at(t+vec2i(0,-1));
let h=at(t+vec2i(0,1));
let d=at(t+vec2i(-1,0));
let f=at(t+vec2i(1,0));
let side=select(d,f,q.x==1);
let vert=select(b,h,q.y==1);
let oside=select(f,d,q.x==1);
let overt=select(h,b,q.y==1);
if(all(side==vert)&&any(vert!=oside)&&any(side!=overt)){return side;}
return e;
}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{
let n=vec2i(textureDimensions(image))*s.grid;
let o=vec2i(floor(p.xy))-s.rect.xy;
let w=s.rect.zw;
if(s.mode==0u){return cell(clamp((o*2+1)*n/(w*2),vec2i(0),n-1));}
let right=vec2f((o+1)*n)/vec2f(w);
let last=vec2i(floor(right));
let k=clamp((right-vec2f(last))*vec2f(w)/vec2f(n),vec2f(0),vec2f(1));
let a=last-1;
let top=mix(cell(vec2i(a.x,a.y)),cell(vec2i(last.x,a.y)),k.x);
let bottom=mix(cell(vec2i(a.x,last.y)),cell(last),k.x);
return mix(top,bottom,k.y);
}`;

let scaleCount = 0;

/**
 * Draws a low-res picture to the canvas (or a target) at any size with a pixel-art filter, for screens whose size is not
 * a whole multiple of the art. One frame-graph pass a view. WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, an invalid `filter` or `fit`.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when the source and the
 * target are the same texture.
 */
export class PixelScale extends ScreenPass {
  /** Read each frame. */
  filter: ScaleFilter;
  constructor(options: PixelScaleOptions) {
    super(options, 'PixelScale', shader, 32, `pixel-scale-${++scaleCount}`);
    this.filter = options.filter ?? 'sharp-bilinear';
    checkFilter(this.filter);
  }
  /** Creates a pass and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: PixelScaleOptions): PixelScale {
    const pass = new PixelScale(options);
    engineRuntime(instance).use(pass);
    return pass;
  }
  protected fill(values: ArrayBuffer, rect: readonly number[], source: GPUTexture): void {
    checkFilter(this.filter);
    const words = new Int32Array(values);
    words.set(rect, 0);
    words[4] = this.filter === 'nearest' ? 0 : 1;
    // Scale2x needs room: below 2x the doubled grid would be finer than the screen, so 'edge' covers the plain one.
    const grid = this.filter === 'xbr4' ? 4 : this.filter === 'xbr3' ? 3 : this.filter === 'edge' ? 2 : 1;
    const room = Math.min(rect[2] / source.width, rect[3] / source.height) >= grid;
    words[5] = room ? grid : 1;
  }
}

const checkFilter = (filter: ScaleFilter): void => {
  if (!['nearest', 'sharp-bilinear', 'edge', 'xbr3', 'xbr4'].includes(filter))
    throw rangeError(`PixelScale filter must be nearest, sharp-bilinear, edge, xbr3 or xbr4, got ${filter}`, 'pixel-options');
};

/** An RGBA picture, 4 bytes a pixel, rows from the top. */
export interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * The picture doubled by the Scale2x rule, on the CPU (the rule `'edge'` draws with): each texel becomes four, and a
 * corner takes the colour of its two neighbours toward it when they match and the other two differ. Texels past the
 * edge repeat the edge. For exporting sprites at twice the size.
 */
export function scale2x(image: PixelImage): PixelImage {
  const { width, height, data } = image;
  if (
    !(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) ||
    data?.length !== width * height * 4
  )
    throw rangeError('scale2x needs a whole width and height and width * height * 4 bytes', 'pixel-options');
  const out = new Uint8Array(data.length * 4),
    at = (x: number, y: number) =>
      (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4,
    same = (a: number, b: number) =>
      data[a] === data[b] && data[a + 1] === data[b + 1] && data[a + 2] === data[b + 2] && data[a + 3] === data[b + 3];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const e = at(x, y),
        b = at(x, y - 1),
        h = at(x, y + 1),
        d = at(x - 1, y),
        f = at(x + 1, y);
      for (let q = 0; q < 4; q++) {
        const right = q & 1,
          bottom = q >> 1,
          side = right ? f : d,
          vert = bottom ? h : b,
          oside = right ? d : f,
          overt = bottom ? b : h,
          from = same(side, vert) && !same(vert, oside) && !same(side, overt) ? side : e,
          to = ((y * 2 + bottom) * width * 2 + x * 2 + right) * 4;
        out.set(data.subarray(from, from + 4), to);
      }
    }
  return { width: width * 2, height: height * 2, data: out };
}
