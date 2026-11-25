// Ramp, Grid, DepthView and TextureOverlay: one composite pass each. Every effect computes a colour layer; the shared
// shader blends it over the frame (W3C Compositing and Blending Level 1) with an opacity and an optional mask.
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math/color';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { copyExternal } from '../../shared/copy-external.js';
import { TextureOption, type TextureSource2D } from '../../shared/texture-option.js';
import { orthographic } from '../../shared/projection.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';
import type { DepthTexture } from './depth.js';

const BLENDS = [
  'normal',
  'add',
  'subtract',
  'multiply',
  'screen',
  'overlay',
  'soft-light',
  'hard-light',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'difference',
  'exclusion',
] as const;
/** How a layer combines with the frame, with the CSS `mix-blend-mode` formulas (`add` and `subtract` clamp). */
export type OverlayBlend = (typeof BLENDS)[number];

/** Options every overlay effect shares. All are read each frame. */
export interface OverlayOptions {
  /** Blend mode. Default 'normal' (Ramp: 'soft-light'). */
  blend?: OverlayBlend;
  /** Layer strength, 0..1. Default 1 (Grid: 0.5). */
  opacity?: number;
  /** Weights the layer by the frame's luminance or by view distance. Default 'none'. */
  mask?: 'none' | 'luminance' | 'depth';
  /** The mask values given weight 0 and weight 1 (swap them to invert): luminance 0..1, or world view distance for
   * 'depth'. Default [0, 1] for luminance, the camera's [near, far] for depth. */
  maskRange?: readonly [number, number];
  /** Default true. */
  enabled?: boolean;
}

/** '#rgb' or '#rrggbb' (math/color's one hex parser, without the alpha form). */
const isHex = (color: string) => color.length <= 7 && hexColor(color) !== undefined;
function rgb(color: string): [number, number, number] {
  return hexColor(color)!.slice(0, 3) as [number, number, number];
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, min: number, max: number) => finite(v) && v >= min && v <= max;
const pair = (v: unknown): v is readonly [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]);
function need(ok: boolean, message: string): void {
  if (!ok) throw new RangeError(message);
}
function flag(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`Use ${label} as true or false`);
}
/** Near and far view distance of the frame's camera, and the vector that turns reversed depth into distance. */
function lens(c: ScreenContext): { near: number; far: number; away: number[] } {
  const eye = orthographic(c.camera.matrix, c.camera.position);
  if (eye)
    return {
      near: eye.near,
      far: eye.far,
      away: [eye.far, eye.near - eye.far, 1, 0],
    };
  const { near, far } = c.camera;
  return { near, far, away: [near * far, 0, near, far - near] };
}

const shader = (declare: string, body: string, depth: boolean) => `${fullscreen}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var<uniform> u:array<vec4f,16>;
${
  depth
    ? `@group(0) @binding(2) var depth:texture_depth_2d;
fn stored(p:vec2f)->f32{let size=vec2f(textureDimensions(depth));return textureLoad(depth,vec2i(min(p/vec2f(textureDimensions(scene))*size,size-1.0)),0);}
fn away(p:vec2f)->f32{let d=stored(p);return abs((u[2].x+u[2].y*d)/(u[2].z+u[2].w*d));}`
    : ''
}
${declare}
fn dodge(b:f32,s:f32)->f32{if(b<=0.0){return 0.0;}if(s>=1.0){return 1.0;}return min(1.0,b/(1.0-s));}
fn soft(b:f32,s:f32)->f32{if(s<=0.5){return b-(1.0-2.0*s)*b*(1.0-b);}var d=sqrt(b);if(b<=0.25){d=((16.0*b-12.0)*b+4.0)*b;}return b+(2.0*s-1.0)*(d-b);}
fn hard(b:vec3f,s:vec3f)->vec3f{return select(1.0-2.0*(1.0-b)*(1.0-s),2.0*b*s,s<=vec3f(0.5));}
fn blended(b:vec3f,s:vec3f,kind:i32)->vec3f{
 switch kind{
  case 1{return min(b+s,vec3f(1.0));}
  case 2{return max(b-s,vec3f(0.0));}
  case 3{return b*s;}
  case 4{return b+s-b*s;}
  case 5{return hard(s,b);}
  case 6{return vec3f(soft(b.r,s.r),soft(b.g,s.g),soft(b.b,s.b));}
  case 7{return hard(b,s);}
  case 8{return min(b,s);}
  case 9{return max(b,s);}
  case 10{return vec3f(dodge(b.r,s.r),dodge(b.g,s.g),dodge(b.b,s.b));}
  case 11{return 1.0-vec3f(dodge(1.0-b.r,1.0-s.r),dodge(1.0-b.g,1.0-s.g),dodge(1.0-b.b,1.0-s.b));}
  case 12{return abs(b-s);}
  case 13{return b+s-2.0*b*s;}
  default{return s;}
 }
}
${body}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let s=textureLoad(scene,vec2i(p.xy),0);
 let base=clamp(s.rgb/max(s.a,1e-6),vec3f(0.0),vec3f(1.0));
 let c=layer(p.xy);
 var w=u[0].x*c.a;
 if(u[0].z>0.5){
  var v=dot(base,vec3f(0.2126,0.7152,0.0722));
  ${depth ? 'if(u[0].z>1.5){v=away(p.xy);}' : ''}
  w*=clamp((v-u[1].x)/(u[1].y-u[1].x),0.0,1.0);
 }
 return vec4f(s.rgb+(blended(base,c.rgb,i32(u[0].y))-base)*(w*s.a),s.a);
}`;

