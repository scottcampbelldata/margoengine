import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {fullscreen,group,compute,dispatch} from '../../shared/gpu.js';
import {invert} from '../../shared/math.js';
import {atmosphere,transmittance,single,density,multiple,add} from './atmosphere.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{STORAGE_BINDING:number;TEXTURE_BINDING:number};
export interface SkyOptions {model?:'preetham'|'bruneton';hours?:number;timeScale?:number;turbidity?:number;exposure?:number}
export function sunDirection(hours:number,out=new Float32Array(3)):Float32Array {if(!Number.isFinite(hours)||out.length!==3)throw new RangeError('Invalid sun clock');const angle=(hours%24-6)*Math.PI/12;out[0]=Math.cos(angle);out[1]=Math.sin(angle);out[2]=0;return out;}
const code=fullscreen+atmosphere+`
@group(0) @binding(1) var scattering:texture_2d<f32>;
@group(0) @binding(2) var transmission:texture_2d<f32>;
fn perez(theta:f32,gamma:f32,a:f32,b:f32,c:f32,d:f32,e:f32)->f32{return (1.0+a*exp(b/max(0.01,cos(theta))))*(1.0+c*exp(d*gamma)+e*cos(gamma)*cos(gamma));}
fn preetham(w:vec3f,s:vec3f)->vec3f {
 let t=frame.settings.z;let theta=acos(clamp(w.y,0.01,1.0));let gamma=acos(clamp(dot(w,s),-1.0,1.0));let z=acos(clamp(s.y,0.01,1.0));let z2=z*z;let z3=z2*z;
 let yz=max(0.001,(4.0453*t-4.9710)*tan((4.0/9.0-t/120.0)*(3.14159265-2.0*z))-0.2155*t+2.4192);
 let xz=(0.00165*z3-0.00374*z2+0.00208*z)*t*t+(-0.02902*z3+0.06377*z2-0.03202*z+0.00394)*t+0.11693*z3-0.21196*z2+0.06052*z+0.25885;
 let zz=(0.00275*z3-0.00610*z2+0.00317*z)*t*t+(-0.04214*z3+0.08970*z2-0.04153*z+0.00516)*t+0.15346*z3-0.26756*z2+0.06670*z+0.26688;
 let y=yz*perez(theta,gamma,0.1787*t-1.4630,-0.3554*t+0.4275,-0.0227*t+5.3251,0.1206*t-2.5771,-0.0670*t+0.3703)/perez(0.0,z,0.1787*t-1.4630,-0.3554*t+0.4275,-0.0227*t+5.3251,0.1206*t-2.5771,-0.0670*t+0.3703)*0.05;
 let x=xz*perez(theta,gamma,-0.0193*t-0.2592,-0.0665*t+0.0008,-0.0004*t+0.2125,-0.0641*t-0.8989,-0.0033*t+0.0452)/perez(0.0,z,-0.0193*t-0.2592,-0.0665*t+0.0008,-0.0004*t+0.2125,-0.0641*t-0.8989,-0.0033*t+0.0452);
 let chroma=zz*perez(theta,gamma,-0.0167*t-0.2608,-0.0950*t+0.0092,-0.0079*t+0.2102,-0.0441*t-1.6537,-0.0109*t+0.0529)/perez(0.0,z,-0.0167*t-0.2608,-0.0950*t+0.0092,-0.0079*t+0.2102,-0.0441*t-1.6537,-0.0109*t+0.0529);
 let xyz=vec3f(x*y/max(chroma,0.001),y,(1.0-x-chroma)*y/max(chroma,0.001));
 return max(vec3f(0),mat3x3f(vec3f(3.2406,-0.9689,0.0557),vec3f(-1.5372,1.8758,-0.2040),vec3f(-0.4986,0.0415,1.0570))*xyz)*smoothstep(-0.2,0.05,s.y);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=frame.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,0.000001,1);let w=normalize(p.xyz/p.w-frame.eye.xyz);let s=frame.sun.xyz;
 var color=vec3f(0);if(frame.settings.x<0.5){color=preetham(w,s);}else{let r=R+clamp(frame.eye.w,0.001,99.9);color=lookup(scattering,r,w.y,s.y,dot(w,s));}
 let disk=smoothstep(cos(0.0047),cos(0.0045),dot(w,s));color+=disk*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*20.0;
 color*=exp2(frame.settings.y);if(frame.settings.w<0.5){color=pow(color/(1.0+color),vec3f(1.0/2.2));}return vec4f(color,1);
}`;
const reflection=code+`
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 let uv=(vec2f(id.xy)+0.5)/vec2f(64,32);let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;
 let w=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));let s=frame.sun.xyz;
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=vec3f(0);
 if(frame.settings.x<0.5){color=preetham(ray,s);}else{color=lookup(scattering,R+clamp(frame.eye.w,0.001,99.9),ray.y,s.y,dot(ray,s));}
 color=mix(vec3f(0.015,0.018,0.012),color,smoothstep(-0.2,0.02,w.y));
 textureStore(reflectionMap,vec2i(id.xy),vec4f(color*exp2(frame.settings.y),1));
}`;
export class Sky implements EnginePlugin {
 private readonly attachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
 private readonly depthAttachment:GPURenderPassDepthStencilAttachment={view:undefined!,depthReadOnly:true,stencilReadOnly:true};
 private readonly presentation:GPURenderPassDescriptor={colorAttachments:[this.attachment],depthStencilAttachment:this.depthAttachment};
 readonly name='sky';private engine?:Engine;private uniform?:GPUBuffer;private textures:GPUTexture[]=[];private pipelines:GPUComputePipeline[]=[];private groups:GPUBindGroup[]=[];private render?:GPURenderPipeline;private bind?:GPUBindGroup;private format='';private computedT=NaN;private readonly values=new Float32Array(28);private readonly inverse=this.values.subarray(0,16);private readonly scratch=new Float64Array(52);readonly sun=new Float32Array(3);private disposed=false;
 private reflectionPipeline?:GPUComputePipeline;private reflectionGroup?:GPUBindGroup;private reflectionRequested=false;private readonly reflectionPass:GPUComputePassDescriptor={};
 /** Borrowed linear HDR sky environment; rebuilt on device restoration. */
 get reflectionTexture():GPUTexture|undefined{this.reflectionRequested=true;return this.textures[6];}
 constructor(readonly options:SkyOptions={}){this.validate();}
 private validate():void {const o=this.options;if(o.model!==undefined&&o.model!=='preetham'&&o.model!=='bruneton'||!Number.isFinite(o.hours??12)||!Number.isFinite(o.timeScale??1/3600)||Math.abs(o.timeScale??1/3600)>24||!Number.isFinite(o.turbidity??2)||(o.turbidity??2)<1||(o.turbidity??2)>10||!Number.isFinite(o.exposure??0)||Math.abs(o.exposure??0)>16)throw new RangeError('Invalid sky options');}
 static attach(engine:EngineKernel,options:SkyOptions={}):Sky {const effect=new Sky(options);engineRuntime(engine).use(effect);return effect;}
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Sky requires WebGPU');this.engine=engine;const d=engine.gpu;
  this.uniform=d.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.textures=[d.createTexture({size:[128,32],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING}),...[0,1,2,3,4].map(()=>d.createTexture({size:[128,256],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING}))];
  this.pipelines=[transmittance,single,density,multiple,add].map(s=>compute(d,s));const t=this.textures.map(t=>t.createView()),u={buffer:this.uniform};
  this.groups=[group(d,this.pipelines[0],[u,t[0]]),group(d,this.pipelines[1],[u,t[0],t[1],t[3]])];
  for(let order=0;order<3;order++){const previous=order%2,next=1-previous;
   this.groups.push(group(d,this.pipelines[2],[u,t[1+previous],t[5]]),group(d,this.pipelines[3],[u,t[5],t[1+next]]),group(d,this.pipelines[4],[t[3+previous],t[1+next],t[3+next]]));
  }
  const reflected=d.createTexture({size:[64,32],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});this.textures.push(reflected);this.reflectionPipeline=compute(d,reflection,'reflectSky');this.reflectionGroup=d.createBindGroup({layout:this.reflectionPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:u},{binding:1,resource:t[4]},{binding:3,resource:reflected.createView()}]});
 }
 registerPasses(graph:FrameGraph):void {graph.add({name:'sky:atmosphere',order:2,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
 private draw(c:Extract<PassContext,{backend:'webgpu'}>):void {
  this.validate();this.options.hours=((this.options.hours??12)+c.delta*(this.options.timeScale??1/3600)+24)%24;sunDirection(this.options.hours,this.sun);
  if(!invert(this.inverse,c.camera.matrix,0,this.scratch))throw new Error('Invalid sky camera');this.values.set(c.camera.position,16);this.values[19]=Math.max(0.001,c.camera.position[1]/1000);this.values.set(this.sun,20);this.values[24]=+(this.options.model==='bruneton');this.values[25]=this.options.exposure??0;this.values[26]=this.options.turbidity??2;this.values[27]=+(c.format==='rgba16float');c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
  if(this.computedT!==(this.options.turbidity??2)){dispatch(c,this.pipelines[0],this.groups[0],16,4);dispatch(c,this.pipelines[1],this.groups[1],16,32);
   for(let i=0;i<3;i++){dispatch(c,this.pipelines[2],this.groups[2+i*3],16,32);dispatch(c,this.pipelines[3],this.groups[3+i*3],16,32);dispatch(c,this.pipelines[4],this.groups[4+i*3],16,32);}this.computedT=this.options.turbidity??2;
  }
  if(this.reflectionRequested){const reflected=c.encoder.beginComputePass(this.reflectionPass);reflected.setPipeline(this.reflectionPipeline!);reflected.setBindGroup(0,this.reflectionGroup!);reflected.dispatchWorkgroups(8,4);reflected.end();}
  if(this.format!==c.format){const module=c.device.createShaderModule({code});this.render=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},depthStencil:{format:c.descriptor.depthStencil!.format,depthCompare:'greater-equal',depthWriteEnabled:false}});this.bind=group(c.device,this.render,[{buffer:this.uniform!},this.textures[4].createView(),this.textures[0].createView()]);this.format=c.format;}
  this.attachment.view=c.color;this.depthAttachment.view=c.depth;const pass=c.encoder.beginRenderPass(this.presentation);pass.setPipeline(this.render!);pass.setBindGroup(0,this.bind!);pass.draw(3);pass.end();
 }
 private release():void {this.uniform?.destroy();for(const t of this.textures)t.destroy();this.uniform=undefined;this.textures=[];this.pipelines=[];this.groups=[];this.render=undefined;this.bind=undefined;this.reflectionPipeline=undefined;this.reflectionGroup=undefined;this.format='';this.computedT=NaN;}
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=undefined;}
}
