// WGSL for GPU-driven culling. Binding numbers are shared by every entry point; `layout:'auto'` keeps each
// pipeline's bind group to the bindings that entry point uses (at most 8 storage buffers each).
export const common = `
struct Cull {camera:mat4x4f,planes:array<vec4f,6>,size:vec4u,mode:vec4u,levels:array<vec4u,16>}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> u:Cull;
`;

/**
 * The world sphere of a matrix as core's kernel computes it (radius scaled by sqrt(norm1*normInf) of the 3x3), padded for
 * float32, and its frustum and screen-size test. They read a `Frame` `f` and a `b` with a local `sphere`.
 */
export const sphereCode = `
fn bound(m:mat4x4f)->vec4f {
  let c=(m*vec4f(b.sphere.xyz,1.0)).xyz;let a=mat3x3f(abs(m[0].xyz),abs(m[1].xyz),abs(m[2].xyz));
  let one=vec3f(1.0);let cols=max(max(dot(a[0],one),dot(a[1],one)),dot(a[2],one));let rows=a[0]+a[1]+a[2];
  var r=b.sphere.w*sqrt(cols*max(max(rows.x,rows.y),rows.z));r+=1e-5*(length(c)+r);
  return vec4f(c,r);
}
fn keep(s:vec4f)->bool {
  let c=s.xyz;let r=s.w;
  for(var p=0u;p<6u;p++){if(dot(f.planes[p].xyz,c)+f.planes[p].w< -r){return false;}}
  let w=dot(vec4f(f.camera[0].w,f.camera[1].w,f.camera[2].w,f.camera[3].w),vec4f(c,1.0));
  return f.size.z<=0.0||w<=r||r*f.size.y/w>=f.size.z;
}
`;

/** The `Frame` and `Part` uniforms of the instance culls; `part` adds fields to `Part`. */
export const cullInputs = (part = ''): string => `
struct Frame {camera:mat4x4f,planes:array<vec4f,6>,size:vec4f}
struct Part {count:u32,indices:u32,pad:vec2u,sphere:vec4f${part}}
`;

/**
 * One dispatch triple per list of 96-byte instance records: frustum (+ screen size) test with a workgroup scan, a scan of
 * the workgroup totals, then a stable scatter of the kept records (original order, so coplanar faces resolve as in core).
 * `matrix` is the WGSL of record i's world matrix.
 */
export const instanceCull = (part: string, matrix: string): string => `${cullInputs(part)}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<uniform> b:Part;
@group(0) @binding(2) var<storage,read> records:array<Record>;
@group(0) @binding(3) var<storage,read_write> visible:array<u32>;
@group(0) @binding(4) var<storage,read_write> local:array<u32>;
@group(0) @binding(5) var<storage,read_write> groups:array<u32>;
@group(0) @binding(6) var<storage,read_write> drawn:array<Record>;
@group(0) @binding(7) var<storage,read_write> args:array<u32>;
var<workgroup> scratch:array<u32,256>;
${sphereCode}
@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u) {
  let i=g.x;var v=0u;
  if(i<b.count){if(keep(bound(${matrix}))){v=1u;}visible[i]=v;}
  scratch[l]=v;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var t=0u;if(l>=o){t=scratch[l-o];}workgroupBarrier();scratch[l]+=t;workgroupBarrier();}
  if(i<b.count){local[i]=scratch[l]-v;}
  if(l==255u){groups[w.x]=scratch[255];}
}
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) l:u32) {
  let n=(b.count+255u)/256u;let per=(n+255u)/256u;let lo=min(l*per,n);let hi=min(lo+per,n);
  var sum=0u;for(var k=lo;k<hi;k++){sum+=groups[k];}
  scratch[l]=sum;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var t=0u;if(l>=o){t=scratch[l-o];}workgroupBarrier();scratch[l]+=t;workgroupBarrier();}
  var run=scratch[l]-sum;for(var k=lo;k<hi;k++){let t=groups[k];groups[k]=run;run+=t;}
}
@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=b.count){return;}
  let p=groups[i>>8u]+local[i];let v=visible[i];
  if(v==1u){drawn[p]=records[i];}
  if(i==b.count-1u){args[0]=b.indices;args[1]=p+v;args[2]=0u;args[3]=0u;args[4]=0u;}
}
`;

/** Fills an instance cull's 44-float `Frame`: the camera, its planes, the width, pixels per unit and `minRadius` in device pixels. */
export function fillFrame(
  f: Float32Array,
  c: { camera: { matrix: Float32Array; planes: ArrayLike<number> }; width: number; height: number },
  canvas: { clientWidth: number },
  minRadius: number,
): void {
  const m = c.camera.matrix,
    ratio = canvas.clientWidth ? c.width / canvas.clientWidth : 1;
  f.set(m);
  f.set(c.camera.planes, 16);
  f[40] = c.width;
  f[41] = (Math.hypot(m[1], m[5], m[9]) * c.height) / 2;
  f[42] = minRadius * ratio;
}