/** The shared composite of the overlay effects: an LDR `PostStack` stage. Not a base class to extend. */
export abstract class OverlayEffect<O extends OverlayOptions> extends ScreenEffect {
  protected readonly kind = 'ldr';
  private readonly values = new Float32Array(64);
  private readonly cached = new WeakMap<GPUTexture, GPUTextureView>();
  protected readonly blend: OverlayBlend = 'normal';
  protected readonly opacity: number = 1;
  constructor(readonly options: O) {
    super();
    this.uniformBytes = 256;
  }
  /** Runs alone in an owned PostStack. */
  protected static alone<E extends OverlayEffect<OverlayOptions>>(engine: EngineKernel, effect: E): E {
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  protected check(): void {
    const o = this.options,
      n = this.name;
    need(o.blend === undefined || BLENDS.includes(o.blend), `Use ${n} blend as one of ${BLENDS.join(', ')}`);
    need(o.opacity === undefined || within(o.opacity, 0, 1), `Use ${n} opacity from 0 to 1`);
    need(
      o.mask === undefined || ['none', 'luminance', 'depth'].includes(o.mask),
      `Use ${n} mask 'none', 'luminance' or 'depth'`,
    );
    need(
      o.maskRange === undefined || (pair(o.maskRange) && o.maskRange[0] !== o.maskRange[1]),
      `Use ${n} maskRange as two different finite numbers`,
    );
    flag(o.enabled, `${n} enabled`);
  }
  protected view(texture: GPUTexture, aspect: GPUTextureAspect = 'all'): GPUTextureView {
    let view = this.cached.get(texture);
    if (!view) this.cached.set(texture, (view = texture.createView({ aspect })));
    return view;
  }
  /** WGSL declaring `fn layer(p:vec2f)->vec4f` (straight colour and coverage) from the uniforms u[3] onwards. */
  protected abstract source(): {
    declare?: string;
    body: string;
    depth?: boolean;
  };
  /** Writes u[3] onwards (`v` starts there); returns the extra bindings, or null when there is nothing to draw yet. */
  protected abstract params(c: ScreenContext, v: Float32Array): GPUBindingResource[] | null;
  /** The depth the shader reads; while undefined the frame passes through. */
  protected depthSource(): GPUTexture | undefined {
    return this.host!.depthTexture;
  }
  /** Bindings used while there is nothing to draw. */
  protected idle(_c: ScreenContext): GPUBindingResource[] {
    return [];
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      v = this.values,
      mask = o.mask ?? 'none',
      code = this.source(),
      depth = !!code.depth || mask === 'depth',
      camera = lens(c);
    v.fill(0);
    const extra = this.params(c, v.subarray(12)),
      source = depth ? this.depthSource() : undefined,
      ready = extra !== null && (!depth || !!source) && o.enabled !== false;
    v.set([
      ready ? (o.opacity ?? this.opacity) : 0,
      BLENDS.indexOf(o.blend ?? this.blend),
      mask === 'none' ? 0 : mask === 'luminance' ? 1 : 2,
    ]);
    v.set(o.maskRange ?? (mask === 'depth' ? [camera.near, camera.far] : [0, 1]), 4);
    v.set(camera.away, 8);
    c.device.queue.writeBuffer(this.uniform!, 0, v);
    const resources: GPUBindingResource[] = [input, { buffer: this.uniform! }];
    if (depth) resources.push(this.view(source ?? this.host!.depthTexture!, 'depth-only'));
    resources.push(...(extra ?? this.idle(c)));
    this.draw(c, shader(code.declare ?? '', code.body, depth), output, resources);
  }
}

/** One colour of a {@link Ramp}. */
export interface RampStop {
  /** Position along the gradient, 0..1, not below the stop before it. */
  at: number;
  /** '#rgb' or '#rrggbb'. */
  color: string;
  /** Coverage, 0..1. Default 1. */
  alpha?: number;
}
/** Options for {@link Ramp}. */
export interface RampOptions extends OverlayOptions {
  /** 'linear' from start to end, 'radial' outwards from start to the circle through end, 'mirrored' from the middle of
   * start..end to both ends. Default 'linear'. */
  type?: 'linear' | 'radial' | 'mirrored';
  /** 2..8 colours, interpolated as display values. Default black to white. */
  stops?: readonly RampStop[];
  /** Gradient start in fractions of the frame, [0, 0] top left. Default [0, 0.5] (radial: [0.5, 0.5]). */
  start?: readonly [number, number];
  /** Gradient end. Default [1, 0.5]. */
  end?: readonly [number, number];
  /** Degrees clockwise, turning start and end about their midpoint (linear and mirrored). Default 0. */
  angle?: number;
  /** Schlick bias, above 0 and below 1: moves the middle of the gradient. Default 0.5 (no change). */
  bias?: number;
  /** Schlick gain, above 0 and below 1: contrast of the gradient. Default 0.5 (no change). */
  gain?: number;
  /** Runs the gradient backwards. Default false. */
  invert?: boolean;
}
const RAMP_TYPES = ['linear', 'radial', 'mirrored'];
const BLACK_WHITE: readonly RampStop[] = [
  { at: 0, color: '#000000' },
  { at: 1, color: '#ffffff' },
];
const RAMP = {
  body: `fn bias(t:f32,a:f32)->f32{return t/((1.0/a-2.0)*(1.0-t)+1.0);}
fn position(i:i32)->f32{return u[14+i/4][i%4];}
fn layer(p:vec2f)->vec4f{
 let a=u[3].xy;let d=u[3].zw-a;let kind=i32(u[4].x);
 var t=dot(p-a,d)/max(dot(d,d),1e-6);
 if(kind==1){t=length(p-a)/max(length(d),1e-3);}
 if(kind==2){t=abs(2.0*t-1.0);}
 t=bias(clamp(t,0.0,1.0),u[4].y);
 if(t<0.5){t=bias(2.0*t,u[4].z)*0.5;}else{t=1.0-bias(2.0-2.0*t,u[4].z)*0.5;}
 if(u[4].w>0.5){t=1.0-t;}
 var c=u[6];
 for(var i=1;i<i32(u[5].x);i++){let low=position(i-1);c=mix(c,u[6+i],clamp((t-low)/max(position(i)-low,1e-6),0.0,1.0));}
 return c;
}`,
};

/** A linear, radial or mirrored colour gradient over the frame. An LDR `PostStack` effect. */
export class Ramp extends OverlayEffect<RampOptions> {
  readonly name = 'ramp';
  protected override readonly blend = 'soft-light';
  constructor(options: RampOptions = {}) {
    super(options);
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: RampOptions = {}): Ramp {
    return OverlayEffect.alone(engine, new Ramp(options));
  }
  protected override check(): void {
    super.check();
    const o = this.options,
      stops = o.stops ?? BLACK_WHITE;
    need(o.type === undefined || RAMP_TYPES.includes(o.type), "Use Ramp type 'linear', 'radial' or 'mirrored'");
    need(Array.isArray(stops) && stops.length >= 2 && stops.length <= 8, 'Use 2 to 8 Ramp stops');
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      need(within(s?.at, i ? stops[i - 1].at : 0, 1), 'Use Ramp stop positions from 0 to 1 in rising order');
      need(typeof s.color === 'string' && isHex(s.color), "Use a Ramp stop color as '#rgb' or '#rrggbb'");
      need(s.alpha === undefined || within(s.alpha, 0, 1), 'Use a Ramp stop alpha from 0 to 1');
    }
    need(o.start === undefined || pair(o.start), 'Use Ramp start as [x, y] finite numbers');
    need(o.end === undefined || pair(o.end), 'Use Ramp end as [x, y] finite numbers');
    need(o.angle === undefined || finite(o.angle), 'Use a finite Ramp angle in degrees');
    for (const k of ['bias', 'gain'] as const)
      need(o[k] === undefined || (finite(o[k]) && o[k]! > 0 && o[k]! < 1), `Use Ramp ${k} above 0 and below 1`);
    flag(o.invert, 'Ramp invert');
  }
  protected source() {
    return RAMP;
  }
  protected params(c: ScreenContext, v: Float32Array): GPUBindingResource[] {
    const o = this.options,
      type = o.type ?? 'linear',
      stops = o.stops ?? BLACK_WHITE,
      start = o.start ?? (type === 'radial' ? [0.5, 0.5] : [0, 0.5]),
      end = o.end ?? [1, 0.5],
      turn = type === 'radial' ? 0 : ((o.angle ?? 0) * Math.PI) / 180;
    let ax = start[0] * c.width,
      ay = start[1] * c.height,
      bx = end[0] * c.width,
      by = end[1] * c.height;
    if (turn) {
      const mx = (ax + bx) / 2,
        my = (ay + by) / 2,
        x = (bx - ax) / 2,
        y = (by - ay) / 2,
        rx = x * Math.cos(turn) - y * Math.sin(turn),
        ry = x * Math.sin(turn) + y * Math.cos(turn);
      [ax, ay, bx, by] = [mx - rx, my - ry, mx + rx, my + ry];
    }
    v.set([ax, ay, bx, by, RAMP_TYPES.indexOf(type), o.bias ?? 0.5, o.gain ?? 0.5, +(o.invert ?? false), stops.length]);
    for (let i = 0; i < stops.length; i++) {
      v.set(rgb(stops[i].color), 12 + i * 4);
      v[15 + i * 4] = stops[i].alpha ?? 1;
      v[44 + i] = stops[i].at;
    }
    return [];
  }
}

