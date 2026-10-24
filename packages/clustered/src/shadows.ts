/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Mesh,
} from '@margoengine/core/extension';
import { instanceLayout, instancedDepth } from '../../shared/instances.js';
import { displacedDepth } from '../../shared/displacement.js';
import { preset } from '../../shared/preset.js';
import type { Clustered, ClusteredShadow } from './index.js';
import { hemisphere, viewportMatrix } from './local-shadow-math.js';
import {
  AREA_FACE_TAN,
  boundsBox,
  cascadeBoxes,
  lightBasis,
  MAX_AREA_SHADOWS,
  MAX_DIRECTIONAL_SHADOWS,
  orthographicShadow,
  type AreaShadowLight,
  type DirectionalShadowLight,
} from './light-shadow-math.js';
import { MargoError } from '@margoengine/math/errors';
import { hiddenInTree } from '../../shared/visibility.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** `LocalShadows` settings, fixed at construction; invalid values throw RangeError. */
export interface LocalShadowOptions {
  /** The clustered lights whose `castShadow` lights get shadow maps. */
  lights: Clustered;
  /**
   * Shadowed point and spot lights with maps (1-16, default 4); further `castShadow` lights stay unshadowed. A point
   * light uses six layers, a spot light one (six for a pi / 2 hemisphere). Directional and area lights with
   * `castShadow` (up to four each, limited by their own lists) take layers after these: one per cascade, and five cube
   * faces per area light (six when two-sided).
   */
  maxLights?: number;
  /**
   * Square size of each layer in texels (default 512), and the largest map a castShadow light's `shadow.resolution`
   * may ask for (a smaller one draws into its layers' top-left corner). Layers are allocated for the lights in use at
   * this size: `layers × resolution² × 4` bytes (a point light takes six, so one at 2048 is 96 MiB).
   */
  resolution?: number;
  /** Receiver offset toward the light, in shadow-map texels at the receiver (default 1). */
  bias?: number;
  /** Receiver offset along its normal, in shadow-map texels at the receiver (default 1.5). */
  normalBias?: number;
}
/** A caster primitive: gltf-pro `shadowPrimitives` (80-byte vertices, optional alpha mask and `PBRInstances`). */
export interface LocalShadowPrimitive {
  primitive?: object;
  alphaTransform?: Float32Array;
  node: Mesh;
  vertex: GPUBuffer;
  index: GPUBuffer;
  count: number;
  stride: number;
  /** Index topology; omitted for triangle casters. Wireframe casters supply triangle-edge line indices. */
  topology?: 'triangle-list' | 'line-list';
  alphaTexture?: GPUTextureView;
  alphaSampler?: GPUSampler;
  alpha?: number;
  cutoff?: number;
  texCoord?: number;
  instances?: { readonly count: number; readonly needsUpdate?: boolean; upload(device: GPUDevice): GPUBuffer };
  /** Vertex displacement along the normal (materials `displacementMap`, 80-byte vertices), bound at group 2. */
  displacement?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
}
/** A caster `LocalShadows.add` takes besides a core mesh, such as a gltf-pro model or materials mesh. */
export interface LocalShadowSource {
  /** Casters drawn into each shadowed light's maps. */
  readonly shadowPrimitives: readonly LocalShadowPrimitive[];
  /** Bumped when the casters change, so cached maps re-render. */
  readonly shadowVersion?: number;
  /** True once disposed; such a source is rejected, or dropped once added. */
  readonly disposed?: boolean;
}
interface Source {
  source: LocalShadowSource | Mesh;
  dynamic: boolean;
  version?: number;
  mesh?: LocalShadowPrimitive[];
}
interface Draw {
  uniform: GPUBuffer;
  group: GPUBindGroup;
  vertex: GPUBuffer;
  index: GPUBuffer;
  alpha?: GPUTextureView;
  sampler?: GPUSampler;
  matrix: Float32Array;
  values: Float32Array;
  visible: boolean;
  count: number;
  instances: number;
  seen: boolean;
  p?: LocalShadowPrimitive;
  key: string;
  displacement?: LocalShadowPrimitive['displacement'];
  displaced?: GPUBindGroup;
}
const MAX_LIGHTS = 16,
  LAYERS = MAX_LIGHTS * 6,
  FRAME_FLOATS = 4 + MAX_LIGHTS * 4 + LAYERS * 16,
  SLOT_FLOATS = 16;
// While some directional or area light casts, the frame continues after the point and spot data: per directional light
// of the list (MAX_DIRECTIONAL_LIGHTS) and area light (MAX_AREA_LIGHTS) its first layer, slot and settings, then per
// shadowed slot its cascades' or cube faces' data and sampling matrices. Their layers follow the point and spot ones.
const SUN_LIST = 16,
  AREA_LIST = 64,
  SUN = FRAME_FLOATS,
  SUN_CASCADES = SUN + SUN_LIST * 4,
  SUN_MATRICES = SUN_CASCADES + MAX_DIRECTIONAL_SHADOWS * 4 * 4,
  AREA = SUN_MATRICES + MAX_DIRECTIONAL_SHADOWS * 4 * 16,
  AREA_SLOTS = AREA + AREA_LIST * 4,
  AREA_MATRICES = AREA_SLOTS + MAX_AREA_SHADOWS * 4,
  EXTENDED_FLOATS = AREA_MATRICES + MAX_AREA_SHADOWS * 6 * 16,
  TOTAL_LAYERS = LAYERS + MAX_DIRECTIONAL_SHADOWS * 4 + MAX_AREA_SHADOWS * 6,
  SIGNATURE = 18,
  noSuns: readonly DirectionalShadowLight[] = [],
  noAreas: readonly AreaShadowLight[] = [];
