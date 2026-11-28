/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { frame } from './shaders.js';
import { SSAO } from './ssao.js';
import { PostStack } from './stack.js';

/** Options of {@link GTAO}. Every value may change per frame (`gtao.options.slices = 1`). */
export interface GTAOOptions {
  /** Occlusion radius in scene units (0-100]; occluders fade out from 60% of it. Default 0.5. */
  radius?: number;
  /** Slice directions per pixel, 1-4. The 4x4 pixel tile rotates them, so the blur averages 16 times as many. Default 2. */
  slices?: number;
  /** Depth samples per side of each slice, 1-16. Default 6. */
  steps?: number;
  /** False skips the effect (the scene passes through). Default true; also `gtao.enabled`. */
  enabled?: boolean;
  /**
   * Sky occlusion reach in scene units, 0 or (0, 1000]: above 0 the occlusion is also multiplied by the share of the
   * sky (the directions above the world horizon, cosine weighted) each surface still sees within this distance, so the
   * sky light darkens in streets, valleys, under eaves and between buildings, at a larger scale than `radius`. An open
   * surface of any tilt reads 1. Default 0: off, the output is the plain GTAO.
   */
  skyRadius?: number;
  /** Depth samples per side of each slice for the sky search, 1-32, spaced more densely near the pixel. Default 16. */
  skySteps?: number;
}

// Ground-truth ambient occlusion (Jimenez, Wu, Pesce and Jarabo 2016, "Practical Real-Time Strategies for Accurate
// Indirect Occlusion"): each slice is the plane through the view vector v and a screen direction. Its two horizons
// (the highest depth sample on each side, as an angle from v) bound the visible arc, clamped to the hemisphere around
// the normal projected into the slice (angle g from v). The cosine-weighted visibility of that arc is the paper's
// closed form (its eq. 10), weighted by the projected normal's length; the slices average to the visible share of the
// cosine-weighted hemisphere, so an open plane gives exactly 1 and a 90-degree crease 0.5.
// The pattern buffer holds the 4x4 tile's slice rotation and step offset; the noise tile stays bound for SSAO's layout.
//
// Sky occlusion (`skyRadius`, frame size.zw = reach and steps, 0 when off): the same slices search their horizons
// again out to the sky reach, samples spaced by the square of their index so the near rim of a street or slot is not
// stepped over, and the visible arc is clamped to both the normal's hemisphere and the sky's (the half of the slice
// above the world horizon, angle u of world up projected into it). The result is the visible share of that sky arc,
// cosine weighted with the same closed form, summed over the slices and divided by the unoccluded sky arc: an open
// plane of any tilt reads 1, and the floor of a long slot of width w and depth h its view factor to the opening,
// sin(atan(w / 2h)) (Hottel's crossed strings). Horizon-based visibility: Bavoil, Sainz and Dimitrov 2008; slices and
// the arc integral: Jimenez et al. 2016; visibility restricted to a directional cone of the hemisphere: Klehm et al.
// 2011 (bent cones); horizon angles over a height field as sky visibility: Max 1988, Timonen and Westerholm 2010.
// `skyArc(h, g)` is the arc integral from the view vector (0) to h, signed: the visible arc [a, b] is skyArc(b) - skyArc(a).
// Samples off the slice (KB-GTAO-OPENFLOOR1): a sample's pixel is rounded to the nearest pixel centre, up to half a pixel
// off the slice's line, so 1 to 3 pixels out its screen direction turns by up to 45 degrees. The horizon of a tilted
// surface depends on that direction, so an open floor's own samples rose above its tangent in the slice and read as cover
// (0.980 on a floor seen 53 degrees off its normal, the same in float64 on the CPU: rounding, not depth precision).
// Each sample is therefore slid back into the slice along the surface's tangent plane (`slide`, the part of the slice
// axis perpendicular to n, scaled to cross the slice in one step): its height above the tangent plane, which is what
// occludes, is kept and only its azimuth is moved onto the slice, so an open plane of any tilt reads exactly 1 and a
// sample already in the slice is unchanged. The falloff keeps the sample's true distance. Projecting straight along the
// slice axis instead changes the height by (n.axis)(axis.delta) and does not help.
// The horizons are searched over the occluder depth (binding 7), the scene's depth; the pixel's own point and normal
// come from the centre depth (binding 1), which under covered blades is the surface beneath them (KB-SCATTER-AOFRINGE1,
// see shaders.ts). The two are the same texture in every other frame.
// In the shader, v points toward the eye: from the point for perspective, the constant view axis for orthographic
// (clip w constant). Screen y runs down and view y up; the slice direction and v span the slice for both
// projections.
const gtaoShader =
  frame +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var gbuffer:texture_2d<f32>;