/** Options for {@link Grid}. */
export interface GridOptions extends OverlayOptions {
  /** Line grid, or dots at the crossings. Default 'lines'. */
  style?: 'lines' | 'dots';
  /** Drawing-buffer pixels between lines, one number or [x, y], 2..4096. Default 32. */
  cellSize?: number | readonly [number, number];
  /** Line width or dot diameter in drawing-buffer pixels, above 0 up to 4096. Default 1 (dots: 3). */
  lineWidth?: number;
  /** '#rgb' or '#rrggbb'. Default '#ffffff'. */
  color?: string;
  /** Moves the grid, in drawing-buffer pixels from the top left. Default [0, 0]. */
  offset?: readonly [number, number];
  /** Degrees clockwise about the offset point. Default 0. */
  angle?: number;
}
const GRID = {
  body: `fn layer(p:vec2f)->vec4f{
 let r=p-u[4].xy;let q=vec2f(r.x*u[4].z+r.y*u[4].w,r.y*u[4].z-r.x*u[4].w);
 let d=abs(q-round(q/u[3].xy)*u[3].xy);
 var gap=min(d.x,d.y);if(u[3].w>0.5){gap=length(d);}
 return vec4f(u[5].rgb,clamp(u[3].z*0.5+0.5-gap,0.0,min(u[3].z,1.0)));
}`,
};