/** The occluder and Hi-Z tests of a world sphere; they read `u` and `hiz`. */
export const occlusionCode = `
// Screen radius in pixels (exact for perspective and orthographic cameras): large parts become occluders.
fn occluder(s:vec4f)->bool {
  let m=u.camera;let w=dot(vec4f(m[0].w,m[1].w,m[2].w,m[3].w),vec4f(s.xyz,1.0));
  return w<=s.w||s.w*length(vec3f(m[0].y,m[1].y,m[2].y))/w*f32(u.size.y)*0.5>=bitcast<f32>(u.mode.w);
}
// Conservative Hi-Z test: the sphere's box projects inside the hull of its 8 projected corners and its nearest depth
// is at most the largest corner depth (reversed Z); for perspective (mode.z 1) and orthographic (2) cameras the
// sphere's own nearest point is used when tighter. It is hidden only if that depth is behind the farthest occluder
// sample in every pixel the box can touch. Corners behind the eye, or depth at the near plane, count as visible.
fn unoccluded(s:vec4f)->bool {
  var lo=vec2f(3.0e38);var hi=vec2f(-3.0e38);var near=0.0;let m=u.camera;
  for(var c=0u;c<8u;c++){
    let k=vec3f(f32(c&1u),f32((c>>1u)&1u),f32(c>>2u))*2.0-1.0;let q=m*vec4f(s.xyz+s.w*k,1.0);
    if(q.w<=1e-6){return true;}
    let n=q.xyz/q.w;lo=min(lo,n.xy);hi=max(hi,n.xy);near=max(near,n.z);
  }
  let row2=vec3f(m[0].z,m[1].z,m[2].z);let row3=vec3f(m[0].w,m[1].w,m[2].w);
  if(u.mode.z==1u){let q=m*vec4f(s.xyz-s.w*normalize(row3),1.0);if(q.w>1e-6){near=min(near,q.z/q.w);}}
  if(u.mode.z==2u){let q=m*vec4f(s.xyz,1.0);near=min(near,(q.z+s.w*length(row2))/q.w);}
  if(near>=1.0){return true;}
  let size=vec2f(u.size.xy);
  let p0=vec2u(clamp(vec2f(lo.x*0.5+0.5,0.5-hi.y*0.5)*size,vec2f(0.0),size-1.0));
  let p1=vec2u(clamp(vec2f(hi.x*0.5+0.5,0.5-lo.y*0.5)*size,vec2f(0.0),size-1.0));
  var l=0u;
  while(l+1u<u.size.z&&((p1.x>>l)-(p0.x>>l)>1u||(p1.y>>l)-(p0.y>>l)>1u)){l++;}
  let e=u.levels[l];let a=p0>>vec2u(l);let b=p1>>vec2u(l);
  let far=min(min(hiz[e.x+a.y*e.y+a.x],hiz[e.x+a.y*e.y+b.x]),min(hiz[e.x+b.y*e.y+a.x],hiz[e.x+b.y*e.y+b.x]));
  return near>=far*(1.0-1e-5);
}
`;