@group(0) @binding(3) var noise:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> pattern:array<vec4f>;
@group(0) @binding(5) var output:texture_storage_2d<r32float,write>;
@group(0) @binding(6) var viewDepth:texture_2d<f32>;
@group(0) @binding(7) var occluderDepth:texture_depth_2d;
@group(0) @binding(8) var occluders:texture_2d<f32>;
const PI=3.14159265;
fn arc(h:f32,g:f32)->f32 {return 0.25*(cos(g)-cos(2.0*h-g)+2.0*h*sin(g));}
fn skyArc(h:f32,g:f32)->f32 {return sign(h)*arc(h,g);}
fn sky(p:vec2i,position:vec3f,n:vec3f,v:vec3f,cell:vec4f,slices:u32,size:vec2u)->f32 {
  if(f.size.z<=0.0){return 1.0;}
  let a=f.projection*vec4f(position,1);let b=f.projection*vec4f(position+vec3f(f.size.z,0,0),1);
  let reach=abs(b.x/b.w-a.x/a.w)*0.5*f.size.x;if(reach<1.0){return 1.0;}
  let up=normalize((f.view*vec4f(0,1,0,0)).xyz);let steps=u32(f.size.w);var seen=0.0;var open=0.0;
  for(var k=0u;k<slices;k++){
    let phi=(f32(k)+cell.x)*PI/f32(slices);let d=vec2f(cos(phi),sin(phi));
    let direction=vec3f(d.x,-d.y,0.0);let side=normalize(direction-dot(direction,v)*v);let axis=cross(side,v);
    let projected=n-axis*dot(n,axis);let weight=length(projected);
    let g=select(-1.0,1.0,dot(projected,side)>=0.0)*acos(clamp(dot(projected,v)/max(weight,1e-6),-1.0,1.0));
    let lifted=up-axis*dot(up,axis);let lift=length(lifted);let w=axis-n*dot(n,axis);let slide=w/max(dot(axis,w),1e-6);
    let u=select(g,select(-1.0,1.0,dot(lifted,side)>=0.0)*acos(clamp(dot(lifted,v)/max(lift,1e-6),-1.0,1.0)),lift>1e-4);
    let a0=max(g,u)-0.5*PI;let b0=min(g,u)+0.5*PI;if(b0<=a0){continue;}
    var horizon=vec2f(-1.0);
    for(var j=0u;j<steps;j++){
      let t=(f32(j)+cell.y)/f32(steps);let offset=d*max(1.0,reach*t*t);
      for(var s=0;s<2;s++){
        let q=vec2i(floor(vec2f(p)+0.5+select(-offset,offset,s==1)));
        if(any(q<vec2i(0))||any(q>=vec2i(size))){continue;}
        let sd=textureLoad(occluderDepth,q,0);if(sd==0){continue;}
        let full=viewPosition(q,sd)-position;let distance=length(full);let delta=full-slide*dot(full,axis);
        let cosine=mix(dot(delta,v)/max(length(delta),1e-6),-1.0,clamp((distance/f.size.z-0.6)*2.5,0.0,1.0));
        horizon[s]=max(horizon[s],cosine);
      }
    }
    let lo=max(-acos(horizon.x),a0);let hi=min(acos(horizon.y),b0);
    open+=weight*(skyArc(b0,g)-skyArc(a0,g));seen+=weight*max(skyArc(hi,g)-skyArc(lo,g),0.0);
  }
  if(open<1e-5){return 1.0;}
  return clamp(seen/open,0.0,1.0);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let p=vec2i(id.xy);let data=textureLoad(gbuffer,p,0);_=textureLoad(noise,vec2i(0),0);_=textureLoad(occluders,vec2i(0),0);
  if(textureLoad(viewDepth,p,0).r==0||f.params.w<0.5){textureStore(output,p,vec4f(1));return;}
  let position=viewPosition(p,textureLoad(depth,p,0));let n=normalize(data.xyz);
  let v=select(vec3f(0,0,1),normalize(-position),f.projection[2][3]<-0.5);
  let a=f.projection*vec4f(position,1);let b=f.projection*vec4f(position+vec3f(f.params.x,0,0),1);
  let reach=abs(b.x/b.w-a.x/a.w)*0.5*f.size.x;
  let cell=pattern[(id.y%4u)*4u+id.x%4u];let slices=u32(f.params.z);
  if(reach<1.0){textureStore(output,p,vec4f(sky(p,position,n,v,cell,slices,size)));return;}
  let steps=u32(f.params.y);var visibility=0.0;
  for(var k=0u;k<slices;k++){
    let phi=(f32(k)+cell.x)*PI/f32(slices);let d=vec2f(cos(phi),sin(phi));
    let direction=vec3f(d.x,-d.y,0.0);let side=normalize(direction-dot(direction,v)*v);let axis=cross(side,v);
    let projected=n-axis*dot(n,axis);let weight=length(projected);
    let g=select(-1.0,1.0,dot(projected,side)>=0.0)*acos(clamp(dot(projected,v)/max(weight,1e-6),-1.0,1.0));
    let w=axis-n*dot(n,axis);let slide=w/max(dot(axis,w),1e-6);
    var horizon=vec2f(-1.0);
    for(var j=0u;j<steps;j++){
      let offset=d*max(1.0,reach*(f32(j)+cell.y)/f32(steps));
      for(var s=0;s<2;s++){
        let q=vec2i(floor(vec2f(p)+0.5+select(-offset,offset,s==1)));
        if(any(q<vec2i(0))||any(q>=vec2i(size))){continue;}
        let sd=textureLoad(occluderDepth,q,0);if(sd==0){continue;}
        let full=viewPosition(q,sd)-position;let distance=length(full);let delta=full-slide*dot(full,axis);
        let cosine=mix(dot(delta,v)/max(length(delta),1e-6),-1.0,clamp((distance/f.params.x-0.6)*2.5,0.0,1.0));
        horizon[s]=max(horizon[s],cosine);
      }
    }
    let h0=g+max(-acos(horizon.x)-g,-0.5*PI);let h1=g+min(acos(horizon.y)-g,0.5*PI);
    visibility+=weight*(arc(h0,g)+arc(h1,g));
  }
  textureStore(output,p,vec4f(max(visibility/f32(slices),0.0)*sky(p,position,n,v,cell,slices,size)));
}
`;
// Per pixel of the 4x4 tile: slice rotation and step offset, both 4x4 Bayer orders (shifted against each other), so
// the 9-tap blur sees every rotation and offset.
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function tile(): Float32Array {
  const values = new Float32Array(128);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      values.set(
        [(bayer[y * 4 + x] + 0.5) / 16, (bayer[((y + 2) % 4) * 4 + ((x + 1) % 4)] + 0.5) / 16],
        (y * 4 + x) * 4,
      );
  return values;
}

/**
 * Ground-truth ambient occlusion (GTAO, Jimenez et al. 2016) in a {@link PostStack}: a horizon search over the depth
 * buffer per slice with the paper's closed-form cosine-weighted visibility, in place of SSAO's sample kernel. Everything
 * else is SSAO's: the normal G-buffer (with `add(source)` material normals), the bilateral blur, the ambient replay and
 * the composite that darkens only the ambient (and IBL) light. HDR stage; perspective and orthographic cameras.
 */
export class GTAO extends SSAO {
  override readonly name: string = 'gtao';
  protected static override readonly presetKey: string = 'gtao';
  protected override readonly label: string = 'GTAO';
  declare readonly options: GTAOOptions;
  private stack?: PostStack;
  constructor(options: GTAOOptions = {}) {
    super(options);
  }
  /** Alone, GTAO runs in its own one-effect PostStack (tone mapped like SSAO alone); to combine it, put it in your PostStack. */
  static override attach(engine: EngineKernel, options: GTAOOptions = {}): GTAO {
    const effect = new GTAO(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  protected override validate(): void {
    const o = this.options,
      r = o.radius ?? 0.5,
      slices = o.slices ?? 2,
      steps = o.steps ?? 6,
      skyRadius = o.skyRadius ?? 0,
      skySteps = o.skySteps ?? 16;
    if (
      typeof skyRadius !== 'number' ||
      !(skyRadius >= 0 && skyRadius <= 1000) ||
      !Number.isInteger(skySteps) ||
      skySteps < 1 ||
      skySteps > 32 ||
      !(r > 0 && r <= 100) ||
      !Number.isFinite(Math.fround(r)) ||
      !Number.isInteger(slices) ||
      slices < 1 ||
      slices > 4 ||
      !Number.isInteger(steps) ||
      steps < 1 ||
      steps > 16 ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new RangeError(
        'Invalid GTAO options; radius must be in (0, 100], slices an integer 1-4, steps an integer 1-16, skyRadius 0 to 1000, skySteps an integer 1-32.',
      );
  }
  protected override occlusionShader(): string {
    return gtaoShader;
  }
  protected override kernel(): Float32Array {
    return tile();
  }
  protected override pack(v: Float32Array): void {
    v[48] = this.options.radius ?? 0.5;
    v[49] = this.options.steps ?? 6;
    v[50] = this.options.slices ?? 2;
    // Sky occlusion in size.zw; both 0 when off, so the uniform is the plain GTAO's.
    const sky = this.options.skyRadius ?? 0;
    v[54] = sky;
    v[55] = sky > 0 ? (this.options.skySteps ?? 16) : 0;
  }
  override setup(engine: Engine): void {
    if (!this.stacked)
      throw margoError(
        'state',
        'GTAO runs in a PostStack: use GTAO.attach(engine) or PostStack.attach(engine, [new GTAO(), ...])',
      );
    super.setup(engine);
  }
  override dispose(): void {
    const stack = this.stack;
    this.stack = undefined;
    super.dispose();
    stack?.dispose();
  }
}