/** An anti-aliased line or dot grid in screen space. An LDR `PostStack` effect. */
export class Grid extends OverlayEffect<GridOptions> {
  readonly name = 'grid';
  protected override readonly opacity = 0.5;
  constructor(options: GridOptions = {}) {
    super(options);
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: GridOptions = {}): Grid {
    return OverlayEffect.alone(engine, new Grid(options));
  }
  protected override check(): void {
    super.check();
    const o = this.options,
      cell = o.cellSize ?? 32;
    need(o.style === undefined || o.style === 'lines' || o.style === 'dots', "Use Grid style 'lines' or 'dots'");
    need(
      typeof cell === 'number' ? within(cell, 2, 4096) : pair(cell) && cell.every((v) => within(v, 2, 4096)),
      'Use Grid cellSize from 2 to 4096, one number or [x, y]',
    );
    need(
      o.lineWidth === undefined || (within(o.lineWidth, 0, 4096) && o.lineWidth > 0),
      'Use Grid lineWidth above 0 up to 4096',
    );
    need(
      o.color === undefined || (typeof o.color === 'string' && isHex(o.color)),
      "Use Grid color as '#rgb' or '#rrggbb'",
    );
    need(o.offset === undefined || pair(o.offset), 'Use Grid offset as [x, y] finite numbers');
    need(o.angle === undefined || finite(o.angle), 'Use a finite Grid angle in degrees');
  }
  protected source() {
    return GRID;
  }
  protected params(_c: ScreenContext, v: Float32Array): GPUBindingResource[] {
    const o = this.options,
      cell = o.cellSize ?? 32,
      dots = o.style === 'dots',
      turn = ((o.angle ?? 0) * Math.PI) / 180,
      [x, y] = o.offset ?? [0, 0];
    v.set(typeof cell === 'number' ? [cell, cell] : cell);
    v.set([o.lineWidth ?? (dots ? 3 : 1), +dots], 2);
    // Half a pixel in, so that a one-pixel line at the default offset covers one pixel instead of half of two.
    v.set([x + 0.5, y + 0.5, Math.cos(turn), Math.sin(turn)], 4);
    v.set(rgb(o.color ?? '#ffffff'), 8);
    return [];
  }
}

