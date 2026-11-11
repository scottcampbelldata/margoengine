// Clean-room, one-pixel ID rendering. See docs/sciviz-pick-gpu.md for the selection policy.
const common = /* wgsl */ `
struct Params {
  clip: mat4x4f, inverse: mat4x4f, viewport: vec4f, query: vec4f,
  dims: vec4u, ids: vec4u, grid: vec4f, range: vec4f,
  planes: array<vec4f,4>, spacing: vec4f, extra: vec4f
}
@group(0) @binding(0) var<uniform> p: Params;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) data: vec3f,
  @location(1) @interpolate(flat) index: u32,
  @location(2) @interpolate(flat) value: f32,
  @location(3) @interpolate(flat) rank: f32,
}
struct Hit { @location(0) id: vec4u, @builtin(frag_depth) depth: f32 }
fn tile(c:vec4f)->vec4f {
  return vec4f((c.xy-p.viewport.zw*c.w)*p.viewport.xy,c.z,c.w);
}
fn triangle(v:u32)->vec2f {
  return vec2f(select(-1.0,3.0,v==1u),select(-1.0,3.0,v==2u));
}
fn result(index:u32,value:f32,data:vec3f,rank:f32)->Hit {
  let c=p.clip*vec4f(data,1.0);
  let depth=c.z/c.w;
  return Hit(vec4u(p.ids.x,index,bitcast<u32>(depth),bitcast<u32>(value)),rank);
}
`;

/** @internal Shaders separated from the public entry so import alone allocates nothing. */
export const pointPickWGSL = /* wgsl */ `${common}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) k:u32,@location(0) position:vec3f)->Out {
  let c=p.clip*vec4f(position,1.0);
  let distance=length((c.xy/c.w-p.viewport.zw)*p.viewport.xy*0.5);
  var out:Out;
  out.clip=vec4f(triangle(v),0.5,1.0);
  if(!(c.w>0.0 && c.z>=0.0 && c.z<=c.w && distance<=p.query.x)) {
    out.clip=vec4f(0.0,0.0,2.0,1.0);
  }
  out.data=position; out.index=k; out.value=0.0;
  // Points retain the CPU picker's precedence over cells. Exact projected ties use reversed depth.
  out.rank=0.5+0.499*(1.0-distance/max(p.query.x,0.00001))+clamp(c.z/c.w,0.0,1.0)*0.0000001;
  return out;
}
@fragment fn fragment(i:Out)->Hit { return result(i.index,i.value,i.data,i.rank); }
`;

/** @internal Rectangles use one instance per original cell, without duplicating six vertices on the CPU. */
export const cellPickWGSL = /* wgsl */ `${common}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) k:u32,@location(0) r:vec4f)->Out {
  let x=select(r.x,r.z,v==1u || v==2u || v==4u);
  let y=select(r.y,r.w,v==2u || v==4u || v==5u);
  var out:Out;
  out.data=vec3f(x,y,p.extra.x); out.index=k; out.value=0.0; out.rank=0.0;
  out.clip=tile(p.clip*vec4f(out.data,1.0));
  return out;
}
@fragment fn fragment(i:Out)->Hit {
  let c=p.clip*vec4f(i.data,1.0);
  return result(i.index,i.value,i.data,0.49*c.z/c.w);
}
`;

/** @internal Uses the renderer's original height storage, including compute-owned data and live updates. */
export const surfacePickWGSL = /* wgsl */ `${common}
@group(0) @binding(1) var<storage,read> heights:array<f32>;
fn nan(v:f32)->bool {return (bitcast<u32>(v)&0x7fffffffu)>0x7f800000u;}
@vertex fn vertex(@builtin(vertex_index) v:u32)->Out {
  let cell=v/6u; let corner=v%6u;
  let x=cell%(p.dims.x-1u); let y=cell/(p.dims.x-1u);
  let i=x+select(0u,1u,corner==1u || corner==2u || corner==4u);
  let j=y+select(0u,1u,corner==2u || corner==4u || corner==5u);
  let h=heights[j*p.dims.x+i];
  var out:Out;
  out.data=vec3f(p.grid.x+f32(i)*p.grid.y,p.grid.z+f32(j)*p.grid.w,h);
  out.clip=tile(p.clip*vec4f(out.data,1.0)); out.index=cell; out.value=h; out.rank=0.0;
  let a=y*p.dims.x+x;
  let b=a+select(p.dims.x,1u,corner<3u);
  if(nan(heights[a]) || nan(heights[a+p.dims.x+1u]) || nan(heights[b])) {
    out.clip=vec4f(0.0,0.0,2.0,1.0);
  }
  return out;
}
@fragment fn fragment(i:Out)->Hit {
  let c=p.clip*vec4f(i.data,1.0);
  return result(i.index,i.data.z,i.data,0.49*c.z/c.w);
}
`;

