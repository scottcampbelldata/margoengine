// Conservative block bounds and adaptive marching, derived from public papers;
// clipping and refinement are written independently from the definitions.
export const blockShader = /* wgsl */ `
struct Blocks { dims:vec4u, grid:vec4u, size:vec4u }
@group(0) @binding(0) var<uniform> u:Blocks;
@group(0) @binding(1) var data:texture_3d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));return vec4f(p[i],0.0,1.0);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let index=u32(p.x)+u32(p.y)*u.size.x;
 if(index>=u.grid.x*u.grid.y*u.grid.z){return vec4f(0.0);}
 let block=vec3u(index%u.grid.x,(index/u.grid.x)%u.grid.y,index/(u.grid.x*u.grid.y));
 let start=vec3i(block*u.size.z)-1;var low=1e30;var high=-1e30;
 // Halo encloses all trilinear support, including samples on a block face.
 for(var z=0u;z<u.size.z+3u;z++){for(var y=0u;y<u.size.z+3u;y++){for(var x=0u;x<u.size.z+3u;x++){
  let q=clamp(start+vec3i(i32(x),i32(y),i32(z)),vec3i(0),vec3i(u.dims.xyz)-1);
  let v=textureLoad(data,q,0).r;low=min(low,v);high=max(high,v);
 }}}
 return vec4f(low,high,0.0,0.0);
}`;