/** Options for {@link DepthView}. */
export interface DepthViewOptions extends OverlayOptions {
  /** A `DepthTexture` to show (add it to the engine yourself; it can hold models of its own). Default the depth of the
   * stack's scene capture. */
  depth?: DepthTexture;
  /** 'linear' view distance from near (black) to far (white), or the 'raw' reversed-Z value. Default 'linear'. */
  mode?: 'linear' | 'raw';
  /** World view distance shown black in 'linear' mode. Default the camera near plane. */
  near?: number;
  /** World view distance shown white in 'linear' mode. Default the camera far plane. */
  far?: number;
  /** Shows 1 - value. Default false. */
  invert?: boolean;
}
const DEPTH = {
  depth: true,
  body: `fn layer(p:vec2f)->vec4f{
 var v=clamp((away(p)-u[3].y)/(u[3].z-u[3].y),0.0,1.0);
 if(u[3].x>0.5){v=stored(p);}
 if(u[3].w>0.5){v=1.0-v;}
 return vec4f(vec3f(v),1.0);
}`,
};

/** Shows the scene depth as grey, linearised or raw. An LDR `PostStack` effect. */
export class DepthView extends OverlayEffect<DepthViewOptions> {
  readonly name = 'depth-view';
  constructor(options: DepthViewOptions = {}) {
    super(options);
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: DepthViewOptions = {}): DepthView {
    return OverlayEffect.alone(engine, new DepthView(options));
  }
  protected override check(): void {
    super.check();
    const o = this.options;
    if (o.depth !== undefined && (typeof o.depth !== 'object' || o.depth === null))
      throw new TypeError('Use DepthView depth as a DepthTexture');
    need(o.mode === undefined || o.mode === 'linear' || o.mode === 'raw', "Use DepthView mode 'linear' or 'raw'");
    for (const k of ['near', 'far'] as const)
      need(o[k] === undefined || within(o[k], 0, Number.MAX_VALUE), `Use DepthView ${k} as a distance of at least 0`);
    need(o.near === undefined || o.near !== o.far, 'Use different DepthView near and far');
    flag(o.invert, 'DepthView invert');
  }
  protected source() {
    return DEPTH;
  }
  protected override depthSource(): GPUTexture | undefined {
    return this.options.depth ? this.options.depth.texture : this.host!.depthTexture;
  }
  protected params(c: ScreenContext, v: Float32Array): GPUBindingResource[] {
    const o = this.options,
      camera = lens(c),
      near = o.near ?? camera.near,
      far = o.far ?? camera.far;
    // One given end may equal the camera's other end: a hard step there, not a division by zero.
    v.set([+(o.mode === 'raw'), near, far === near ? near * 1.000001 + 1e-6 : far, +(o.invert ?? false)]);
    return [];
  }
}