/** @internal First classified sample, with the current transfer texture and clipping planes. */
export const volumePickWGSL = /* wgsl */ `${common}
@group(0) @binding(1) var data:texture_3d<f32>;
@group(0) @binding(2) var transfer:texture_2d<f32>;
@group(0) @binding(3) var linearSampler:sampler;
@vertex fn vertex(@builtin(vertex_index) v:u32)->@builtin(position) vec4f {
  return vec4f(triangle(v),0.5,1.0);
}
fn voxel(i:vec3i)->f32 {return textureLoad(data,clamp(i,vec3i(0),vec3i(p.dims.xyz)-1),0).r;}
fn sample(at:vec3f)->f32 {
  // Explicit f32 interpolation avoids implementation-dependent half-float filtering precision in the hit value.
  let q=at*vec3f(p.dims.xyz)-0.5;let i=vec3i(floor(q));let f=fract(q);
  let low=mix(mix(voxel(i),voxel(i+vec3i(1,0,0)),f.x),
    mix(voxel(i+vec3i(0,1,0)),voxel(i+vec3i(1,1,0)),f.x),f.y);
  let high=mix(mix(voxel(i+vec3i(0,0,1)),voxel(i+vec3i(1,0,1)),f.x),
    mix(voxel(i+vec3i(0,1,1)),voxel(i+vec3i(1,1,1)),f.x),f.y);
  return mix(low,high,f.z);
}
fn slab(o:f32,d:f32)->vec2f {
  if(abs(d)<1e-20) {
    if(o<0.0 || o>1.0) {return vec2f(1.0,-1.0);}
    return vec2f(-1e30,1e30);
  }
  let a=-o/d; let b=(1.0-o)/d;
  return vec2f(min(a,b),max(a,b));
}
@fragment fn fragment()->Hit {
  let a=p.inverse*vec4f(p.viewport.zw,1.0,1.0);
  let b=p.inverse*vec4f(p.viewport.zw,0.5,1.0);
  let origin=a.xyz/a.w;
  let dir=normalize(b.xyz/b.w-origin);
  let x=slab(origin.x,dir.x); let y=slab(origin.y,dir.y); let z=slab(origin.z,dir.z);
  let enter=max(0.0,max(x.x,max(y.x,z.x))); let exit=min(x.y,min(y.y,z.y));
  if(exit<=enter) {discard;}
  let voxel=1.0/f32(max(p.dims.x,max(p.dims.y,p.dims.z)));
  let stride=max(voxel/p.query.z,(exit-enter)/2048.0);
  for(var k=0u;k<2048u;k++) {
    let t=enter+(f32(k)+0.5)*stride;
    if(t>=exit) {break;}
    let at=origin+dir*t;
    var kept=true;
    for(var j=0u;j<p.dims.w;j++) {if(dot(p.planes[j].xyz,at)+p.planes[j].w<0.0){kept=false;}}
    if(!kept){continue;}
    let v=sample(at);
    var coordinate=0.5;
    if(p.range.z==1.0) {
      let d=1.0/vec3f(p.dims.xyz);
      let low=clamp(at-d,d*0.5,1.0-d*0.5); let high=clamp(at+d,d*0.5,1.0-d*0.5);
      let g=vec3f(sample(vec3f(high.x,at.yz))-sample(vec3f(low.x,at.yz)),
        sample(vec3f(at.x,high.y,at.z))-sample(vec3f(at.x,low.y,at.z)),
        sample(vec3f(at.xy,high.z))-sample(vec3f(at.xy,low.z)));
      coordinate=length(g/max((high-low)*vec3f(p.dims.xyz),vec3f(1.0))/p.spacing.xyz)*p.range.w;
    }
    if(p.range.z==2.0) {coordinate=sample(origin+dir*min(t+stride,exit));}
    var uv=vec2f(v,coordinate);
    if(p.range.z>0.5) {let n=vec2f(textureDimensions(transfer));uv=(uv*(n-1.0)+0.5)/n;}
    let alpha=textureSampleLevel(transfer,linearSampler,uv,0.0).a;
    // Opacity 1 is opaque over any step, so a threshold of 1 still finds it (KB5700a).
    let scaled=clamp(alpha*p.query.w,0.0,1.0);
    var opacity=select(1.0-pow(1.0-min(scaled,0.999),stride/voxel),1.0,scaled>=1.0);
    if(p.range.z==2.0) {opacity=1.0-pow(max(1.0-alpha,0.0),stride/voxel/p.spacing.w*p.query.w/p.extra.y);}
    if(opacity<p.query.y) {continue;}
    let ijk=min(vec3u(at*vec3f(p.dims.xyz)),p.dims.xyz-1u);
    let index=(ijk.z*p.dims.y+ijk.y)*p.dims.x+ijk.x;
    let c=p.clip*vec4f(at,1.0);
    return result(index,mix(p.range.x,p.range.y,v),at,0.49*c.z/c.w);
  }
  discard;
  return Hit(vec4u(0u),0.0);
}
`;

/** @internal Unstructured grid triangles retain their source-cell mapping on the CPU, one lookup per hit. */
export const meshPickWGSL = /* wgsl */ `${common}
@group(0) @binding(1) var<storage,read> corners:array<vec4f>;
struct MeshOut { @builtin(position) clip:vec4f, @location(0) data:vec3f,
  @location(1) @interpolate(flat) index:u32, @location(2) value:f32 }
@vertex fn vertex(@builtin(vertex_index) v:u32)->MeshOut {
  let a=corners[v*2u]; var out:MeshOut;
  out.clip=tile(p.clip*vec4f(a.xyz,1.0));out.data=a.xyz;out.value=a.w;out.index=v/3u;return out;
}
@fragment fn fragment(i:MeshOut)->Hit {
  if(p.extra.x<=0.0 || (p.extra.y>0.5 && !(i.value>0.0))) {discard;}
  let c=p.clip*vec4f(i.data,1.0);
  return result(i.index,i.value,i.data,0.49*c.z/c.w);
}
`;
