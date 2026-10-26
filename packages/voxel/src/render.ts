/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/render: draws a VoxelWorld (packages/voxel/DESIGN.md, "Renderer"). Quads live in one storage buffer
// in 64-quad pages and are pulled by vertex index; each chunk layer is one drawIndexedIndirect whose instance count the
// CPU frustum cull sets, opaque and cutout replayed from a render bundle, translucent drawn back to front. With a bevel,
// cube faces become a chamfered triangle mesh per chunk layer instead (crosses and liquids stay quads).
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
import { displayShader } from '../../shared/display.js';
import { clusterBrdf, ggxDFloat, smithGFloat } from '../../shared/light-terms.js';
import { lightPBR, type PBRHooks } from '../../shared/pbr-hooks.js';
import { viewMatrix } from '../../shared/view.js';
import { applyView } from '../../shared/view-rect.js';
import type { CubeFace, VoxelBevel } from './bevel.js';
import { uniformState } from './chunk.js';
import { normalShader, tileShader } from './faces.js';
import { blockMaterials, type ChunkMesh, decodeQuad, quadCenters, sortQuads, VoxelMesher } from './mesher.js';
import { voxelPostShader } from './render-post.js';
import type { VoxelLightmap } from './lightmap.js';
import { BlockTextures, blockTextureView } from './textures.js';
import type { VoxelWorld } from './world.js';
import { alphaBlend } from '../../shared/pass.js';

export type { VoxelLightmap } from './lightmap.js';
export { type BlockPixels, BlockTextures, type BlockTexturesOptions } from './textures.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  INDEX: number;
  INDIRECT: number;
  COPY_SRC: number;
  COPY_DST: number;
  VERTEX: number;
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
  EDGE_PIXELS = 1 / 128,
  OVER = { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } as const;

// Material table, block textures and sampler (group 0 bindings 4-6), shared by every voxel shader. A material is two
// vec4u (eight words): [layer 11 | frames - 1 11 | solid 1, sRGB tint, roughness 8 | metalness 8 | fps * 256 16,
// emissive f32] and [normal layer 11 | roughness layer 11, scatter f32, emissive layer 11 | transmission 8, 0].
// voxelLayer is a material's texture layer at time t (its animation); voxelOpaque the cutout test of a shadow caster.
const MATERIALS = /* wgsl */ `
@group(0) @binding(4) var<storage,read> voxelMaterials:array<vec4u>;
@group(0) @binding(5) var voxelTextures:texture_2d_array<f32>;
@group(0) @binding(6) var voxelSampler:sampler;
fn voxelLayer(m:vec4u,t:f32)->u32 {return (m.x&2047u)+u32(floor(t*f32(m.z>>16u)/256.0))%(((m.x>>11u)&2047u)+1u);}
fn voxelOpaque(m:vec4u,uv:vec2f,t:f32)->bool {return (m.x&4194304u)!=0u||textureSampleLevel(voxelTextures,voxelSampler,uv,voxelLayer(m,t),0.0).a>=0.5;}
`;
// Group 0 bindings 1-3 of the quad shaders: quad pool, page -> chunk slot, slot -> chunk origin. Vertex pulling: quad =
// vertex_index >> 2, corner = vertex_index & 3, chunk = pages[quad >> 6]. voxelPlace gives corner c of a quad, (0, 0),
// (w, 0), (w, h) or (0, h) along the face's u and v (see ChunkMesh), with a liquid's lowered top and the half-block
// inset and trims of slab and stair faces (word 1 bits 21-25: voxelPart); voxelRise lifts the
// surface of a liquid with the wave bit by the same height everywhere at time t, so merged and unit quads, tops and
// sides and neighbouring chunks stay joined (the ripples are in the shading normal, voxelRipple). voxelTile maps
// chunk-local point l on a face to texture coordinates in blocks (the sampler repeats), v running down the sides
// (generated from faces.ts TILE, as the bevel mesh's `tile`).
const QUADS = /* wgsl */ `${MATERIALS}
@group(0) @binding(1) var<storage,read> voxelQuads:array<u32>;
@group(0) @binding(2) var<storage,read> voxelPages:array<u32>;
@group(0) @binding(3) var<storage,read> voxelOrigins:array<vec4f>;
fn voxelRise(w1:u32,t:f32)->f32 {return select(0.0,0.04*sin(t*1.6),(w1&0x100000u)!=0u);}
// voxelPart: a quad's start and end along u and v in blocks from its cell, and its plane's offset along the normal.
struct VoxelPart {lo:vec2f,hi:vec2f,n:f32}
fn voxelPart(w0:u32,w1:u32)->VoxelPart {
 let b=vec4f(vec4u(w1>>22u,w1>>23u,w1>>24u,w1>>25u)&vec4u(1u))*0.5;
 let size=vec2f(f32(((w0>>18u)&31u)+1u),f32(((w0>>23u)&31u)+1u));
 return VoxelPart(b.xz,size-b.yw,abs(f32(((w0>>15u)&1u)==0u)-f32((w1>>21u)&1u)*0.5));
}
fn voxelPlace(w0:u32,w1:u32,c:u32,t:f32)->vec3f {
 let face=(w0>>15u)&7u;let r=voxelPart(w0,w1);let su=select(r.lo.x,r.hi.x,c==1u||c==2u);let sv=select(r.lo.y,r.hi.y,c>=2u);
 var p=vec3f(f32(w0&31u),f32((w0>>5u)&31u),f32((w0>>10u)&31u));
 switch face {
  case 0u,1u {p+=vec3f(r.n,sv,su);}
  case 2u,3u {p+=vec3f(su,r.n,sv);}
  case 4u,5u {p+=vec3f(su,sv,r.n);}
  case 6u {p+=vec3f(su,sv,su);}
  default {p+=vec3f(1.0-su,sv,su);}
 }
 if(face==2u||(face!=3u&&face<6u&&c>=2u)){p.y+=voxelRise(w1,t)-f32(w0>>29u)*0.125;}
 // A lowered liquid side cut to half a block (beside a slab or stair) keeps its corners at or under the surface.
 if((w0>>29u)!=0u&&(face<2u||(face>3u&&face<6u))&&(w1&0x3000000u)!=0u){
  let y0=f32((w0>>5u)&31u);p.y=min(y0+select(r.lo.y,r.hi.y,c>=2u),y0+1.0-f32(w0>>29u)*0.125)+select(0.0,voxelRise(w1,t),c>=2u);
 }
 return p;
}
${tileShader}`;
// Sky visibility of the sun: without a shadow map the sun reaches a face as far as the open sky does. With one
// (`shadows.add(voxels)`), the map decides inside its range and sky visibility fades back in over the last tenth of it;
// this reads the shadows package's own uniform (shadowFrame.view and splits.w, its receivers' "outside" test).
const SUN = 'fn voxelSun(p:vec3f,sky:f32)->f32 {return sky*sky;}',
  SHADOWED_SUN =
    'fn voxelSun(p:vec3f,sky:f32)->f32 {let d=-(shadowFrame.view*vec4f(p,1.0)).z;return mix(1.0,sky*sky,smoothstep(0.9*shadowFrame.splits.w,shadowFrame.splits.w,d));}';