/** Options for {@link TextureOverlay}. */
export interface TextureOverlayOptions extends OverlayOptions {
  /** An ImageBitmap (uploaded once, and again after a device restore), a filterable 2D GPUTexture, or a function
   * returning one each frame. Colours are straight alpha. While the function returns nothing the frame passes through.
   * A GPUTexture belongs to the device it was given on: after a device restore the frame passes through, reported once
   * through `engine.onError`, until `setSource` (or this option) hands in a new one. Read every frame. */
  source: ImageBitmap | GPUTexture | (() => GPUTexture | undefined);
  /** How the image sits in the frame, as CSS object-fit: 'fill' stretches, 'contain' and 'cover' keep the aspect,
   * 'none' keeps its pixel size. Default 'cover'. */
  fit?: 'fill' | 'contain' | 'cover' | 'none';
  /** Moves the image, in fractions of the frame (x right, y down). Default [0, 0]. */
  offset?: readonly [number, number];
  /** Size factor after fit, one number or [x, y], not 0; negative mirrors. Default 1. */
  scale?: number | readonly [number, number];
  /** Degrees clockwise about the image centre. Default 0. */
  rotation?: number;
  /** Tiles the image over the whole frame. Default false. */
  repeat?: boolean;
}
type TextureOverlaySource = TextureOverlayOptions['source'];
const isSource = (source: unknown): source is TextureOverlaySource =>
  typeof source === 'function' || (typeof source === 'object' && !!source && (source as { width: number }).width > 0);
const isBitmap = (source: TextureOverlaySource): source is ImageBitmap =>
  typeof source !== 'function' && !('createView' in source);
const imageShader = (slot: number) => ({
  declare: `@group(0) @binding(${slot}) var image:texture_2d<f32>;
@group(0) @binding(${slot + 1}) var sampling:sampler;`,
  body: `fn layer(p:vec2f)->vec4f{
 let r=p-u[3].xy;let q=vec2f(r.x*u[4].x+r.y*u[4].y,r.y*u[4].x-r.x*u[4].y);
 var t=q/u[3].zw+0.5;
 var cover=1.0;
 if(u[4].z>0.5){t=fract(t);}else{let edge=clamp((0.5-abs(t-0.5))*abs(u[3].zw)+0.5,vec2f(0.0),vec2f(1.0));cover=edge.x*edge.y;}
 var c=textureSampleLevel(image,sampling,t,0.0);
 if(u[4].w>0.5){c=vec4f(select(1.055*pow(c.rgb,vec3f(1.0/2.4))-0.055,c.rgb*12.92,c.rgb<=vec3f(0.0031308)),c.a);}
 return vec4f(c.rgb,c.a*cover);
}`,
});
// The image binds after the depth when a depth mask takes binding 2.
const IMAGE = imageShader(2),
  MASKED_IMAGE = imageShader(3);

