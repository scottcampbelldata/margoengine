// What `/curve-flow` and `/instanced-curve-flow` share: the checks of a curve's frame table and the WGSL that moves a
// vertex from its mesh onto a curve. Not a public entry; sources are listed in curve-flow.ts.
import type { CurveFlowFrames } from './curve-flow.js';

export const curveFlowHelp = '; see https://margoengine.com/errors#curve-flow',
  // Components of a local point that are along, up and side, and the sign of side (as `CurveFlow.deform`).
  curveFlowLayouts = { x: ['x', 'y', 'z', 1], y: ['y', 'z', 'x', 1], z: ['z', 'y', 'x', -1] } as const,
  // WebGPU's guaranteed maxTextureDimension2D: one texel column per frame.
  MAX_FRAMES = 8192;

export type CurveFlowLayout = (typeof curveFlowLayouts)[keyof typeof curveFlowLayouts];

export function finite(label: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RangeError(`${label} ${String(value)} is invalid; pass a finite number${curveFlowHelp}`);
  return value;
}

/** The checked frame table of `flow`: 16 floats per frame. */
export function frameTableOf(flow: CurveFlowFrames, caller: string): { count: number; table: Float32Array } {
  if (
    typeof flow !== 'object' ||
    flow === null ||
    typeof flow.frameTable !== 'function' ||
    !(flow.length > 0 && flow.length < Infinity)
  )
    throw new TypeError(`${caller} needs a CurveFlow from @margoengine/geometry/flow; pass one${curveFlowHelp}`);
  const count = flow.frameCount,
    table = flow.frameTable();
  if (!Number.isInteger(count) || count < 2 || count > MAX_FRAMES || table.length !== count * 16)
    throw new RangeError(
      `${caller} takes 2 to ${MAX_FRAMES} frames (CurveFlow segments 1 to ${MAX_FRAMES - 1}), got ${count}; pass fewer segments${curveFlowHelp}`,
    );
  return { count, table };
}

/**
 * The vertex WGSL of plugin `n`: bends `position` and `normal` along the frames `<n>Frame(i, row)` reads. `head`
 * declares `fl` (the curve's length), `seg` (its segments), `loops` (distances wrap), `stretch` (distance per unit
 * along the mesh) and `var at` (this vertex's distance along the curve).
 */
export function bendWgsl(n: string, [a, u, s, sign]: CurveFlowLayout, head: string): string {
  return `
${head}var beyond=0.0;
if(loops){at=at-floor(at/fl)*fl;}else if(at<0.0){beyond=at;at=0.0;}else if(at>fl){beyond=at-fl;at=fl;}
let place=at/fl*seg;let k=min(i32(seg)-1,i32(floor(place)));let fr=place-f32(k);
let t=normalize(mix(${n}Frame(k,1),${n}Frame(k+1,1),fr));
let uu=normalize(mix(${n}Frame(k,2),${n}Frame(k+1,2),fr));
let ss=normalize(mix(${n}Frame(k,3),${n}Frame(k+1,3),fr));
let rate=select(seg/fl,0.0,beyond!=0.0);
let du=(${n}Frame(k+1,2)-${n}Frame(k,2))*rate;let ds=(${n}Frame(k+1,3)-${n}Frame(k,3))*rate;
let up=position.${u};let side=position.${s}*${sign.toFixed(1)};
let j=(t+up*du+side*ds)*stretch;
let na=normal.${a};let nu=normal.${u};let ns=normal.${s}*${sign.toFixed(1)};
let bent=na*cross(uu,ss)+nu*cross(ss,j)+ns*cross(j,uu);
let len=length(bent);
if(len>0.0){normal=bent/len*select(1.0,-1.0,stretch<0.0);}
position=mix(${n}Frame(k,0),${n}Frame(k+1,0),fr)+t*beyond+up*uu+side*ss;`;
}
