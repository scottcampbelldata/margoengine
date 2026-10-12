import type {PassContext} from '@margoengine/core/extension';
import {compute,group} from '../../shared/gpu.js';
import {waterFrame,type CoastalFlow} from './coastal.js';
declare const GPUBufferUsage:{STORAGE:number;COPY_SRC:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
const particles=`struct Particle {position:vec4f,velocity:vec4f}
fn random(value:u32)->f32 {var x=value;x=(x^(x>>16u))*2246822519u;x=(x^(x>>13u))*3266489917u;return f32(x^(x>>16u))/4294967295.0;}`;
const simulate=waterFrame+particles+`
@group(0) @binding(1) var coast:texture_2d<f32>;
@group(0) @binding(2) var flux:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> droplets:array<Particle>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let index=id.x;if(index>=2048u){return;}
 let size=vec2i(textureDimensions(coast));let dt=min(0.05,frame.cameraData.z);var p=droplets[index];
 p.position.w-=dt;
 if(p.position.w>0){
  p.velocity.y-=9.81*dt;p.position=vec4f(p.position.xyz+p.velocity.xyz*dt,p.position.w);
  let uv=(p.position.xz-frame.coast.xy)/frame.coast.zw;let pixel=clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1);
  let water=textureLoad(coast,pixel,0);if(p.position.y<water.x+water.y){p.position.w=0;}
 }else{
  let clock=u32(frame.settings.x*60.0);let seed=index*73856093u+clock*19349663u;
  for(var i=0u;i<4u;i++){
   let key=seed+i*83492791u;let pixel=vec2i(vec2f(random(key),random(key+1u))*vec2f(size-1));let water=textureLoad(coast,pixel,0);
   if(water.x>0.01&&water.x<1.8&&water.w>0.08&&random(key+2u)<min(0.9,dt*45.0*water.w)){
    let q=textureLoad(flux,pixel,0);let velocity=clamp(vec2f(q.y-q.x,q.w-q.z)/max(0.04,water.x),vec2f(-4),vec2f(4));
    let xz=frame.coast.xy+(vec2f(pixel)+vec2f(random(key+3u),random(key+4u)))/vec2f(size)*frame.coast.zw;
    p.position=vec4f(xz.x,water.x+water.y+0.03,xz.y,0.4+random(key+5u)*0.5);
    p.velocity=vec4f(velocity.x*0.4+(random(key+6u)-0.5)*0.6,1.3+random(key+7u)*2.2,velocity.y*0.4+(random(key+8u)-0.5)*0.6,random(key+9u));break;
   }
  }
 }droplets[index]=p;
}`;
const render=waterFrame+particles+`
@group(0) @binding(1) var<storage,read> droplets:array<Particle>;
@group(0) @binding(2) var surface:texture_depth_2d;
struct Output {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) index:u32)->Output {
 let p=droplets[index];if(p.position.w<=0){return Output(vec4f(-2,-2,0,1),vec2f(0),0);}
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));let uv=corners[v];
 let right=normalize(vec3f(frame.camera[0].x,frame.camera[1].x,frame.camera[2].x));let up=normalize(vec3f(frame.camera[0].y,frame.camera[1].y,frame.camera[2].y));
 let size=(0.018+p.velocity.w*0.025)*(1.0+p.position.w*0.2);let world=p.position.xyz+(right*uv.x+up*uv.y)*size;
 return Output(frame.camera*vec4f(world,1),uv,min(1.0,p.position.w*5.0));
}
fn linear(d:f32)->f32{return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
@fragment fn fragment(i:Output)->@location(0) vec4f {
 let radius=dot(i.uv,i.uv);if(radius>1){discard;}
 let gap=max(0.0,linear(textureLoad(surface,vec2i(i.clip.xy),0))-linear(i.clip.z));
 let alpha=(1.0-smoothstep(0.25,1.0,radius))*i.alpha*min(1.0,gap*12.0)*0.65;
 let color=vec3f(0.78,0.84,0.85)*(vec3f(0.05)+frame.radiance.rgb*min(1.0,frame.sun.w));
 return vec4f(color*alpha,alpha);
}`;

/** Fixed GPU pool, born only where shallow flow is actively breaking. */
export class Spray {
 readonly buffer:GPUBuffer;
 private readonly simulation:GPUComputePipeline;
 private readonly simulationGroups:GPUBindGroup[]=[];
 private readonly descriptor:GPUComputePassDescriptor={};
 private readonly color:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
 private readonly depth:GPURenderPassDepthStencilAttachment={view:undefined!,depthReadOnly:true,stencilReadOnly:true};
 private readonly presentation:GPURenderPassDescriptor={colorAttachments:[this.color],depthStencilAttachment:this.depth};
 private render?:GPURenderPipeline;private renderGroup?:GPUBindGroup;private format='';private depthFormat='';private sampled?:GPUTexture;
 constructor(device:GPUDevice,private readonly uniform:GPUBuffer,private readonly coast:CoastalFlow){
  this.buffer=device.createBuffer({size:2048*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  try{this.simulation=compute(device,simulate);for(let i=0;i<2;i++)this.simulationGroups.push(group(device,this.simulation,[{buffer:uniform},coast.views[i],coast.fluxes[i].createView(),{buffer:this.buffer}]));}
  catch(error){this.buffer.destroy();throw error;}
 }
 step(encoder:GPUCommandEncoder):void {const pass=encoder.beginComputePass(this.descriptor);pass.setPipeline(this.simulation);pass.setBindGroup(0,this.simulationGroups[this.coast.current]);pass.dispatchWorkgroups(32);pass.end();}
 draw(c:Context,surface:GPUTexture,view:GPUTextureView):void {
  if(this.format!==c.format||this.depthFormat!==surface.format){const module=c.device.createShaderModule({code:render});this.render=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},depthStencil:{format:surface.format,depthWriteEnabled:false,depthCompare:'greater-equal'}});this.format=c.format;this.depthFormat=surface.format;this.sampled=undefined;}
  if(this.sampled!==surface){this.renderGroup=group(c.device,this.render!,[{buffer:this.uniform},{buffer:this.buffer},surface.createView({aspect:'depth-only'})]);this.sampled=surface;}
  this.color.view=c.color;this.depth.view=view;const pass=c.encoder.beginRenderPass(this.presentation);pass.setPipeline(this.render!);pass.setBindGroup(0,this.renderGroup!);pass.draw(6,2048);pass.end();
 }
 dispose():void {this.buffer.destroy();}
}
