// Screen-space tracing shared by SSR and SSGI: the fullscreen vertex stage, the Hi-Z reduction and the Hi-Z ray march.
// Hi-Z tracing after Y. Uludag, "Hi-Z Screen-Space Cone-Traced Reflections" (GPU Pro 5, 2014) and McGuire & Mara,
// "Efficient GPU Screen-Space Ray Tracing" (JCGT 3(4), 2014); the start offset and nudge constants are Margo's.
// A cell that sent the ray down is not tested again while the ray stays in it and its depth does not grow: the ray stays
// at or behind that cell's closest depth, so the test could only descend again (the "crossed cell boundary" rule of
// Uludag's traversal, kept per level; N. Hofmann, P. Bogendoerfer, M. Stamminger, K. Selgrad, "Hierarchical Multi-Layer
// Screen-Space Ray Tracing", HPG 2017, https://doi.org/10.1145/3105762.3105781, on the cost of long rays near surfaces).
// Hits count only on surfaces facing the ray (KB-POST-SSRSTREET1).
// SSR's composite is assembled from these pieces, so its shader text is what it was before they moved here.
import { group as bind } from '../../shared/gpu.js';
import { compatibilityLevel } from '../../shared/compat.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number; COPY_DST: number };
export const vertex =
  '@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}\n';
// Hierarchical depth (Hi-Z) level: each texel keeps the closest (largest reversed-Z) depth of its 2x2 source texels, and
// the last row and column also take an odd source's remainder, so every texel bounds its whole cell.
export const reduceShader = (source: string, load: string) => `
@group(0) @binding(0) var source:${source};
@group(0) @binding(1) var reduced:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
let size=vec2i(textureDimensions(reduced));let p=vec2i(id.xy);if(any(p>=size)){return;}
let base=p*2;let end=select(base+1,vec2i(textureDimensions(source))-1,p==size-1);var m=0.0;
for(var y=base.y;y<=end.y;y++){for(var x=base.x;x<=end.x;x++){m=max(m,textureLoad(source,vec2i(x,y),0)${load});}}
textureStore(reduced,p,vec4f(m));
}`;
/** A Hi-Z pyramid of `levels` r32float levels over a depth view, and how to build it each frame. */
export interface HiZ {
  /** All levels, for the march. */
  view: GPUTextureView;
  /** One reduction per level: its bind group and its size. */
  groups: GPUBindGroup[];
  sizes: number[][];
  /** At WebGPU's compatibility level: each level's own texture, copied into the pyramid after the reduction. */
  own?: { pyramid: GPUTexture; levels: GPUTexture[] };
}

/**
 * The Hi-Z pyramid of `half` (the depth's size halved) with `levels` levels; `texture` makes and owns each texture. A
 * dispatch at WebGPU's compatibility level may not bind two views of one texture, so there each level reduces into a
 * texture of its own, read by the next level and copied into its mip of the pyramid (`encodeHiZ`); elsewhere each level
 * reads the mip above it in place.
 */
export function createHiZ(
  device: GPUDevice,
  depth: GPUTextureView,
  reduceDepth: GPUComputePipeline,
  reduce: GPUComputePipeline,
  half: number[],
  levels: number,
  texture: (size: number[], format: GPUTextureFormat, usage: number, mipLevelCount?: number) => GPUTexture,
): HiZ {
  const sampled = GPUTextureUsage.TEXTURE_BINDING,
    storage = GPUTextureUsage.STORAGE_BINDING,
    split = compatibilityLevel(device),
    pyramid = texture(half, 'r32float', sampled | (split ? GPUTextureUsage.COPY_DST : storage), levels),
    // Made before the levels' views, so the full level's calls are what they were.
    view = pyramid.createView(),
    own: GPUTexture[] = [],
    groups: GPUBindGroup[] = [],
    sizes: number[][] = [];
  for (let i = 0; i < levels; i++) {
    const size = [Math.max(1, half[0] >> i), Math.max(1, half[1] >> i)];
    if (split) own.push(texture(size, 'r32float', sampled | storage | GPUTextureUsage.COPY_SRC));
    sizes.push(size);
    groups.push(
      bind(device, i ? reduce : reduceDepth, [
        i ? (split ? own[i - 1].createView() : pyramid.createView({ baseMipLevel: i - 1, mipLevelCount: 1 })) : depth,
        split ? own[i].createView() : pyramid.createView({ baseMipLevel: i, mipLevelCount: 1 }),
      ]),
    );
  }
  return { view, groups, sizes, own: split ? { pyramid, levels: own } : undefined };
}

/** Encodes a frame's Hi-Z reduction (and, at the compatibility level, the copies into the pyramid). */
export function encodeHiZ(
  encoder: GPUCommandEncoder,
  hiz: HiZ,
  reduceDepth: GPUComputePipeline,
  reduce: GPUComputePipeline,
): void {
  const pass = encoder.beginComputePass();
  for (let i = 0; i < hiz.groups.length; i++) {
    pass.setPipeline(i ? reduce : reduceDepth);
    pass.setBindGroup(0, hiz.groups[i]);
    pass.dispatchWorkgroups(Math.ceil(hiz.sizes[i][0] / 8), Math.ceil(hiz.sizes[i][1] / 8));
  }
  pass.end();
  if (hiz.own)
    for (let i = 0; i < hiz.sizes.length; i++)
      encoder.copyTextureToTexture({ texture: hiz.own.levels[i] }, { texture: hiz.own.pyramid, mipLevel: i }, [
        hiz.sizes[i][0],
        hiz.sizes[i][1],
      ]);
}

