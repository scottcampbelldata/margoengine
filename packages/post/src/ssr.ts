/// <reference lib="esnext.disposable" preserve="true" />
import type { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { render, compute, group as bind } from '../../shared/gpu.js';
import { preset } from '../../shared/preset.js';
import { margoError } from '../../shared/errors.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { PostStack } from './stack.js';
import { displayShader } from '../../shared/display.js';
import { vertex, reduceShader, downsampleShader, traceFunctions, march } from './hiz.js';
import { captureModel, drawCapture } from '../../shared/capture.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { MaterialClear, partialMaterialView } from './material-clear.js';
import { currentFrame, retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
type PostPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** SSR settings, read every frame from `ssr.options`; out of range throws RangeError. */
export interface SSROptions {
  /** Surfaces rougher than this (perceptual, 0..1) get no screen-space reflection; fades out from half of it. Default 0.6. */
  maxRoughness?: number;
  /** Scene units a ray may pass behind the depth buffer and still count as a hit. Default 0.5. */
  thickness?: number;
  /** Longest reflection ray in scene units; hits fade out over the last 20%. Default 100. */
  maxDistance?: number;
  /** Hierarchical-depth march iterations per pixel (1-256). Default 64. */
  steps?: number;
  /** False skips the reflection passes. Default true; also `ssr.enabled`. */
  enabled?: boolean;
  /** Rough reflections: surfaces rougher than half of `maxRoughness`, where the mirror ray fades out, trace one ray per
   * pixel per frame along a sampled GGX microfacet normal, averaged over frames by a reprojected history with a
   * neighbourhood clamp, instead of keeping only the environment. Default false (deterministic frames). */
  stochastic?: boolean;
}
/** The capture hook SSR gives models (gltf-pro's `PBRCapture`, terrain's `TerrainCapture`, water's `WaterCapture`;
 * declared here so post imports none of them). For code with gltf-pro's PBR `Surface`, `declarations` holds
 * `margoCapture(s, v, k)`; for any other code only `struct MargoSSR` and `margoSSR(n, v, base, metal, rough)`: return
 * that, or `MargoSSR(vec4f(specularToReplace, roughness), vec4f(weight, 1), vec4f(n * 0.5 + 0.5, 1))` directly. */
export interface SSRCapture {
  declarations(code: string): string;
  readonly targets: readonly GPUColorTargetState[];
  begin(): GPURenderPassEncoder;
}
/** What `ssr.add` takes: a gltf-pro `PBRModel`, a `@margoengine/materials` mesh, a `Terrain` (@margoengine/terrain) or
 * a `Water` (@margoengine/water). */
export interface SSRModel {
  setCapture(hook: SSRCapture): () => void;
  onDispose(callback: () => void): () => void;
  draw(context: PostPassContext, mode: 'capture', color: GPUTextureView, depth: GPUTextureView): void;
}

// Material replay outputs: environment specular already in the scene (rgb) + roughness, split-sum weight F0*A+B (rgb) +
// coverage, world normal. With `margoAmbient` from EnvironmentLighting the weight and specular come from its own LUT and
// prefiltered cube, so the composite removes exactly the IBL specular it replaces; without IBL nothing is removed and
// the weight is Karis' analytic split-sum fit (B. Karis, "Physically Based Shading on Mobile", Unreal Engine blog 2014,
// a published engine standard after Lazarov 2013; F0 0.04 from glTF 2.0 Appendix B). With LightProbes (`probeSpecular`, @margoengine/environment/probes) the
// specular removed is the probes' own at the pixel's world position (`margoPosition`, set by the replay and by gltf-pro's
// capture), so reflection probes are what SSR falls back to off screen.
const replayTail = (code: string) => {
  const ibl = lit(code),
    probes = code.includes('fn probeSpecular(');
  return `
${probes ? 'var<private> margoPosition:vec3f;\n' : ''}struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}
fn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {return margoSSRFresnel(n,v,base,metal,rough,vec3f(0.04),1.0);}
fn margoSSRFresnel(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32,dielectricF0:vec3f,dielectricF90:f32)->MargoSSR {
let nv=clamp(dot(n,v),1e-4,1.0);let f0=mix(dielectricF0,base,metal);let f90=mix(dielectricF90,1.0,metal);
${ibl ? 'let ab=iblBrdfTerms(nv,rough);let w=f0*ab.x+f90*ab.y;' : 'let r=rough*vec4f(-1,-0.0275,-0.572,0.022)+vec4f(1,0.0425,1.04,-0.04);let k=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;let w=f0*(r.z-1.04*k)+f90*(r.w+1.04*k);'}${
  probes
    ? 'let e=probeSpecular(margoPosition,n,v,rough)*w;'
    : ibl
      ? 'let e=iblPrefiltered(iblSpecular,iblSampler,iblParams,reflect(-v,n),rough)*w*iblParams.w;'
      : 'let e=vec3f(0);'
}
return MargoSSR(vec4f(e,rough),vec4f(w,1),vec4f(n*0.5+0.5,1));
}`;
};
// gltf-pro capture: the same targets from the model's Surface. Its environment ambient is iblShade(...)*s.occlusion, and
// clearcoat/sheen scale it by k, so the specular to replace and the weight it is replaced with carry both factors.
// Shaders without gltf-pro's PBR Surface (terrain, water) get margoSSR and the MargoSSR targets only, and return them.
const pbrSurface = /struct Surface\s*\{\s*base:vec4f/;
const modelTail = (code: string) =>
  replayTail(code) +
  (pbrSurface.test(code)
    ? `
struct MargoCapture {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}
fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {let m=margoSSRFresnel(s.n,v,s.base.rgb,s.metal,s.roughness,${code.includes(' f0:vec3f') ? 's.f0' : 'vec3f(0.04)'},${code.includes(' sw:f32') ? 's.sw' : '1.0'});let o=k*s.occlusion;return MargoCapture(vec4f(m.specular.rgb*o,m.specular.a),vec4f(m.weight.rgb*o,1),m.normal);}
`
    : '');
const lit = (code: string) => code.includes('let margoAmbient=') && code.includes('fn iblBrdfTerms(');
// One ray per pixel along the mirror direction, marched over the Hi-Z pyramid in screen space (pixel x, y and NDC depth
// are linear along a projected segment for perspective and orthographic cameras alike). Roughness widens the cone:
// the hit colour comes from a blurred mip of the scene. Deterministic, so frames are stable without TAA.
const compositeShader =
  vertex +
  `
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var blurred:texture_2d<f32>;
@group(0) @binding(3) var bilinear:sampler;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var hiz:texture_2d<f32>;
@group(0) @binding(6) var specular:texture_2d<f32>;
@group(0) @binding(7) var weight:texture_2d<f32>;
@group(0) @binding(8) var normals:texture_2d<f32>;
${traceFunctions}${displayShader}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let s=textureLoad(scene,q,0);var c=s.rgb;
let m=textureLoad(weight,q,0);let e=textureLoad(specular,q,0);let rough=e.a;let d=textureLoad(depth,q,0);
if(u.b.w>0.5&&m.a>0.5&&rough<=u.a.z&&d>0.0){
let px=vec2f(q)+0.5;let p=world(px,d);let v=normalize(world(px,1.0)-p);
let n=normalize(textureLoad(normals,q,0).xyz*2.0-1.0);let r=reflect(-v,n);let toward=dot(r,v);
if(toward<0.5){
${march}if(hit){
let h=o+dir*t;let hq=vec2i(h.xy);let hp=world(vec2f(hq)+0.5,textureLoad(depth,hq,0));let hn=textureLoad(normals,hq,0).xyz*2.0-1.0;
// Fades: rays toward the camera, back faces, roughness, screen edges, distance.
let f=(1.0-smoothstep(0.0,0.5,toward))*(1.0-smoothstep(0.0,0.3,dot(hn,r)))*(1.0-smoothstep(u.a.z*0.5,u.a.z,rough))
*clamp(min(min(h.x,u.a.x-h.x),min(h.y,u.a.y-h.y))/(0.08*min(u.a.x,u.a.y)),0.0,1.0)*(1.0-smoothstep(0.8*u.b.x,u.b.x,distance(p,hp)));
let lod=log2(max(t*len*rough*rough*2.0,1.0));var reflected=textureLoad(scene,hq,0).rgb;
if(lod>0.0){reflected=mix(reflected,textureSampleLevel(blurred,bilinear,h.xy/u.a.xy,min(lod-1.0,f32(textureNumLevels(blurred)-1))).rgb,min(lod,1.0));}
c=max(vec3f(0),c+f*(m.rgb*reflected-e.rgb));
}}}}
return vec4f(toDisplay(c),s.a);
}`;
const linearComposite = compositeShader.replace('return vec4f(toDisplay(c),s.a);', 'return vec4f(c,s.a);');
// The display transform must be gone, or an HDR stage would hand the next effect display-encoded colour.
if (linearComposite.includes('vec4f(toDisplay(c)'))
  throw margoError('failed', 'SSR: the HDR composite still encodes for display; update its linear-output patch');
// With models added, never remove more IBL specular than the pixel holds: at 4x a silhouette pixel is the resolve of both
// sides while its material is the centre sample's, so removal and replacement are scaled by the share the pixel can hold
// (1 wherever scene and material agree, so exact there). Without models the composite is unchanged.
const guarded = (code: string) =>
  code.replace(
    'c=max(vec3f(0),c+f*(m.rgb*reflected-e.rgb));',
    'let q=select(vec3f(1),c/e.rgb,e.rgb>vec3f(1e-6));c=max(vec3f(0),c+f*min(1.0,min(q.x,min(q.y,q.z)))*(m.rgb*reflected-e.rgb));',
  );
// Stochastic rough reflections. Trace: on pixels rougher than half of maxRoughness, one ray per pixel per frame along a
// GGX microfacet normal sampled from the distribution of visible normals (E. Heitz, "Sampling the GGX Distribution of
// Visible Normals", JCGT 7(4), 2018) in an orthonormal basis around the normal (T. Duff et al., "Building an
// Orthonormal Basis, Revisited", JCGT 6(1), 2017), random numbers from the pixel and frame by pcg3d (M. Jarzynski and
// M. Olano, "Hash Functions for GPU Rendering", JCGT 9(3), 2020). Output: hit radiance times the mirror path's fades
// (rgb) and the fades (a), zero on a miss, so the average over frames is the share of the lobe the screen holds.
const roughTraceShader =
  vertex +
  `
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f}
struct R {previous:mat4x4f,c:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var<uniform> rr:R;
@group(0) @binding(2) var scene:texture_2d<f32>;
@group(0) @binding(3) var depth:texture_depth_2d;
@group(0) @binding(4) var hiz:texture_2d<f32>;
@group(0) @binding(5) var specular:texture_2d<f32>;
@group(0) @binding(6) var weight:texture_2d<f32>;
@group(0) @binding(7) var normals:texture_2d<f32>;
${traceFunctions}
fn pcg3d(seed:vec3u)->vec3u {var v=seed*1664525u+1013904223u;v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);
v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;return v;}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let e=textureLoad(specular,q,0);let rough=e.a;let m=textureLoad(weight,q,0);let d=textureLoad(depth,q,0);
var out=vec4f(0);
if(m.a>0.5&&rough>u.a.z*0.5&&d>0.0){
let px=vec2f(q)+0.5;let p=world(px,d);let v=normalize(world(px,1.0)-p);
let n=normalize(textureLoad(normals,q,0).xyz*2.0-1.0);
let sg=select(-1.0,1.0,n.z>=0.0);let ba=-1.0/(sg+n.z);let bb=n.x*n.y*ba;
let t1=vec3f(1.0+sg*n.x*n.x*ba,sg*bb,-sg*n.x);let b1=vec3f(bb,sg+n.y*n.y*ba,-n.y);
let a=max(rough*rough,0.002);let ve=vec3f(dot(v,t1),dot(v,b1),max(dot(v,n),1e-4));
let vh=normalize(vec3f(a*ve.x,a*ve.y,ve.z));let l2=dot(vh.xy,vh.xy);
let ta=select(vec3f(1,0,0),vec3f(-vh.y,vh.x,0)/sqrt(l2),l2>0.0);let tb=cross(vh,ta);
let xi=vec2f(pcg3d(vec3u(vec2u(q),u32(rr.c.x))).xy)*(1.0/4294967296.0);
let radius=sqrt(xi.x);let phi=6.2831853*xi.y;let blend=0.5*(1.0+vh.z);
let p1=radius*cos(phi);let p2=mix(sqrt(max(0.0,1.0-p1*p1)),radius*sin(phi),blend);
let nh=p1*ta+p2*tb+sqrt(max(0.0,1.0-p1*p1-p2*p2))*vh;let ne=normalize(vec3f(a*nh.x,a*nh.y,max(nh.z,0.0)));
let r=reflect(-v,t1*ne.x+b1*ne.y+n*ne.z);let toward=dot(r,v);
if(dot(r,n)>0.0&&toward<0.5){
${march}if(hit){
let h=o+dir*t;let hq=vec2i(h.xy);let hp=world(vec2f(hq)+0.5,textureLoad(depth,hq,0));let hn=textureLoad(normals,hq,0).xyz*2.0-1.0;
let f=(1.0-smoothstep(0.0,0.5,toward))*(1.0-smoothstep(0.0,0.3,dot(hn,r)))
*clamp(min(min(h.x,u.a.x-h.x),min(h.y,u.a.y-h.y))/(0.08*min(u.a.x,u.a.y)),0.0,1.0)*(1.0-smoothstep(0.8*u.b.x,u.b.x,distance(p,hp)));
out=vec4f(f*textureLoad(scene,hq,0).rgb,f);
}}}}
return out;
}`;
// Resolve: the history reprojected through last frame's camera (the surface's own motion), clamped to the mean plus or
// minus one standard deviation of this frame's 3x3 neighbourhood (variance clipping, M. Salvi, "An Excursion in
// Temporal Supersampling", GDC 2016), blended with this frame's sample by max(1 / (frames + 1), 1 / 16).
const roughResolveShader =
  vertex +
  `
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f}
struct R {previous:mat4x4f,c:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var<uniform> rr:R;
@group(0) @binding(2) var noisy:texture_2d<f32>;
@group(0) @binding(3) var history:texture_2d<f32>;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var bilinear:sampler;
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let size=vec2i(u.a.xy);let now=textureLoad(noisy,q,0);var m1=vec4f(0);var m2=vec4f(0);
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let k=textureLoad(noisy,clamp(q+vec2i(x,y),vec2i(0),size-1),0);m1+=k;m2+=k*k;}}
m1/=9.0;m2/=9.0;let sigma=sqrt(max(m2-m1*m1,vec4f(0)));
let d=textureLoad(depth,q,0);let px=vec2f(q)+0.5;
let w=u.inverse*vec4f(px.x/u.a.x*2.0-1.0,1.0-px.y/u.a.y*2.0,d,1.0);let c=rr.previous*vec4f(w.xyz/w.w,1.0);
let uv=vec2f(c.x/c.w*0.5+0.5,0.5-c.y/c.w*0.5);
let old=clamp(textureSampleLevel(history,bilinear,uv,0.0),m1-sigma,m1+sigma);
if(rr.c.z<0.5||d<=0.0||c.w<=0.0||any(uv<vec2f(0))||any(uv>vec2f(1))){return now;}
return mix(old,now,rr.c.y);
}`;
// The composite adds the resolved rough reflections where the mirror path fades out by roughness, so the two meet:
// c + s (weight x radiance - share x IBL specular), s = smoothstep(maxRoughness / 2, maxRoughness, roughness).
const roughComposite = (code: string, models: boolean) =>
  code
    .replace(
      '@group(0) @binding(8) var normals:texture_2d<f32>;',
      '@group(0) @binding(8) var normals:texture_2d<f32>;\n@group(0) @binding(9) var roughs:texture_2d<f32>;',
    )
    .replace(
      /\nreturn vec4f\((toDisplay\(c\)|c),s\.a\);/,
      `
if(u.b.w>0.5&&m.a>0.5&&rough>u.a.z*0.5&&d>0.0){let g=textureLoad(roughs,q,0);let ws=smoothstep(u.a.z*0.5,u.a.z,rough);${
        models
          ? 'let k=select(vec3f(1),c/e.rgb,e.rgb>vec3f(1e-6));c=max(vec3f(0),c+ws*min(1.0,min(k.x,min(k.y,k.z)))*(m.rgb*g.rgb-g.a*e.rgb));'
          : 'c=max(vec3f(0),c+ws*(m.rgb*g.rgb-g.a*e.rgb));'
      }}
return vec4f($1,s.a);`,
    );
const formats: GPUTextureFormat[] = ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm'],
  blurLevels = 5,
  targets = formats.map((format) => ({ format }));

/** Screen-space reflections in a PostStack (HDR effect): a material replay of core meshes and of models added with
 * `add(model)` (roughness, split-sum weight, normal, and the IBL specular to replace), a Hi-Z ray march per pixel, and a
 * composite that swaps the environment specular for the reflected scene where a ray hits; misses keep the IBL.
 * @throws RangeError when an option is out of range; TypeError when `enabled` is not a boolean.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced core's lighting shader,
 * `'disposed'` after `dispose()`, `'attached'` when attached twice, `'state'` outside a PostStack or when the camera
 * matrix is not invertible. */
export class SSR implements EnginePlugin {
  readonly name = 'ssr';
  private engine?: Engine;
  /** Device of the current GPU resources, so a release after device restoration retires them on their own device. */
  private device?: GPUDevice;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private reduceDepth?: GPUComputePipeline;
  private reduce?: GPUComputePipeline;
  private downsample?: GPURenderPipeline;
  private textures: GPUTexture[] = [];
  private width = 0;
  private height = 0;
  private target?: SceneTarget;
  private owned = false;
  private depthView?: GPUTextureView;
  private ownDepth?: GPUTextureView;
  private base?: GPURenderPipelineDescriptor;
  private single?: GPURenderPipelineDescriptor;
  private hiz?: GPUTextureView;
  private hizGroups: GPUBindGroup[] = [];
  private hizSizes: number[][] = [];
  private material: GPUTextureView[] = [];
  private blur?: GPUTextureView;
  private blurViews: GPUTextureView[] = [];
  private blurGroups: GPUBindGroup[] = [];
  private replay?: GPURenderPipeline;
  private replayKey?: string;
  private composite?: GPURenderPipeline;
  /** Composite group per uniform binding: a second view of a frame binds its own uniform slice. */
  private compositeGroups?: { get(copy?: GPUBufferBinding): GPUBindGroup };
  private slice?: GPUBufferBinding;
  private input?: GPUTextureView;
  private key = '';
  private clearPass?: GPURenderPassDescriptor;
  private materialClear?: MaterialClear;
  private extra: GPURenderPassColorAttachment[] = [];
  private blurPasses: GPURenderPassDescriptor[] = [];
  private readonly compositeAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly compositePass: GPURenderPassDescriptor = { colorAttachments: [this.compositeAttachment] };
  private readonly models = new Map<SSRModel, () => void>();
  private readonly modelCode = new Map<string, string>();
  private context?: PostPassContext;
  private pass?: GPURenderPassEncoder;
  // gltf-pro capture hook: model materials into the same three targets, after the core replay.
  private readonly hook: SSRCapture = {
    targets,
    declarations: (code) => {
      let out = this.modelCode.get(code);
      if (out === undefined) {
        if (this.modelCode.size >= 64) this.modelCode.clear();
        this.modelCode.set(code, (out = modelTail(code)));
      }
      return out;
    },
    begin: () => {
      if (this.pass) return this.pass;
      const c = this.context!,
        stencil = c.descriptor.depthStencil!.format.includes('stencil')
          ? ({ stencilLoadOp: 'load', stencilStoreOp: 'store' } as const)
          : {};
      const pass = (this.pass = c.encoder.beginRenderPass({
        colorAttachments: this.material.map((view) => ({ view, loadOp: 'load', storeOp: 'store' })),
        depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', ...stencil },
      }));
      applyView(pass, c);
      return pass;
    },
  };
  private readonly values = new Float32Array(40);
  // Stochastic rough reflections: trace and resolve pipelines, their uniform (last frame's camera, seed, blend, history
  // valid), the noisy, resolved and history textures, and how many frames the history holds.
  private roughTrace?: GPURenderPipeline;
  private roughResolve?: GPURenderPipeline;
  private roughUniform?: GPUBuffer;
  private roughTraceGroups?: { get(copy?: GPUBufferBinding): GPUBindGroup };
  private roughResolveGroups?: { get(copy?: GPUBufferBinding): GPUBindGroup };
  private roughViews: GPUTextureView[] = [];
  private roughTextures: GPUTexture[] = [];
  private roughPasses: GPURenderPassDescriptor[] = [];
  private roughFrames = 0;
  private roughSeed = 0;
  private stochastic = false;
  private readonly previous = new Float32Array(16);
  private readonly roughValues = new Float32Array(20);
  private readonly workspace = new Float64Array(52);
  private readonly inverse = this.values.subarray(0, 16);
  constructor(readonly options: SSROptions = {}) {
    this.options = preset('ssr', options);
    this.validate();
  }
  /** Alone, SSR runs in its own one-effect PostStack (tone mapped like SSAO alone); to combine it, put it in your PostStack. */
  static attach(engine: EngineKernel, options: SSROptions = {}): SSR {
    const effect = new SSR(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Makes a gltf-pro model or materials mesh reflect: its own materials (maps, alpha mask, instances, skinning) are drawn
   * into SSR's material targets. Returns a remover; models not added are still reflected but do not reflect. */
  add(model: SSRModel): () => void {
    if (this.disposed) throw margoError('disposed', 'SSR is disposed; create a new SSR');
    return captureModel(this.models, model, this.hook);
  }
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('SSR enabled must be boolean');
    this.options.enabled = value;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', 'SSR is already attached; create a new SSR');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options,
      r = o.maxRoughness ?? 0.6,
      t = o.thickness ?? 0.5,
      d = o.maxDistance ?? 100,
      s = o.steps ?? 64;
    if (
      !(r > 0 && r <= 1) ||
      !(t > 0 && Number.isFinite(t)) ||
      !(d > 0 && Number.isFinite(Math.fround(d))) ||
      !Number.isInteger(s) ||
      s < 1 ||
      s > 256 ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean') ||
      (o.stochastic !== undefined && typeof o.stochastic !== 'boolean')
    )
      throw new RangeError(
        'Invalid SSR options; maxRoughness must be in (0, 1], thickness and maxDistance above 0, steps 1-256, stochastic a boolean.',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'SSR is disposed; create a new SSR');
    if (!this.host)
      throw margoError(
        'state',
        'SSR runs in a PostStack; use SSR.attach(engine) or PostStack.attach(engine, [..., new SSR(), ...]).',
      );
    if (!engine.gpu) throw margoError('unsupported', 'SSR requires WebGPU; use a WebGPU engine');
    this.engine = engine;
    this.device = engine.gpu;
    const device = engine.gpu;
    this.uniform = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.reduceDepth = compute(device, reduceShader('texture_depth_2d', ''));
    this.reduce = compute(device, reduceShader('texture_2d<f32>', '.r'));
    this.downsample = render(device, downsampleShader, 'rgba16float');
  }
  registerPasses(graph: FrameGraph): void {
    // After the scene and SSAO's replays (10-13), before the stack composes (30).
    graph.add({
      name: 'ssr:gbuffer',
      order: 14,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.host?.target) this.prepare(c);
      },
    });
  }
  private prepare(c: PostPassContext): void {
    this.validate();
    this.resize(c);
    const v = this.values,
      o = this.options,
      own = this.ownDepth;
    if (!invertMatrixStable(c.camera.matrix, this.inverse, this.workspace))
      throw margoError('state', 'Invalid SSR camera; give the camera a finite, invertible projection');
    v.set(c.camera.matrix, 16);
    v[32] = c.width;
    v[33] = c.height;
    v[34] = o.maxRoughness ?? 0.6;
    v[35] = o.thickness ?? 0.5;
    v[36] = o.maxDistance ?? 100;
    v[37] = o.steps ?? 64;
    v[38] = this.hizGroups.length;
    v[39] = +this.enabled;
    this.slice = writeUniform(c.device, this.uniform!, v as Float32Array<ArrayBuffer>, c.view ?? c);
    if (!this.enabled) return;
    // Material replay of core's lit shader with its lighting in a dead block (every binding stays statically used, so the
    // pass bindings fit the auto layout, but none of the light is computed), from its shading normal `let n=normalize(i.normal)…` and view vector
    // `let v=normalize(frame.eye.xyz-i.position)` (tests/shader-contracts). A 1x scene is replayed depth-equal against its
    // own depth; a 4x scene at 1x into SSR's own depth (pixel-centre materials and depth, no multisampled targets).
    if (this.base !== c.descriptor) {
      this.base = c.descriptor;
      this.single = {
        ...c.descriptor,
        multisample: { count: 1 },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    }
    const key = c.shader + !!own;
    if (this.replayKey !== key) {
      const code = c.shader
        .replace(/(@fragment[^{]*)->@location\(0\) vec4f/, '$1->MargoSSR')
        .replace(
          /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/,
          c.shader.includes('fn probeSpecular(')
            ? 'if(false){$1_=$2;}margoPosition=i.position;return margoSSR(n,v,i.color,i.material.y,i.material.x);'
            : 'if(false){$1_=$2;}return margoSSR(n,v,i.color,i.material.y,i.material.x);',
        );
      if (!code.includes('->MargoSSR') || !code.includes('return margoSSR('))
        throw margoError(
          'unsupported',
          "SSR requires the standard core lighting shader; remove the plugin that replaced core's shader",
        );
      const module = c.device.createShaderModule({ code: code + replayTail(code) });
      this.replay = c.device.createRenderPipeline({
        ...this.single!,
        layout: 'auto',
        vertex: { ...c.descriptor.vertex, module },
        fragment: { module, entryPoint: 'fragment', targets: formats.map((format) => ({ format })) },
        depthStencil: own
          ? this.single!.depthStencil
          : { ...c.descriptor.depthStencil!, depthWriteEnabled: false, depthCompare: 'equal' },
      });
      this.replayKey = key;
    }
    const partial = partialMaterialView(c);
    const { color, depth, descriptor } = c;
    c.color = this.material[0];
    if (own) {
      c.depth = own;
      c.descriptor = this.single!;
    }
    try {
      if (partial) {
        const clear = (this.materialClear ??= new MaterialClear(formats, this.extra));
        clear.draw(c, !!own);
        c.draw({
          pipeline: this.replay,
          clear: false,
          clearDepth: false,
          bindings: c.bindings,
          colorAttachments: clear.extra,
        });
      } else {
        if (!own) c.encoder.beginRenderPass(this.clearPass!).end();
        c.draw({ pipeline: this.replay, clear: !!own, bindings: c.bindings, colorAttachments: this.extra });
      }
      // Added models draw their own materials on top, depth tested against (and, at 4x, into) the same depth.
      if (this.models.size) {
        this.context = c;
        for (const model of this.models.keys()) drawCapture(model, this.hook, c);
      }
    } finally {
      this.pass?.end();
      this.pass = this.context = undefined;
      Object.assign(c, { color, depth, descriptor });
    }
    // Hi-Z over the depth the materials match.
    const pass = c.encoder.beginComputePass();
    for (let i = 0; i < this.hizGroups.length; i++) {
      pass.setPipeline(i ? this.reduce! : this.reduceDepth!);
      pass.setBindGroup(0, this.hizGroups[i]);
      pass.dispatchWorkgroups(Math.ceil(this.hizSizes[i][0] / 8), Math.ceil(this.hizSizes[i][1] / 8));
    }
    pass.end();
  }
  private stage(c: PostPassContext, input: GPUTextureView, output: StageOutput): void {
    const models = this.models.size > 0,
      rough = this.stochastic,
      key = output.format + output.multisample.count + output.hdr + models + rough,
      code = output.hdr ? linearComposite : compositeShader,
      shader = models ? guarded(code) : code;
    if (this.key !== key) {
      this.key = key;
      this.composite = render(c.device, rough ? roughComposite(shader, models) : shader, output.format, {
        multisample: output.multisample,
      });
      this.input = undefined;
    }
    if (this.input !== input) {
      this.input = input;
      this.blurGroups[0] = bind(c.device, this.downsample!, [input, this.sampler!]);
      this.compositeGroups = uniformGroups(this.uniform!, (uniform) =>
        bind(c.device, this.composite!, [
          uniform,
          input,
          this.blur!,
          this.sampler!,
          this.depthView!,
          this.hiz!,
          ...this.material,
          ...(rough ? [this.roughViews[1]] : []),
        ]),
      );
      if (rough) {
        const device = c.device;
        this.roughTrace ??= render(device, roughTraceShader, 'rgba16float');
        this.roughResolve ??= render(device, roughResolveShader, 'rgba16float');
        this.roughTraceGroups = uniformGroups(this.uniform!, (uniform) =>
          bind(device, this.roughTrace!, [
            uniform,
            { buffer: this.roughUniform! },
            input,
            this.depthView!,
            this.hiz!,
            ...this.material,
          ]),
        );
        this.roughResolveGroups = uniformGroups(this.uniform!, (uniform) =>
          bind(device, this.roughResolve!, [
            uniform,
            { buffer: this.roughUniform! },
            this.roughViews[0],
            this.roughViews[2],
            this.depthView!,
            this.sampler!,
          ]),
        );
      }
    }
    if (this.enabled)
      for (let i = 0; i < blurLevels; i++) {
        const pass = c.encoder.beginRenderPass(this.blurPasses[i]);
        pass.setPipeline(this.downsample!);
        pass.setBindGroup(0, this.blurGroups[i]);
        pass.draw(3);
        pass.end();
      }
    if (this.enabled && rough) this.traceRough(c);
    this.compositeAttachment.view = output.view;
    this.compositeAttachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.compositePass);
    pass.setPipeline(this.composite!);
    pass.setBindGroup(0, this.compositeGroups!.get(this.slice));
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  /** Rough reflections for this frame: the noisy trace, the resolve against the history, then the resolve becomes the
   * next frame's history. The history restarts after a resize, a switch of `stochastic` or `enabled`. */
  private traceRough(c: PostPassContext): void {
    const r = this.roughValues;
    r.set(this.roughFrames ? this.previous : this.values.subarray(16, 32));
    r[16] = this.roughSeed = (this.roughSeed + 1) >>> 0;
    r[17] = Math.max(1 / (this.roughFrames + 1), 1 / 16);
    r[18] = +(this.roughFrames > 0);
    c.device.queue.writeBuffer(this.roughUniform!, 0, r as Float32Array<ArrayBuffer>);
    this.previous.set(this.values.subarray(16, 32));
    this.roughFrames++;
    for (const [pipeline, groups, pass] of [
      [this.roughTrace!, this.roughTraceGroups!, this.roughPasses[0]],
      [this.roughResolve!, this.roughResolveGroups!, this.roughPasses[1]],
    ] as const) {
      const encoder = c.encoder.beginRenderPass(pass);
      encoder.setPipeline(pipeline);
      encoder.setBindGroup(0, groups.get(this.slice));
      encoder.draw(3);
      encoder.end();
    }
    const size = [this.width, this.height];
    c.encoder.copyTextureToTexture({ texture: this.roughTextures[1] }, { texture: this.roughTextures[2] }, size);
  }
  private resize(c: PostPassContext): void {
    // This view draws in the frame: what it releases waits while another view's commands still need it.
    currentFrame(c.device, c.view ?? c);
    const target = this.host!.target!,
      // Own 1x depth at 4x, and at 1x once models are added: a capture writes depth, and water samples the stack's.
      own = target.samples === 4 || this.models.size > 0;
    const rough = this.enabled && (this.options.stochastic ?? false);
    if (rough !== this.stochastic) {
      // Rough reflections switched (or SSR re-enabled with them): new targets, a new composite and an empty history.
      this.stochastic = rough;
      this.width = 0;
      this.key = '';
    }
    if (this.width === c.width && this.height === c.height && this.target === target && this.owned === own) return;
    this.release();
    this.width = c.width;
    this.height = c.height;
    this.target = target;
    this.owned = own;
    const device = c.device,
      sampled = GPUTextureUsage.TEXTURE_BINDING,
      texture = (size: number[], format: GPUTextureFormat, usage: number, mipLevelCount = 1) => {
        const t = device.createTexture({ size, format, usage, mipLevelCount });
        this.textures.push(t);
        return t;
      };
    const scene = this.host!.depthTexture!,
      depth = own ? texture([c.width, c.height], 'depth32float', sampled | GPUTextureUsage.RENDER_ATTACHMENT) : scene;
    this.depthView = depth.createView({ aspect: 'depth-only' });
    if (depth !== scene) this.ownDepth = depth.createView();
    // Hi-Z levels 1..n (level 0 is the depth itself), cells up to 64 px.
    const half = [Math.max(1, c.width >> 1), Math.max(1, c.height >> 1)],
      levels = Math.max(1, Math.min(6, Math.floor(Math.log2(Math.min(c.width, c.height)))));
    const hiz = texture(half, 'r32float', sampled | GPUTextureUsage.STORAGE_BINDING, levels);
    this.hiz = hiz.createView();
    for (let i = 0; i < levels; i++) {
      this.hizSizes.push([Math.max(1, half[0] >> i), Math.max(1, half[1] >> i)]);
      this.hizGroups.push(
        bind(device, i ? this.reduce! : this.reduceDepth!, [
          i ? hiz.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }) : this.depthView,
          hiz.createView({ baseMipLevel: i, mipLevelCount: 1 }),
        ]),
      );
    }
    const attachment = sampled | GPUTextureUsage.RENDER_ATTACHMENT,
      clear = { r: 0.5, g: 0.5, b: 0.5, a: 0 };
    this.material = formats.map((format) => texture([c.width, c.height], format, attachment).createView());
    // Attachment 0 is core's draw target (cleared with the depth at 4x, else by clearPass); the other two clear themselves.
    this.clearPass = { colorAttachments: [{ view: this.material[0], loadOp: 'clear', storeOp: 'store' }] };
    this.extra = [1, 2].map((i) => ({
      view: this.material[i],
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: i === 2 ? clear : { r: 0, g: 0, b: 0, a: 0 },
    }));
    // Blurred scene for rough hits: half resolution and down, filled from the stage input each frame.
    const blur = texture(half, 'rgba16float', attachment, blurLevels);
    this.blur = blur.createView();
    for (let i = 0; i < blurLevels; i++) {
      const view = blur.createView({ baseMipLevel: i, mipLevelCount: 1 });
      this.blurViews.push(view);
      this.blurPasses.push({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      if (i) this.blurGroups[i] = bind(device, this.downsample!, [this.blurViews[i - 1], this.sampler!]);
    }
    if (this.stochastic) {
      // Noisy trace, resolved and history (rgba16float): radiance times fades, and the fades.
      this.roughUniform ??= device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.roughTextures = [attachment, attachment | GPUTextureUsage.COPY_SRC, sampled | GPUTextureUsage.COPY_DST].map(
        (usage) => texture([c.width, c.height], 'rgba16float', usage),
      );
      this.roughViews = this.roughTextures.map((t) => t.createView());
      this.roughPasses = [0, 1].map((i) => ({
        colorAttachments: [{ view: this.roughViews[i], loadOp: 'clear', storeOp: 'store' }],
      }));
      this.roughFrames = 0;
    }
  }
  private release(): void {
    for (const t of this.textures) retire(this.device!, t);
    this.textures = [];
    this.width = this.height = 0;
    this.target = undefined;
    this.input = undefined;
    this.hizGroups = [];
    this.hizSizes = [];
    this.material = [];
    this.blurViews = [];
    this.blurGroups = [];
    this.blurPasses = [];
    this.extra = [];
    this.roughTextures = [];
    this.roughViews = [];
    this.roughPasses = [];
    this.roughTraceGroups = this.roughResolveGroups = undefined;
    this.roughFrames = 0;
    this.depthView = this.ownDepth = this.hiz = this.blur = undefined;
    this.compositeGroups = undefined;
    this.clearPass = undefined;
    this.materialClear = undefined;
    this.compositeAttachment.view = undefined!;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    retire(this.device!, this.uniform);
    retire(this.device!, this.roughUniform);
    this.roughUniform = this.roughTrace = this.roughResolve = undefined;
    this.stochastic = false;
    this.replay = this.composite = undefined;
    this.replayKey = this.base = undefined;
    this.key = '';
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stack = this.stack;
    this.stack = undefined;
    for (const release of [...this.models.values()]) release();
    this.engine?.removePlugin(this.name);
    this.release();
    retire(this.device!, this.uniform);
    retire(this.device!, this.roughUniform);
    this.uniform = this.roughUniform = undefined;
    this.replay = this.composite = this.roughTrace = this.roughResolve = undefined;
    this.engine = undefined;
    stack?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
