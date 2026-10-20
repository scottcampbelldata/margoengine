// Screen-space tracing shared by SSR and SSGI: the fullscreen vertex stage, the Hi-Z reduction and the Hi-Z ray march.
// SSR's composite is assembled from these pieces, so its shader text is what it was before they moved here.
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
export const downsampleShader =
  vertex +
  `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureSampleLevel(source,bilinear,p.xy*2.0/vec2f(textureDimensions(source)),0.0);}
`;
/** WGSL helpers of the march; need `u` (U: inverse, matrix, a = (width, height, -, thickness), b = (maxDistance, steps,
 * Hi-Z levels, -)), `depth` (texture_depth_2d) and `hiz` (the reduced levels). */
export const traceFunctions = `fn world(q:vec2f,d:f32)->vec3f {let w=u.inverse*vec4f(q.x/u.a.x*2.0-1.0,1.0-q.y/u.a.y*2.0,d,1.0);return w.xyz/w.w;}
fn screen(p:vec4f)->vec3f {let n=p.xyz/p.w;return vec3f((n.x*0.5+0.5)*u.a.x,(0.5-n.y*0.5)*u.a.y,n.z);}
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
for(var i=0;i<i32(u.b.y);i++){
if(t>1.0){break;}
let h=o+dir*t;let size=exp2(f32(level));let cell=floor(h.xy/size);let z=closest(vec2i(cell),level);
let edge=(cell+select(vec2f(0),vec2f(1),dir.xy>vec2f(0)))*size;
let across=select(vec2f(1e30),(edge-o.xy)/dir.xy,abs(dir.xy)>vec2f(1e-6));let exit=min(across.x,across.y)+nudge;
if(h.z>z){
// In front of everything in this cell: drop to its closest depth if the ray gets there inside the cell, else move on.
let plane=select(2.0,(z-o.z)/dir.z,dir.z<0.0);
if(plane<exit){t=max(t,plane);if(level==0){hit=z>0.0;break;}level--;}else{t=exit;level=min(level+1,top);}
}else if(level>0){level--;}
else if(z>0.0&&distance(world(h.xy,z),world(h.xy,h.z))<u.a.w){hit=true;break;}
else{t=exit;}
}
`;