// The lit part of both beauty shaders (quads and bevel triangles): frame uniform, surface, sun, ambient and the PBR
// direct term. `f.glow` is the block light colour and time, `f.ambient.w` the daylight. MODE: 0 opaque, 1 cutout (alpha
// test), 2 cutout (alpha to coverage), 3 translucent (premultiplied).
// direct_light: GGX D (Walter et al. 2007, eq. 33), Smith G (Heitz 2014), Schlick 1994 Fresnel, F0 0.04 from
// glTF 2.0 Appendix B. ambient: Margo design (the gltf-pro hemisphere ground tint and f0*0.5 specular share).
const LIT = /* wgsl */ `${displayShader}
struct Frame {camera:mat4x4f,inverse:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f,glow:vec4f,viewport:vec4f,settings:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
override MODE:u32=0u;
struct Surface {base:vec4f,n:vec3f,roughness:f32,metal:f32,occlusion:f32,emissive:vec3f}
struct VoxelPixel {clip:vec4f,position:vec3f}
${normalShader}${SUN}
fn ambient(s:Surface)->vec3f {let f0=mix(vec3f(0.04),s.base.rgb,s.metal);return (s.base.rgb*(1.0-s.metal)+f0*0.5)*mix(vec3f(0.35,0.3,0.25),vec3f(1.0),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.ambient.rgb*f.radiance.w*s.occlusion;}
fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {
 let h=(v+l)/max(length(v+l),0.0001);
 let nl=clamp(dot(s.n,l),0.0,1.0);let nv=clamp(dot(s.n,v),0.0001,1.0);let nh=clamp(dot(s.n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let a=s.roughness*s.roughness;let a2=a*a;let d=${ggxDFloat};
 let g=${smithGFloat};
 let base=s.base.rgb;let metal=s.metal;let f0=mix(vec3f(0.04),base,metal);let fresnel=f0+(1.0-f0)*pow(1.0-vh,5.0);
 return ${clusterBrdf}*nl*f.radiance.rgb*f.light.w;
}
`;
// The shared end of both beauty fragments. It reads material m and maps (the two vec4u), tile uv with its screen
// gradients dx and dy, lit (corner AO 0-3, sky 0-15, block 0-15), the shading normal `normal` (facing the viewer),
// `outward` (the surface's own outward normal, for baked light), the face tangent and pixel i. Sky light scales the
// ambient term and the sun, so caves and nights stay dark. Its lines keep gltf-pro's hook points
// (packages/shared/pbr-hooks.js) for shadows, clustered lights, IBL and fog. Transmission (MODE 3) lowers alpha and
// mixes in the base colour; scatter halves that see-through part at 1.
// Constants: sRGB decode per IEC 61966-2-1; roughness floor 0.045 is the minimum perceptual roughness of the
// Filament design document (published engine standard); AO 0.4 + 0.2 x level and the 0.03 ambient floor are Margo
// design (the corner AO rule itself is Lysenko 2013, see mesher.ts).
const SHADE = /* wgsl */ `
 let tc=unpack4x8unorm(m.y).rgb;let tint=select(tc/12.92,pow((tc+0.055)/1.055,vec3f(2.4)),tc>vec3f(0.04045));
 let texel=textureSampleGrad(voxelTextures,voxelSampler,uv,voxelLayer(m,f.glow.w),dx,dy);
 var s:Surface;s.base=vec4f(texel.rgb*tint,select(texel.a,1.0,(m.x&4194304u)!=0u));
 if(MODE==1u&&s.base.a<0.5){discard;}
 s.n=normal;s.roughness=clamp(f32(m.z&255u)/255.0,0.045,1.0);s.metal=f32((m.z>>8u)&255u)/255.0;
 let nLayer=maps.x&2047u;if(nLayer!=0u){s.n=voxelNormal(normal,tangent,textureSampleGrad(voxelTextures,voxelSampler,uv,nLayer,dx,dy).rgb*2.0-1.0);}
 let rLayer=(maps.x>>11u)&2047u;if(rLayer!=0u){s.roughness=clamp(textureSampleGrad(voxelTextures,voxelSampler,uv,rLayer,dx,dy).r,0.045,1.0);}
 let eLayer=maps.z&2047u;var eMap=1.0;if(eLayer!=0u){eMap=textureSampleGrad(voxelTextures,voxelSampler,uv,eLayer,dx,dy).r;}
 // Light level 0-15 to brightness: each level is an equal step in CIE L* lightness (CIE 15:2004), 0 at level 0
 // and 100 at level 15, turned back into relative luminance Y with the CIE inverse (((L+16)/116)^3 above L* 8,
 // L/(24389/27) below). Equal steps look evenly spaced on screen while the low levels stay dark (level 1 is 0.7%,
 // level 7 is 16%), so caves and night read dark. Sky and block light share the curve.
 let sky=clamp(lit.y,0.0,15.0);let block=clamp(lit.z,0.0,15.0);
 let lightness=vec2f(sky,block)*100.0/15.0;let cube=(lightness+16.0)/116.0;
 let brightness=select(lightness*(27.0/24389.0),cube*cube*cube,lightness>vec2f(8.0));let skyLight=brightness.x;
 let ao=0.4+0.2*lit.x;
 s.occlusion=ao*(0.03+skyLight*f.ambient.w);
 s.emissive=s.base.rgb*(bitcast<f32>(m.w)*eMap+brightness.y*ao*f.glow.rgb);
 let v=normalize(f.eye.xyz-i.position);let lightDirection=normalize(f.light.xyz);
 let direct=direct_light(s,v,lightDirection)*voxelSun(i.position,skyLight);
 var color=direct+ambient(s)+s.emissive;
 if(f.settings.w<0.5) {color=toDisplay(color);}
 if(MODE==3u){let through=f32((maps.z>>11u)&255u)/255.0*(1.0-bitcast<f32>(maps.y)*0.5);let alpha=s.base.a*(1.0-through*0.85);return vec4f((color*(1.0-through)+s.base.rgb*through)*alpha,alpha);}
 return vec4f(color,select(1.0,s.base.a,MODE==2u));
}`;

