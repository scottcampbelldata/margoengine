import {group,compute} from '../../shared/gpu.js';

declare const GPUTextureUsage:{TEXTURE_BINDING:number;STORAGE_BINDING:number;COPY_SRC:number};
declare const GPUBufferUsage:{STORAGE:number;COPY_SRC:number};
export const waterFrame=`
struct Wave {wave:vec4f,shape:vec4f}
struct Light {direction:vec4f,radiance:vec4f}
struct Frame {camera:mat4x4f,eye:vec4f,settings:vec4f,color:vec4f,cameraData:vec4f,waves:array<Wave,8>,coast:vec4f,flow:vec4f,sun:vec4f,radiance:vec4f,lights:array<Light,2>}
@group(0) @binding(0) var<uniform> frame:Frame;
`;
export const oceanWaves=`
struct Swell {direction:vec2f,gradient:vec2f,phase:f32,amplitude:f32}
fn swell(w:Wave,xz:vec2f,index:u32,sampleWidth:f32)->Swell {
 let spectrum=array<vec4f,3>(vec4f(0,1,0.4,0),vec4f(-0.64,0.84,0.35,2.17),vec4f(0.81,1.18,0.25,4.91));let component=spectrum[index];
 let rotation=vec2f(cos(component.x),sin(component.x));let d=vec2f(w.wave.x*rotation.x-w.wave.y*rotation.y,w.wave.x*rotation.y+w.wave.y*rotation.x);let across=vec2f(-d.y,d.x);let k=w.wave.w*component.y;let speed=w.shape.y*sqrt(component.y);
 let bend=k*0.35*dot(across,xz)-speed*frame.settings.x*0.12+w.shape.z+component.w;
 // Filter against the maximum bend gradient so amplitudes stay constant along each crest.
 let gradient=k*(d+across*0.49*cos(bend));let t=clamp((6.2831853/(k*1.114)/max(0.0001,sampleWidth)-2.0)*0.5,0.0,1.0);
 return Swell(d,gradient,k*dot(d,xz)-speed*frame.settings.x+w.shape.z+component.w+1.4*sin(bend),w.wave.z*component.z*min(w.shape.w,t*t*(3.0-2.0*t)));
}
`;
const ocean=oceanWaves+`
fn oceanHeight(p:vec2i,size:vec2i)->f32{
 let xz=frame.coast.xy+(vec2f(p)+0.5)/vec2f(size)*frame.coast.zw;
 var h=frame.settings.y;
 for(var j=0u;j<u32(frame.settings.w);j++){
  for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,length(frame.flow.yz));h+=s.amplitude*sin(s.phase);}
 }return h;
}
`;
const initialize=waterFrame+`
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var state:texture_storage_2d<rgba32float,write>;
@group(0) @binding(3) var flux:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var<storage,read_write> connected:array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(state);if(any(id.xy>=size)){return;}
 let p=vec2i(id.xy);let ground=textureLoad(terrain,p,0).r;
 let index=id.y*size.x+id.x+1u;let edge=id.x==0u||id.y==0u||id.x==size.x-1u||id.y==size.y-1u;
 connected[index]=select(select(index,0u,edge),0xffffffffu,ground>=frame.settings.y);
 textureStore(state,p,vec4f(max(0.0,frame.settings.y-ground),ground,0,0));textureStore(flux,p,vec4f(0));
}`;
const topology=`
@group(0) @binding(0) var terrain:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> connected:array<atomic<u32>>;
fn root(index:u32)->u32 {
 var p=index;
 loop {let next=atomicLoad(&connected[p]);if(next==p){return p;}atomicMin(&connected[p],atomicLoad(&connected[next]));p=next;}
}
fn join(a:u32,b:u32){
 var x=a;var y=b;
 loop {x=root(x);y=root(y);if(x==y){return;}let high=max(x,y);let low=min(x,y);let previous=atomicMin(&connected[high],low);if(previous==high){return;}
  // Retry the displaced parent too, preserving its component when another thread links the root first.
  x=previous;y=low;
 }
}
@compute @workgroup_size(8,8) fn connect(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(terrain);if(any(id.xy>=size)){return;}let index=id.y*size.x+id.x+1u;if(atomicLoad(&connected[index])==0xffffffffu){return;}
 if(id.x>0u&&atomicLoad(&connected[index-1u])!=0xffffffffu){join(index,index-1u);}
 if(id.y>0u&&atomicLoad(&connected[index-size.x])!=0xffffffffu){join(index,index-size.x);}
}
@compute @workgroup_size(8,8) fn compress(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(terrain);if(any(id.xy>=size)){return;}let index=id.y*size.x+id.x+1u;if(atomicLoad(&connected[index])!=0xffffffffu){atomicStore(&connected[index],root(index));}
}`;
const flow=waterFrame+`
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
fn surface(p:vec2i)->vec2f {let v=textureLoad(state,p,0);return vec2f(v.x+v.y,v.y);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(state));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let h=v.x+v.y;let dt=frame.flow.x;
 let l=surface(max(p-vec2i(1,0),vec2i(0)));let r=surface(min(p+vec2i(1,0),size-1));
 let u=surface(max(p-vec2i(0,1),vec2i(0)));let d=surface(min(p+vec2i(0,1),size-1));
 var q=max(vec4f(0),textureLoad(previous,p,0)*exp(-dt*0.12)+dt*9.81*v.x*(vec4f(h)-vec4f(l.x,r.x,u.x,d.x))/frame.flow.yyzz);
 q*=vec4f(select(0.0,1.0,h>l.y),select(0.0,1.0,h>r.y),select(0.0,1.0,h>u.y),select(0.0,1.0,h>d.y));
 if(p.x==0){q.x=0;}if(p.x==size.x-1){q.y=0;}if(p.y==0){q.z=0;}if(p.y==size.y-1){q.w=0;}
 // Limit the complete outflow together so a cell cannot spend more water than it owns.
 let outgoing=(q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z;
 q*=min(1.0,v.x/max(0.000001,dt*outgoing));textureStore(next,p,q);
}`;
const integrate=waterFrame+ocean+`
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var flux:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var<storage,read> connected:array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(state));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let q=textureLoad(flux,p,0);let dt=frame.flow.x;
 var incoming=vec4f(0);
 if(p.x>0){incoming.x=textureLoad(flux,p-vec2i(1,0),0).y;}
 if(p.x<size.x-1){incoming.y=textureLoad(flux,p+vec2i(1,0),0).x;}
 if(p.y>0){incoming.z=textureLoad(flux,p-vec2i(0,1),0).w;}
 if(p.y<size.y-1){incoming.w=textureLoad(flux,p+vec2i(0,1),0).z;}
 var h=max(0.0,v.x+dt*((incoming.x+incoming.y-q.x-q.y)/frame.flow.y+(incoming.z+incoming.w-q.z-q.w)/frame.flow.z));
 // Drive open sea near every beach; isolated basins retain conservative flow.
 if(connected[id.y*u32(size.x)+id.x+1u]==0u){let weight=smoothstep(0.65,2.4,max(0.0,frame.settings.y-v.y));h=mix(h,max(0.0,oceanHeight(p,size)-v.y),(1.0-exp(-dt*4.0))*weight);}
 if(p.x==0||p.y==0||p.x==size.x-1||p.y==size.y-1){h=max(0.0,oceanHeight(p,size)-v.y);}
 var carried=v.x*v.z;
 if(p.x>0){carried+=dt*incoming.x*textureLoad(state,p-vec2i(1,0),0).z/frame.flow.y;}
 if(p.x<size.x-1){carried+=dt*incoming.y*textureLoad(state,p+vec2i(1,0),0).z/frame.flow.y;}
 if(p.y>0){carried+=dt*incoming.z*textureLoad(state,p-vec2i(0,1),0).z/frame.flow.z;}
 if(p.y<size.y-1){carried+=dt*incoming.w*textureLoad(state,p+vec2i(0,1),0).z/frame.flow.z;}
 carried-=dt*v.z*((q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z);
 let velocity=vec2f(q.y-q.x+incoming.x-incoming.y,q.w-q.z+incoming.z-incoming.w)/max(0.04,2.0*h);
 let froude=length(velocity)/sqrt(9.81*max(0.03,h));
 let breaker=smoothstep(0.45,1.0,froude)*smoothstep(0.01,0.08,h)*(1.0-smoothstep(0.8,1.8,h));
 let foam=max(clamp(carried/max(0.003,h),0.0,1.0)*exp(-dt*0.8),breaker);
 textureStore(next,p,vec4f(h,v.y,foam,breaker));
}`;

