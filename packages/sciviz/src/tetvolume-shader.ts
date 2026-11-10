// Clean-room barycentric half-space ray casting with opposite-face adjacency.
export const tetrahedralShader = /* wgsl */ `
struct TetVolume { model:mat4x4f,inverse:mat4x4f,options:vec4f,classification:vec4f,low:vec4f,span:vec4f,size:vec4f,planes:array<vec4f,4> }
@group(1) @binding(0) var<uniform> u:TetVolume;
@group(1) @binding(1) var cells:texture_2d<f32>;
@group(1) @binding(2) var transfer:texture_2d<f32>;
@group(1) @binding(3) var linearSampler:sampler;
@group(1) @binding(4) var nodes:texture_2d<f32>;
fn load(t:texture_2d<f32>,i:u32)->vec4f {let w=textureDimensions(t).x;return textureLoad(t,vec2i(i32(i%w),i32(i/w)),0);}
fn weights(cell:u32,p:vec3f)->vec4f {let v=vec4f(p,1.0);let q=vec3f(dot(load(cells,cell*6u),v),dot(load(cells,cell*6u+1u),v),dot(load(cells,cell*6u+2u),v));return vec4f(1.0-q.x-q.y-q.z,q);}
struct Interval { low:f32,high:f32,face:i32,valid:bool }
fn interval(cell:u32,origin:vec3f,d:vec3f,limit:f32)->Interval {
 let a=weights(cell,origin);let q=vec3f(dot(load(cells,cell*6u).xyz,d),dot(load(cells,cell*6u+1u).xyz,d),dot(load(cells,cell*6u+2u).xyz,d));let b=vec4f(-q.x-q.y-q.z,q);
 var lo=0.0;var hi=limit;var face=-1;
 for(var f=0u;f<4u;f++) {
  if(abs(b[f])<1e-20){if(a[f]<0.0){return Interval(0.0,0.0,-1,false);}}
  else {let t=-a[f]/b[f];if(b[f]>0.0){lo=max(lo,t);}else if(t<hi){hi=t;face=i32(f);}}
 }
 return Interval(lo,hi,face,hi>lo);
}
fn boxHit(origin:vec3f,d:vec3f,lo:vec3f,hi:vec3f,start:f32,limit:f32)->bool {
 var a=start;var b=limit;
 for(var axis=0u;axis<3u;axis++) {
  if(abs(d[axis])<1e-20){if(origin[axis]<lo[axis] || origin[axis]>hi[axis]){return false;}}
  else {let x=(lo[axis]-origin[axis])/d[axis];let y=(hi[axis]-origin[axis])/d[axis];a=max(a,min(x,y));b=min(b,max(x,y));}
 }return b>=a;
}
fn closest(origin:vec3f,d:vec3f,start:f32,limit:f32)->i32 {
 var best=limit;var result=-1;var index=0u;let count=u32(u.low.w);
 for(var n=0u;n<count && index<count;n++) {
  let a=load(nodes,index*2u);let b=load(nodes,index*2u+1u);
  if(!boxHit(origin,d,a.xyz,b.xyz,start,best)){index=u32(a.w);continue;}
  index++;if(b.w<0.5){continue;}
  let cell=u32(b.w)-1u;let hit=interval(cell,origin,d,limit);let enter=max(start,hit.low);
  if(hit.valid && hit.high>enter && (enter<best || (enter==best && (result<0 || i32(cell)<result)))){best=enter;result=i32(cell);}
 }return result;
}
fn scalar(cell:u32,p:vec3f)->f32 {var w=clamp(weights(cell,p),vec4f(0.0),vec4f(1.0));w/=dot(w,vec4f(1.0));return dot(w,load(cells,cell*6u+3u));}
fn classify(cell:u32,p:vec3f,next:vec3f)->vec4f {
 let value=scalar(cell,p);var y=0.5;
 if(u.classification.x==1.0){y=length(load(cells,cell*6u+5u).xyz)*u.classification.y;}
 if(u.classification.x==2.0){y=scalar(cell,next);}
 let n=vec2f(textureDimensions(transfer));let uv=select(vec2f(value,y),(vec2f(value,y)*(n-1.0)+0.5)/n,u.classification.x>0.5);
 return textureSampleLevel(transfer,linearSampler,uv,0.0);
}
struct Out { @builtin(position) position:vec4f,@location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));var o:Out;o.position=vec4f(p[i],0.0,1.0);o.ndc=p[i];return o;}
@fragment fn fragment(in:Out)->@location(0) vec4f {
 let a=frame.inverse*vec4f(in.ndc,1.0,1.0);let b=frame.inverse*vec4f(in.ndc,0.000001,1.0);
 let world=a.xyz/a.w;let worldDir=normalize(b.xyz/b.w-world);let origin=(u.inverse*vec4f(world,1.0)).xyz;let raw=(u.inverse*vec4f(worldDir,0.0)).xyz;let speed=length(raw);let d=raw/speed;
 var start=0.0;var limit=1e30;let opaque=opaquePoint(in.position.xy,in.ndc);if(opaque.w>0.0){limit=dot(opaque.xyz-world,worldDir)*speed;}
 // Clip in physical-bounds box coordinates before locating cells.
 for(var k=0u;k<u32(u.size.y);k++){let plane=u.planes[k];let f=dot(plane.xyz,origin)+plane.w;let slope=dot(plane.xyz,d);if(abs(slope)<1e-20){if(f<0.0){discard;}}else if(slope>0.0){start=max(start,-f/slope);}else{limit=min(limit,-f/slope);}}
 if(limit<=start){discard;}
 let physicalSpeed=length(d*u.span.xyz);var cursor=start;var cell=-1;var total=vec4f(0.0);var peak=-1.0;var peakCell=0u;var peakPoint=vec3f(0.0);
 // A convex tetrahedron is crossed at most once. Re-entry uses the tree; ordinary faces use adjacency.
 for(var visit=0u;visit<u32(u.size.x)+1u && cursor<limit;visit++) {
  if(cell<0){cell=closest(origin,d,cursor,limit);if(cell<0){break;}}
  let id=u32(cell);let hit=interval(id,origin,d,limit);let enter=max(cursor,hit.low);
  if(!hit.valid || hit.high<=enter){cell=-1;continue;}
  if(load(cells,id*6u+5u).w>0.5){
   if(u.options.w>0.5){
    let p0=origin+d*enter;let p1=origin+d*hit.high;let v0=scalar(id,p0);let v1=scalar(id,p1);
    if(max(v0,v1)>peak){peak=max(v0,v1);peakCell=id;peakPoint=select(p0,p1,v1>v0);}
   }else {
    let distance=(hit.high-enter)*physicalSpeed;let count=max(1u,min(2048u,u32(ceil(distance/u.options.x*u.options.y))));let ds=(hit.high-enter)/f32(count);
    for(var i=0u;i<count;i++) {
     let p=origin+d*(enter+(f32(i)+0.5)*ds);let next=origin+d*min(hit.high,enter+(f32(i)+1.5)*ds);let tf=classify(id,p,next);
     var alpha=1.0-pow(1.0-clamp(tf.a*u.options.z,0.0,1.0),ds*physicalSpeed/u.options.x);
     if(u.classification.x==2.0){alpha=1.0-pow(max(1.0-tf.a,0.0),ds*physicalSpeed/u.options.x/u.classification.z*u.options.z/u.classification.w);}
     var rgb=tf.rgb;let g=load(cells,id*6u+5u).xyz*u.span.xyz;
     if(u.span.w>0.5 && dot(g,g)>1e-14){let n=vec3f(dot(u.inverse[0].xyz,g),dot(u.inverse[1].xyz,g),dot(u.inverse[2].xyz,g));rgb=shade(rgb,normalize(n),-worldDir);}
     total+=vec4f(rgb*alpha,alpha)*(1.0-total.a);if(total.a>0.999){break;}
    }
   }
  }
  cursor=hit.high;if(total.a>0.999){break;}
  cell=-1;if(hit.face>=0){let neighbour=i32(load(cells,id*6u+4u)[u32(hit.face)]);if(neighbour>=0){let h=interval(u32(neighbour),origin,d,limit);if(h.valid && h.high>max(cursor,h.low)){cell=neighbour;}}}
 }
 if(u.options.w>0.5){if(peak<0.0){discard;}let tf=classify(peakCell,peakPoint,peakPoint);return vec4f(toOutput(tf.rgb),clamp(tf.a*u.options.z,0.0,1.0));}
 if(total.a<1e-8){discard;}return vec4f(toOutput(total.rgb/total.a),total.a);
}
`;
