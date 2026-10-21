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
}

// Ground-truth ambient occlusion (Jimenez, Wu, Pesce and Jarabo 2016, "Practical Real-Time Strategies for Accurate
// Indirect Occlusion"): each slice is the plane through the view vector v and a screen direction. Its two horizons
// (the highest depth sample on each side, as an angle from v) bound the visible arc, clamped to the hemisphere around
// the normal projected into the slice (angle g from v). The cosine-weighted visibility of that arc is the paper's
// closed form (its eq. 10), weighted by the projected normal's length; the slices average to the visible share of the
// cosine-weighted hemisphere, so an open plane gives exactly 1 and a 90-degree crease 0.5.
// The pattern buffer holds the 4x4 tile's slice rotation and step offset; the noise tile stays bound for SSAO's layout.
const gtaoShader =
  frame +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var gbuffer:texture_2d<f32>;
@group(0) @binding(3) var noise:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> pattern:array<vec4f>;
@group(0) @binding(5) var output:texture_storage_2d<r32float,write>;
const PI=3.14159265;
fn arc(h:f32,g:f32)->f32 {return 0.25*(cos(g)-cos(2.0*h-g)+2.0*h*sin(g));}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let p=vec2i(id.xy);let data=textureLoad(gbuffer,p,0);_=textureLoad(noise,vec2i(0),0);
  if(data.w==0||f.params.w<0.5){textureStore(output,p,vec4f(1));return;}
  let position=viewPosition(p,textureLoad(depth,p,0));let n=normalize(data.xyz);
  // Toward the eye: from the point for perspective, the constant view axis for orthographic (clip w constant).
  let v=select(vec3f(0,0,1),normalize(-position),f.projection[2][3]<-0.5);
  let a=f.projection*vec4f(position,1);let b=f.projection*vec4f(position+vec3f(f.params.x,0,0),1);
  let reach=abs(b.x/b.w-a.x/a.w)*0.5*f.size.x;
  if(reach<1.0){textureStore(output,p,vec4f(1));return;}
  let cell=pattern[(id.y%4u)*4u+id.x%4u];let slices=u32(f.params.z);let steps=u32(f.params.y);var visibility=0.0;
  for(var k=0u;k<slices;k++){
    let phi=(f32(k)+cell.x)*PI/f32(slices);let d=vec2f(cos(phi),sin(phi));
    // Screen y runs down, view y up; this direction and v span the slice for both projections.
    let direction=vec3f(d.x,-d.y,0.0);let side=normalize(direction-dot(direction,v)*v);let axis=cross(side,v);
    let projected=n-axis*dot(n,axis);let weight=length(projected);
    let g=select(-1.0,1.0,dot(projected,side)>=0.0)*acos(clamp(dot(projected,v)/max(weight,1e-6),-1.0,1.0));
    var horizon=vec2f(-1.0);
    for(var j=0u;j<steps;j++){
      let offset=d*max(1.0,reach*(f32(j)+cell.y)/f32(steps));
      for(var s=0;s<2;s++){
        let q=vec2i(floor(vec2f(p)+0.5+select(-offset,offset,s==1)));
        if(any(q<vec2i(0))||any(q>=vec2i(size))){continue;}
        let sd=textureLoad(depth,q,0);if(sd==0){continue;}
        let delta=viewPosition(q,sd)-position;let distance=length(delta);
        let cosine=mix(dot(delta,v)/max(distance,1e-6),-1.0,clamp((distance/f.params.x-0.6)*2.5,0.0,1.0));
        horizon[s]=max(horizon[s],cosine);
      }
    }
    let h0=g+max(-acos(horizon.x)-g,-0.5*PI);let h1=g+min(acos(horizon.y)-g,0.5*PI);
    visibility+=weight*(arc(h0,g)+arc(h1,g));
  }
  textureStore(output,p,vec4f(max(visibility/f32(slices),0.0)));
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
      steps = o.steps ?? 6;
    if (
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
      throw new RangeError('Invalid GTAO options: radius (0, 100], slices 1-4, steps 1-16');
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
    v[54] = v[55] = 0;
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