export const downsampleShader =
  vertex +
  `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureSampleLevel(source,bilinear,p.xy*2.0/vec2f(textureDimensions(source)),0.0);}
`;
/** WGSL helpers of the march; need `u` (U: inverse, matrix, a = (width, height, -, thickness), b = (maxDistance, steps,
 * Hi-Z levels, -)), `depth` (texture_depth_2d), `hiz` (the reduced levels) and `normals` (world normal * 0.5 + 0.5). */
export const traceFunctions = `fn world(q:vec2f,d:f32)->vec3f {let w=u.inverse*vec4f(q.x/u.a.x*2.0-1.0,1.0-q.y/u.a.y*2.0,d,1.0);return w.xyz/w.w;}
fn screen(p:vec4f)->vec3f {let n=p.xyz/p.w;return vec3f((n.x*0.5+0.5)*u.a.x,(0.5-n.y*0.5)*u.a.y,n.z);}
fn facing(cell:vec2i,r:vec3f)->bool {return dot(textureLoad(normals,cell,0).xyz*2.0-1.0,r)<0.0;}
fn closest(cell:vec2i,level:i32)->f32 {
if(level==0){return textureLoad(depth,cell,0);}
return textureLoad(hiz,min(cell,vec2i(textureDimensions(hiz,level-1))-1),level-1).r;
}
`;
/** The Hi-Z march of a ray from world point `p` along unit `r` (up to `u.b.x`), as a statement list: it clips the ray,
 * opens `if(len>1.5){` and leaves `o`, `dir`, `len`, `t` and `hit` in scope there (the hit is at `o+dir*t`). The caller
 * closes that block. */
export const march = `let start=u.matrix*vec4f(p,1.0);var end=u.matrix*vec4f(p+r*u.b.x,1.0);
// Clip to the near plane (reversed-Z: z<=w) and the far plane (z>=0), then to the screen.
if(end.z>end.w){end=mix(start,end,0.999*(start.w-start.z)/((start.w-start.z)-(end.w-end.z)));}
if(end.z<0.0){end=mix(start,end,start.z/(start.z-end.z));}
let o=screen(start);var dir=screen(end)-o;
let room=select(vec2f(0.5)-o.xy,u.a.xy-0.5-o.xy,dir.xy>vec2f(0));
let fit=select(vec2f(1),room/dir.xy,abs(dir.xy)>vec2f(1e-6));dir*=clamp(min(fit.x,fit.y),0.0,1.0);
let len=length(dir.xy);
if(len>1.5){
var t=1.5/len;var level=0;var hit=false;let top=i32(u.b.z);let nudge=0.01/max(abs(dir.x),abs(dir.y));
// Bit k: the level-k cell around the ray already sent it down. While depth does not grow along the ray it stays at or
// behind that cell's closest depth until it leaves the cell, so testing the cell again would only descend once more.
var failed=0u;let away=dir.z<=0.0;
for(var i=0;i<i32(u.b.y);i++){
if(t>1.0){break;}
let h=o+dir*t;let size=exp2(f32(level));let cell=floor(h.xy/size);let z=closest(vec2i(cell),level);
let edge=(cell+select(vec2f(0),vec2f(1),dir.xy>vec2f(0)))*size;
let across=select(vec2f(1e30),(edge-o.xy)/dir.xy,abs(dir.xy)>vec2f(1e-6));let exit=min(across.x,across.y)+nudge;
var next=-1.0;var up=true;
if(h.z>z){
// In front of everything in this cell: drop to its closest depth if the ray gets there inside the cell, else move on.
let plane=select(2.0,(z-o.z)/dir.z,dir.z<0.0);
if(plane>=exit){next=exit;}
else if(level>0){t=max(t,plane);if(away){failed|=1u<<u32(level);}level--;}
// A ray reaches only surfaces facing it: one that faces away is the ray's own surface or a back seen at grazing angles.
else if(z>0.0&&facing(vec2i(cell),r)){t=max(t,plane);hit=true;break;}
else{next=exit;}
}else if(level>0){if(away){failed|=1u<<u32(level);}level--;}
else if(z>0.0&&facing(vec2i(cell),r)&&distance(world(h.xy,z),world(h.xy,h.z))<u.a.w){hit=true;break;}
else{next=exit;up=false;}
if(next>=0.0){
// Cells the step leaves lose their mark: the highest level whose cell changed is the top bit where the pixels differ.
let a=vec2u(max(floor(h.xy),vec2f(0)));let b=vec2u(max(floor((o+dir*next).xy),vec2f(0)));let x=(a.x^b.x)|(a.y^b.y);
if(x!=0u){failed&=~((2u<<firstLeadingBit(x))-1u);}
t=next;if(up&&(failed&(1u<<u32(level+1)))==0u){level=min(level+1,top);}
}
}
`;
