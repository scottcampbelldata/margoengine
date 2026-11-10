import type { EngineKernel, Scene } from '@margoengine/core';
import { createCustomTransition, type CustomTransitionOptions } from './custom.js';
import { LiveTransitions, type LiveTransitionOptions } from './live.js';
import type { Transitions } from './index.js';

/** Image-space transition library, written from geometric mappings rather than imported shader assets. */
export type TransitionPreset =
  | 'slide'
  | 'push'
  | 'zoom'
  | 'iris'
  | 'cube'
  | 'page-curl'
  | 'swirl'
  | 'fade-through-color';
/** Finite parameters embedded as shader constants. Image coordinates have top-left origin. */
export interface TransitionPresetOptions {
  /** Incoming edge direction, normalized internally; default [1,0] enters from right. Must be finite and nonzero. */
  direction?: readonly [number, number];
  /** Edge half-width in UV units, default 0.02, finite [0,0.5]. */
  softness?: number;
  /** Progress remapping. Default linear. Quadratic ease-in/out and cubic Hermite ease-in-out. */
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  /** Iris, zoom and swirl center, default [0.5,0.5], each coordinate in [0,1]. */
  center?: readonly [number, number];
  /** RGBA background and fade-through colour, default opaque black, each component [0,1]. */
  color?: readonly [number, number, number, number];
  /** Swirl revolutions and zoom magnification control, default 1, finite (0,8]. */
  strength?: number;
}
const presets: TransitionPreset[] = [
  'slide',
  'push',
  'zoom',
  'iris',
  'cube',
  'page-curl',
  'swirl',
  'fade-through-color',
];
/** All available preset names, as an independent immutable list. */
export const transitionPresets: readonly TransitionPreset[] = Object.freeze([...presets]);
const number = (v: number) => `f32(${v})`;
/** Builds the custom entry's WGSL function contract. Source is pure and deterministic; no GPU work runs here. */
export function transitionPresetWGSL(kind: TransitionPreset, options: TransitionPresetOptions = {}): string {
  if (!presets.includes(kind)) throw new RangeError('Unknown transition preset; choose a name in transitionPresets');
  const direction = options.direction ?? [1, 0],
    center = options.center ?? [0.5, 0.5],
    color = options.color ?? [0, 0, 0, 1];
  const softness = options.softness ?? 0.02,
    strength = options.strength ?? 1,
    easing = options.easing ?? 'linear';
  const length = Math.hypot(...direction);
  if (direction.length !== 2 || !direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0)
    throw new RangeError('Transition direction must be a finite nonzero 2-vector; choose [1,0]');
  if (
    center.length !== 2 ||
    !center.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
    color.length !== 4 ||
    !color.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  )
    throw new RangeError('Transition center and color must be normalized vectors; choose [0.5,0.5] and [0,0,0,1]');
  if (
    !Number.isFinite(softness) ||
    softness < 0 ||
    softness > 0.5 ||
    !Number.isFinite(strength) ||
    strength <= 0 ||
    strength > 8
  )
    throw new RangeError('Transition softness or strength is out of range; use softness [0,0.5] and strength (0,8]');
  const ease = { linear: 't', 'ease-in': 't*t', 'ease-out': '1.0-(1.0-t)*(1.0-t)', 'ease-in-out': 't*t*(3.0-2.0*t)' }[
    easing
  ];
  if (!ease) throw new RangeError('Unknown transition easing; choose linear, ease-in, ease-out or ease-in-out');
  const d = direction.map((v) => number(v / length)).join(','),
    c = center.map(number).join(','),
    bg = color.map(number).join(',');
  const common = `
fn presetUV(q:vec2f)->vec2f {let d=vec2f(${d});return vec2f(0.5)+d*(q.x-0.5)+vec2f(-d.y,d.x)*(q.y-0.5);}
fn presetCoverage(q:vec2f)->f32 {let edge=min(min(q.x,q.y),min(1.0-q.x,1.0-q.y));return ${softness === 0 ? 'select(0.0,1.0,edge>=0.0)' : `smoothstep(-${number(softness)},${number(softness)},edge)`};}
fn presetImage(image:texture_2d<f32>,q:vec2f)->vec4f {return mix(vec4f(${bg}),sample(image,presetUV(q)),presetCoverage(q));}
fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,t:f32)->vec4f {
 let p=${ease};let dir=vec2f(${d});let center=vec2f(${c});
 let q=vec2f(dot(uv-0.5,dir),dot(uv-0.5,vec2f(-dir.y,dir.x)))+0.5;
`;
  let body: string;
  switch (kind) {
    case 'slide':
      body = `let incoming=q-vec2f(1.0-p,0.0);return mix(sample(a,uv),sample(b,presetUV(incoming)),presetCoverage(incoming));`;
      break;
    case 'push':
      body = `let old=q+vec2f(p,0.0);let next=q-vec2f(1.0-p,0.0);let w=${softness === 0 ? 'select(0.0,1.0,q.x>=1.0-p)' : `smoothstep(1.0-p-${number(softness)},1.0-p+${number(softness)},q.x)`};return mix(sample(a,presetUV(old)),sample(b,presetUV(next)),w);`;
      break;
    case 'zoom':
      body = `let out=sample(a,center+(uv-center)/(1.0+p*${number(strength)}));let incoming=sample(b,center+(uv-center)*(1.0+(1.0-p)*${number(strength)}));return mix(out,incoming,p);`;
      break;
    case 'iris':
      body = `let radius=p*max(max(distance(center,vec2f(0,0)),distance(center,vec2f(1,0))),max(distance(center,vec2f(0,1)),distance(center,vec2f(1,1))));let r=distance(uv,center);let w=${softness === 0 ? 'select(0.0,1.0,r<=radius)' : `1.0-smoothstep(radius-${number(softness)},radius+${number(softness)},r)`};return mix(sample(a,uv),sample(b,uv),w);`;
      break;
    case 'swirl':
      body = `let rel=uv-center;let angle=sin(p*3.14159265)*6.2831853*${number(strength)}*max(0.0,1.0-length(rel)/0.70710678);let cs=cos(angle);let sn=sin(angle);let rotated=center+vec2f(cs*rel.x-sn*rel.y,sn*rel.x+cs*rel.y);return mix(sample(a,rotated),sample(b,rotated),p);`;
      break;
    case 'fade-through-color':
      body = `if(p<0.5){return mix(sample(a,uv),vec4f(${bg}),p*2.0);}return mix(vec4f(${bg}),sample(b,uv),p*2.0-1.0);`;
      break;
    case 'cube':
      body = `
 let angle=p*1.570796327;let cs=cos(angle);let sn=sin(angle);
 let ro=vec3f(-3.0*sn,0,3.0*cs);let screen=vec2f(q.x*2.0-1.0,1.0-q.y*2.0);
 let rd=vec3f(cs*screen.x+2.0*sn,screen.y,sn*screen.x-2.0*cs);
 var result=vec4f(${bg});var nearest=1e20;
 if(rd.z < -0.000001){let time=(1.0-ro.z)/rd.z;let hit=ro+rd*time;
 if(time>0.0&&abs(hit.x)<=1.0&&abs(hit.y)<=1.0){nearest=time;result=presetImage(a,vec2f(hit.x+1.0,1.0-hit.y)*0.5);}}
 if(rd.x>0.000001){let time=(-1.0-ro.x)/rd.x;let hit=ro+rd*time;
 if(time>0.0&&time<nearest&&abs(hit.z)<=1.0&&abs(hit.y)<=1.0){result=presetImage(b,vec2f(hit.z+1.0,1.0-hit.y)*0.5);}}
 return result;`;
      break;
    case 'page-curl':
      body = `
 let radius=0.15;let edge=1.0-p*(1.0+3.14159265*radius);let x=q.x-edge;
 if(x<=0.0){return sample(a,uv);}
 let next=sample(b,uv);
 if(x>radius){return next;}
 let angle=asin(clamp(x/radius,0.0,1.0));let back=edge+radius*(3.14159265-angle);
 if(back<=1.0){let folded=sample(a,presetUV(vec2f(back,q.y)));let shade=0.65+0.35*cos(angle);let paper=vec4f(mix(folded.rgb,vec3f(1),0.2)*shade,folded.a);return mix(next,paper,presetCoverage(vec2f(back,q.y)));}
 let front=edge+radius*angle;
 if(front<=1.0){return sample(a,presetUV(vec2f(front,q.y)));}
 return next;`;
      break;
  }
  return common + body + '\n}';
}
/** Validates and attaches a frozen-frame preset. Call start('wipe',seconds); the supplied preset controls the effect. */
export function createPresetTransition(
  engine: EngineKernel,
  kind: TransitionPreset,
  options: TransitionPresetOptions & CustomTransitionOptions = {},
): Promise<Transitions> {
  return createCustomTransition(engine, transitionPresetWGSL(kind, options), options);
}
/** Validates and attaches a preset between two live scenes; scenes and cameras remain borrowed. */
export function createLivePresetTransition(
  engine: EngineKernel,
  before: Scene,
  after: Scene,
  kind: TransitionPreset,
  options: TransitionPresetOptions &
    Pick<LiveTransitionOptions, 'beforeCamera' | 'afterCamera'> &
    CustomTransitionOptions = {},
): Promise<LiveTransitions> {
  return LiveTransitions.custom(engine, before, after, transitionPresetWGSL(kind, options), options);
}