/** Conservative shore flow; connected offshore cells supply waves while inland basins retain volume. */
export class CoastalFlow {
 readonly states:GPUTexture[]=[];
 readonly views:GPUTextureView[]=[];
 readonly fluxes:GPUTexture[]=[];
 readonly connected:GPUBuffer;
 private readonly flowGroups:GPUBindGroup[]=[];
 private readonly integrateGroups:GPUBindGroup[]=[];
 private readonly initializer:GPUComputePipeline;
 private readonly flowing:GPUComputePipeline;
 private readonly integrating:GPUComputePipeline;
 private readonly initialGroup:GPUBindGroup;
 private readonly connector:GPUComputePipeline;private readonly compressor:GPUComputePipeline;
 private readonly connectGroup:GPUBindGroup;private readonly compressGroup:GPUBindGroup;
 private readonly descriptor:GPUComputePassDescriptor={};
 private initialized=false;
 current=0;
 constructor(device:GPUDevice,uniform:GPUBuffer,readonly terrain:GPUTexture){
  try{
   this.connected=device.createBuffer({size:(terrain.width*terrain.height+1)*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
   for(let i=0;i<2;i++){
    this.states.push(device.createTexture({size:[terrain.width,terrain.height],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC}));
    this.fluxes.push(device.createTexture({size:[terrain.width,terrain.height],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING}));
   }
   this.views=this.states.map(t=>t.createView());const fluxViews=this.fluxes.map(t=>t.createView());
   this.initializer=compute(device,initialize);this.flowing=compute(device,flow);this.integrating=compute(device,integrate);
   const topologyModule=device.createShaderModule({code:topology});this.connector=device.createComputePipeline({layout:'auto',compute:{module:topologyModule,entryPoint:'connect'}});this.compressor=device.createComputePipeline({layout:'auto',compute:{module:topologyModule,entryPoint:'compress'}});
   this.connectGroup=group(device,this.connector,[terrain.createView(),{buffer:this.connected}]);this.compressGroup=group(device,this.compressor,[terrain.createView(),{buffer:this.connected}]);
   this.initialGroup=group(device,this.initializer,[{buffer:uniform},terrain.createView(),this.views[0],fluxViews[0],{buffer:this.connected}]);
   for(let i=0;i<2;i++){
    this.flowGroups.push(group(device,this.flowing,[{buffer:uniform},this.views[i],fluxViews[i],fluxViews[1-i]]));
    this.integrateGroups.push(group(device,this.integrating,[{buffer:uniform},this.views[i],fluxViews[1-i],this.views[1-i],{buffer:this.connected}]));
   }
  }catch(error){this.dispose();throw error;}
 }
 step(encoder:GPUCommandEncoder):void {
  const pass=encoder.beginComputePass(this.descriptor),x=Math.ceil(this.terrain.width/8),y=Math.ceil(this.terrain.height/8);
  if(!this.initialized){pass.setPipeline(this.initializer);pass.setBindGroup(0,this.initialGroup);pass.dispatchWorkgroups(x,y);pass.setPipeline(this.connector);pass.setBindGroup(0,this.connectGroup);pass.dispatchWorkgroups(x,y);pass.setPipeline(this.compressor);pass.setBindGroup(0,this.compressGroup);pass.dispatchWorkgroups(x,y);this.initialized=true;}
  // shortcut: three substeps suit coastal cells >= 0.5m, increase substeps for finer maps.
  for(let i=0;i<3;i++){
   pass.setPipeline(this.flowing);pass.setBindGroup(0,this.flowGroups[this.current]);pass.dispatchWorkgroups(x,y);
   pass.setPipeline(this.integrating);pass.setBindGroup(0,this.integrateGroups[this.current]);pass.dispatchWorkgroups(x,y);this.current=1-this.current;
  }pass.end();
 }
 dispose():void {this.connected?.destroy();for(let i=0;i<this.states.length;i++)this.states[i].destroy();for(let i=0;i<this.fluxes.length;i++)this.fluxes[i].destroy();}
}
