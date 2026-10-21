/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/render: draws a VoxelWorld (packages/voxel/DESIGN.md, "Renderer"). Quads live in one storage buffer
// in 64-quad pages and are pulled by vertex index; each chunk layer is one drawIndexedIndirect whose instance count the
// CPU frustum cull sets, opaque and cutout replayed from a render bundle, translucent drawn back to front.
import type { EngineKernel } from '@margoengine/core';
import {
  type Engine,
  type EnginePlugin,
  engineRuntime,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import type { Vec3, Vec3Like } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { Frustum } from '@margoengine/math/frustum';
import { invertMatrix } from '@margoengine/math/mat4';
import { neutralShader } from '../../shared/display.js';
import { lightPBR, type PBRHooks } from '../../shared/pbr-hooks.js';
import { viewMatrix } from '../../shared/view.js';
import { uniformState } from './chunk.js';
import { blockMaterials, type ChunkMesh, sortQuads, VoxelMesher } from './mesher.js';
import { BlockTextures, blockTextureView } from './textures.js';
import type { VoxelWorld } from './world.js';
import { voxelPostShader } from './render-post.js';

export { type BlockPixels, BlockTextures, type BlockTexturesOptions } from './textures.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  INDEX: number;
  INDIRECT: number;
  COPY_SRC: number;
  COPY_DST: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;

// The mesh of an all-air chunk: no quads, every pair of its faces joined (as the mesher reports for one).
const AIR: ChunkMesh = {
  opaque: new Uint32Array(0),
  cutout: new Uint32Array(0),
  translucent: new Uint32Array(0),
  visibility: 0x20c38f3e, // bit a * 6 + b for every pair of faces a < b
};
const PAGE = 64, // quads per page
  PAGE_BYTES = PAGE * 12,
  // Most quads one chunk layer can hold: two glass blocks in a 3D checkerboard show every face (mesher README).
  MAX_QUADS = 196608,
  FIRST_POOL = 4 << 20,
  UPLOAD_BYTES = 4 << 20, // finished meshes uploaded per frame, at least one
  RESORT = 4, // blocks the camera moves before a near translucent chunk is sorted again
  NEAR = 64, // blocks from the camera to the centre of a chunk that is re-sorted
  RESORTS = 4, // re-sorts per frame
  // Pixels a merged quad's edges move out to close T-junction cracks: 1/512 closed every crack of the browser check on
  // the Arc 140V (D3D12 snaps vertices to 1/256 pixel); 1/128 leaves margin. ponytail: a rasterizer with 4 subpixel
  // bits (some mobile Vulkan GPUs) can open slivers up to 1/32 pixel: raise it if cracks show there.
  EDGE_PIXELS = 1 / 128;

// Group 0 bindings 1-6, shared by the beauty and shadow shaders: quad pool, page -> chunk slot, slot -> chunk origin,
// material table, block textures, sampler. Vertex pulling: quad = vertex_index >> 2, corner = vertex_index & 3, chunk =
// pages[quad >> 6]. voxelPlace gives corner c of a quad, (0, 0), (w, 0), (w, h) or (0, h) along the face's u and v
// (see ChunkMesh), with a liquid's lowered top; voxelRise lifts the surface of a liquid with the wave bit by the same
// height everywhere at time t, so merged and unit quads, tops and sides and neighbouring chunks stay joined (the ripples
// are in the shading normal, voxelRipple). voxelTile maps chunk-local point l on a face to texture coordinates in blocks
// (the sampler repeats), v running down the sides; voxelLayer is a material's texture layer at time t (its animation).
const COMMON = /* wgsl */ `
@group(0) @binding(1) var<storage,read> voxelQuads:array<u32>;
@group(0) @binding(2) var<storage,read> voxelPages:array<u32>;
@group(0) @binding(3) var<storage,read> voxelOrigins:array<vec4f>;
@group(0) @binding(4) var<storage,read> voxelMaterials:array<vec4u>;
@group(0) @binding(5) var voxelTextures:texture_2d_array<f32>;
@group(0) @binding(6) var voxelSampler:sampler;
fn voxelRise(w1:u32,t:f32)->f32 {return select(0.0,0.04*sin(t*1.6),(w1&0x100000u)!=0u);}
fn voxelPlace(w0:u32,w1:u32,c:u32,t:f32)->vec3f {
 let face=(w0>>15u)&7u;let su=select(0.0,f32(((w0>>18u)&31u)+1u),c==1u||c==2u);let sv=select(0.0,f32(((w0>>23u)&31u)+1u),c>=2u);
 var p=vec3f(f32(w0&31u),f32((w0>>5u)&31u),f32((w0>>10u)&31u));
 switch face {
  case 0u,1u {p+=vec3f(f32(face==0u),sv,su);}
  case 2u,3u {p+=vec3f(su,f32(face==2u),sv);}
  case 4u,5u {p+=vec3f(su,sv,f32(face==4u));}
  case 6u {p+=vec3f(su,sv,su);}
  default {p+=vec3f(1.0-su,sv,su);}
 }
 if(face==2u||(face!=3u&&face<6u&&c>=2u)){p.y+=voxelRise(w1,t)-f32(w0>>29u)*0.125;}
 return p;
}
fn voxelTile(face:u32,l:vec3f,cell:vec3f)->vec2f {
 switch face {
  case 0u {return vec2f(-l.z,-l.y);}
  case 1u {return vec2f(l.z,-l.y);}
  case 2u {return l.xz;}
  case 3u {return vec2f(l.x,-l.z);}
  case 4u {return vec2f(l.x,-l.y);}
  case 5u {return vec2f(-l.x,-l.y);}
  case 6u {return vec2f(l.x-cell.x,-l.y);}
  default {return vec2f(cell.x+1.0-l.x,-l.y);}
 }
}
fn voxelLayer(m:vec4u,t:f32)->u32 {return (m.x&255u)+u32(floor(t*f32(m.z>>16u)/256.0))%(((m.x>>8u)&255u)+1u);}
`;
// Sky visibility of the sun: without a shadow map the sun reaches a face as far as the open sky does. With one
// (`shadows.add(voxels)`), the map decides inside its range and sky visibility fades back in over the last tenth of it;
// this reads the shadows package's own uniform (shadowFrame.view and splits.w, its receivers' "outside" test).
const SUN = 'fn voxelSun(p:vec3f,sky:f32)->f32 {return sky*sky;}',
  SHADOWED_SUN =
    'fn voxelSun(p:vec3f,sky:f32)->f32 {let d=-(shadowFrame.view*vec4f(p,1.0)).z;return mix(1.0,sky*sky,smoothstep(0.9*shadowFrame.splits.w,shadowFrame.splits.w,d));}';

// The beauty shader. MODE: 0 opaque, 1 cutout (alpha test), 2 cutout (alpha to coverage), 3 translucent
// (premultiplied); EDGE: pixels a merged quad's edges move out. T-junctions: neighbours' corners lie on a merged quad's
// edges, and once the rasterizer snaps them to its subpixel grid a sliver between the two can stay uncovered;
// voxelStretch moves each edge EDGE pixels out along the quad's own edges in clip space (so it stays in its plane): EDGE
// over the quad's on-screen thickness there, at most a pixel and half the quad, 0 for an edge under 1/16 pixel long,
// whose direction is too uncertain. Unit quads share all their corners with their neighbours and stay as they are.
// The fragment shades from voxelHit, the point where the pixel's ray meets the face's plane (never from interpolated
// attributes), so a greedy quad shades its pixels bit for bit like the unit faces it covers; AO and light (voxelCorner)
// are mixed bilinearly with voxelMix, which returns a exactly when a == b; texture gradients come from the neighbouring
// pixels' hits. Its lit part keeps gltf-pro's hook points (packages/shared/pbr-hooks.js) for shadows, clustered lights,
// IBL and fog; `f.glow` is the block light colour and time, `f.ambient.w` the daylight.
const SHADER = /* wgsl */ `${neutralShader}
struct Frame {camera:mat4x4f,inverse:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f,glow:vec4f,viewport:vec4f,settings:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
${COMMON}
override MODE:u32=0u;
override EDGE:f32=0.0;
struct Out {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) words:vec3u,@location(1) @interpolate(flat) origin:vec4f,@location(2) @interpolate(flat) material:vec4u}
fn voxelStretch(s:vec2f,along:vec2f,across:vec2f)->f32 {
 let d=s-along;let l=length(d);let a=s-across;if(l<0.0625){return 0.0;}
 return min(min(EDGE/max(abs(dot(vec2f(-d.y,d.x)/l,a)),0.000001),0.5),1.0/max(length(a),0.000001));
}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Out {
 let q=index>>2u;let w0=voxelQuads[q*3u];let w1=voxelQuads[q*3u+1u];let face=(w0>>15u)&7u;var c=index&3u;let t=f.glow.w;
 if((w0&0x10000000u)!=0u){c=(c+1u)&3u;}
 if(face==0u||face==2u||face==5u){c=(4u-c)&3u;}
 let origin=voxelOrigins[voxelPages[q>>6u]];var clip=f.camera*vec4f(origin.xyz+voxelPlace(w0,w1,c,t),1.0);
 if(EDGE>0.0&&((w0>>18u)&0x3ffu)!=0u){
  let u=f.camera*vec4f(origin.xyz+voxelPlace(w0,w1,c^1u,t),1.0);let v=f.camera*vec4f(origin.xyz+voxelPlace(w0,w1,3u-c,t),1.0);
  if(clip.w>0.0&&u.w>0.0&&v.w>0.0){
   let half=f.viewport.xy*0.5;let s=clip.xy/clip.w*half;let su=u.xy/u.w*half;let sv=v.xy/v.w*half;
   clip+=voxelStretch(s,su,sv)*(clip-v)+voxelStretch(s,sv,su)*(clip-u);
  }
 }
 var o:Out;o.clip=clip;o.words=vec3u(w0,w1,voxelQuads[q*3u+2u]);o.origin=origin;o.material=voxelMaterials[w1&4095u];return o;
}
struct Surface {base:vec4f,n:vec3f,roughness:f32,metal:f32,occlusion:f32,emissive:vec3f}
struct VoxelPixel {clip:vec4f,position:vec3f}
fn voxelHit(px:vec2f,n:vec3f,k:f32)->vec3f {
 let a=f.inverse*vec4f(px.x*f.viewport.z*2.0-1.0,1.0-px.y*f.viewport.w*2.0,0.0,1.0);let b=f.inverse[2];
 let h=a-b*((dot(n,a.xyz)-k*a.w)/(dot(n,b.xyz)-k*b.w));return h.xyz/h.w;
}
fn voxelCorner(w:vec3u,c:u32)->vec3f {return vec3f(f32((w.y>>(12u+2u*c))&3u),f32((w.z>>(8u*c))&15u),f32((w.z>>(8u*c+4u))&15u));}
fn voxelMix(a:vec3f,b:vec3f,t:f32)->vec3f {return a+(b-a)*t;}
fn voxelRipple(p:vec2f,t:f32)->vec3f {
 let a=0.035*cos(dot(p,vec2f(1.3,0.4))+t*1.7);let b=0.03*cos(dot(p,vec2f(-0.5,1.6))+t*1.3);let c=0.015*cos(dot(p,vec2f(2.9,2.3))+t*2.9);
 return normalize(vec3f(-(1.3*a-0.5*b+2.9*c),1.0,-(0.4*a+1.6*b+2.3*c)));
}
${SUN}
fn ambient(s:Surface)->vec3f {let f0=mix(vec3f(0.04),s.base.rgb,s.metal);return (s.base.rgb*(1.0-s.metal)+f0*0.5)*mix(vec3f(0.35,0.3,0.25),vec3f(1.0),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.ambient.rgb*f.radiance.w*s.occlusion;}
fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {
 let h=(v+l)/max(length(v+l),0.0001);
 let nl=clamp(dot(s.n,l),0.0,1.0);let nv=clamp(dot(s.n,v),0.0001,1.0);let nh=clamp(dot(s.n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let a=s.roughness*s.roughness;let a2=a*a;let d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));
 let g=2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001);
 let f0=mix(vec3f(0.04),s.base.rgb,s.metal);let fresnel=f0+(1.0-f0)*pow(1.0-vh,5.0);
 return ((1.0-fresnel)*(1.0-s.metal)*s.base.rgb/3.14159265+d*g*fresnel/max(4.0*nl*nv,0.0001))*nl*f.radiance.rgb*f.light.w;
}
@fragment fn fragment(o:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
 let w=o.words;let face=(w.x>>15u)&7u;let O=o.origin.xyz;let t=f.glow.w;let drop=f32(w.x>>29u)*0.125-voxelRise(w.y,t);
 let cell=vec3f(f32(w.x&31u),f32((w.x>>5u)&31u),f32((w.x>>10u)&31u));let size=vec2f(f32(((w.x>>18u)&31u)+1u),f32(((w.x>>23u)&31u)+1u));
 let axis=face>>1u;var n=vec3f(f32(axis==0u),f32(axis==1u),f32(axis==2u));var k=dot(n,O+cell)+f32((face&1u)==0u);
 if(face==2u){k-=drop;}
 if(face==6u){n=vec3f(1.0,0.0,-1.0);k=(O.x+cell.x)-(O.z+cell.z);}
 if(face==7u){n=vec3f(1.0,0.0,1.0);k=O.x+cell.x+1.0+O.z+cell.z;}
 var i:VoxelPixel;i.clip=o.clip;i.position=voxelHit(o.clip.xy,n,k);let l=i.position-O;
 var uv=l.xy;var at=cell.xy;
 if(axis==0u){uv=l.zy;at=cell.zy;} else if(axis==1u){uv=l.xz;at=cell.xz;}
 let r=clamp((uv-at)/vec2f(size.x,size.y-select(0.0,drop,face<6u&&axis!=1u)),vec2f(0.0),vec2f(1.0));
 let lit=voxelMix(voxelMix(voxelCorner(w,0u),voxelCorner(w,1u),r.x),voxelMix(voxelCorner(w,3u),voxelCorner(w,2u),r.x),r.y);
 let m=o.material;let layer=voxelLayer(m,t);
 let s0=voxelTile(face,l,cell);let s1=voxelTile(face,voxelHit(o.clip.xy+vec2f(1.0,0.0),n,k)-O,cell);let s2=voxelTile(face,voxelHit(o.clip.xy+vec2f(0.0,1.0),n,k)-O,cell);
 let texel=textureSampleGrad(voxelTextures,voxelSampler,s0,layer,s1-s0,s2-s0);
 let tc=unpack4x8unorm(m.y).rgb;let tint=select(tc/12.92,pow((tc+0.055)/1.055,vec3f(2.4)),tc>vec3f(0.04045));
 var s:Surface;s.base=vec4f(texel.rgb*tint,select(texel.a,1.0,(m.x&0x10000u)!=0u));
 if(MODE==1u&&s.base.a<0.5){discard;}
 let side=select(-1.0,1.0,front);
 s.n=select(vec3f(0.0,1.0,0.0),n*select(-1.0,1.0,(face&1u)==0u)*side,face<6u);
 if(face==2u&&(w.y&0x100000u)!=0u){s.n=voxelRipple(i.position.xz,t)*side;}
 s.roughness=clamp(f32(m.z&255u)/255.0,0.045,1.0);s.metal=f32((m.z>>8u)&255u)/255.0;
 let sky=lit.y/15.0;let block=lit.z/15.0;let skyLight=sky/(4.0-3.0*sky);let ao=0.4+0.2*lit.x;
 s.occlusion=ao*(0.03+skyLight*f.ambient.w);
 s.emissive=s.base.rgb*(bitcast<f32>(m.w)+block/(4.0-3.0*block)*ao*f.glow.rgb);
 let v=normalize(f.eye.xyz-i.position);let lightDirection=normalize(f.light.xyz);
 let direct=direct_light(s,v,lightDirection)*voxelSun(i.position,skyLight);
 var color=direct+ambient(s)+s.emissive;
 if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0))); color=select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308));}
 if(MODE==3u){return vec4f(color*s.base.a,s.base.a);}
 return vec4f(color,select(1.0,s.base.a,MODE==2u));
}`;

// The shadow-map shader: opaque chunks depth only (shadowVertex), cutout ones alpha tested at their texture's level 0
// (shadowCutout). No winding (both sides cast). Every quad reaches 1/64 block past its edges in its plane, so T-junction
// slivers cannot let light through the map (a texel is at least a few centimetres; the snapping error is 1/256 of one),
// and merged and unit quads cast the same outline. Translucent blocks cast no shadow.
const SHADOW_SHADER = /* wgsl */ `
struct VoxelShadow {matrix:mat4x4f,time:vec4f}
@group(0) @binding(0) var<uniform> shadow:VoxelShadow;
${COMMON}
struct ShadowOut {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) words:vec2u,@location(1) local:vec3f}
@vertex fn shadowVertex(@builtin(vertex_index) index:u32)->ShadowOut {
 let q=index>>2u;let w0=voxelQuads[q*3u];let w1=voxelQuads[q*3u+1u];let c=index&3u;let t=shadow.time.x;
 var p=voxelPlace(w0,w1,c,t);
 p+=(normalize(p-voxelPlace(w0,w1,c^1u,t))+normalize(p-voxelPlace(w0,w1,3u-c,t)))*${1 / 64};
 var o:ShadowOut;o.clip=shadow.matrix*vec4f(voxelOrigins[voxelPages[q>>6u]].xyz+p,1.0);o.words=vec2u(w0,w1);o.local=p;return o;
}
@fragment fn shadowCutout(o:ShadowOut) {
 let face=(o.words.x>>15u)&7u;let cell=vec3f(f32(o.words.x&31u),f32((o.words.x>>5u)&31u),f32((o.words.x>>10u)&31u));
 let m=voxelMaterials[o.words.y&4095u];
 if((m.x&0x10000u)==0u&&textureSampleLevel(voxelTextures,voxelSampler,voxelTile(face,o.local,cell),voxelLayer(m,shadow.time.x),0.0).a<0.5){discard;}
}`;

/** Options of {@link VoxelRenderer.attach}. */
export interface VoxelRendererOptions {
  /** The world to draw. The renderer meshes the chunks in `world.dirty` (nearest first) and removes their keys. */
  world: VoxelWorld;
  /** Textures of the blocks: `BlockTypeOptions.textures` are layers of it. */
  textures: BlockTextures;
  /** Mesher workers, as `VoxelMesherOptions.workers`. Default: half the logical cores minus one, 1 to 4. */
  workers?: number;
  /**
   * Most GPU bytes for quads (12 each, in pages of 64): the buffer starts at 4 MiB and doubles up to this. A mesh that
   * does not fit waits until other chunks free pages. Default 96 MiB; at most the device's maxStorageBufferBindingSize.
   */
  maxQuadBytes?: number;
  /** Initial {@link VoxelRenderer.daylight}. Default 1. */
  daylight?: number;
  /** Cutout cubes (leaves) are see-through; false draws them solid. Cross blocks always cut out. Default true. */
  fancyLeaves?: boolean;
}

/**
 * A lighting effect for {@link VoxelRenderer.addLighting}: an object with glTF-pro's lighting hooks (contract version 1),
 * such as `Shadows`, `Clustered`, `Fog` or `EnvironmentLighting`. Their `add(voxels)` calls `addLighting` for you.
 */
export interface VoxelRendererEffect {
  /**
   * WGSL hooks for bind group `group` (the renderer passes 1): `declarations` and any of `direct` (wraps the sun
   * term), `light` (local lights), `ambient` (replaces the hemisphere ambient) and `output` (wraps the display colour).
   * Undefined while the effect is not ready; the renderer asks every frame.
   */
  pbr(group: number):
    | {
        readonly declarations: string;
        direct?(direct: string): string;
        readonly light?: string;
        readonly ambient?: string;
        output?(color: string): string;
      }
    | undefined;
  /** Bind group entries of those hooks' bindings. */
  bindings(): GPUBindGroupEntry[];
}

/** Material capture contract shared with SSR and SSGI from `@margoengine/post`; neither package is required. */
export interface VoxelCapture {
  /** PBR Surface capture declarations, including `MargoCapture` and `margoCapture(s,v,k)`. */
  declarations(code: string): string;
  /** Capture color targets in declaration location order. */
  readonly targets: readonly GPUColorTargetState[];
  /** Begins the owner's shared pass; the owner ends it after all registered sources draw. */
  begin(): GPURenderPassEncoder;
}

/** What `Shadows` hands {@link VoxelRenderer.drawShadow}: one cascade's depth pass and light matrix. */
export interface VoxelShadowContext {
  /** The frame's pass context; the renderer reads its `device`. */
  readonly context: { readonly device: GPUDevice };
  /** The cascade's depth pass (depth32float, less-equal). */
  readonly pass: GPURenderPassEncoder;
  /** The cascade's light view-projection matrix (column-major, depth 0 to 1). */
  readonly matrix: Float32Array;
  /** Cascade index, 0 to 3. */
  readonly cascade: number;
}

/** What a {@link VoxelRenderer} holds and drew in its last frame. */
export interface VoxelRendererStats {
  /** Chunks with quads on the GPU. */
  readonly chunks: number;
  /** Of those, chunks in the camera frustum. */
  readonly visible: number;
  /** Quads on the GPU. */
  readonly quads: number;
  /** GPU bytes of the quad pages in use (768 per page of 64 quads). */
  readonly bytes: number;
  /** Draw calls: one per visible chunk layer with quads. */
  readonly draws: number;
}

// First fit over runs of free pages: [start, length] pairs sorted by start, neighbours merged.
class Pages {
  runs: number[] = [];
  capacity = 0;
  used = 0;
  grow(capacity: number): void {
    this.#free(this.capacity, capacity - this.capacity);
    this.capacity = capacity;
  }
  alloc(n: number): number {
    const r = this.runs;
    for (let i = 0; i < r.length; i += 2)
      if (r[i + 1] >= n) {
        const start = r[i];
        r[i] += n;
        r[i + 1] -= n;
        if (!r[i + 1]) r.splice(i, 2);
        this.used += n;
        return start;
      }
    return -1;
  }
  release(start: number, n: number): void {
    if (!n) return;
    this.used -= n;
    this.#free(start, n);
  }
  #free(start: number, n: number): void {
    const r = this.runs;
    let i = 0;
    while (i < r.length && r[i] < start) i += 2;
    if (i < r.length && start + n === r[i]) {
      r[i] = start;
      r[i + 1] += n;
    } else r.splice(i, 0, start, n);
    if (i && r[i - 2] + r[i - 1] === start) {
      r[i - 1] += r[i + 1];
      r.splice(i, 2);
    }
  }
}