export const qualityShader = /* wgsl */ `
struct Quality {
 model:mat4x4f,toBox:mat4x4f,normalModel:mat4x4f,dims:vec4f,params:vec4f,
 classification:vec4f,spacing:vec4f,planes:array<vec4f,4>,options:vec4f,adaptive:vec4f,surface:vec4f,blocks:vec4f
}
@group(1) @binding(0) var<uniform> u:Quality;
@group(1) @binding(1) var data:texture_3d<f32>;
@group(1) @binding(2) var transfer:texture_2d<f32>;
@group(1) @binding(3) var linearSampler:sampler;
@group(1) @binding(4) var blocks:texture_2d<f32>;
@group(1) @binding(5) var opacityBounds:texture_2d<f32>;
@group(1) @binding(6) var noise:texture_2d<f32>;
struct Out { @builtin(position) position:vec4f,@location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
 let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
 var o:Out;o.position=vec4f(p[i],0.0,1.0);o.ndc=p[i];return o;
}
fn exactScalar(p:vec3f)->f32 {
 let q=clamp(p,vec3f(0.0),vec3f(1.0))*(u.dims.xyz-1.0);let a=vec3i(floor(q));let b=min(a+1,vec3i(u.dims.xyz)-1);let f=fract(q);
 let z0=mix(mix(textureLoad(data,vec3i(a.x,a.y,a.z),0).r,textureLoad(data,vec3i(b.x,a.y,a.z),0).r,f.x),
             mix(textureLoad(data,vec3i(a.x,b.y,a.z),0).r,textureLoad(data,vec3i(b.x,b.y,a.z),0).r,f.x),f.y);
 let z1=mix(mix(textureLoad(data,vec3i(a.x,a.y,b.z),0).r,textureLoad(data,vec3i(b.x,a.y,b.z),0).r,f.x),
             mix(textureLoad(data,vec3i(a.x,b.y,b.z),0).r,textureLoad(data,vec3i(b.x,b.y,b.z),0).r,f.x),f.y);
 return mix(z0,z1,f.z);
}
fn scalar(p:vec3f)->f32 {
 if(u.options.z>=0.0){return exactScalar(p);}
 return textureSampleLevel(data,linearSampler,(p*(u.dims.xyz-1.0)+0.5)/u.dims.xyz,0.0).r;
}
fn gradient(p:vec3f)->vec3f {
 let h=1.0/(u.dims.xyz-1.0);let a=clamp(p-h,vec3f(0.0),vec3f(1.0));let b=clamp(p+h,vec3f(0.0),vec3f(1.0));
 return vec3f(scalar(vec3f(b.x,p.y,p.z))-scalar(vec3f(a.x,p.y,p.z)),
 scalar(vec3f(p.x,b.y,p.z))-scalar(vec3f(p.x,a.y,p.z)),
 scalar(vec3f(p.x,p.y,b.z))-scalar(vec3f(p.x,p.y,a.z))) / max((b-a)*(u.dims.xyz-1.0),vec3f(1.0)) / u.spacing.xyz;
}
fn kept(p:vec3f)->bool {
 for(var k=0u;k<u32(u.dims.w);k++){if(dot(u.planes[k].xyz,p)+u.planes[k].w<0.0){return false;}}return true;
}
fn classify(p:vec3f,next:vec3f)->vec4f {
 let v=scalar(p);var y=0.5;
 if(u.classification.x==1.0){y=length(gradient(p))*u.classification.y;}
 if(u.classification.x==2.0){y=scalar(next);}
 let n=vec2f(textureDimensions(transfer));
 let uv=select(vec2f(v,y),(vec2f(v,y)*(n-1.0)+0.5)/n,u.classification.x>0.5);
 return textureSampleLevel(transfer,linearSampler,uv,0.0);
}
fn lit(colour:vec3f,p:vec3f,toEye:vec3f)->vec3f {
 if(u.params.z<0.5){return colour;}
 let g=gradient(p);
 if(dot(g,g)<1e-12){return colour;}
 return shade(colour,normalize((u.normalModel*vec4f(-g*u.spacing.xyz*(u.dims.xyz-1.0),0.0)).xyz),toEye);
}
struct Result { @location(0) colour:vec4f,@builtin(frag_depth) depth:f32 }
@fragment fn fragment(in:Out)->Result {
 let a=frame.inverse*vec4f(in.ndc,1.0,1.0);let b=frame.inverse*vec4f(in.ndc,0.000001,1.0);
 let world=a.xyz/a.w;let direction=normalize(b.xyz/b.w-world);
 let origin=(u.toBox*vec4f(world,1.0)).xyz;let d=(u.toBox*vec4f(direction,0.0)).xyz;
 var enter=0.0;var exit=1e30;
 for(var axis=0u;axis<3u;axis++){
  if(abs(d[axis])<1e-20){if(origin[axis]<0.0 || origin[axis]>1.0){discard;}}
  else{let lo=-origin[axis]/d[axis];let hi=(1.0-origin[axis])/d[axis];enter=max(enter,min(lo,hi));exit=min(exit,max(lo,hi));}
 }
 let opaque=opaquePoint(in.position.xy,in.ndc);
 if(opaque.w>0.0){exit=min(exit,dot(opaque.xyz-world,direction));}
 if(exit<=enter){discard;}
 let base=max(u.params.w/u.params.x,(exit-enter)/2048.0);
 let grid=vec3i(ceil((u.dims.xyz-1.0)/u.adaptive.z));
 var t=enter;var total=vec4f(0.0);var previous=scalar(origin+d*t);var previousT=t;
 var depth=0.0;var peak=select(-1e30,1e30,u.blocks.y>1.5);var peakPoint=origin+d*enter;
 let jitter=select(0.5,textureLoad(noise,vec2i(in.position.xy)%vec2i(32),0).r,u.options.w>0.5);
 for(var k=0u;k<4096u && t<exit;k++) {
  let p=origin+d*(t+u.params.w*1e-5);
  let block=clamp(vec3i(floor(p*(u.dims.xyz-1.0)/u.adaptive.z)),vec3i(0),grid-1);
  let index=block.x+grid.x*(block.y+grid.y*block.z);
  let mm=textureLoad(blocks,vec2i(index%i32(u.blocks.x),index/i32(u.blocks.x)),0).rg;
  let lo=i32(floor(clamp(mm.x,0.0,1.0)*255.0));let hi=i32(ceil(clamp(mm.y,0.0,1.0)*255.0));
  let empty=select(textureLoad(opacityBounds,vec2i(lo,hi),0).r==0.0,u.options.z<mm.x || u.options.z>mm.y,u.options.z>=0.0);
  var boundary=exit-t;
  for(var axis=0u;axis<3u;axis++){
   if(abs(d[axis])>1e-20){let face=f32(block[axis]+select(0,1,d[axis]>0.0))*u.adaptive.z/(u.dims[axis]-1.0);
    let distance=(face-p[axis])/d[axis];if(distance>u.params.w*1e-6){boundary=min(boundary,distance+u.params.w*1e-5);}}
  }
  if(u.options.x>0.5 && empty && u.blocks.y<0.5){t+=max(boundary,u.params.w*1e-5);previousT=t;previous=scalar(origin+d*t);continue;}
  let factor=clamp(u.adaptive.y/max(mm.y-mm.x,1e-10),1.0,u.adaptive.x);
  let ds=min(min(base*factor,exit-t),max(boundary,u.params.w*1e-5));
  let sampleT=select(t+ds*jitter,t+ds,u.options.z>=0.0);let sampleP=origin+d*sampleT;
  if(u.options.z>=0.0){
   let value=scalar(sampleP);
   if((previous-u.options.z)*(value-u.options.z)<=0.0 && kept(sampleP)){
    var near=previousT;var far=sampleT;let sign=previous-u.options.z;
    for(var i=0u;i<u32(u.options.y);i++){let mid=(near+far)*0.5;let f=scalar(origin+d*mid)-u.options.z;if(f*sign>0.0){near=mid;}else{far=mid;}}
    let hit=origin+d*((near+far)*0.5);let c=classify(hit,hit);
    let clip=frame.clip*u.model*vec4f(hit,1.0);depth=clip.z/clip.w;
    total=vec4f(lit(select(c.rgb,u.surface.rgb,u.surface.a>0.5),hit,-direction),1.0);break;
   }
   previous=value;previousT=sampleT;
  }else if(kept(sampleP)){
   if(u.blocks.y>0.5){let v=scalar(sampleP);if(select((v>peak),(v<peak),(u.blocks.y>1.5))){peak=v;peakPoint=sampleP;}t+=ds;continue;}
   let c=classify(sampleP,origin+d*min(t+ds,exit));
   var sigma=-log(max(1.0-c.a,1e-6))*u.params.y/u.params.w;
   if(u.classification.x==2.0){sigma/=u.classification.z*u.classification.w;}
   let alpha=1.0-exp(-sigma*ds);total+=vec4f(lit(c.rgb,sampleP,-direction)*alpha,alpha)*(1.0-total.a);
   if(total.a>0.9999){break;}
  }
  t+=ds;
 }
 if(u.blocks.y>0.5 && u.options.z<0.0){let c=classify(peakPoint,peakPoint);let shown=clamp(select(max(c.a,peak),c.a,u.blocks.y>1.5)*u.params.y,0.0,1.0);total=vec4f(c.rgb*shown,shown);}
 if(total.a<=0.0){discard;}
 var out:Result;out.colour=vec4f(toOutput(total.rgb/total.a),total.a);out.depth=depth;return out;
}`;