// Reversed depth (near 1, far 0) for float precision. lights[k]: first layer, point (1) or spot (0), texel size per unit distance.
// A point light picks the cube face by the major axis of the offset receiver, so faces need no seam filtering.
const sampling = (group: number, sun = false, area = false) =>
  /* wgsl */ `
struct LocalShadowFrame {settings:vec4f,lights:array<vec4f,${MAX_LIGHTS}>,matrices:array<mat4x4f,${LAYERS}>${sun || area ? extendedFrame : ''}}
@group(${group}) @binding(14) var<uniform> localShadowFrame:LocalShadowFrame;
@group(${group}) @binding(15) var localShadowMap:texture_depth_2d_array;
@group(${group}) @binding(16) var localShadowSampler:sampler_comparison;
fn clusterShadow(light:ClusterLight,position:vec3f,n:vec3f)->f32 {
  let slot=u32(light.params.z);if(slot==0u||f32(slot)>localShadowFrame.settings.x){return 1.0;}
  let info=localShadowFrame.lights[slot-1u];let delta=light.positionRange.xyz-position;let distance=length(delta);
  let texel=info.z*distance;let p=position+n*(texel*localShadowFrame.settings.z)+delta/max(distance,0.0001)*(texel*localShadowFrame.settings.y);
  var layer=u32(info.x);
  if(info.y>0.5){let d=p-light.positionRange.xyz;let a=abs(d);
    if(a.x>=a.y&&a.x>=a.z){layer+=select(1u,0u,d.x>0);}else if(a.y>=a.z){layer+=select(3u,2u,d.y>0);}else{layer+=select(5u,4u,d.z>0);}}
  let clip=localShadowFrame.matrices[layer]*vec4f(p,1);if(clip.w<=0){return 1.0;}
  let ndc=clip.xyz/clip.w;let uv=ndc.xy*vec2f(0.5,-0.5)+0.5;if(any(uv<vec2f(0))||any(uv>vec2f(1))||ndc.z<=0){return 1.0;}
  var lit=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){lit+=textureSampleCompareLevel(localShadowMap,localShadowSampler,uv+vec2f(f32(x),f32(y))*localShadowFrame.settings.w,i32(layer),ndc.z);}}
  return lit/9.0;
}
` +
  (sun ? sunShadow : '') +
  (area ? areaShadow : '');