interface Chunk {
  key: string;
  /** World cell of the chunk's corner. */
  x: number;
  y: number;
  z: number;
  slot: number;
  /** Per layer (opaque, cutout, translucent): first page, pages, quads. */
  start: Int32Array;
  pages: Int32Array;
  quads: Int32Array;
  translucent?: Uint32Array;
  sortedAt: Vec3;
}
interface Finished {
  mesh: ChunkMesh;
  priority: number;
  eye: Vec3;
}
interface Pipelines {
  /** Format, samples and depth format they draw to. */
  target: string;
  layers: GPURenderPipeline[];
  /** The effects composed into them, whose bindings fill group 1. */
  effects: VoxelRendererEffect[];
  groups?: GPUBindGroup[];
  groupVersion?: number;
  lights?: GPUBindGroup[];
  lightBound?: unknown[];
  lightVersion?: number;
  bundle?: GPURenderBundle;
  bundleKey?: string;
}
interface ShadowState {
  uniform: GPUBuffer;
  values: Float32Array;
  /** Opaque (depth only) and cutout (alpha tested) pipelines, once compiled. */
  ready?: GPURenderPipeline[];
  /** Per pipeline, per cascade. */
  groups?: GPUBindGroup[][];
  groupVersion?: number;
}
interface Gpu {
  device: GPUDevice;
  frame: GPUBuffer;
  pool: GPUBuffer;
  pageTable: GPUBuffer;
  origins: GPUBuffer;
  args: GPUBuffer;
  materials: GPUBuffer;
  index: GPUBuffer;
  sampler: GPUSampler;
  view?: GPUTextureView;
  pipelines: Map<string, { ready?: Pipelines }>;
  shadow?: ShadowState;
  post?: { view: GPUBuffer; states: Map<string, { ready?: Pipelines }> };
}

