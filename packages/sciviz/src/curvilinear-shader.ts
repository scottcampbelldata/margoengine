// Public inverse-map mathematics, independently implemented. No companion code used.
export const curvilinearShader = /* wgsl */ `
struct Mapped {
 model:mat4x4f,inverse:mat4x4f,dims:vec4f,options:vec4f,classification:vec4f,spacing:vec4f,
 low:vec4f,span:vec4f,center:vec4f,planes:array<vec4f,4>,slice:vec4f
}
@group(1) @binding(0) var<uniform> u:Mapped;
@group(1) @binding(1) var data:texture_3d<f32>;
@group(1) @binding(2) var transfer:texture_2d<f32>;
@group(1) @binding(3) var linearSampler:sampler;
@group(1) @binding(4) var points:texture_2d<f32>;
@group(1) @binding(5) var nodes:texture_2d<f32>;
@group(1) @binding(6) var axes:texture_2d<f32>;
@group(1) @binding(7) var valid:texture_3d<f32>;
fn load(t:texture_2d<f32>,index:u32)->vec4f {let w=textureDimensions(t).x;return textureLoad(t,vec2i(i32(index%w),i32(index/w)),0);}
fn nodePoint(p:vec3u)->vec3f {return load(points,p.x+u32(u.dims.x)*(p.y+u32(u.dims.y)*p.z)).xyz;}
fn interval(v:f32,axis:u32)->f32 {
 var lo=0u;var hi=u32(u.dims[axis])-1u;
 if(v<load(axes,lo)[axis]-1e-6 || v>load(axes,hi)[axis]+1e-6){return -1.0;}
 for(var k=0u;k<32u && hi-lo>1u;k++){let m=(lo+hi)/2u;if(load(axes,m)[axis]>v){hi=m;}else{lo=m;}}
 return (f32(lo)+clamp((v-load(axes,lo)[axis])/(load(axes,hi)[axis]-load(axes,lo)[axis]),0.0,1.0))/(u.dims[axis]-1.0);
}
fn inverseMap(p:vec3f)->vec4f {
 if(u.dims.w>0.5) {
  let world=p*u.span.xyz+u.low.xyz-u.center.xyz;let r=length(world);
  if(r<1e-20){return vec4f(0.0);}
  let start=load(axes,0u).x;let angle=atan2(world.y,world.x);
  let lon=angle+ceil((start-angle)/6.28318530718)*6.28318530718;
  let q=vec3f(interval(lon,0u),interval(asin(clamp(world.z/r,-1.0,1.0)),1u),interval(r,2u));
  return vec4f(q,select(0.0,1.0,all(q>=vec3f(0.0))));
 }
 var index=0u;let count=u32(u.low.w);
 for(var n=0u;n<count && index<count;n++) {
  let a=load(nodes,index*2u);let b=load(nodes,index*2u+1u);
  if(any(p<a.xyz-vec3f(1e-6)) || any(p>b.xyz+vec3f(1e-6))){index=u32(a.w);continue;}
  index++;
  if(b.w<0.5){continue;}
  let cell=u32(b.w)-1u;let size=vec3u(u.dims.xyz)-1u;
  let base=vec3u(cell%size.x,(cell/size.x)%size.y,cell/(size.x*size.y));
  var c:array<vec3f,8>;
  for(var k=0u;k<8u;k++){c[k]=nodePoint(base+vec3u(k&1u,(k>>1u)&1u,k>>2u));}
  var q=vec3f(0.5);
  for(var iteration=0u;iteration<24u;iteration++) {
   var value=vec3f(0.0);var j0=vec3f(0.0);var j1=vec3f(0.0);var j2=vec3f(0.0);
   for(var k=0u;k<8u;k++) {
    let bit=vec3u(k&1u,(k>>1u)&1u,k>>2u);let w=select(1.0-q,q,bit>vec3u(0u));let sign=select(vec3f(-1.0),vec3f(1.0),bit>vec3u(0u));
    value+=c[k]*w.x*w.y*w.z;j0+=c[k]*sign.x*w.y*w.z;j1+=c[k]*w.x*sign.y*w.z;j2+=c[k]*w.x*w.y*sign.z;
   }
   let residual=value-p;let det=dot(j0,cross(j1,j2));
   if(abs(det)<1e-20){break;}
   if(length(residual)<1e-6*max(length(b.xyz-a.xyz),1e-6)) {
    if(all(q>=vec3f(-1e-5)) && all(q<=vec3f(1.00001))){return vec4f((vec3f(base)+clamp(q,vec3f(0.0),vec3f(1.0)))/(u.dims.xyz-1.0),1.0);}break;
   }
   q-=vec3f(dot(residual,cross(j1,j2)),dot(residual,cross(j2,j0)),dot(residual,cross(j0,j1)))/det;
   if(any(abs(q)>vec3f(4.0))){break;}
  }
 }
 return vec4f(0.0);
}
fn scalar(q:vec3f)->vec2f {
 let p=clamp(q,vec3f(0.0),vec3f(1.0))*(u.dims.xyz-1.0);let a=vec3i(floor(p));let f=fract(p);
 var value=0.0;
 for(var k=0u;k<8u;k++) {
  let bit=vec3i(i32(k&1u),i32((k>>1u)&1u),i32(k>>2u));let v=min(a+bit,vec3i(u.dims.xyz)-1);let w=select(1.0-f,f,bit>vec3i(0));let weight=w.x*w.y*w.z;
  if(weight>1e-7 && textureLoad(valid,v,0).r<0.5){return vec2f(0.0);}
  value+=textureLoad(data,v,0).r*weight;
 }return vec2f(value,1.0);
}
fn sample(p:vec3f)->vec2f {let q=inverseMap(p);if(q.w==0.0){return vec2f(0.0);}return scalar(q.xyz);}
fn gradient(p:vec3f,v:f32)->vec3f {
 let h=u.options.x/max(max(u.span.x,u.span.y),u.span.z)*0.5;var g=vec3f(0.0);
 for(var a=0u;a<3u;a++){var delta=vec3f(0.0);delta[a]=h;let lo=sample(p-delta);let hi=sample(p+delta);g[a]=(select(v,hi.x,hi.y>0.0)-select(v,lo.x,lo.y>0.0))/(2.0*h*u.span[a]);}
 return g;
}
fn classify(p:vec3f,q:vec3f,v:f32,next:vec3f)->vec4f {
 var y=0.5;if(u.classification.x==1.0){y=length(gradient(p,v))*u.classification.y;}
 if(u.classification.x==2.0){let s=sample(next);y=select(v,s.x,s.y>0.0);}
 let n=vec2f(textureDimensions(transfer));let uv=select(vec2f(v,y),(vec2f(v,y)*(n-1.0)+0.5)/n,u.classification.x>0.5);
 return textureSampleLevel(transfer,linearSampler,uv,0.0);
}
fn kept(q:vec3f)->bool {for(var k=0u;k<u32(u.center.w);k++){if(dot(u.planes[k].xyz,q)+u.planes[k].w<0.0){return false;}}return true;}
struct Out { @builtin(position) position:vec4f,@location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));var o:Out;o.position=vec4f(p[i],0.0,1.0);o.ndc=p[i];return o;}
@fragment fn fragment(in:Out)->@location(0) vec4f {
 let a=frame.inverse*vec4f(in.ndc,1.0,1.0);let b=frame.inverse*vec4f(in.ndc,0.000001,1.0);
 let world=a.xyz/a.w;let worldDir=normalize(b.xyz/b.w-world);let origin=(u.inverse*vec4f(world,1.0)).xyz;
 let raw=(u.inverse*vec4f(worldDir,0.0)).xyz;let speed=length(raw);let d=raw/speed;
 var enter=0.0;var exit=1e30;
 for(var axis=0u;axis<3u;axis++){if(abs(d[axis])<1e-20){if(origin[axis]<0.0||origin[axis]>1.0){discard;}}else{let lo=-origin[axis]/d[axis];let hi=(1.0-origin[axis])/d[axis];enter=max(enter,min(lo,hi));exit=min(exit,max(lo,hi));}}
 let opaque=opaquePoint(in.position.xy,in.ndc);if(opaque.w>0.0){exit=min(exit,dot(opaque.xyz-world,worldDir)*speed);}
 if(exit<=enter){discard;}
 let physicalSpeed=length(d*u.span.xyz);let step=max(u.options.x/physicalSpeed/u.options.y,(exit-enter)/4096.0);var t=enter;var total=vec4f(0.0);var peak=-1.0;var peakPoint=vec3f(0.0);var peakQ=vec3f(0.0);
 for(var i=0u;i<4096u && t<exit;i++) {
  let ds=min(step,exit-t);let p=origin+d*(t+ds*0.5);t+=ds;
  let q=inverseMap(p);if(q.w==0.0 || !kept(q.xyz)){continue;}let v=scalar(q.xyz);if(v.y==0.0){continue;}
  if(u.options.w>0.5){if(v.x>peak){peak=v.x;peakPoint=p;peakQ=q.xyz;}continue;}
  let tf=classify(p,q.xyz,v.x,origin+d*min(t+step*0.5,exit));
  var alpha=1.0-pow(1.0-clamp(tf.a*u.options.z,0.0,0.999999),ds*physicalSpeed/u.options.x);
  if(u.classification.x==2.0){alpha=1.0-pow(max(1.0-tf.a,0.0),ds*physicalSpeed/u.options.x/u.classification.z*u.options.z/u.classification.w);}
  var rgb=tf.rgb;
  if(u.span.w>0.5){let g=gradient(p,v.x)*u.span.xyz;if(dot(g,g)>1e-14){let normal=vec3f(dot(u.inverse[0].xyz,g),dot(u.inverse[1].xyz,g),dot(u.inverse[2].xyz,g));rgb=shade(rgb,normalize(normal),-worldDir);}}
  total+=vec4f(rgb*alpha,alpha)*(1.0-total.a);if(total.a>0.999){break;}
 }
 if(u.options.w>0.5){if(peak<0.0){discard;}let tf=classify(peakPoint,peakQ,peak,peakPoint);return vec4f(toOutput(tf.rgb),clamp(tf.a*u.options.z,0.0,1.0));}
 if(total.a<1e-6){discard;}return vec4f(toOutput(total.rgb/total.a),total.a);
}
struct SliceOut { @builtin(position) position:vec4f,@location(0) p:vec3f,@location(1) q:vec3f }
@vertex fn sliceVertex(@location(0) p:vec3f,@location(1) q:vec3f)->SliceOut {var o:SliceOut;o.position=frame.clip*u.model*vec4f(p,1.0);o.p=p;o.q=q;return o;}
@fragment fn sliceFragment(in:SliceOut)->@location(0) vec4f {if(!kept(in.q)){discard;}let s=scalar(in.q);if(s.y==0.0){discard;}let c=classify(in.p,in.q,s.x,in.p);return vec4f(toOutput(c.rgb),u.slice.x);}
@fragment fn outlineFragment()->@location(0) vec4f {return vec4f(toOutput(u.slice.yzw),1.0);}
`;