// The quad beauty shader. EDGE: pixels a merged quad's edges move out. T-junctions: neighbours' corners lie on a merged
// quad's edges, and once the rasterizer snaps them to its subpixel grid a sliver between the two can stay uncovered;
// voxelStretch moves each edge EDGE pixels out along the quad's own edges in clip space (so it stays in its plane): EDGE
// over the quad's on-screen thickness there, at most a pixel and half the quad, 0 for an edge under 1/16 pixel long,
// whose direction is too uncertain. Unit quads share all their corners with their neighbours and stay as they are;
// half-block quads (a slab beside a cube) do not, so they stretch too.
// The fragment shades from voxelHit, the point where the pixel's ray meets the face's plane (never from interpolated
// attributes), so a greedy quad shades its pixels bit for bit like the unit faces it covers; AO and light (voxelCorner)
// are mixed bilinearly with voxelMix, which returns a exactly when a == b; texture gradients come from the neighbouring
// pixels' hits.
const SHADER = /* wgsl */ `${LIT}${QUADS}
override EDGE:f32=0.0;
struct Out {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) words:vec3u,@location(1) @interpolate(flat) origin:vec4f,@location(2) @interpolate(flat) material:vec4u,@location(3) @interpolate(flat) maps:vec4u}
fn voxelStretch(s:vec2f,along:vec2f,across:vec2f)->f32 {
 let d=s-along;let l=length(d);let a=s-across;if(l<0.0625){return 0.0;}
 return min(min(EDGE/max(abs(dot(vec2f(-d.y,d.x)/l,a)),0.000001),0.5),1.0/max(length(a),0.000001));
}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Out {
 let q=index>>2u;let w0=voxelQuads[q*3u];let w1=voxelQuads[q*3u+1u];let face=(w0>>15u)&7u;var c=index&3u;let t=f.glow.w;
 if((w0&0x10000000u)!=0u){c=(c+1u)&3u;}
 if(face==0u||face==2u||face==5u){c=(4u-c)&3u;}
 let origin=voxelOrigins[voxelPages[q>>6u]];var clip=f.camera*vec4f(origin.xyz+voxelPlace(w0,w1,c,t),1.0);
 if(EDGE>0.0&&(((w0>>18u)&0x3ffu)!=0u||(w1&0x3e00000u)!=0u)){
  let u=f.camera*vec4f(origin.xyz+voxelPlace(w0,w1,c^1u,t),1.0);let v=f.camera*vec4f(origin.xyz+voxelPlace(w0,w1,3u-c,t),1.0);
  if(clip.w>0.0&&u.w>0.0&&v.w>0.0){
   let half=f.viewport.xy*0.5;let s=clip.xy/clip.w*half;let su=u.xy/u.w*half;let sv=v.xy/v.w*half;
   clip+=voxelStretch(s,su,sv)*(clip-v)+voxelStretch(s,sv,su)*(clip-u);
  }
 }
 var o:Out;o.clip=clip;o.words=vec3u(w0,w1,voxelQuads[q*3u+2u]);o.origin=origin;o.material=voxelMaterials[(w1&4095u)*2u];o.maps=voxelMaterials[(w1&4095u)*2u+1u];return o;
}
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
@fragment fn fragment(o:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
 let w=o.words;let face=(w.x>>15u)&7u;let O=o.origin.xyz;let t=f.glow.w;let drop=f32(w.x>>29u)*0.125-voxelRise(w.y,t);
 let cell=vec3f(f32(w.x&31u),f32((w.x>>5u)&31u),f32((w.x>>10u)&31u));let part=voxelPart(w.x,w.y);let size=part.hi-part.lo;
 let axis=face>>1u;var n=vec3f(f32(axis==0u),f32(axis==1u),f32(axis==2u));var k=dot(n,O+cell)+part.n;
 if(face==2u){k-=drop;}
 if(face==6u){n=vec3f(1.0,0.0,-1.0);k=(O.x+cell.x)-(O.z+cell.z);}
 if(face==7u){n=vec3f(1.0,0.0,1.0);k=O.x+cell.x+1.0+O.z+cell.z;}
 var i:VoxelPixel;i.clip=o.clip;i.position=voxelHit(o.clip.xy,n,k);let l=i.position-O;
 var at=l.xy;var start=cell.xy;
 if(axis==0u){at=l.zy;start=cell.zy;} else if(axis==1u){at=l.xz;start=cell.xz;}
 start+=part.lo;
 var high=size.y-select(0.0,drop,face<6u&&axis!=1u);
 if((w.x>>29u)!=0u&&face<6u&&axis!=1u&&(w.y&0x3000000u)!=0u){high=max(min(part.hi.y,1.0-drop)-part.lo.y,0.0001);}
 let r=clamp((at-start)/vec2f(size.x,high),vec2f(0.0),vec2f(1.0));
 let lit=voxelMix(voxelMix(voxelCorner(w,0u),voxelCorner(w,1u),r.x),voxelMix(voxelCorner(w,3u),voxelCorner(w,2u),r.x),r.y);
 let m=o.material;let maps=o.maps;
 let uv=voxelTile(face,l,cell);let dx=voxelTile(face,voxelHit(o.clip.xy+vec2f(1.0,0.0),n,k)-O,cell)-uv;let dy=voxelTile(face,voxelHit(o.clip.xy+vec2f(0.0,1.0),n,k)-O,cell)-uv;
 let side=select(-1.0,1.0,front);let outward=n*select(-1.0,1.0,(face&1u)==0u);let tangent=voxelTangent(face);
 var normal=select(vec3f(0.0,1.0,0.0),outward*side,face<6u);
 if(face==2u&&(w.y&0x100000u)!=0u){normal=voxelRipple(i.position.xz,t)*side;}
${SHADE}`;

// The shadow-map shader: opaque casters depth only, cutout ones alpha tested at their texture's level 0. No winding
// (both sides cast). Quads (shadowVertex, shadowCutout): every quad reaches 1/64 block past its edges in its plane, so
// T-junction slivers cannot let light through the map (a texel is at least a few centimetres; the snapping error is
// 1/256 of one), and merged and unit quads cast the same outline. A bevel adds its triangle casters. Translucent blocks
// cast no shadow.
const SHADOW_SHADER = /* wgsl */ `
struct VoxelShadow {matrix:mat4x4f,time:vec4f}
@group(0) @binding(0) var<uniform> shadow:VoxelShadow;
${QUADS}
struct ShadowOut {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) words:vec2u,@location(1) local:vec3f}
@vertex fn shadowVertex(@builtin(vertex_index) index:u32)->ShadowOut {
 let q=index>>2u;let w0=voxelQuads[q*3u];let w1=voxelQuads[q*3u+1u];let c=index&3u;let t=shadow.time.x;
 var p=voxelPlace(w0,w1,c,t);
 p+=(normalize(p-voxelPlace(w0,w1,c^1u,t))+normalize(p-voxelPlace(w0,w1,3u-c,t)))*${1 / 64};
 var o:ShadowOut;o.clip=shadow.matrix*vec4f(voxelOrigins[voxelPages[q>>6u]].xyz+p,1.0);o.words=vec2u(w0,w1);o.local=p;return o;
}
@fragment fn shadowCutout(o:ShadowOut) {
 let cell=vec3f(f32(o.words.x&31u),f32((o.words.x>>5u)&31u),f32((o.words.x>>10u)&31u));
 if(!voxelOpaque(voxelMaterials[(o.words.y&4095u)*2u],voxelTile((o.words.x>>15u)&7u,o.local,cell),shadow.time.x)){discard;}
}
`;

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
  /**
   * A bevel from `voxelBevel(amount)` (`@margoengine/voxel/bevel`): each chunk's cube faces become a chamfered
   * triangle mesh, lit, shadowed and replayed like the quads; crosses and liquids stay quads. Default none (flat quads).
   */
  bevel?: VoxelBevel;
  /** Initial {@link VoxelRenderer.lightmap}. Default none. */
  lightmap?: VoxelLightmap;
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
  /** Quads on the GPU. With a bevel only crosses and liquids are quads. */
  readonly quads: number;
  /** Chamfer triangles on the GPU (with a bevel). */
  readonly triangles: number;
  /** GPU bytes of the quad pages in use (768 per page of 64 quads). */
  readonly bytes: number;
  /** Draw calls: one per visible chunk layer with quads or triangles. */
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