let serial = 0;
const isNumber = (value: unknown, name: string, fix: string): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelRenderer ${name} must be a number; ${fix}`);
  return value;
};

/**
 * Draws a {@link VoxelWorld} with an engine: an engine plugin that meshes the world's dirty chunks in workers
 * ({@link VoxelMesher}, nearest chunks first), keeps their quads on the GPU, culls chunks against the camera frustum on
 * the CPU and draws opaque and cutout blocks before the sky (pass order 1) and translucent ones back to front after
 * water (order 4.5). Lit by the engine's directional light (`engine.lighting`) and an ambient term, both scaled by the
 * chunks' baked sky light, ambient occlusion and block light (attach `VoxelLighting` to compute it: unlit chunks are
 * dark). Needs the WebGPU backend.
 *
 * ```ts
 * const voxels = VoxelRenderer.attach(engine, { world, textures: await BlockTextures.load(urls) });
 * world.setBlock(x, y, z, stone); // drawn within two frames
 * voxels.stats.draws;
 * voxels.dispose();
 * ```
 */
export class VoxelRenderer implements EnginePlugin {
  /** Plugin name, unique per renderer. */
  readonly name = `voxel:${serial++}`;
  /** The world drawn. */
  readonly world: VoxelWorld;
  /** The textures drawn with. */
  readonly textures: BlockTextures;
  #engine?: Engine;
  #mesher: VoxelMesher;
  #maxPages: number;
  #fancyLeaves: boolean;
  #daylight = 1;
  #disposed = false;
  #gpu?: Gpu;
  #pages = new Pages();
  #chunks = new Map<string, Chunk>();
  #known = new Set<string>();
  #finished = new Map<string, Finished>();
  #full = false;
  #generation = 0;
  #slots: number[] = [];
  #slotTop = 0;
  #origins = new Float32Array(0);
  #args = new Uint32Array(0);
  #materialTypes = 0;
  #resources = 0;
  #residency = 0;
  #time = 0;
  #ready?: Pipelines;
  #translucent: Chunk[] = [];
  #frame = new Float32Array(60);
  #inverse = new Float64Array(16);
  #postView = new Float32Array(16);
  #frustum = new Frustum();
  #box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  #stats = { chunks: 0, visible: 0, quads: 0, bytes: 0, draws: 0 };
  #effects = new Set<VoxelRendererEffect>();
  #capture?: VoxelCapture;
  #disposeListeners = new Set<() => void>();
  #composed = { from: '', code: SHADER };
  #lightVersion = 0;
  #shadowVersion = 0;
  #shadowResources = -1;
  /** The cascades of the last shadow map drawn: chunks changing outside them leave the map as it is. */
  #shadowFrusta: Frustum[] = [];
  #blockLight: [number, number, number] = [1, 0.82, 0.6];

  private constructor(options: VoxelRendererOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('VoxelRenderer.attach expects (engine, {world, textures})');
    const { world, textures, workers, maxQuadBytes = 96 << 20, daylight = 1, fancyLeaves = true } = options;
    if (typeof world?.getChunk !== 'function' || !(world.dirty instanceof Set) || !Array.isArray(world.blocks?.table))
      throw new TypeError('VoxelRenderer world must be a VoxelWorld; pass {world: new VoxelWorld({blocks})}');
    if (!(textures instanceof BlockTextures))
      throw new TypeError(
        'VoxelRenderer textures must be BlockTextures; pass {textures: await BlockTextures.load(urls)}',
      );
    isNumber(maxQuadBytes, 'maxQuadBytes', 'pass bytes, such as 96 << 20');
    if (!Number.isInteger(maxQuadBytes) || maxQuadBytes < PAGE_BYTES)
      throw new RangeError(`VoxelRenderer maxQuadBytes ${maxQuadBytes} is not a whole number of at least 768 bytes`);
    if (typeof fancyLeaves !== 'boolean') throw new TypeError('VoxelRenderer fancyLeaves must be true or false');
    this.world = world;
    this.textures = textures;
    this.#maxPages = Math.floor(maxQuadBytes / PAGE_BYTES);
    this.#fancyLeaves = fancyLeaves;
    this.daylight = daylight;
    this.#mesher = new VoxelMesher(workers === undefined ? {} : { workers });
  }

  /**
   * Creates a renderer for `options.world` and adds it to `engine`.
   * @throws TypeError when `world` is not a VoxelWorld, `textures` not BlockTextures, or an option has the wrong type.
   * @throws RangeError for `maxQuadBytes` under 768 or over the device's maxStorageBufferBindingSize, `daylight` that is
   * negative or not finite, or `workers` that is not a whole number of 1 or more.
   * @throws MargoError `unsupported` without the WebGPU backend or Web Workers.
   */
  static attach(engine: EngineKernel, options: VoxelRendererOptions): VoxelRenderer {
    const renderer = new VoxelRenderer(options);
    try {
      engineRuntime(engine).use(renderer);
    } catch (error) {
      renderer.dispose();
      throw error;
    }
    return renderer;
  }

  /** Scale of the sky light (ambient light from the open sky), 0 (night) to 1 (day) and above. Live. Default 1. */
  get daylight(): number {
    return this.#daylight;
  }
  set daylight(value: number) {
    isNumber(value, 'daylight', 'pass 0 (night) to 1 (day)');
    if (!(value >= 0) || !Number.isFinite(value))
      throw new RangeError(`VoxelRenderer daylight ${value} must be finite and >= 0; pass 0 (night) to 1 (day)`);
    this.#daylight = value;
  }

  /**
   * Linear colour of block light (torches, lava: `BlockTypeOptions.light`), 0 to 1 or above per channel. Live. Default
   * warm white `[1, 0.82, 0.6]`.
   */
  get blockLightColor(): Vec3 {
    return this.#blockLight;
  }
  set blockLightColor(value: Vec3) {
    if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number'))
      throw new TypeError(
        'VoxelRenderer blockLightColor must be [r, g, b]; pass linear numbers such as [1, 0.82, 0.6]',
      );
    if (!value.every((v) => v >= 0 && Number.isFinite(v)))
      throw new RangeError(`VoxelRenderer blockLightColor [${value}] must be finite and >= 0`);
    this.#blockLight = [value[0], value[1], value[2]];
  }

  /** Chunks, quads, bytes and draw calls of the last frame. */
  get stats(): VoxelRendererStats {
    return this.#stats;
  }

  /** True after disposal, for optional post and lighting hosts. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Notifies an optional host when this renderer leaves; the returned unsubscribe and disposal are idempotent. */
  onDispose(callback: () => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('VoxelRenderer onDispose needs a callback');
    if (this.#disposed) {
      callback();
      return () => {};
    }
    this.#disposeListeners.add(callback);
    return () => {
      this.#disposeListeners.delete(callback);
    };
  }

  /** Sets the native PBR material capture hook used by SSR/SSGI. Returns an identity-safe remover. */
  setCapture(hook: VoxelCapture): () => void {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelRenderer is disposed; attach a new one');
    if (
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets) ||
      !hook.targets.length
    )
      throw new TypeError('VoxelRenderer capture needs declarations, targets and begin; pass a post capture hook');
    this.#capture = hook;
    return () => {
      if (this.#capture === hook) this.#capture = undefined;
    };
  }

  /**
   * Replays native quad materials for GTAO/SSAO (`gbuffer`, `ambient`, `occlusion`) or SSR/SSGI (`capture`). Opaque and
   * cutout geometry keep the beauty shader's texture, alpha, liquid normals and lighting hooks. Capture excludes
   * translucent surfaces. `occlusion` needs the post owner's two-target external pass; external/capture passes remain
   * open for their owner. GPU state is allocated only on the first replay, and pipelines compile asynchronously.
   */
  draw(
    c: Extract<PassContext, { backend: 'webgpu' }>,
    mode: 'gbuffer' | 'ambient' | 'occlusion' | 'capture',
    color: GPUTextureView,
    depth: GPUTextureView,
    phase: 'all' | 'opaque' | 'blend' = 'all',
    external?: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction },
  ): void {
    const gpu = this.#gpu,
      hook = mode === 'capture' ? this.#capture : undefined;
    if (this.#disposed || !gpu || gpu.device !== c.device || !this.#chunks.size || (mode === 'capture' && !hook))
      return;
    if (mode === 'occlusion' && !external)
      throw new TypeError("VoxelRenderer occlusion needs the post owner's two-target external pass");
    const { code: beauty, effects } = this.#composition(),
      code = voxelPostShader(beauty, mode, hook?.declarations(beauty)),
      samples = c.descriptor.multisample?.count ?? 1,
      targets: GPUColorTargetState[] = hook
        ? [...hook.targets]
        : Array.from({ length: mode === 'occlusion' ? 2 : 1 }, () => ({ format: 'rgba16float' })),
      compare = external?.depthCompare ?? 'greater-equal',
      target = `${mode}|${samples}|${c.descriptor.depthStencil!.format}|${compare}|${targets.map((t) => t.format).join(',')}`,
      key = `${target}|${code}`,
      post: NonNullable<Gpu['post']> = (gpu.post ??= {
        view: c.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        states: new Map(),
      });
    let state = post.states.get(key);
    if (!state) {
      state = {};
      post.states.set(key, state);
      const pending = state,
        module = c.device.createShaderModule({ code });
      const create = (layer: number) =>
        c.device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', constants: { EDGE: layer === 2 ? 0 : EDGE_PIXELS } },
          fragment: {
            module,
            entryPoint: 'fragment',
            constants: { MODE: layer === 0 ? 0 : layer === 2 ? 3 : samples > 1 && compare === 'equal' ? 2 : 1 },
            targets: targets.map((t, index) => ({
              ...t,
              ...(layer === 2 && mode !== 'gbuffer' && index === (mode === 'occlusion' ? 1 : 0)
                ? {
                    blend: {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                  }
                : {}),
            })),
          },
          primitive: { cullMode: layer === 0 ? 'back' : 'none' },
          depthStencil: {
            format: c.descriptor.depthStencil!.format,
            depthWriteEnabled: mode === 'capture',
            depthCompare: compare,
          },
          multisample: { count: samples },
        });
      Promise.all([create(0), create(1), ...(mode === 'capture' ? [] : [create(2)])])
        .then((layers) => {
          if (this.#gpu !== gpu) return;
          pending.ready = { target, layers, effects };
          for (const [old, value] of post.states)
            if (old !== key && value.ready?.target === target) post.states.delete(old);
        })
        .catch((error) => this.#engine?.onError(error));
    }
    const p = state.ready;
    if (!p) return;
    const view = external?.view ?? viewMatrix(this.#postView, c.camera);
    if (mode === 'gbuffer' || mode === 'occlusion') gpu.device.queue.writeBuffer(post.view, 0, Float32Array.from(view));
    if (p.groupVersion !== this.#resources) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: gpu.frame } },
        { binding: 1, resource: { buffer: gpu.pool } },
        { binding: 2, resource: { buffer: gpu.pageTable } },
        { binding: 3, resource: { buffer: gpu.origins } },
        { binding: 4, resource: { buffer: gpu.materials } },
        { binding: 5, resource: gpu.view! },
        { binding: 6, resource: gpu.sampler },
        ...(mode === 'gbuffer' || mode === 'occlusion' ? [{ binding: 7, resource: { buffer: post.view } }] : []),
      ];
      p.groups = p.layers.map((pipeline) =>
        gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
      );
      p.groupVersion = this.#resources;
    }
    if (effects.length) {
      const entries = effects.flatMap((e) => e.bindings()),
        bound = entries.map((e) => ('buffer' in e.resource ? e.resource.buffer : e.resource));
      if (!p.lights || bound.length !== p.lightBound!.length || bound.some((v, i) => v !== p.lightBound![i])) {
        p.lights = p.layers.map((pipeline) =>
          gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries }),
        );
        p.lightBound = bound;
      }
    }
    const pass = hook
      ? hook.begin()
      : (external?.pass ??
        c.encoder.beginRenderPass({
          colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: depth, depthReadOnly: true, stencilReadOnly: true },
        }));
    pass.setIndexBuffer(gpu.index, 'uint32');
    for (let layer = 0; layer < p.layers.length; layer++) {
      if ((phase === 'blend' && layer < 2) || (phase === 'opaque' && layer === 2)) continue;
      pass.setPipeline(p.layers[layer]);
      pass.setBindGroup(0, p.groups![layer]);
      if (p.lights) pass.setBindGroup(1, p.lights[layer]);
      if (layer < 2) {
        for (const chunk of this.#chunks.values())
          if (chunk.quads[layer]) pass.drawIndexedIndirect(gpu.args, chunk.slot * 40 + layer * 20);
      } else
        for (const chunk of this.#translucent) pass.drawIndexed(chunk.quads[2] * 6, 1, 0, chunk.start[2] * PAGE * 4, 0);
    }
    if (!hook && !external) pass.end();
  }

  /**
   * Changes whenever the shadow map must be drawn again: chunks with opaque or cutout quads arrive, change or leave
   * inside the last map's cascades, the textures or GPU buffers change, or the shadow pipelines become ready. `Shadows`
   * redraws a `static` source's map only then (and when its cascades move).
   */
  get shadowVersion(): number {
    return this.#shadowVersion;
  }

  /**
   * Lights the voxels with an effect's glTF-pro lighting hooks: `shadows.add(voxels, {static: true})`,
   * `clustered.add(voxels)`, `fog.add(voxels)` and `environment.add(voxels)` call this. The shader is composed again
   * and compiled in the background; until it is ready the previous one keeps drawing. Returns a remover.
   * @throws TypeError when `effect` has no `pbr` and `bindings` functions.
   * @throws MargoError `attached` when the effect belongs to another engine, `disposed` after `dispose()`.
   */
  addLighting(effect: VoxelRendererEffect): () => void {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelRenderer is disposed; attach a new one');
    if (!effect || typeof effect.pbr !== 'function' || typeof effect.bindings !== 'function')
      throw new TypeError(
        'VoxelRenderer lighting effects need pbr(group) and bindings(); pass Shadows, Clustered, Fog or EnvironmentLighting',
      );
    const owner = (effect as { owner?: unknown }).owner;
    if (owner && this.#engine && owner !== this.#engine)
      throw new MargoError(
        'attached',
        'VoxelRenderer lighting effect belongs to another engine; use one of this engine',
      );
    this.#effects.add(effect);
    return () => {
      this.#effects.delete(effect);
    };
  }

  /**
   * `Shadows` calls this per cascade (add the renderer with `shadows.add(voxels, {static: true})`): the opaque and
   * cutout chunks inside the cascade, culled on the CPU, into its depth pass. Translucent blocks cast no shadow.
   */
  drawShadow({ context, pass, matrix, cascade }: VoxelShadowContext): void {
    const gpu = this.#gpu;
    if (this.#disposed || !gpu || gpu.device !== context.device || !this.#chunks.size) return;
    const s = this.#shadowState(gpu);
    if (!s.ready) return;
    const frustum = (this.#shadowFrusta[cascade] ??= new Frustum()).setFromProjectionMatrix({ elements: matrix });
    s.values.set(matrix);
    s.values[16] = this.#time;
    gpu.device.queue.writeBuffer(s.uniform, cascade * 256, s.values);
    if (s.groupVersion !== this.#resources) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 1, resource: { buffer: gpu.pool } },
        { binding: 2, resource: { buffer: gpu.pageTable } },
        { binding: 3, resource: { buffer: gpu.origins } },
        { binding: 4, resource: { buffer: gpu.materials } },
        { binding: 5, resource: gpu.view! },
        { binding: 6, resource: gpu.sampler },
      ];
      s.groups = s.ready.map((pipeline, l) =>
        [0, 1, 2, 3].map((i) =>
          gpu.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: s.uniform, offset: i * 256, size: 80 } },
              ...entries.slice(0, l ? 6 : 3),
            ],
          }),
        ),
      );
      s.groupVersion = this.#resources;
    }
    pass.setIndexBuffer(gpu.index, 'uint32');
    for (let l = 0; l < 2; l++) {
      let bound = false;
      for (const chunk of this.#chunks.values()) {
        if (!chunk.quads[l] || !frustum.intersectsBox(this.#chunkBox(chunk))) continue;
        if (!bound) {
          pass.setPipeline(s.ready[l]);
          pass.setBindGroup(0, s.groups![l][cascade]);
          bound = true;
        }
        pass.drawIndexed(chunk.quads[l] * 6, 1, 0, chunk.start[l] * PAGE * 4, 0);
      }
    }
  }

  /** @internal Engine plugin hook. */
  setup(engine: Engine): void {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelRenderer is disposed; attach a new one');
    const device = engine.gpu;
    if (!device)
      throw new MargoError('unsupported', 'VoxelRenderer needs the WebGPU backend; create the engine with WebGPU');
    const limit = device.limits.maxStorageBufferBindingSize;
    if (this.#maxPages * PAGE_BYTES > limit)
      throw new RangeError(`VoxelRenderer maxQuadBytes is over this device's ${limit}-byte storage binding limit`);
    this.#engine = engine;
  }

  /** @internal Engine plugin hook: prepare (order -6), opaque and cutout (1), translucent (4.5). */
  registerPasses(graph: FrameGraph): void {
    const webgpu = (run: (c: Context) => void) => (c: PassContext) => {
      if (c.backend === 'webgpu' && !this.#disposed) run(c);
    };
    graph.add({ name: `${this.name}:prepare`, order: -6, execute: webgpu((c) => this.#prepare(c)) });
    graph.add({ name: this.name, order: 1, execute: webgpu((c) => this.#draw(c)) });
    graph.add({ name: `${this.name}:translucent`, order: 4.5, execute: webgpu((c) => this.#drawTranslucent(c)) });
  }

  /** @internal Engine plugin hook: the new device starts empty and every chunk is meshed again. */
  onDeviceRestored(): void {
    this.#restart();
  }

  /** Stops the workers, frees the GPU buffers and leaves the engine. The textures stay (dispose them yourself). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const callback of this.#disposeListeners) callback();
    this.#disposeListeners.clear();
    this.#capture = undefined;
    this.#engine?.removePlugin(this.name);
    this.#mesher.dispose();
    this.#release();
    this.#chunks.clear();
    this.#finished.clear();
    this.#known.clear();
    this.#effects.clear();
    this.#engine = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  // GPU state for `device`, made on first use (and after a device change: a restore).
  #device(device: GPUDevice): Gpu {
    if (this.#gpu?.device === device) return this.#gpu;
    if (this.#gpu) this.#restart();
    const buffer = (size: number, usage: number) => device.createBuffer({ size, usage });
    const index = device.createBuffer({ size: MAX_QUADS * 24, usage: GPUBufferUsage.INDEX, mappedAtCreation: true }),
      indices = new Uint32Array(index.getMappedRange());
    for (let q = 0, i = 0; q < MAX_QUADS; q++, i += 6) {
      const v = q * 4;
      indices[i] = indices[i + 3] = v;
      indices[i + 1] = v + 1;
      indices[i + 2] = indices[i + 4] = v + 2;
      indices[i + 5] = v + 3;
    }
    index.unmap();
    const pages = Math.min(this.#maxPages, Math.floor(FIRST_POOL / PAGE_BYTES)),
      storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.#pages = new Pages();
    this.#pages.grow(pages);
    this.#gpu = {
      device,
      frame: buffer(240, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      pool: buffer(pages * PAGE_BYTES, storage),
      pageTable: buffer(pages * 4, storage),
      origins: buffer(16, storage),
      args: buffer(40, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST),
      materials: buffer(16, storage),
      index,
      sampler: device.createSampler({
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        magFilter: 'nearest',
        minFilter: 'linear',
        mipmapFilter: 'linear',
      }),
      pipelines: new Map(),
    };
    this.#materialTypes = 0;
    this.#resources++;
    return this.#gpu;
  }

  // Drops every GPU object and chunk record and queues every chunk seen for meshing again (device change, restore).
  #restart(): void {
    this.#release();
    for (const key of this.#known) this.world.dirty.add(key);
    this.#chunks.clear();
    this.#finished.clear();
    this.#generation++;
  }

  #release(): void {
    const g = this.#gpu;
    if (g)
      for (const b of [
        g.frame,
        g.pool,
        g.pageTable,
        g.origins,
        g.args,
        g.materials,
        g.index,
        g.shadow?.uniform,
        g.post?.view,
      ])
        b?.destroy();
    this.#gpu = this.#ready = undefined;
    this.#shadowVersion++;
    this.#slots = [];
    this.#slotTop = 0;
    this.#origins = new Float32Array(0);
    this.#args = new Uint32Array(0);
    this.#translucent = [];
    this.#full = false;
  }

  #prepare(c: Context): void {
    const gpu = this.#device(c.device),
      { device } = gpu,
      eye: Vec3 = [c.camera.position[0], c.camera.position[1], c.camera.position[2]];
    this.#time += c.delta;
    this.#materials(gpu);
    const view = blockTextureView(this.textures, device);
    if (view !== gpu.view) {
      gpu.view = view;
      this.#resources++;
    }
    this.#submit(eye);
    this.#upload(gpu);
    if (this.#shadowResources !== this.#resources) {
      this.#shadowResources = this.#resources;
      this.#shadowVersion++;
    }
    // Frame uniform: camera, its inverse (for the per-pixel plane hits), eye, engine lighting, daylight, block light
    // colour, time, target size and the HDR flag in settings.w (no tone mapping on rgba16float targets).
    const f = this.#frame,
      lighting = this.#engine!.lighting;
    if (!invertMatrix(c.camera.matrix, this.#inverse)) return;
    f.set(c.camera.matrix);
    f.set(this.#inverse, 16);
    f.set(eye, 32);
    f.set(lighting.direction, 36);
    f.set(lighting.radiance, 40);
    f.set(lighting.ambient ?? [1, 1, 1], 44);
    f[47] = this.#daylight;
    f.set(this.#blockLight, 48);
    f[51] = this.#time;
    f[52] = c.width;
    f[53] = c.height;
    f[54] = 1 / c.width;
    f[55] = 1 / c.height;
    f[59] = +(c.format === 'rgba16float');
    device.queue.writeBuffer(gpu.frame, 0, f);
    this.#cull(c, gpu, eye);
    const ready = this.#pipelines(c, gpu);
    this.#ready = ready;
    if (ready) this.#bundle(c, gpu, ready);
    else this.#stats.draws = 0; // nothing is drawn until the pipelines are compiled
  }

  // The material table: 16 bytes per material id of blockMaterials, rebuilt when block types are added.
  #materials(gpu: Gpu): void {
    const table = this.world.blocks.table;
    if (table.length === this.#materialTypes) return;
    this.#materialTypes = table.length;
    const ids = blockMaterials(table);
    let count = 1;
    for (const id of ids) if (id !== 0xffff) count = Math.max(count, id + 1);
    const data = new Uint32Array(count * 4),
      floats = new Float32Array(data.buffer),
      srgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    for (let id = 0; id < table.length; id++)
      for (let face = 0; face < 6; face++) {
        const m = ids[id * 6 + face],
          t = table[id];
        if (m === 0xffff) continue;
        const solid = !this.#fancyLeaves && t.layer === 'cutout' && t.shape === 'cube';
        data[m * 4] = t.textures[face] | ((t.animation.frames - 1) << 8) | (+solid << 16);
        data[m * 4 + 1] = (srgb(t.color[0]) | (srgb(t.color[1]) << 8) | (srgb(t.color[2]) << 16) | (255 << 24)) >>> 0;
        data[m * 4 + 2] =
          (Math.round(t.roughness * 255) |
            (Math.round(t.metalness * 255) << 8) |
            (Math.min(65535, Math.round(t.animation.fps * 256)) << 16)) >>>
          0;
        floats[m * 4 + 3] = t.emissive;
      }
    if (gpu.materials.size < data.byteLength) {
      gpu.materials.destroy();
      gpu.materials = gpu.device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#resources++;
    }
    gpu.device.queue.writeBuffer(gpu.materials, 0, data);
  }

  // Sends the world's dirty chunks to the mesher, nearest first; a removed chunk's mesh goes at once.
  #submit(eye: Vec3): void {
    const world = this.world;
    for (const key of world.dirty) {
      world.dirty.delete(key);
      const [cx, cy, cz] = key.split(',').map(Number),
        chunk = world.getChunk(cx, cy, cz);
      if (!chunk) {
        this.#mesher.cancel(key);
        this.#drop(key);
        this.#finished.delete(key);
        this.#known.delete(key);
        continue;
      }
      this.#known.add(key);
      const priority = Math.hypot(cx * 32 + 16 - eye[0], cy * 32 + 16 - eye[1], cz * 32 + 16 - eye[2]),
        generation = this.#generation,
        state = uniformState(chunk);
      // All air (an invisible block in every cell) has no faces whatever its neighbours hold: no shell, no worker.
      if (state !== undefined && world.blocks.table[state & 0xffff]?.layer === 'invisible') {
        this.#mesher.cancel(key);
        this.#finished.set(key, { mesh: AIR, priority, eye });
        continue;
      }
      this.#mesher.mesh(world, key, priority, eye).then(
        (mesh) => {
          if (mesh && generation === this.#generation && !this.#disposed)
            this.#finished.set(key, { mesh, priority, eye });
        },
        (error) => this.#engine?.onError(error),
      );
    }
  }

  // Finished meshes into the pool, nearest first, about 4 MiB per frame; then near translucent chunks re-sorted.
  #upload(gpu: Gpu): void {
    if (this.#finished.size && !this.#full) {
      const list = [...this.#finished].sort((a, b) => a[1].priority - b[1].priority);
      let bytes = 0;
      for (const [key, finished] of list) {
        if (bytes >= UPLOAD_BYTES) break;
        const { opaque, cutout, translucent } = finished.mesh,
          placed = this.#place(gpu, key, finished);
        if (!placed) {
          this.#full = true; // until pages are freed
          break;
        }
        this.#finished.delete(key);
        bytes += opaque.byteLength + cutout.byteLength + translucent.byteLength;
      }
    }
  }

  // Puts a mesh's layers in pages (in place when they still fit) and writes them; false when the pool is full.
  #place(gpu: Gpu, key: string, { mesh, eye }: Finished): boolean {
    const layers = [mesh.opaque, mesh.cutout, mesh.translucent];
    if (!layers.some((l) => l.length)) {
      this.#drop(key);
      return true;
    }
    let chunk = this.#chunks.get(key);
    if (!chunk) {
      const [cx, cy, cz] = key.split(',').map(Number);
      chunk = {
        key,
        x: cx * 32,
        y: cy * 32,
        z: cz * 32,
        slot: -1,
        start: new Int32Array(3),
        pages: new Int32Array(3),
        quads: new Int32Array(3),
        sortedAt: eye,
      };
      this.#chunks.set(key, chunk);
    }
    if (chunk.slot < 0) chunk.slot = this.#slot(gpu, chunk);
    if (chunk.quads[0] || chunk.quads[1] || mesh.opaque.length || mesh.cutout.length) this.#shadowChanged(chunk);
    for (let l = 0; l < 3; l++) {
      const quads = layers[l].length / 3,
        need = Math.ceil(quads / PAGE);
      if (need > chunk.pages[l]) {
        this.#pages.release(chunk.start[l], chunk.pages[l]);
        chunk.pages[l] = 0;
        const start = this.#alloc(gpu, need);
        if (start < 0) {
          this.#drop(key);
          return false;
        }
        chunk.start[l] = start;
      } else this.#pages.release(chunk.start[l] + need, chunk.pages[l] - need);
      if (l < 2 && !quads !== !chunk.quads[l]) this.#residency++;
      chunk.pages[l] = need;
      chunk.quads[l] = quads;
    }
    for (let l = 0; l < 3; l++)
      if (chunk.quads[l]) {
        gpu.device.queue.writeBuffer(gpu.pool, chunk.start[l] * PAGE_BYTES, layers[l]);
        gpu.device.queue.writeBuffer(
          gpu.pageTable,
          chunk.start[l] * 4,
          new Uint32Array(chunk.pages[l]).fill(chunk.slot),
        );
      }
    chunk.translucent = mesh.translucent.length ? mesh.translucent : undefined;
    chunk.sortedAt = eye;
    return true;
  }

  // Pages from the pool, growing it (doubling, up to maxQuadBytes) when no run is long enough; -1 when full.
  #alloc(gpu: Gpu, n: number): number {
    const pages = this.#pages;
    let start = pages.alloc(n);
    while (start < 0 && pages.capacity < this.#maxPages) {
      const capacity = Math.min(this.#maxPages, Math.max(pages.capacity * 2, pages.capacity + n)),
        { device } = gpu,
        usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        pool = device.createBuffer({ size: capacity * PAGE_BYTES, usage }),
        table = device.createBuffer({ size: capacity * 4, usage }),
        encoder = device.createCommandEncoder();
      // Its own submission, so this frame's earlier writes are copied and later ones land in the new buffers.
      encoder.copyBufferToBuffer(gpu.pool, 0, pool, 0, pages.capacity * PAGE_BYTES);
      encoder.copyBufferToBuffer(gpu.pageTable, 0, table, 0, pages.capacity * 4);
      device.queue.submit([encoder.finish()]);
      gpu.pool.destroy();
      gpu.pageTable.destroy();
      gpu.pool = pool;
      gpu.pageTable = table;
      pages.grow(capacity);
      this.#resources++;
      start = pages.alloc(n);
    }
    return start;
  }

  // A chunk slot (its origin and indirect arguments), growing the tables by doubling.
  #slot(gpu: Gpu, chunk: Chunk): number {
    const slot = this.#slots.pop() ?? this.#slotTop++;
    if (slot * 4 < this.#origins.length) {
      this.#origins.set([chunk.x, chunk.y, chunk.z, 0], slot * 4);
      gpu.device.queue.writeBuffer(gpu.origins, slot * 16, this.#origins, slot * 4, 4);
    } else {
      const capacity = Math.max(64, this.#slotTop * 2),
        origins = new Float32Array(capacity * 4),
        args = new Uint32Array(capacity * 10);
      origins.set(this.#origins);
      args.set(this.#args);
      this.#origins = origins;
      this.#args = args;
      gpu.origins.destroy();
      gpu.args.destroy();
      gpu.origins = gpu.device.createBuffer({
        size: origins.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      gpu.args = gpu.device.createBuffer({
        size: args.byteLength,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      });
      this.#resources++;
      origins.set([chunk.x, chunk.y, chunk.z, 0], slot * 4);
      gpu.device.queue.writeBuffer(gpu.origins, 0, origins);
    }
    return slot;
  }

  // Frees a chunk's pages and slot.
  #drop(key: string): void {
    const chunk = this.#chunks.get(key);
    if (!chunk) return;
    this.#chunks.delete(key);
    for (let l = 0; l < 3; l++) this.#pages.release(chunk.start[l], chunk.pages[l]);
    if (chunk.slot >= 0) {
      this.#slots.push(chunk.slot);
      this.#args.fill(0, chunk.slot * 10, chunk.slot * 10 + 10);
    }
    if (chunk.quads[0] || chunk.quads[1]) {
      this.#residency++;
      this.#shadowChanged(chunk);
    }
    this.#full = false;
  }

  #chunkBox(chunk: Chunk): { min: Vec3Like; max: Vec3Like } {
    const box = this.#box;
    box.min.x = chunk.x;
    box.min.y = chunk.y;
    box.min.z = chunk.z;
    box.max.x = chunk.x + 32;
    box.max.y = chunk.y + 32;
    box.max.z = chunk.z + 32;
    return box;
  }

  // A chunk's opaque or cutout quads change: the static shadow map is drawn again if the chunk is in one of its cascades.
  #shadowChanged(chunk: Chunk): void {
    const frusta = this.#shadowFrusta;
    if (!frusta.length) this.#shadowVersion++;
    else {
      const box = this.#chunkBox(chunk);
      if (frusta.some((f) => f?.intersectsBox(box))) this.#shadowVersion++;
    }
  }

  // The shadow uniform (four 256-byte cascade slots) and pipelines, compiled asynchronously on first use; the map is
  // drawn again once they are ready.
  #shadowState(gpu: Gpu): ShadowState {
    if (gpu.shadow) return gpu.shadow;
    const device = gpu.device,
      s: ShadowState = {
        uniform: device.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        values: new Float32Array(20),
      },
      module = device.createShaderModule({ code: SHADOW_SHADER }),
      create = (cutout: boolean) =>
        device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'shadowVertex' },
          ...(cutout ? { fragment: { module, entryPoint: 'shadowCutout', targets: [] } } : {}),
          primitive: { cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
        });
    gpu.shadow = s;
    Promise.all([create(false), create(true)])
      .then((pipelines) => {
        if (this.#gpu !== gpu) return;
        s.ready = pipelines;
        this.#shadowVersion++;
      })
      .catch((error) => this.#engine?.onError(error));
    return s;
  }

  // This frame's shader: the lit part composed with every added effect that is ready (pbr(1) gives hooks), and those
  // effects (their bindings fill group 1 in order). Hooks and compositions are cached by the effects and lightPBR.
  #composition(): { code: string; effects: VoxelRendererEffect[] } {
    let code = SHADER;
    const effects: VoxelRendererEffect[] = [];
    for (const effect of this.#effects) {
      const hooks = effect.pbr(1);
      if (!hooks) continue;
      code = lightPBR(code, hooks as PBRHooks);
      effects.push(effect);
    }
    const composed = this.#composed;
    if (composed.from !== code) {
      composed.from = code;
      composed.code = code.includes('var<uniform> shadowFrame') ? code.replace(SUN, SHADOWED_SUN) : code;
    }
    return { code: composed.code, effects };
  }

  // Frustum cull per chunk into the indirect arguments, the translucent chunks sorted back to front, stats.
  #cull(c: Context, gpu: Gpu, eye: Vec3): void {
    const frustum = this.#frustum.fromArray(c.camera.planes),
      args = this.#args,
      list = this.#translucent,
      stats = this.#stats,
      distance = (k: Chunk) => (k.x + 16 - eye[0]) ** 2 + (k.y + 16 - eye[1]) ** 2 + (k.z + 16 - eye[2]) ** 2;
    list.length = stats.chunks = stats.visible = stats.quads = stats.draws = 0;
    for (const chunk of this.#chunks.values()) {
      const seen = frustum.intersectsBox(this.#chunkBox(chunk)),
        a = chunk.slot * 10;
      for (let l = 0; l < 2; l++) {
        args[a + l * 5] = chunk.quads[l] * 6;
        args[a + l * 5 + 1] = +(seen && chunk.quads[l] > 0);
        args[a + l * 5 + 2] = 0;
        args[a + l * 5 + 3] = chunk.start[l] * PAGE * 4;
        args[a + l * 5 + 4] = 0;
        stats.draws += args[a + l * 5 + 1];
      }
      stats.chunks++;
      stats.quads += chunk.quads[0] + chunk.quads[1] + chunk.quads[2];
      if (seen) stats.visible++;
      if (seen && chunk.quads[2]) list.push(chunk);
    }
    stats.bytes = this.#pages.used * PAGE_BYTES;
    stats.draws += list.length;
    if (this.#slotTop) gpu.device.queue.writeBuffer(gpu.args, 0, args, 0, this.#slotTop * 10);
    list.sort((a, b) => distance(b) - distance(a));
    // Quad order inside near chunks, from the camera's position, when it moved RESORT blocks since the last sort.
    for (let i = list.length - 1, n = 0; i >= 0 && n < RESORTS; i--) {
      const k = list[i];
      if (distance(k) > NEAR * NEAR) break;
      if (!k.translucent || Math.hypot(eye[0] - k.sortedAt[0], eye[1] - k.sortedAt[1], eye[2] - k.sortedAt[2]) < RESORT)
        continue;
      sortQuads(k.translucent, [eye[0] - k.x, eye[1] - k.y, eye[2] - k.z]);
      gpu.device.queue.writeBuffer(gpu.pool, k.start[2] * PAGE_BYTES, k.translucent);
      k.sortedAt = eye;
      n++;
    }
  }

  // The three pipelines for this target (format, samples, depth format) and composed shader, compiled asynchronously.
  // While a new composition compiles, the last pipelines for the target keep drawing as long as their effects are
  // still added; undefined when there are none.
  #pipelines(c: Context, gpu: Gpu): Pipelines | undefined {
    const samples = c.descriptor.multisample?.count ?? 1,
      depth = c.descriptor.depthStencil!.format,
      target = `${c.format}|${samples}|${depth}`,
      { code, effects } = this.#composition(),
      key = `${target}|${code}`;
    let entry = gpu.pipelines.get(key);
    if (!entry) {
      const device = gpu.device,
        module = device.createShaderModule({ code }),
        pending: { ready?: Pipelines } = {},
        over = { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } as const,
        create = (mode: number, write: boolean, blend?: GPUBlendState) =>
          device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex', constants: { EDGE: mode === 3 ? 0 : EDGE_PIXELS } },
            fragment: {
              module,
              entryPoint: 'fragment',
              constants: { MODE: mode },
              targets: [{ format: c.format, blend }],
            },
            primitive: { cullMode: mode ? 'none' : 'back' },
            depthStencil: { format: depth, depthWriteEnabled: write, depthCompare: 'greater-equal' },
            multisample: { count: samples, alphaToCoverageEnabled: mode === 2 },
          });
      gpu.pipelines.set(key, (entry = pending));
      Promise.all([create(0, true), create(samples > 1 ? 2 : 1, true), create(3, false, { color: over, alpha: over })])
        .then((layers) => {
          if (this.#gpu !== gpu) return;
          pending.ready = { target, layers, effects };
          // Older compositions for this target are dropped once a newer one is ready.
          for (const [k, e] of gpu.pipelines)
            if (e.ready && e !== pending && e.ready.target === target) gpu.pipelines.delete(k);
        })
        .catch((error) => this.#engine?.onError(error));
    }
    if (entry.ready) return entry.ready;
    const last = this.#ready;
    return last?.target === target && last.effects.every((e) => this.#effects.has(e) && e.pbr(1)) ? last : undefined;
  }

  // Bind groups (per pipeline: 'auto' layouts) and the opaque + cutout bundle, re-recorded only when the chunk layers
  // with quads, a buffer, the textures or the target change. Culling changes only the indirect arguments.
  #bundle(c: Context, gpu: Gpu, p: Pipelines): void {
    if (p.groupVersion !== this.#resources) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: gpu.frame } },
        { binding: 1, resource: { buffer: gpu.pool } },
        { binding: 2, resource: { buffer: gpu.pageTable } },
        { binding: 3, resource: { buffer: gpu.origins } },
        { binding: 4, resource: { buffer: gpu.materials } },
        { binding: 5, resource: gpu.view! },
        { binding: 6, resource: gpu.sampler },
      ];
      p.groups = p.layers.map((pipeline) =>
        gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
      );
      p.groupVersion = this.#resources;
    }
    // Group 1: the effects' bindings, in composition order; new bind groups when any of their resources changes.
    if (p.effects.length) {
      const entries = p.effects.flatMap((e) => e.bindings()),
        bound = entries.map((e) => ('buffer' in e.resource ? e.resource.buffer : e.resource));
      if (!p.lights || bound.length !== p.lightBound!.length || bound.some((x, i) => x !== p.lightBound![i])) {
        p.lights = p.layers.map((pipeline) =>
          gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries }),
        );
        p.lightBound = bound;
        p.lightVersion = ++this.#lightVersion;
      }
    }
    const key = `${this.#resources}|${this.#residency}|${p.lightVersion}`;
    if (p.bundleKey === key) return;
    const encoder = gpu.device.createRenderBundleEncoder({
      colorFormats: [c.format],
      depthStencilFormat: c.descriptor.depthStencil!.format,
      sampleCount: c.descriptor.multisample?.count ?? 1,
      stencilReadOnly: true,
    });
    encoder.setIndexBuffer(gpu.index, 'uint32');
    for (let l = 0; l < 2; l++) {
      encoder.setPipeline(p.layers[l]);
      encoder.setBindGroup(0, p.groups![l]);
      if (p.lights) encoder.setBindGroup(1, p.lights[l]);
      for (const chunk of this.#chunks.values())
        if (chunk.quads[l]) encoder.drawIndexedIndirect(gpu.args, chunk.slot * 40 + l * 20);
    }
    p.bundle = encoder.finish();
    p.bundleKey = key;
  }

  #pass(c: Context): GPURenderPassEncoder {
    return c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
    });
  }

  #draw(c: Context): void {
    const p = this.#ready;
    if (!p?.bundle || !this.#chunks.size) return;
    const pass = this.#pass(c);
    pass.executeBundles([p.bundle]);
    pass.end();
    this.#engine!.stats.drawCalls += this.#stats.draws - this.#translucent.length;
  }

  #drawTranslucent(c: Context): void {
    const p = this.#ready,
      gpu = this.#gpu;
    if (!p?.groups || !gpu || !this.#translucent.length) return;
    const pass = this.#pass(c);
    pass.setPipeline(p.layers[2]);
    pass.setBindGroup(0, p.groups[2]);
    if (p.lights) pass.setBindGroup(1, p.lights[2]);
    pass.setIndexBuffer(gpu.index, 'uint32');
    for (const k of this.#translucent) pass.drawIndexed(k.quads[2] * 6, 1, 0, k.start[2] * PAGE * 4, 0);
    pass.end();
    this.#engine!.stats.drawCalls += this.#translucent.length;
  }
}