/** An image or texture over the frame: fitted, moved, scaled, turned or tiled. An LDR `PostStack` effect. */
export class TextureOverlay extends OverlayEffect<TextureOverlayOptions> {
  readonly name = 'texture-overlay';
  private sampler?: GPUSampler;
  private blank?: GPUTexture;
  private uploaded?: { bitmap: ImageBitmap; texture: GPUTexture };
  /** A GPUTexture or function `source`, held by the borrowed-object rule (docs/conventions.md). */
  private held?: TextureOption;
  constructor(options: TextureOverlayOptions) {
    super(options);
    this.check();
    if (!isBitmap(options.source)) this.hold(options.source, undefined);
  }
  /**
   * Replaces `options.source` from the next frame. Call it from `onDeviceRestored` with a texture of the new device; a
   * plain texture held at a device restore is dropped (the frame passes through, reported once through
   * `engine.onError`) while the frame keeps drawing.
   */
  setSource(source: TextureOverlayOptions['source']): this {
    if (!isSource(source))
      throw new TypeError('Use TextureOverlay source as an open ImageBitmap, a GPUTexture or () => texture');
    this.options.source = source;
    if (!isBitmap(source)) this.hold(source, this.engine?.gpu);
    return this;
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.held?.fix(engine.gpu);
  }
  private hold(source: GPUTexture | (() => GPUTexture | undefined), device: GPUDevice | null | undefined): void {
    if (this.held) this.held.set(source as TextureSource2D, device);
    else {
      this.held = new TextureOption(source as TextureSource2D, 'TextureOverlay source', 'setSource');
      this.held.fix(device);
    }
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: TextureOverlayOptions): TextureOverlay {
    return OverlayEffect.alone(engine, new TextureOverlay(options));
  }
  protected override check(): void {
    super.check();
    const o = this.options,
      source = o?.source;
    if (!isSource(source))
      throw new TypeError('Use TextureOverlay source as an open ImageBitmap, a GPUTexture or () => texture');
    need(
      o.fit === undefined || ['fill', 'contain', 'cover', 'none'].includes(o.fit),
      "Use TextureOverlay fit 'fill', 'contain', 'cover' or 'none'",
    );
    need(o.offset === undefined || pair(o.offset), 'Use TextureOverlay offset as [x, y] finite numbers');
    const s = o.scale ?? 1;
    need(
      typeof s === 'number' ? finite(s) && s !== 0 : pair(s) && s[0] !== 0 && s[1] !== 0,
      'Use a finite TextureOverlay scale other than 0, one number or [x, y]',
    );
    need(o.rotation === undefined || finite(o.rotation), 'Use a finite TextureOverlay rotation in degrees');
    flag(o.repeat, 'TextureOverlay repeat');
  }
  protected source() {
    return this.options.mask === 'depth' ? MASKED_IMAGE : IMAGE;
  }
  private texture(device: GPUDevice): GPUTexture | undefined {
    const source = this.options.source;
    if (!isBitmap(source)) {
      // The options object is read every frame: a `source` assigned straight onto it is taken like `setSource`.
      if (this.held?.value !== source) this.hold(source, device);
      return this.held!.get(device, this.engine);
    }
    if (this.uploaded?.bitmap !== source) {
      this.uploaded?.texture.destroy();
      const size = [source.width, source.height],
        texture = device.createTexture({
          size,
          format: 'rgba8unorm',
          usage: 0x2 | 0x4 | 0x10,
        });
      copyExternal(device, { source }, { texture }, size);
      this.uploaded = { bitmap: source, texture };
    }
    return this.uploaded.texture;
  }
  private bindings(device: GPUDevice, texture: GPUTexture): GPUBindingResource[] {
    this.sampler ??= device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    return [this.view(texture), this.sampler];
  }
  protected override idle(c: ScreenContext): GPUBindingResource[] {
    this.blank ??= c.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: 0x4 | 0x10,
    });
    return this.bindings(c.device, this.blank);
  }
  protected params(c: ScreenContext, v: Float32Array): GPUBindingResource[] | null {
    const o = this.options,
      texture = this.texture(c.device);
    if (!texture) return null;
    const fit = o.fit ?? 'cover',
      rx = c.width / texture.width,
      ry = c.height / texture.height,
      k = fit === 'contain' ? Math.min(rx, ry) : fit === 'cover' ? Math.max(rx, ry) : 1,
      s = o.scale ?? 1,
      [sx, sy] = typeof s === 'number' ? [s, s] : s,
      [x, y] = o.offset ?? [0, 0],
      turn = ((o.rotation ?? 0) * Math.PI) / 180;
    v.set([
      (0.5 + x) * c.width,
      (0.5 + y) * c.height,
      (fit === 'fill' ? c.width : texture.width * k) * sx,
      (fit === 'fill' ? c.height : texture.height * k) * sy,
      Math.cos(turn),
      Math.sin(turn),
      +(o.repeat ?? false),
      +!!texture.format?.endsWith('-srgb'),
    ]);
    return this.bindings(c.device, texture);
  }
  protected override release(): void {
    super.release();
    this.uploaded?.texture.destroy();
    this.blank?.destroy();
    this.uploaded = this.blank = this.sampler = undefined;
  }
}