interface BevelLayer {
  /** BEVEL_WORDS per vertex, world positions. */
  vertices: GPUBuffer;
  index: GPUBuffer;
  /** Indices drawn: three per triangle. */
  count: number;
  /** Translucent layer only, for sorting: the indices as built and each triangle's centre in chunk blocks. */
  indices?: Uint32Array;
  centers?: Float32Array;
}
interface Chunk {
  key: string;
  /** World cell of the chunk's corner. */
  x: number;
  y: number;
  z: number;
  slot: number;
  /** Per layer (opaque, cutout, translucent): first page, pages, quads in the pool. */
  start: Int32Array;
  pages: Int32Array;
  quads: Int32Array;
  /** In the camera frustum this frame. */
  visible: boolean;
  /** The translucent quads as meshed (with a bevel: crosses and liquids) and, with a bevel, their centres. */
  translucent?: Uint32Array;
  centers?: Float32Array;
  sortedAt: Vec3;
  /** With a bevel: the chamfer mesh of each layer. */
  bevel?: (BevelLayer | undefined)[];
  /**
   * With a bevel, the translucent draw order: back-to-front runs of quads (kind 0) and triangles (kind 1) as
   * [kind, first, count] triples.
   */
  runs?: number[];
}
interface Finished {
  mesh: ChunkMesh;
  priority: number;
  eye: Vec3;
}
interface Pipelines {
  /** Format, samples and depth format they draw to. */
  target: string;
  /** Quad pipelines per layer, and with a bevel the triangle pipelines. */
  layers: GPURenderPipeline[];
  bevel?: GPURenderPipeline[];
  /** The effects composed into them, whose bindings fill group 1. */
  effects: VoxelRendererEffect[];
  /** Whether the lightmap is composed in (bindings 8-10). */
  lit: boolean;
  groups?: GPUBindGroup[];
  bevelGroups?: GPUBindGroup[];
  groupVersion?: number;
  lights?: GPUBindGroup[];
  bevelLights?: GPUBindGroup[];
  lightBound?: unknown[];
  lightVersion?: number;
  bundle?: GPURenderBundle;
  bundleKey?: string;
}
/** What a pass draws with: pipeline and bind groups 0 and 1 (lighting effects). */
type Bound = [GPURenderPipeline, GPUBindGroup, GPUBindGroup | undefined];
/** Per layer: shader MODE, colour targets, depth write and compare, alpha to coverage. */
type LayerState = {
  mode: number;
  targets: GPUColorTargetState[];
  write: boolean;
  compare: GPUCompareFunction;
  coverage: boolean;
};
interface ShadowState {
  uniform: GPUBuffer;
  values: Float32Array;
  /** Opaque (depth only) and cutout (alpha tested) pipelines for quads and, with a bevel, triangles, once compiled. */
  ready?: GPURenderPipeline[];
  bevel?: GPURenderPipeline[];
  /** Per pipeline, per cascade. */
  groups?: GPUBindGroup[][];
  bevelGroups?: GPUBindGroup[][];
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
  lightmap?: { buffer: GPUBuffer; index: GPUBuffer; view: GPUTextureView };
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
  #bevel?: VoxelBevel;
  #lightmap?: VoxelLightmap;
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
  /** 1 per liquid material id: liquids stay quads under a bevel (a chamfer has no lowered top). */
  #liquid = new Uint8Array(0);
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
  #stats = { chunks: 0, visible: 0, quads: 0, triangles: 0, bytes: 0, draws: 0 };
  #effects = new Set<VoxelRendererEffect>();
  #capture?: VoxelCapture;
  #disposeListeners = new Set<() => void>();
  /** The composed shaders, `id` changing with them (pipeline keys). */
  #composed = { from: '', lit: false, id: 0, code: SHADER, bevel: '' };
  #lightVersion = 0;
  #shadowVersion = 0;
  #shadowResources = -1;
  /** The cascades of the last shadow map drawn: chunks changing outside them leave the map as it is. */
  #shadowFrusta: Frustum[] = [];
  #blockLight: [number, number, number] = [1, 0.82, 0.6];

  private constructor(options: VoxelRendererOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('VoxelRenderer.attach expects (engine, {world, textures})');
    const {
      world,
      textures,
      workers,
      maxQuadBytes = 96 << 20,
      daylight = 1,
      fancyLeaves = true,
      bevel,
      lightmap,
    } = options;
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
    if (bevel !== undefined && typeof bevel?.mesh !== 'function')
      throw new TypeError('VoxelRenderer bevel must come from voxelBevel(amount) of @margoengine/voxel/bevel');
    this.#bevel = bevel;
    this.lightmap = lightmap;
    this.daylight = daylight;
    this.#mesher = new VoxelMesher(workers === undefined ? {} : { workers });
  }