const extendedFrame = `,sun:array<vec4f,${SUN_LIST}>,sunCascades:array<vec4f,${MAX_DIRECTIONAL_SHADOWS * 4}>,sunMatrices:array<mat4x4f,${MAX_DIRECTIONAL_SHADOWS * 4}>,area:array<vec4f,${AREA_LIST}>,areaSlots:array<vec4f,${MAX_AREA_SHADOWS}>,areaMatrices:array<mat4x4f,${MAX_AREA_SHADOWS * 6}>`;
// Directional light j: sun[j] is (first layer, slot + 1, cascades); per cascade, the world size of a texel and the UV box
// whose 3x3 filter stays inside the map. The finest cascade holding the receiver shades it; outside all of them it is lit.
const sunShadow = /* wgsl */ `fn clusterDirectionalShadow(j:u32,position:vec3f,n:vec3f,l:vec3f)->f32 {
  let info=localShadowFrame.sun[j];if(info.y<0.5){return 1.0;}
  let first=(u32(info.y)-1u)*4u;
  for(var k=0u;k<u32(info.z);k++){
    let cascade=localShadowFrame.sunCascades[first+k];
    let p=position+n*(cascade.x*localShadowFrame.settings.z)+l*(cascade.x*localShadowFrame.settings.y);
    let clip=localShadowFrame.sunMatrices[first+k]*vec4f(p,1);let uv=clip.xy*vec2f(0.5,-0.5)+0.5;
    if(any(uv<vec2f(cascade.w))||any(uv>cascade.yz)||clip.z<=0||clip.z>1){continue;}
    var lit=0.0;
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){lit+=textureSampleCompareLevel(localShadowMap,localShadowSampler,uv+vec2f(f32(x),f32(y))*localShadowFrame.settings.w,i32(info.x)+i32(k),clip.z);}}
    return lit/9.0;
  }
  return 1.0;
}
`;
// Area light j: area[j] is (first layer, slot + 1, near, far); areaSlots: texel size per unit distance, the guard band
// (largest filter radius, UV), the smallest radius and two-sided. Cube faces in the light's frame (+n, +r, -r, +u, -u,
// -n). PCSS (Fernando 2005): blockers found within the light's footprint give the penumbra, the light's half extents
// at the receiver times (receiver - blocker) / blocker depth, filtered over a disk of comparisons. The receiver's
// tangent plane mapped into the face (planes stay planes under a projection) is the reference depth at every tap.
const areaShadow = /* wgsl */ `fn localShadowTap(i:u32,count:u32)->vec2f {let a=f32(i)*2.39996323;return vec2f(cos(a),sin(a))*sqrt(f32(i)/f32(count));}
fn clusterAreaShadow(j:u32,position:vec3f,n:vec3f,c:vec3f,r:vec3f,u:vec3f)->f32 {
  let info=localShadowFrame.area[j];if(info.y<0.5){return 1.0;}
  let slot=u32(info.y)-1u;let s=localShadowFrame.areaSlots[slot];let distance=length(c);let texel=s.x*distance;
  let p=position+n*(texel*localShadowFrame.settings.z)+c/max(distance,0.0001)*(texel*localShadowFrame.settings.y);
  let rn=normalize(r);let un=normalize(u);let q=p-position-c;let a=vec3f(dot(q,cross(rn,un)),dot(q,rn),dot(q,un));let b=abs(a);
  var face=select(5u,0u,a.x>=0);if(b.y>b.x&&b.y>=b.z){face=select(2u,1u,a.y>=0);}else if(b.z>b.x&&b.z>b.y){face=select(4u,3u,a.z>=0);}
  if(face==5u&&s.w<0.5){return 1.0;}
  let m=localShadowFrame.areaMatrices[slot*6u+face];let clip=m*vec4f(p,1);if(clip.w<=0){return 1.0;}
  let z=clip.z/clip.w;if(z<=0||z>1){return 1.0;}
  let uv=clip.xy/clip.w*vec2f(0.5,-0.5)+0.5;let layer=i32(info.x)+i32(face);
  let t1=normalize(cross(n,select(vec3f(1,0,0),vec3f(0,1,0),abs(n.x)>0.9)))*(distance*0.01);let t2=cross(n,t1);
  let c1=m*vec4f(p+t1,1);let c2=m*vec4f(p+t2,1);
  let d1=vec3f(c1.xy/c1.w*vec2f(0.5,-0.5)+0.5-uv,c1.z/c1.w-z);let d2=vec3f(c2.xy/c2.w*vec2f(0.5,-0.5)+0.5-uv,c2.z/c2.w-z);
  let det=d1.x*d2.y-d1.y*d2.x;
  let slope=select(vec2f(0),vec2f(d1.z*d2.y-d2.z*d1.y,d1.x*d2.z-d2.x*d1.z)/det,abs(det)>1e-12);
  let extent=(abs((m*vec4f(r,0)).xy)+abs((m*vec4f(u,0)).xy))*0.5/clip.w;
  let size=vec2f(textureDimensions(localShadowMap));let reach=min(extent*3.0,vec2f(s.y));
  var blockers=0.0;var depth=0.0;
  for(var i=0u;i<16u;i++){
    let o=localShadowTap(i,16u)*reach;let stored=textureLoad(localShadowMap,vec2i(clamp((uv+o)*size,vec2f(0),size-1)),layer,0);
    if(stored>z+dot(slope,o)){blockers+=1.0;depth+=info.z*info.w/(stored*(info.w-info.z)+info.z);}
  }
  if(blockers<0.5){return 1.0;}
  let blocker=depth/blockers;let radius=clamp(extent*max(clip.w-blocker,0.0)/blocker,vec2f(s.z),vec2f(s.y));
  var lit=0.0;
  for(var i=0u;i<24u;i++){let o=localShadowTap(i,24u)*radius;lit+=textureSampleCompareLevel(localShadowMap,localShadowSampler,uv+o,layer,z+dot(slope,o));}
  return lit/24.0;
}
`;
// Same text shape as @margoengine/shadows' depth shader, so shared/instances.js instancedDepth applies.
const depth = (pbr: boolean, transformed: boolean) => /* wgsl */ `
@group(0) @binding(0) var<uniform> camera:mat4x4f;
struct Frame {model:mat4x4f,alpha:vec4f${transformed ? ',alphaUV0:vec4f,alphaUV1:vec4f' : ''}}
@group(1) @binding(0) var<uniform> f:Frame;
@group(1) @binding(1) var alphaMap:texture_2d<f32>;
@group(1) @binding(2) var alphaSampler:sampler;
struct In {@location(0) position:${pbr ? 'vec4f,@location(3) uv:vec4f,@location(4) color:vec4f' : 'vec3f'}}
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:In)->Out {var o:Out;o.clip=camera*f.model*vec4f(i.position.xyz,1);${pbr ? 'o.uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);o.alpha=i.color.a;' : 'o.uv=vec2f(0);o.alpha=1;'}${transformed ? 'let sourceUV=o.uv;o.uv=vec2f(dot(f.alphaUV0.xy,sourceUV)+f.alphaUV0.z,dot(f.alphaUV1.xy,sourceUV)+f.alphaUV1.z);' : ''}return o;}
@fragment fn fragment(i:Out){if(textureSampleLevel(alphaMap,alphaSampler,i.uv,0).a*f.alpha.x*i.alpha<f.alpha.y){discard;}}
`;
const axes = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;
/** Reversed-depth perspective view-projection looking along unit `f` from `e` (column-major, into `out` at `o`). */
function lightMatrix(
  out: Float32Array,
  o: number,
  e: ArrayLike<number>,
  f: ArrayLike<number>,
  tan: number,
  near: number,
  far: number,
): void {
  const up = Math.abs(f[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  const length = Math.hypot(...r);
  r = r.map((v) => v / length);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]],
    k = near / (far - near),
    dot = (a: ArrayLike<number>) => a[0] * e[0] + a[1] * e[1] + a[2] * e[2];
  for (let c = 0; c < 3; c++) {
    out[o + c * 4] = r[c] / tan;
    out[o + c * 4 + 1] = u[c] / tan;
    out[o + c * 4 + 2] = -k * f[c];
    out[o + c * 4 + 3] = f[c];
  }
  out[o + 12] = -dot(r) / tan;
  out[o + 13] = -dot(u) / tan;
  out[o + 14] = k * far + k * dot(f);
  out[o + 15] = -dot(f);
}
function fits(width: number, height: number, size: number, kind: string): void {
  if (width > size || height > size)
    throw new RangeError(
      `A castShadow ${kind} light's shadow.resolution exceeds LocalShadows resolution ${size}; lower it or raise resolution`,
    );
}
/**
 * Shadows for clustered point lights (six cube faces) and spot lights (one perspective map) in one depth texture array.
 * Lights with `castShadow` take slots in list order up to `maxLights`. The same array, casters and biases shadow
 * `DirectionalLights` with `castShadow` (orthographic maps: a `bounds` box or one to four camera-fitted cascades, 3x3
 * PCF) and `AreaLights` with `castShadow` (cube faces around the light, PCSS penumbrae scaled by its size), without
 * adding bindings. Maps re-render only when their light changes (or the camera, for cascades) or a caster moves,
 * shows/hides, changes instances or `shadowVersion`, or was added with `{dynamic:true}`.
 * `LocalShadows.attach(engine, {lights})`; WebGPU only.
 * @throws TypeError without the Clustered lights or for an invalid caster; RangeError for invalid options or a map
 * larger than the device allows.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` for a caster
 * added twice or from another engine, `'state'` when used before attaching.
 */