/** Compute stages. `samples` picks the depth texture type the Hi-Z pyramid is built from. */
export const computeShader = (samples: number): string =>
  common +
  `
@group(0) @binding(1) var<storage,read> hidden:array<u32>;
@group(0) @binding(2) var<storage,read_write> visible:array<u32>;
@group(0) @binding(3) var<storage,read_write> local:array<u32>;
@group(0) @binding(4) var<storage,read_write> groups:array<u32>;
@group(0) @binding(5) var<storage,read_write> hiz:array<f32>;
@group(0) @binding(6) var<storage,read> batchOf:array<u32>;
@group(0) @binding(7) var<storage,read> batches:array<vec4u>;
@group(0) @binding(8) var<storage,read_write> args:array<u32>;
@group(0) @binding(9) var<storage,read_write> earlyArgs:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> earlyList:array<u32>;
@group(0) @binding(11) var<storage,read> records:array<Record>;
@group(0) @binding(12) var<storage,read_write> drawn:array<Record>;
@group(0) @binding(13) var<uniform> level:vec4u;
@group(0) @binding(14) var depth:${samples > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@group(0) @binding(15) var<storage,read> bounds:array<vec4f>;
var<workgroup> scratch:array<u32,256>;

// World bounding sphere of part i: its batch's local sphere under the part's matrix (radius times the largest axis
// scale), padded for float32 transform error. Hidden parts get a negative radius.
fn sphereOf(i:u32)->vec4f {
  if(hidden[i]!=0u){return vec4f(0.0,0.0,0.0,-1.0);}
  let m=records[i].m;let b=bounds[batchOf[i]];let c=(m*vec4f(b.xyz,1.0)).xyz;
  let r=b.w*sqrt(max(dot(m[0].xyz,m[0].xyz),max(dot(m[1].xyz,m[1].xyz),dot(m[2].xyz,m[2].xyz))));
  return vec4f(c,r+1e-5*(length(c)+r));
}

// Bounding sphere against the six frustum planes (hidden parts carry a negative radius).
fn inside(s:vec4f)->bool {
  if(s.w<0.0){return false;}
  if(u.mode.x==0u){return true;}
  for(var p=0u;p<6u;p++){if(dot(u.planes[p].xyz,s.xyz)+u.planes[p].w< -s.w){return false;}}
  return true;
}
${occlusionCode}
// Pass 1 (occlusion only): large parts drawn last frame and still in the frustum, appended per batch for the depth
// prepass. Any subset of real geometry is a valid occluder set; small parts cost vertex work and hide little.
@compute @workgroup_size(256) fn early(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=u.size.w||visible[i]==0u){return;}
  let s=sphereOf(i);if(!inside(s)||!occluder(s)){return;}
  let b=batchOf[i];earlyList[batches[b].x+atomicAdd(&earlyArgs[b*5u+1u],1u)]=i;
}
// Hi-Z level 0: farthest (smallest reversed-Z) depth over every sample of each pixel.
@compute @workgroup_size(8,8) fn depth0(@builtin(global_invocation_id) g:vec3u) {
  if(g.x>=u.size.x||g.y>=u.size.y){return;}
  var m=1.0;for(var s=0;s<${samples};s++){m=min(m,textureLoad(depth,vec2i(g.xy),s));}
  hiz[g.y*u.size.x+g.x]=m;
}
@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) g:vec3u) {
  let d=u.levels[level.x];let s=u.levels[level.x-1u];
  if(g.x>=d.y||g.y>=d.z){return;}
  let a=g.xy*2u;let b=min(a+vec2u(1u),s.yz-vec2u(1u));
  hiz[d.x+g.y*d.y+g.x]=min(min(hiz[s.x+a.y*s.y+a.x],hiz[s.x+a.y*s.y+b.x]),min(hiz[s.x+b.y*s.y+a.x],hiz[s.x+b.y*s.y+b.x]));
}
// Pass 2: visibility of every part, then an exclusive scan inside each workgroup of 256.
@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u) {
  let i=g.x;var f=0u;
  if(i<u.size.w){let s=sphereOf(i);if(inside(s)&&(u.mode.x<2u||unoccluded(s))){f=1u;}visible[i]=f;}
  scratch[l]=f;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var v=0u;if(l>=o){v=scratch[l-o];}workgroupBarrier();scratch[l]+=v;workgroupBarrier();}
  if(i<u.size.w){local[i]=scratch[l]-f;}
  if(l==255u){groups[w.x]=scratch[255];}
}
// Pass 3: exclusive scan of the workgroup totals (one workgroup).
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) l:u32) {
  let n=(u.size.w+255u)/256u;let per=(n+255u)/256u;let a=min(l*per,n);let b=min(a+per,n);
  var sum=0u;for(var k=a;k<b;k++){sum+=groups[k];}
  scratch[l]=sum;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var v=0u;if(l>=o){v=scratch[l-o];}workgroupBarrier();scratch[l]+=v;workgroupBarrier();}
  var run=scratch[l]-sum;for(var k=a;k<b;k++){let v=groups[k];groups[k]=run;run+=v;}
}
// Pass 4: stable compaction. Visible parts keep their original order inside each batch, so coplanar faces resolve
// exactly as without culling; the last part of each batch writes the batch's instance count.
@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=u.size.w){return;}
  let b=batchOf[i];let range=batches[b];let s=range.x;
  let base=groups[s>>8u]+local[s];let p=groups[i>>8u]+local[i];let f=visible[i];
  if(f==1u){drawn[s+p-base]=records[i];}
  if(i==range.y-1u){args[b*5u+1u]=p+f-base;}
}
`;

/** Depth-only prepass of last frame's visible parts. Positions are computed exactly as in core's vertex shader. */
export const depthShader =
  common +
  `
@group(0) @binding(11) var<storage,read> records:array<Record>;
struct V {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) side:vec2f}
@vertex fn vertex(@location(0) position:vec3f,@location(2) index:u32)->V {
  let r=records[index];let model=r.m;let p=model*vec4f(position,1);
  var o:V;o.clip=u.camera*p;o.side=vec2f(sign(dot(model[0].xyz,cross(model[1].xyz,model[2].xyz))),r.factors.z);return o;
}
// Matches core's single-sided rule (mirrored instances flip the front face).
@fragment fn fragment(i:V,@builtin(front_facing) front:bool) {if(front!=(i.side.x>0.0)&&i.side.y<0.5){discard;}}
`;