  /**
   * Creates a renderer for `options.world` and adds it to `engine`.
   * @throws TypeError when `world` is not a VoxelWorld, `textures` not BlockTextures, `lightmap` not a `voxelLightmap`
   * result, `bevel` not a `voxelBevel` result, or an option has the wrong type.
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
   * cutout geometry keep the beauty shader's texture, alpha, liquid normals and lighting hooks; with a bevel the
   * chamfer triangles replay the same way. Capture excludes translucent surfaces. `occlusion` needs the post owner's
   * two-target external pass; external/capture passes remain open for their owner. GPU state is allocated only on the
   * first replay, and pipelines compile asynchronously.
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
    const { code, bevel, effects, id, lit } = this.#composition(),
      declarations = hook?.declarations(code) ?? '',
      samples = c.descriptor.multisample?.count ?? 1,
      depthFormat = c.descriptor.depthStencil!.format,
      targets: GPUColorTargetState[] = hook
        ? [...hook.targets]
        : Array.from({ length: mode === 'occlusion' ? 2 : 1 }, () => ({ format: 'rgba16float' })),
      compare = external?.depthCompare ?? 'greater-equal',
      target = `${mode}|${samples}|${depthFormat}|${compare}|${targets.map((t) => t.format).join(',')}`,
      key = `${target}|${id}|${declarations}`,
      viewed = mode === 'gbuffer' || mode === 'occlusion',
      post: NonNullable<Gpu['post']> = (gpu.post ??= {
        view: c.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        states: new Map(),
      });
    let state = post.states.get(key);
    if (!state) {
      const pending: { ready?: Pipelines } = (state = {});
      post.states.set(key, state);
      // Translucent replay blends into the colour target (the second one for occlusion); gbuffer normals do not blend.
      const layer = (l: number): LayerState => ({
        mode: l === 0 ? 0 : l === 2 ? 3 : samples > 1 && compare === 'equal' ? 2 : 1,
        targets: targets.map((t, index) =>
          l === 2 && mode !== 'gbuffer' && index === (mode === 'occlusion' ? 1 : 0)
            ? {
                ...t,
                blend: alphaBlend,
              }
            : t,
        ),
        write: mode === 'capture',
        compare,
        coverage: false,
      });
      this.#compile(
        gpu,
        voxelPostShader(code, mode, declarations),
        bevel && voxelPostShader(bevel, mode, hook?.declarations(bevel)),
        mode === 'capture' ? 2 : 3,
        layer,
        samples,
        depthFormat,
      )
        .then(([layers, bevelLayers]) => {
          if (this.#gpu !== gpu) return;
          pending.ready = { target, layers, bevel: bevelLayers, effects, lit };
          for (const [old, value] of post.states)
            if (old !== key && value.ready?.target === target) post.states.delete(old);
        })
        .catch((error) => this.#engine?.onError(error));
    }
    const p = state.ready;
    if (!p) return;
    const view = external?.view ?? viewMatrix(this.#postView, c.camera);
    if (viewed) gpu.device.queue.writeBuffer(post.view, 0, Float32Array.from(view));
    this.#bind(gpu, p, viewed ? [{ binding: 7, resource: { buffer: post.view } }] : []);
    const pass = hook
      ? hook.begin()
      : (external?.pass ??
        c.encoder.beginRenderPass({
          colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: depth, depthReadOnly: true, stencilReadOnly: true },
        }));
    applyView(pass, c);
    for (let layer = 0; layer < p.layers.length; layer++) {
      if ((phase === 'blend' && layer < 2) || (phase === 'opaque' && layer === 2)) continue;
      if (layer === 2) {
        this.#drawRuns(gpu, pass, p);
        continue;
      }
      pass.setPipeline(p.layers[layer]);
      pass.setBindGroup(0, p.groups![layer]);
      if (p.lights) pass.setBindGroup(1, p.lights[layer]);
      pass.setIndexBuffer(gpu.index, 'uint32');
      for (const chunk of this.#chunks.values())
        if (chunk.quads[layer]) pass.drawIndexedIndirect(gpu.args, chunk.slot * 40 + layer * 20);
      this.#drawBevel(pass, p, layer);
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
   * Baked light from `voxelLightmap(options)` (`@margoengine/voxel/lightmap`): fragments on its charts take the atlas's
   * light instead of the sun and ambient terms; emission still adds and the rest stay live. Undefined restores live
   * lighting. Live: the shader is composed again and compiled in the background. The atlas texture is borrowed, never
   * destroyed; on a new device upload it again and assign a new lightmap.
   * @throws TypeError for anything but a `voxelLightmap` result or undefined.
   * @throws MargoError `disposed` after `dispose()`.
   */
  get lightmap(): VoxelLightmap | undefined {
    return this.#lightmap;
  }
  set lightmap(lightmap: VoxelLightmap | undefined) {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelRenderer is disposed; attach a new one');
    if (lightmap !== undefined && typeof lightmap?.shader !== 'function')
      throw new TypeError(
        'VoxelRenderer lightmap must come from voxelLightmap(options) of @margoengine/voxel/lightmap',
      );
    this.#lightmap = lightmap;
    const gpu = this.#gpu;
    if (gpu?.lightmap) {
      gpu.lightmap.buffer.destroy();
      gpu.lightmap.index.destroy();
      gpu.lightmap = undefined;
    }
    this.#resources++;
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
   * cutout chunks inside the cascade, culled on the CPU, into its depth pass. Translucent blocks cast no shadow. With a
   * bevel the chamfer triangles cast.
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
        ],
        // Per cascade: depth-only casters read their geometry, cutout ones also the materials and textures.
        groups = (
          pipelines: GPURenderPipeline[] | undefined,
          depth: GPUBindGroupEntry[],
          cutout: GPUBindGroupEntry[],
        ) =>
          pipelines?.map((pipeline, l) =>
            [0, 1, 2, 3].map((i) =>
              gpu.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: s.uniform, offset: i * 256, size: 80 } },
                  ...(l ? cutout : depth),
                ],
              }),
            ),
          );
      s.groups = groups(s.ready, entries.slice(0, 3), entries);
      s.bevelGroups = groups(s.bevel, [], entries.slice(3));
      s.groupVersion = this.#resources;
    }
    for (let l = 0; l < 2; l++) {
      pass.setPipeline(s.ready[l]);
      pass.setBindGroup(0, s.groups![l][cascade]);
      pass.setIndexBuffer(gpu.index, 'uint32');
      for (const chunk of this.#chunks.values())
        if (chunk.quads[l] && frustum.intersectsBox(this.#chunkBox(chunk)))
          pass.drawIndexed(chunk.quads[l] * 6, 1, 0, chunk.start[l] * PAGE * 4, 0);
      if (!s.bevel) continue;
      pass.setPipeline(s.bevel[l]);
      pass.setBindGroup(0, s.bevelGroups![l][cascade]);
      for (const chunk of this.#chunks.values()) {
        const mesh = chunk.bevel?.[l];
        if (mesh && frustum.intersectsBox(this.#chunkBox(chunk))) this.#drawMesh(pass, mesh);
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
      throw new RangeError(
        `VoxelRenderer maxQuadBytes is over this device's ${limit}-byte storage binding limit; lower maxQuadBytes`,
      );
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
        g.lightmap?.buffer,
        g.lightmap?.index,
      ])
        b?.destroy();
    for (const chunk of this.#chunks.values()) this.#releaseBevel(chunk);
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

  // The material table: two vec4u per material id of blockMaterials (layout at MATERIALS), rebuilt when block types
  // are added.
  #materials(gpu: Gpu): void {
    const table = this.world.blocks.table;
    if (table.length === this.#materialTypes) return;
    this.#materialTypes = table.length;
    const ids = blockMaterials(table);
    let count = 1;
    for (const id of ids) if (id !== 0xffff) count = Math.max(count, id + 1);
    const data = new Uint32Array(count * 8),
      floats = new Float32Array(data.buffer),
      liquid = new Uint8Array(count),
      srgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    for (let id = 0; id < table.length; id++)
      for (let face = 0; face < 6; face++) {
        const m = ids[id * 6 + face],
          t = table[id],
          o = m * 8;
        if (m === 0xffff) continue;
        // Opaque blocks ignore texture alpha, and cutout cubes do when fancyLeaves is off; crosses stay cut out.
        const solid = t.layer === 'opaque' || (!this.#fancyLeaves && t.layer === 'cutout' && t.shape === 'cube');
        data[o] = t.textures[face] | ((t.animation.frames - 1) << 11) | (+solid << 22);
        data[o + 1] = (srgb(t.color[0]) | (srgb(t.color[1]) << 8) | (srgb(t.color[2]) << 16) | (255 << 24)) >>> 0;
        data[o + 2] =
          (Math.round(t.roughness * 255) |
            (Math.round(t.metalness * 255) << 8) |
            (Math.min(65535, Math.round(t.animation.fps * 256)) << 16)) >>>
          0;
        floats[o + 3] = t.emissive;
        data[o + 4] = t.maps.normal | (t.maps.roughness << 11);
        floats[o + 5] = t.scatter;
        data[o + 6] = t.maps.emissive | (Math.round(t.transmission * 255) << 11);
        liquid[m] = +(t.shape === 'liquid');
      }
    this.#liquid = liquid;
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

  // Puts a mesh's layers in pages (in place when they still fit) and writes them; false when the pool is full. With a
  // bevel only crosses and liquids go to the pool and the cube faces become the chunk's chamfer meshes.
  #place(gpu: Gpu, key: string, { mesh, eye }: Finished): boolean {
    const meshed = [mesh.opaque, mesh.cutout, mesh.translucent];
    if (!meshed.some((l) => l.length)) {
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
        visible: false,
        sortedAt: eye,
      };
      this.#chunks.set(key, chunk);
    }
    if (chunk.slot < 0) chunk.slot = this.#slot(gpu, chunk);
    if (chunk.quads[0] || chunk.quads[1] || chunk.bevel || mesh.opaque.length || mesh.cutout.length)
      this.#shadowChanged(chunk);
    const split = this.#bevel ? meshed.map((words) => this.#split(words)) : undefined,
      layers = split ? split.map(([kept]) => kept) : meshed;
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
    chunk.translucent = layers[2].length ? layers[2] : undefined;
    chunk.sortedAt = eye;
    if (split) {
      this.#releaseBevel(chunk);
      const bevel = split.map(([, faces], l) => (faces.length ? this.#bevelLayer(gpu, chunk, faces, l) : undefined));
      chunk.bevel = bevel.some(Boolean) ? bevel : undefined;
      chunk.centers = chunk.translucent && quadCenters(chunk.translucent);
      this.#sortBevel(gpu, chunk, eye);
    }
    return true;
  }

  // A mesh layer's quads that stay quads under a bevel (crosses, liquids, half-block faces), and its cube faces to chamfer, their
  // material carrying the face for the shader's tangent frame.
  #split(words: Uint32Array): [Uint32Array, CubeFace[]] {
    const kept: number[] = [],
      faces: CubeFace[] = [];
    for (let i = 0; i < words.length; i += 3) {
      const quad = decodeQuad(words, i / 3);
      if (quad.face > 5 || this.#liquid[quad.material] || quad.inset || quad.trim)
        kept.push(words[i], words[i + 1], words[i + 2]);
      else faces.push({ ...quad, material: quad.material | (quad.face << 12) });
    }
    return [Uint32Array.from(kept), faces];
  }

  // The chamfer mesh of one chunk layer on the GPU; the translucent layer keeps its indices and centres for sorting.
  #bevelLayer(gpu: Gpu, chunk: Chunk, faces: CubeFace[], layer: number): BevelLayer {
    const { vertices, indices, centers } = this.#bevel!.mesh(faces, [chunk.x, chunk.y, chunk.z]),
      buffer = (array: Float32Array | Uint32Array, usage: number) => {
        const created = gpu.device.createBuffer({ size: array.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
        gpu.device.queue.writeBuffer(created, 0, array);
        return created;
      };
    return {
      vertices: buffer(vertices, GPUBufferUsage.VERTEX),
      index: buffer(indices, GPUBufferUsage.INDEX),
      count: indices.length,
      ...(layer === 2 ? { indices, centers } : {}),
    };
  }

  #releaseBevel(chunk: Chunk): void {
    for (const mesh of chunk.bevel ?? []) {
      mesh?.vertices.destroy();
      mesh?.index.destroy();
    }
    chunk.bevel = chunk.runs = undefined;
  }

  // Sorts a beveled chunk's translucent quads and triangles together, back to front from `eye`, into the pool, the
  // triangle index buffer and the chunk's draw runs, so liquids and crosses blend in order with the chamfered glass.
  #sortBevel(gpu: Gpu, chunk: Chunk, eye: Vec3): void {
    const mesh = chunk.bevel?.[2],
      quads = chunk.translucent,
      qc = chunk.centers ?? new Float32Array(0),
      tc = mesh?.centers ?? new Float32Array(0),
      nq = qc.length / 3,
      n = nq + tc.length / 3,
      distance = new Float64Array(n),
      order = new Uint32Array(n),
      x = eye[0] - chunk.x,
      y = eye[1] - chunk.y,
      z = eye[2] - chunk.z;
    for (let i = 0; i < n; i++) {
      const c = i < nq ? qc : tc,
        j = (i < nq ? i : i - nq) * 3;
      distance[i] = (c[j] - x) ** 2 + (c[j + 1] - y) ** 2 + (c[j + 2] - z) ** 2;
      order[i] = i;
    }
    order.sort((a, b) => distance[b] - distance[a] || a - b);
    const words = new Uint32Array(nq * 3),
      indices = new Uint32Array(tc.length),
      runs: number[] = [];
    let q = 0,
      t = 0;
    for (const i of order) {
      const kind = +(i >= nq);
      if (runs.length && runs[runs.length - 3] === kind) runs[runs.length - 1]++;
      else runs.push(kind, kind ? t : q, 1);
      if (kind) indices.set(mesh!.indices!.subarray((i - nq) * 3, (i - nq) * 3 + 3), t++ * 3);
      else words.set(quads!.subarray(i * 3, i * 3 + 3), q++ * 3);
    }
    if (q) gpu.device.queue.writeBuffer(gpu.pool, chunk.start[2] * PAGE_BYTES, words);
    if (t) gpu.device.queue.writeBuffer(mesh!.index, 0, indices);
    chunk.runs = runs;
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
    if (chunk.quads[0] || chunk.quads[1]) this.#residency++;
    if (chunk.quads[0] || chunk.quads[1] || chunk.bevel) this.#shadowChanged(chunk);
    this.#releaseBevel(chunk);
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
      bevel = this.#bevel,
      module = device.createShaderModule({ code: SHADOW_SHADER + (bevel?.shadow ?? '') }),
      create = (vertex: string, cutout?: string) =>
        device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: vertex, buffers: vertex === 'bevelVertex' ? [bevel!.layout] : [] },
          ...(cutout ? { fragment: { module, entryPoint: cutout, targets: [] } } : {}),
          primitive: { cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
        });
    gpu.shadow = s;
    Promise.all([
      create('shadowVertex'),
      create('shadowVertex', 'shadowCutout'),
      ...(bevel ? [create('bevelVertex'), create('bevelVertex', 'bevelCutout')] : []),
    ])
      .then((pipelines) => {
        if (this.#gpu !== gpu) return;
        s.ready = pipelines.slice(0, 2);
        if (pipelines.length > 2) s.bevel = pipelines.slice(2);
        this.#shadowVersion++;
      })
      .catch((error) => this.#engine?.onError(error));
    return s;
  }

  // This frame's shaders: the quad (and with a bevel the triangle) shader composed with every added effect that is ready
  // (pbr(1) gives hooks), the lightmap and the shadowed sun; and those effects (their bindings fill group 1 in order).
  // Hooks and their compositions are cached by the effects and lightPBR; the rest is redone only when they change, and
  // `id` names the result in pipeline keys.
  #composition(): { code: string; bevel: string; effects: VoxelRendererEffect[]; id: number; lit: boolean } {
    let code = SHADER,
      bevel = this.#bevel ? `${LIT}${MATERIALS}${this.#bevel.shader}${SHADE}` : '';
    const effects: VoxelRendererEffect[] = [],
      lit = !!this.#lightmap,
      c = this.#composed;
    for (const effect of this.#effects) {
      const hooks = effect.pbr(1) as PBRHooks | undefined;
      if (!hooks) continue;
      code = lightPBR(code, hooks);
      if (bevel) bevel = lightPBR(bevel, hooks);
      effects.push(effect);
    }
    if (c.from !== code || c.lit !== lit) {
      const finish = (text: string) => {
        const baked = lit ? this.#lightmap!.shader(text) : text;
        return baked.includes('var<uniform> shadowFrame') ? baked.replace(SUN, SHADOWED_SUN) : baked;
      };
      c.from = code;
      c.lit = lit;
      c.id++;
      c.code = finish(code);
      c.bevel = bevel && finish(bevel);
    }
    return { code: c.code, bevel: c.bevel, effects, id: c.id, lit };
  }

  // Frustum cull per chunk into the indirect arguments, the translucent chunks sorted back to front, stats.
  #cull(c: Context, gpu: Gpu, eye: Vec3): void {
    const frustum = this.#frustum.fromArray(c.camera.planes),
      args = this.#args,
      list = this.#translucent,
      stats = this.#stats,
      distance = (k: Chunk) => (k.x + 16 - eye[0]) ** 2 + (k.y + 16 - eye[1]) ** 2 + (k.z + 16 - eye[2]) ** 2;
    list.length = stats.chunks = stats.visible = stats.quads = stats.triangles = stats.draws = 0;
    for (const chunk of this.#chunks.values()) {
      const seen = frustum.intersectsBox(this.#chunkBox(chunk)),
        a = chunk.slot * 10;
      chunk.visible = seen;
      for (let l = 0; l < 2; l++) {
        args[a + l * 5] = chunk.quads[l] * 6;
        args[a + l * 5 + 1] = +(seen && chunk.quads[l] > 0);
        args[a + l * 5 + 2] = 0;
        args[a + l * 5 + 3] = chunk.start[l] * PAGE * 4;
        args[a + l * 5 + 4] = 0;
        stats.draws += args[a + l * 5 + 1] + +(seen && !!chunk.bevel?.[l]);
      }
      stats.chunks++;
      stats.quads += chunk.quads[0] + chunk.quads[1] + chunk.quads[2];
      for (const mesh of chunk.bevel ?? []) stats.triangles += (mesh?.count ?? 0) / 3;
      if (seen) stats.visible++;
      if (seen && (chunk.quads[2] || chunk.bevel?.[2])) list.push(chunk);
    }
    stats.bytes = this.#pages.used * PAGE_BYTES;
    stats.draws += list.length;
    if (this.#slotTop) gpu.device.queue.writeBuffer(gpu.args, 0, args, 0, this.#slotTop * 10);
    list.sort((a, b) => distance(b) - distance(a));
    // Quad (and triangle) order inside near chunks, from the camera's position, when it moved RESORT blocks since the
    // last sort; at most RESORTS chunks a frame.
    for (let i = list.length - 1, n = 0; i >= 0 && n < RESORTS; i--) {
      const k = list[i];
      if (distance(k) > NEAR * NEAR) break;
      if (Math.hypot(eye[0] - k.sortedAt[0], eye[1] - k.sortedAt[1], eye[2] - k.sortedAt[2]) < RESORT) continue;
      if (this.#bevel) this.#sortBevel(gpu, k, eye);
      else if (k.translucent) {
        sortQuads(k.translucent, [eye[0] - k.x, eye[1] - k.y, eye[2] - k.z]);
        gpu.device.queue.writeBuffer(gpu.pool, k.start[2] * PAGE_BYTES, k.translucent);
      }
      k.sortedAt = eye;
      n++;
    }
  }

  // Quad pipelines for `code` and, given `bevel`, triangle pipelines for it: layers 0 to count - 1 as `layer` describes.
  #compile(
    gpu: Gpu,
    code: string,
    bevel: string,
    count: number,
    layer: (l: number) => LayerState,
    samples: number,
    depth: GPUTextureFormat,
  ): Promise<[GPURenderPipeline[], GPURenderPipeline[] | undefined]> {
    const device = gpu.device,
      all = (module: GPUShaderModule, quads: boolean) =>
        Promise.all(
          Array.from({ length: count }, (_, l) => {
            const o = layer(l);
            return device.createRenderPipelineAsync({
              layout: 'auto',
              vertex: quads
                ? { module, entryPoint: 'vertex', constants: { EDGE: l === 2 ? 0 : EDGE_PIXELS } }
                : { module, entryPoint: 'vertex', buffers: [this.#bevel!.layout] },
              fragment: { module, entryPoint: 'fragment', constants: { MODE: o.mode }, targets: o.targets },
              primitive: { cullMode: l ? 'none' : 'back' },
              depthStencil: { format: depth, depthWriteEnabled: o.write, depthCompare: o.compare },
              multisample: { count: samples, alphaToCoverageEnabled: o.coverage },
            });
          }),
        );
    return Promise.all([
      all(device.createShaderModule({ code }), true),
      bevel ? all(device.createShaderModule({ code: bevel }), false) : undefined,
    ]);
  }

  // The pipelines for this target (format, samples, depth format) and composition, compiled asynchronously. While a
  // new composition compiles, the last pipelines for the target keep drawing as long as their effects are still added
  // and the lightmap is still on or off as they were built; undefined when there are none.
  #pipelines(c: Context, gpu: Gpu): Pipelines | undefined {
    const samples = c.descriptor.multisample?.count ?? 1,
      depth = c.descriptor.depthStencil!.format,
      target = `${c.format}|${samples}|${depth}`,
      { code, bevel, effects, id, lit } = this.#composition(),
      key = `${target}|${id}`;
    let entry = gpu.pipelines.get(key);
    if (!entry) {
      const pending: { ready?: Pipelines } = (entry = {});
      gpu.pipelines.set(key, entry);
      this.#compile(
        gpu,
        code,
        bevel,
        3,
        (l) => {
          const mode = l === 2 ? 3 : l && samples > 1 ? 2 : l;
          return {
            mode,
            targets: [{ format: c.format, ...(l === 2 ? { blend: { color: OVER, alpha: OVER } } : {}) }],
            write: l < 2,
            compare: 'greater-equal',
            coverage: mode === 2,
          };
        },
        samples,
        depth,
      )
        .then(([layers, bevelLayers]) => {
          if (this.#gpu !== gpu) return;
          pending.ready = { target, layers, bevel: bevelLayers, effects, lit };
          // Older compositions for this target are dropped once a newer one is ready.
          for (const [k, e] of gpu.pipelines)
            if (e.ready && e !== pending && e.ready.target === target) gpu.pipelines.delete(k);
        })
        .catch((error) => this.#engine?.onError(error));
    }
    if (entry.ready) return entry.ready;
    const last = this.#ready;
    return last?.target === target && last.lit === lit && last.effects.every((e) => this.#effects.has(e) && e.pbr(1))
      ? last
      : undefined;
  }

  // Bind groups of `p` (per pipeline: 'auto' layouts), made again when a buffer, the textures or the lightmap change,
  // and group 1 when any of the effects' resources changes. `extra` adds the post replay's view (binding 7).
  #bind(gpu: Gpu, p: Pipelines, extra: GPUBindGroupEntry[] = []): void {
    const group = (pipeline: GPURenderPipeline, index: number, entries: GPUBindGroupEntry[]) =>
      gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries });
    if (p.groupVersion !== this.#resources) {
      const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: gpu.frame } },
          { binding: 1, resource: { buffer: gpu.pool } },
          { binding: 2, resource: { buffer: gpu.pageTable } },
          { binding: 3, resource: { buffer: gpu.origins } },
          { binding: 4, resource: { buffer: gpu.materials } },
          { binding: 5, resource: gpu.view! },
          { binding: 6, resource: gpu.sampler },
          ...(p.lit ? this.#lightmapBindings(gpu) : []),
          ...extra,
        ],
        // The triangle shaders read no quad pool.
        shared = entries.filter((e) => e.binding < 1 || e.binding > 3);
      p.groups = p.layers.map((pipeline) => group(pipeline, 0, entries));
      p.bevelGroups = p.bevel?.map((pipeline) => group(pipeline, 0, shared));
      p.groupVersion = this.#resources;
    }
    if (p.effects.length) {
      const entries = p.effects.flatMap((e) => e.bindings()),
        bound = entries.map((e) => ('buffer' in e.resource ? e.resource.buffer : e.resource));
      if (!p.lights || bound.length !== p.lightBound!.length || bound.some((x, i) => x !== p.lightBound![i])) {
        p.lights = p.layers.map((pipeline) => group(pipeline, 1, entries));
        p.bevelLights = p.bevel?.map((pipeline) => group(pipeline, 1, entries));
        p.lightBound = bound;
        p.lightVersion = ++this.#lightVersion;
      }
    }
  }

  // Bindings 8-10: the lightmap texture, its charts and their index, uploaded on first use.
  #lightmapBindings(gpu: Gpu): GPUBindGroupEntry[] {
    const lightmap = this.#lightmap!,
      storage = (data: Float32Array | Int32Array) => {
        const buffer = gpu.device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        gpu.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      },
      baked = (gpu.lightmap ??= {
        view: lightmap.texture.createView(),
        buffer: storage(lightmap.charts),
        index: storage(lightmap.index),
      });
    return [
      { binding: 8, resource: baked.view },
      { binding: 9, resource: { buffer: baked.buffer } },
      { binding: 10, resource: { buffer: baked.index } },
    ];
  }

  // The opaque + cutout quad bundle, re-recorded only when the chunk layers with quads, a buffer, the textures or the
  // target change. Culling changes only the indirect arguments.
  #bundle(c: Context, gpu: Gpu, p: Pipelines): void {
    this.#bind(gpu, p);
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
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
    });
    applyView(pass, c);
    return pass;
  }

  #drawMesh(pass: GPURenderPassEncoder, mesh: BevelLayer): void {
    pass.setVertexBuffer(0, mesh.vertices);
    pass.setIndexBuffer(mesh.index, 'uint32');
    pass.drawIndexed(mesh.count);
  }

  // The chamfer triangles of opaque or cutout `layer` in the visible chunks.
  #drawBevel(pass: GPURenderPassEncoder, p: Pipelines, layer: number): void {
    if (!p.bevel) return;
    pass.setPipeline(p.bevel[layer]);
    pass.setBindGroup(0, p.bevelGroups![layer]);
    if (p.bevelLights) pass.setBindGroup(1, p.bevelLights[layer]);
    for (const chunk of this.#chunks.values()) {
      const mesh = chunk.bevel?.[layer];
      if (chunk.visible && mesh) this.#drawMesh(pass, mesh);
    }
  }

  // The translucent chunks back to front, each in its runs of quads and (with a bevel) triangles; the draw calls made.
  #drawRuns(gpu: Gpu, pass: GPURenderPassEncoder, p: Pipelines): number {
    const quads: Bound = [p.layers[2], p.groups![2], p.lights?.[2]],
      triangles: Bound | undefined = p.bevel && [p.bevel[2], p.bevelGroups![2], p.bevelLights?.[2]];
    let bound = -1,
      draws = 0;
    for (const chunk of this.#translucent) {
      const runs = chunk.runs ?? [0, 0, chunk.quads[2]],
        mesh = chunk.bevel?.[2];
      for (let r = 0; r < runs.length; r += 3) {
        const kind = runs[r],
          first = runs[r + 1],
          count = runs[r + 2];
        if (kind !== bound) {
          const [pipeline, group, lights] = kind ? triangles! : quads;
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          if (lights) pass.setBindGroup(1, lights);
          if (!kind) pass.setIndexBuffer(gpu.index, 'uint32');
        }
        if (kind && (kind !== bound || !r)) {
          pass.setVertexBuffer(0, mesh!.vertices);
          pass.setIndexBuffer(mesh!.index, 'uint32');
        }
        bound = kind;
        if (kind) pass.drawIndexed(count * 3, 1, first * 3);
        else pass.drawIndexed(count * 6, 1, first * 6, chunk.start[2] * PAGE * 4, 0);
        draws++;
      }
    }
    return draws;
  }

  #draw(c: Context): void {
    const p = this.#ready;
    if (!p?.bundle || !this.#chunks.size) return;
    const pass = this.#pass(c);
    pass.executeBundles([p.bundle]);
    this.#drawBevel(pass, p, 0);
    this.#drawBevel(pass, p, 1);
    pass.end();
    this.#engine!.stats.drawCalls += this.#stats.draws - this.#translucent.length;
  }

  #drawTranslucent(c: Context): void {
    const p = this.#ready,
      gpu = this.#gpu;
    if (!p?.groups || !gpu || !this.#translucent.length) return;
    const pass = this.#pass(c);
    this.#engine!.stats.drawCalls += this.#drawRuns(gpu, pass, p);
    pass.end();
  }
}