export class LocalShadows implements EnginePlugin, ClusteredShadow {
  readonly name = 'clustered:shadows';
  readonly lights: Clustered;
  /** Last frame: layers re-rendered, caster draws, frames that re-rendered nothing. */
  readonly stats = { layers: 0, draws: 0, cacheHits: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private frame?: GPUBuffer;
  private cameras?: GPUBuffer;
  private map?: GPUTexture;
  private white?: GPUTexture;
  private whiteView?: GPUTextureView;
  private sampler?: GPUSampler;
  private alphaSampler?: GPUSampler;
  private cameraLayout?: GPUBindGroupLayout;
  private drawLayout?: GPUBindGroupLayout;
  private displaceLayout?: GPUBindGroupLayout;
  private cameraGroup?: GPUBindGroup;
  private layerViews: GPUTextureView[] = [];
  private entries: GPUBindGroupEntry[] = [];
  private pipelines = new Map<string, GPURenderPipeline>();
  private draws = new Map<Mesh, Map<object, Draw>>();
  private sources: Source[] = [];
  /** The frame with the directional and area data; `values` is its point and spot part, uploaded alone otherwise. */
  private readonly all = new Float32Array(EXTENDED_FLOATS);
  private readonly values = this.all.subarray(0, FRAME_FLOATS);
  private readonly matrices = new Float32Array(TOTAL_LAYERS * 64);
  /** Receivers' matrices per layer: the depth pass's, or for a smaller map the same mapped into its corner. */
  private readonly sampled = new Float32Array(TOTAL_LAYERS * 16);
  /** Per layer: a smaller map's viewport width and height, 0 for the whole layer. */
  private readonly viewports = new Uint32Array(TOTAL_LAYERS * 2);
  private readonly slots = new Float32Array(MAX_LIGHTS * SLOT_FLOATS).fill(NaN);
  private readonly dirtyLayers = new Uint8Array(TOTAL_LAYERS);
  private readonly bases = new Int32Array(MAX_LIGHTS);
  /** First layer of each shadowed directional and area light (after the point and spot layers). */
  private readonly sunBases = new Int32Array(MAX_DIRECTIONAL_SHADOWS);
  private readonly areaBases = new Int32Array(MAX_AREA_SHADOWS);
  /** Per layer last drawn for a directional or area light: its depth-pass matrix and viewport (NaN: drawn for another). */
  private readonly signatures = new Float32Array(TOTAL_LAYERS * SIGNATURE).fill(NaN);
  /** Some directional (area) light casts: the WGSL and the frame carry their data. */
  private sunShadows = false;
  private areaShadows = false;
  /** Layers the depth-pass camera buffer holds; it grows past the point and spot layers only for directional and area maps. */
  private cameraLayers = 0;
  private readonly list: Draw[] = [];
  private layers = 0;
  private changed = true;
  private disposed = false;
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthClearValue: 0,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
  };
  private readonly depthPass: GPURenderPassDescriptor = {
    colorAttachments: [],
    depthStencilAttachment: this.depthAttachment,
  };
  private readonly offset = [0];
  constructor(readonly options: LocalShadowOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('LocalShadows needs the Clustered lights');
    this.options = preset('localShadows', options);
    this.lights = options.lights;
    this.validate();
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: LocalShadowOptions): LocalShadows {
    const effect = new LocalShadows(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  private validate(): void {
    const o = this.options,
      max = o.maxLights ?? 4,
      size = o.resolution ?? 512;
    if (
      !Number.isInteger(max) ||
      max < 1 ||
      max > MAX_LIGHTS ||
      !Number.isInteger(size) ||
      size < 16 ||
      [o.bias ?? 1, o.normalBias ?? 1.5].some((v) => !Number.isFinite(Math.fround(v)) || v < 0)
    )
      throw new RangeError('Invalid local shadow options');
  }
  /** Adds a caster: a core mesh, or a gltf-pro model / materials mesh (`shadowPrimitives`). `dynamic` re-renders its lights every frame (skinned or morphing geometry). */
  add(source: LocalShadowSource | MeshHandle, { dynamic = false }: { dynamic?: boolean } = {}): () => void {
    if (this.disposed || !source || typeof dynamic !== 'boolean') throw new TypeError('Invalid shadow caster');
    if ('disposed' in source && source.disposed)
      throw new MargoError('disposed', 'Shadow caster is disposed; add a live mesh');
    const runtime = 'id' in source ? meshRuntime(source as MeshHandle) : (source as LocalShadowSource);
    if ('id' in runtime) {
      runtime.check();
      if (this.engine && runtime.engine !== this.engine)
        throw new MargoError(
          'attached',
          'Shadow mesh belongs to another engine; use objects created by the same engine',
        );
    } else if (!('shadowPrimitives' in runtime)) throw new TypeError('Invalid shadow caster');
    if (this.sources.some((r) => r.source === runtime))
      throw new MargoError('attached', 'Duplicate shadow caster; add each caster once');
    const r: Source = { source: runtime, dynamic };
    this.sources.push(r);
    this.invalidate();
    return () => {
      const index = this.sources.indexOf(r);
      if (index >= 0) {
        this.sources.splice(index, 1);
        this.invalidate();
      }
    };
  }
  /** Re-renders every shadow map next frame. */
  invalidate(): void {
    this.changed = true;
  }
  /** ClusteredShadow: while a directional light casts, the directional loop's shadow call (`clusterDirectionalShadow`). */
  get directionalShadow(): string | undefined {
    return this.sunShadows ? 'clusterDirectionalShadow(j,position,n,l)' : undefined;
  }
  /** ClusteredShadow: while an area light casts, `clusterAreaLighting`'s shadow call (`clusterAreaShadow`). */
  get areaShadow(): string | undefined {
    return this.areaShadows ? 'clusterAreaShadow(j,position,n,c,r,u)' : undefined;
  }
  /** @internal ClusteredShadow: WGSL for the light loop. */
  declarations(group: number): string {
    return sampling(group, this.sunShadows, this.areaShadows);
  }
  /** @internal ClusteredShadow: bindings 14-16 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.frame || this.disposed)
      throw new MargoError('state', 'Local shadows are not attached; attach them to an engine first');
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Local shadows require WebGPU and a live effect; attach a new LocalShadows to a WebGPU engine',
      );
    this.validate();
    this.engine = engine;
    const device = (this.device = engine.gpu);
    if ((this.options.resolution ?? 512) > device.limits.maxTextureDimension2D)
      throw new RangeError('Shadow map exceeds device limit');
    for (const r of this.sources)
      if ('id' in r.source && r.source.engine !== engine)
        throw new MargoError(
          'attached',
          'Shadow mesh belongs to another engine; use objects created by the same engine',
        );
    this.frame = device.createBuffer({
      size: FRAME_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cameras = device.createBuffer({ size: LAYERS * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cameraLayers = LAYERS;
    this.sampler = device.createSampler({ compare: 'greater-equal', magFilter: 'linear', minFilter: 'linear' });
    this.alphaSampler = device.createSampler();
    this.white = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.white },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.whiteView = this.white.createView();
    const V = GPUShaderStage.VERTEX,
      F = GPUShaderStage.FRAGMENT;
    this.cameraLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 } }],
    });
    this.drawLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    this.cameraGroup = device.createBindGroup({
      layout: this.cameraLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameras, size: 64 } }],
    });
    this.allocate(1);
    this.lights.shadow = this;
  }
  private allocate(layers: number): void {
    this.map?.destroy();
    const size = this.options.resolution ?? 512;
    this.layers = layers;
    this.map = this.device!.createTexture({
      size: [size, size, layers],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.layerViews = Array.from({ length: layers }, (_, baseArrayLayer) =>
      this.map!.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
    );
    if (layers > this.cameraLayers) {
      this.cameras!.destroy();
      this.cameraLayers = TOTAL_LAYERS;
      this.cameras = this.device!.createBuffer({
        size: TOTAL_LAYERS * 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.cameraGroup = this.device!.createBindGroup({
        layout: this.cameraLayout!,
        entries: [{ binding: 0, resource: { buffer: this.cameras, size: 64 } }],
      });
    }
    this.bind();
    this.changed = true;
  }
  private bind(): void {
    this.entries = [
      { binding: 14, resource: { buffer: this.frame! } },
      { binding: 15, resource: this.map!.createView({ dimension: '2d-array' }) },
      { binding: 16, resource: this.sampler! },
    ];
  }
  /**
   * Turns the directional and area parts of the frame and WGSL on or off: a larger frame buffer while either casts, and
   * Clustered rebuilds its shaders with the new declarations.
   */
  private extend(sun: boolean, area: boolean): void {
    if (sun === this.sunShadows && area === this.areaShadows) return;
    const resize = sun || area ? !(this.sunShadows || this.areaShadows) : true;
    this.sunShadows = sun;
    this.areaShadows = area;
    if (resize) {
      this.frame!.destroy();
      this.frame = this.device!.createBuffer({
        size: (sun || area ? EXTENDED_FLOATS : FRAME_FLOATS) * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.bind();
    }
    if (this.lights.shadow === this) this.lights.shadow = this;
  }
  // Runs after skinning (-10) and before directional shadows (-5), which upload pending instance rows.
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -5.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.render(c);
      },
    });
  }
  private render(c: Context): void {
    this.validate();
    const o = this.options,
      size = o.resolution ?? 512,
      max = o.maxLights ?? 4,
      data = this.lights['data'],
      cameras = this.lights['shadowCameras'],
      count = this.lights['lightCount'],
      slots = this.slots,
      values = this.values;
    // Slots from the clustered list: params.z is the 1-based shadow ordinal.
    let used = 0,
      layers = 0;
    const bases = this.bases.fill(0);
    for (let j = 0; j < count; j++) {
      const at = j * 16,
        slot = data[at + 14] - 1;
      if (slot < 0 || slot >= max) continue;
      used = Math.max(used, slot + 1);
      // A hemisphere spot (cosine data[at + 11]) is shadowed as a point light: six cube faces.
      const point = data[at + 13] < 0.5 || hemisphere(data[at + 11]);
      bases[slot] = point ? 6 : 1;
    }
    for (let s = 0; s < used; s++) {
      const n = bases[s];
      bases[s] = layers;
      layers += n;
    }
    for (let s = used; s < MAX_LIGHTS; s++) slots[s * SLOT_FLOATS + 11] = NaN;
    // Directional and area lights with castShadow take the layers after the point and spot ones.
    const pointLayers = layers,
      suns = this.lights.directional?.shadowLights?.() ?? noSuns,
      areas = this.lights.area?.shadowLights?.() ?? noAreas,
      sunCount = Math.min(suns.length, MAX_DIRECTIONAL_SHADOWS),
      areaCount = Math.min(areas.length, MAX_AREA_SHADOWS);
    for (let s = 0; s < sunCount; s++) {
      this.sunBases[s] = layers;
      layers += suns[s].bounds ? 1 : suns[s].cascades;
    }
    for (let s = 0; s < areaCount; s++) {
      this.areaBases[s] = layers;
      layers += areas[s].twoSided ? 6 : 5;
    }
    this.extend(sunCount > 0, areaCount > 0);
    if (layers > this.layers) this.allocate(layers);
    for (let j = 0; j < count; j++) {
      const at = j * 16,
        slot = data[at + 14] - 1;
      if (slot < 0 || slot >= max) continue;
      // The light's `shadow` map size and near/far (Clustered.setLights), 0 where unset.
      const point = data[at + 13] < 0.5 || hemisphere(data[at + 11]),
        base = bases[slot],
        c = j * 4,
        width = cameras[c] || size,
        height = cameras[c + 1] || size,
        range = cameras[c + 3] || data[at + 3],
        near = cameras[c + 2] || range * 1e-3,
        s = slot * SLOT_FLOATS;
      if (width > size || height > size)
        throw new RangeError(
          `A castShadow light's shadow.resolution exceeds LocalShadows resolution ${size}; lower it or raise resolution`,
        );
      let same = slots[s + 11] === base && slots[s + 10] === (point ? 1 : 0);
      for (let k = 0; k < 8; k++) if (slots[s + k] !== data[at + (k < 4 ? k : k + 4)]) same = false;
      if (slots[s + 8] !== size) same = false;
      for (let k = 0; k < 4; k++) if (slots[s + 12 + k] !== cameras[c + k]) same = false;
      if (same && !this.changed) continue;
      for (let k = 0; k < 8; k++) slots[s + k] = data[at + (k < 4 ? k : k + 4)];
      slots[s + 8] = size;
      slots[s + 10] = point ? 1 : 0;
      slots[s + 11] = base;
      for (let k = 0; k < 4; k++) slots[s + 12 + k] = cameras[c + k];
      // Two texels of margin per side keep the 3x3 filter inside a cube face; the spot frustum covers the outer cone.
      // A smaller map draws into its layers' top-left corner: viewportMatrix keeps that margin and maps the UVs.
      const scaled = width !== size || height !== size,
        margin = size / (size - 4),
        cos = data[at + 11],
        cone = point ? 1 : Math.sqrt(1 - cos * cos) / cos,
        tan = scaled ? cone : cone * margin;
      values[4 + slot * 4] = base;
      values[5 + slot * 4] = point ? 1 : 0;
      values[6 + slot * 4] = scaled ? (2 * cone) / (Math.min(width, height) - 4) : (2 * tan) / size;
      for (let face = 0; face < (point ? 6 : 1); face++) {
        const layer = base + face;
        lightMatrix(
          this.matrices,
          layer * 64,
          data.subarray(at, at + 3),
          point ? axes[face] : data.subarray(at + 8, at + 11),
          tan,
          near,
          range,
        );
        if (scaled) viewportMatrix(this.matrices, layer * 64, this.sampled, layer * 16, width, height, size);
        else this.sampled.set(this.matrices.subarray(layer * 64, layer * 64 + 16), layer * 16);
        this.viewports[layer * 2] = scaled ? width : 0;
        this.viewports[layer * 2 + 1] = scaled ? height : 0;
        this.dirtyLayers[layer] = 1;
        this.signatures[layer * SIGNATURE] = NaN;
      }
    }
    const extended = this.sunShadows || this.areaShadows;
    if (extended) this.extras(c, suns, sunCount, areas, areaCount, size);
    values[0] = used;
    values[1] = o.bias ?? 1;
    values[2] = o.normalBias ?? 1.5;
    values[3] = 1 / size;
    values.set(this.sampled.subarray(0, pointLayers * 16), 4 + MAX_LIGHTS * 4);
    c.device.queue.writeBuffer(
      this.frame!,
      0,
      (extended ? this.all : values) as Float32Array<ArrayBuffer>,
      0,
      extended ? EXTENDED_FLOATS : 4 + MAX_LIGHTS * 4 + pointLayers * 16,
    );
    // Casters: any change re-renders every layer (ponytail: per-light caster bounds would limit it to the lights it reaches).
    const engine = this.engine!;
    let casters = this.changed;
    for (const records of this.draws.values()) for (const d of records.values()) d.seen = false;
    const list = this.list;
    list.length = 0;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const r = this.sources[i];
      if (
        ('disposed' in r.source && r.source.disposed) ||
        ('id' in r.source && engine.meshes.get(r.source.id) !== r.source)
      ) {
        this.sources.splice(i, 1);
        casters = true;
      }
    }
    for (const r of this.sources) {
      if (r.dynamic) casters = true;
      let primitives: readonly LocalShadowPrimitive[];
      if ('id' in r.source) {
        const node = r.source;
        const buffers = node.geometry && engine.geometryBuffers(node.geometry);
        if (!buffers) continue;
        const p = (r.mesh ??= [{ node, vertex: buffers.vertex, index: buffers.index, count: 0, stride: 24 }])[0];
        p.vertex = buffers.vertex;
        p.index = buffers.index;
        p.count = node.geometry!.indices.length;
        primitives = r.mesh;
      } else {
        primitives = r.source.shadowPrimitives;
        if (r.version !== r.source.shadowVersion) {
          r.version = r.source.shadowVersion;
          casters = true;
        }
      }
      for (const p of primitives) {
        const node = p.node;
        node.check();
        if (node.engine !== engine)
          throw new MargoError(
            'attached',
            'Shadow caster belongs to another engine; use objects created by the same engine',
          );
        const visible = !hiddenInTree(engine.store, node.id);
        const inst = p.instances,
          d = this.record(p);
        d.seen = true;
        d.p = p;
        let moved =
          d.visible !== visible ||
          d.count !== p.count ||
          (inst ? inst.count !== d.instances || !!inst.needsUpdate : false);
        for (let k = 0; k < 16; k++) if (d.matrix[k] !== node.matrix[k]) moved = true;
        if (
          d.values[16] !== Math.fround(p.alpha ?? 1) ||
          d.values[17] !== Math.fround(p.cutoff ?? 0) ||
          d.values[18] !== (p.texCoord ?? 0)
        )
          moved = true;
        if (p.alphaTransform) for (let k = 0; k < 8; k++) if (d.values[20 + k] !== p.alphaTransform[k]) moved = true;
        // ponytail: displaced casters redraw every frame (live scale and bias live in a GPU buffer); compare their
        // values on the CPU if many static displaced casters make that costly.
        if (p.displacement) moved = true;
        if (moved) {
          casters = true;
          d.matrix.set(node.matrix);
          d.visible = visible;
          d.count = p.count;
          d.instances = inst?.count ?? 0;
        }
        if (visible && p.count && (!inst || inst.count)) list.push(d);
      }
    }
    for (const [node, records] of this.draws) {
      for (const [index, d] of records)
        if (!d.seen) {
          d.uniform.destroy();
          records.delete(index);
          casters = true;
        }
      if (!records.size) this.draws.delete(node);
    }
    if (casters) {
      this.dirtyLayers.fill(1, 0, layers);
      // Layers out of use now hold stale depth for whichever directional or area light takes them next.
      this.signatures.fill(NaN, layers * SIGNATURE);
    }
    this.changed = false;
    this.stats.layers = this.stats.draws = 0;
    let any = false;
    for (let l = 0; l < layers; l++) if (this.dirtyLayers[l]) any = true;
    if (!any) {
      this.stats.cacheHits++;
      return;
    }
    // The view matches the buffer: the point and spot layers, or every layer once directional or area maps grew it.
    const upload = this.matrices.subarray(0, this.cameraLayers * 64) as Float32Array<ArrayBuffer>;
    c.device.queue.writeBuffer(this.cameras!, 0, upload, 0, layers * 64);
    for (const d of list) {
      const p = d.p!;
      d.values.set(p.node.matrix);
      d.values[16] = p.alpha ?? 1;
      d.values[17] = p.cutoff ?? 0;
      d.values[18] = p.texCoord ?? 0;
      if (p.alphaTransform) d.values.set(p.alphaTransform, 20);
      c.device.queue.writeBuffer(d.uniform, 0, d.values as Float32Array<ArrayBuffer>);
    }
    for (let l = 0; l < layers; l++) {
      if (!this.dirtyLayers[l]) continue;
      this.dirtyLayers[l] = 0;
      this.stats.layers++;
      this.depthAttachment.view = this.layerViews[l];
      const pass = c.encoder.beginRenderPass(this.depthPass);
      this.offset[0] = l * 256;
      try {
        const width = this.viewports[l * 2];
        if (width) pass.setViewport(0, 0, width, this.viewports[l * 2 + 1], 0, 1);
        pass.setBindGroup(0, this.cameraGroup!, this.offset);
        for (const d of list) {
          const p = d.p!;
          pass.setPipeline(this.pipeline(d.key));
          pass.setBindGroup(1, d.group);
          if (d.displaced) pass.setBindGroup(2, d.displaced);
          pass.setVertexBuffer(0, p.vertex);
          pass.setIndexBuffer(p.index, 'uint32');
          if (p.instances) {
            pass.setVertexBuffer(1, p.instances.upload(c.device));
            pass.drawIndexed(p.count, p.instances.count);
          } else pass.drawIndexed(p.count);
          this.stats.draws++;
        }
      } catch (error) {
        try {
          pass.end();
        } catch {}
        throw error;
      }
      pass.end();
    }
  }
  /** Matrices and frame data of the directional and area lights' layers; marks the layers whose camera changed. */
  private extras(
    c: Context,
    suns: readonly DirectionalShadowLight[],
    sunCount: number,
    areas: readonly AreaShadowLight[],
    areaCount: number,
    size: number,
  ): void {
    const values = this.all;
    values.fill(0, SUN, SUN + SUN_LIST * 4);
    values.fill(0, AREA, AREA + AREA_LIST * 4);
    for (let s = 0; s < sunCount; s++) {
      const light = suns[s],
        f = light.direction,
        [x, y] = lightBasis(f),
        width = light.width || size,
        height = light.height || size,
        base = this.sunBases[s],
        scaled = width !== size || height !== size;
      fits(width, height, size, 'directional');
      const boxes = light.bounds
        ? [boundsBox(f, x, y, light.bounds.min, light.bounds.max)]
        : cascadeBoxes(c.camera, f, x, y, light.cascades, light.distance, width, height);
      boxes.forEach((box, k) => {
        const layer = base + k,
          cascade = s * 4 + k;
        // A full-size map widens its box by two texels a side for the 3x3 filter; a smaller one narrows its viewport.
        orthographicShadow(
          this.matrices,
          layer * 64,
          f,
          x,
          y,
          box,
          scaled ? box.hx : (box.hx * size) / (size - 4),
          scaled ? box.hy : (box.hy * size) / (size - 4),
        );
        this.place(layer, SUN_MATRICES + cascade * 16, width, height, size);
        values[SUN_CASCADES + cascade * 4] = Math.max((2 * box.hx) / (width - 4), (2 * box.hy) / (height - 4));
        values[SUN_CASCADES + cascade * 4 + 1] = (width - 2) / size;
        values[SUN_CASCADES + cascade * 4 + 2] = (height - 2) / size;
        values[SUN_CASCADES + cascade * 4 + 3] = 2 / size;
      });
      values.set([base, s + 1, boxes.length, 0], SUN + light.index * 4);
    }
    for (let s = 0; s < areaCount; s++) {
      const light = areas[s],
        width = light.width || size,
        height = light.height || size,
        base = this.areaBases[s],
        scaled = width !== size || height !== size,
        { normal: n, right: r, up: u } = light,
        axes = [n, r, r.map((v) => -v), u, u.map((v) => -v), n.map((v) => -v)];
      fits(width, height, size, 'area');
      for (let face = 0; face < (light.twoSided ? 6 : 5); face++) {
        const layer = base + face;
        lightMatrix(this.matrices, layer * 64, light.center, axes[face], AREA_FACE_TAN, light.near, light.far);
        this.place(layer, AREA_MATRICES + (s * 6 + face) * 16, width, height, size);
      }
      // The guard band: UV between the 45-degree face and its map's edge, less the bilinear filter's reach.
      const small = Math.min(width, height),
        inner = scaled ? (small - 4) / small : 1,
        smallest = 1.5 / size;
      values[AREA_SLOTS + s * 4] = (2 * AREA_FACE_TAN) / (small - (scaled ? 4 : 0));
      values[AREA_SLOTS + s * 4 + 1] = Math.max(
        ((0.5 - (0.5 * inner) / AREA_FACE_TAN) * small) / size - smallest,
        smallest,
      );
      values[AREA_SLOTS + s * 4 + 2] = smallest;
      values[AREA_SLOTS + s * 4 + 3] = light.twoSided ? 1 : 0;
      values.set([base, s + 1, light.near, light.far], AREA + light.index * 4);
    }
  }
  /**
   * Writes layer `layer`'s sampling matrix into the frame at `at` (mapped into its corner for a smaller map) and marks
   * the layer for re-rendering when its depth-pass matrix or viewport changed.
   */
  private place(layer: number, at: number, width: number, height: number, size: number): void {
    const o = layer * 64,
      v = layer * 2,
      k = layer * SIGNATURE,
      scaled = width !== size || height !== size,
      signature = this.signatures;
    if (scaled) viewportMatrix(this.matrices, o, this.all, at, width, height, size);
    else this.all.set(this.matrices.subarray(o, o + 16), at);
    this.viewports[v] = scaled ? width : 0;
    this.viewports[v + 1] = scaled ? height : 0;
    let same = signature[k + 16] === this.viewports[v] && signature[k + 17] === this.viewports[v + 1];
    for (let i = 0; i < 16; i++) if (signature[k + i] !== this.matrices[o + i]) same = false;
    if (same) return;
    signature.set(this.matrices.subarray(o, o + 16), k);
    signature[k + 16] = this.viewports[v];
    signature[k + 17] = this.viewports[v + 1];
    this.dirtyLayers[layer] = 1;
  }
  private record(p: LocalShadowPrimitive): Draw {
    if (![24, 80].includes(p.stride) || (p.instances && p.stride !== 80))
      throw new RangeError('Unsupported shadow caster vertex stride');
    const transform = p.alphaTransform;
    if (
      transform !== undefined &&
      (!(transform instanceof Float32Array) ||
        transform.length !== 8 ||
        transform.some((value) => !Number.isFinite(value)) ||
        p.stride !== 80)
    )
      throw new TypeError('Local shadow alpha transform requires finite affine rows and PBR vertices');
    const identity = p.primitive ?? p.index,
      displacement = p.displacement,
      key = `${p.stride}${p.instances ? 'i' : ''}${(p.cutoff ?? 0) > 0 ? 'm' : ''}${transform ? 't' : ''}${p.topology === 'line-list' ? 'l' : ''}${displacement ? 'd' : ''}`;
    if (displacement && p.stride !== 80) throw new RangeError('Displaced shadow casters need 80-byte vertices');
    let records = this.draws.get(p.node);
    if (!records) this.draws.set(p.node, (records = new Map()));
    let d = records.get(identity);
    if (
      !d ||
      d.vertex !== p.vertex ||
      d.index !== p.index ||
      d.alpha !== p.alphaTexture ||
      d.sampler !== p.alphaSampler ||
      d.key !== key ||
      d.displacement !== displacement
    ) {
      d?.uniform.destroy();
      const uniform = this.device!.createBuffer({
        size: transform ? 112 : 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      try {
        const group = this.device!.createBindGroup({
          layout: this.drawLayout!,
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: p.alphaTexture ?? this.whiteView! },
            { binding: 2, resource: p.alphaSampler ?? this.alphaSampler! },
          ],
        });
        d = {
          uniform,
          group,
          vertex: p.vertex,
          index: p.index,
          alpha: p.alphaTexture,
          sampler: p.alphaSampler,
          matrix: new Float32Array(16).fill(NaN),
          values: new Float32Array(transform ? 28 : 20),
          visible: false,
          count: -1,
          instances: -1,
          seen: true,
          key,
          displacement,
          displaced: displacement
            ? this.device!.createBindGroup({
                layout: this.displacementLayout(),
                entries: [
                  { binding: 0, resource: { buffer: displacement.buffer } },
                  { binding: 1, resource: displacement.view },
                  { binding: 2, resource: displacement.sampler },
                ],
              })
            : undefined,
        };
        records.set(identity, d);
        this.changed = true;
      } catch (error) {
        uniform.destroy();
        throw error;
      }
    }
    return d;
  }
  /** Group 2 of a displaced caster (shared/displacement.js `displacedDepth`): its uniform, map and sampler. */
  private displacementLayout(): GPUBindGroupLayout {
    const V = GPUShaderStage.VERTEX;
    return (this.displaceLayout ??= this.device!.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, texture: { sampleType: 'float' } },
        { binding: 2, visibility: V, sampler: { type: 'filtering' } },
      ],
    }));
  }
  private pipeline(key: string): GPURenderPipeline {
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const pbr = key.startsWith('80'),
      displaced = key.includes('d'),
      plain = depth(pbr, key.includes('t')),
      code = displaced ? displacedDepth(plain, 2) : plain,
      module = this.device!.createShaderModule({ code: key.includes('i') ? instancedDepth(code) : code });
    pipeline = this.device!.createRenderPipeline({
      layout: this.device!.createPipelineLayout({
        bindGroupLayouts: [this.cameraLayout!, this.drawLayout!, ...(displaced ? [this.displacementLayout()] : [])],
      }),
      vertex: {
        module,
        entryPoint: 'vertex',
        buffers: [
          {
            arrayStride: pbr ? 80 : 24,
            attributes: pbr
              ? [
                  { shaderLocation: 0, offset: 0, format: 'float32x4' },
                  ...(displaced ? [{ shaderLocation: 1, offset: 16, format: 'float32x4' as const }] : []),
                  { shaderLocation: 3, offset: 48, format: 'float32x4' },
                  { shaderLocation: 4, offset: 64, format: 'float32x4' },
                ]
              : [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
          ...(key.includes('i') ? [instanceLayout as GPUVertexBufferLayout] : []),
        ],
      },
      // Opaque casters need no fragment stage, which keeps early depth testing.
      ...(key.includes('m') ? { fragment: { module, entryPoint: 'fragment', targets: [] } } : {}),
      ...(key.includes('l') ? { primitive: { topology: 'line-list' as const } } : {}),
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
  private release(): void {
    if (this.lights.shadow === this) this.lights.shadow = undefined;
    for (const records of this.draws.values()) for (const d of records.values()) d.uniform.destroy();
    this.draws.clear();
    for (const resource of [this.map, this.white, this.frame, this.cameras]) resource?.destroy();
    this.map = this.white = this.frame = this.cameras = undefined;
    this.whiteView =
      this.sampler =
      this.alphaSampler =
      this.cameraLayout =
      this.drawLayout =
      this.displaceLayout =
      this.cameraGroup =
        undefined;
    this.layerViews = [];
    this.entries = [];
    this.pipelines.clear();
    this.layers = 0;
    this.slots.fill(NaN);
    this.signatures.fill(NaN);
    this.sunShadows = this.areaShadows = false;
    this.cameraLayers = 0;
    this.changed = true;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.sources.length = 0;
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
