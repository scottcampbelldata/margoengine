import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {acquireDepth,group} from '../../shared/gpu.js';
declare const GPUBufferUsage:{VERTEX:number;INDEX:number;UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface Wave {direction:readonly [number,number];amplitude:number;wavelength:number;steepness?:number;phase?:number}
export interface WaterOptions {size?:readonly [number,number];segments?:number;height?:number;waves?:readonly Wave[];color?:readonly [number,number,number];foamDistance?:number;depth?:()=>GPUTexture|undefined}
const shader=`
struct Wave {wave:vec4f,shape:vec4f}
struct Frame {camera:mat4x4f,eye:vec4f,settings:vec4f,color:vec4f,cameraData:vec4f,waves:array<Wave,8>}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var history:texture_2d<f32>;
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) world:vec3f}
@vertex fn vertex(@location(0) xz:vec2f)->Output {
 var p=vec3f(xz.x,frame.settings.y,xz.y);var tangent=vec3f(1,0,0);var binormal=vec3f(0,0,1);
 for(var j=0u;j<u32(frame.settings.w);j++){
  let w=frame.waves[j];let d=w.wave.xy;let a=w.wave.z;let k=w.wave.w;let q=w.shape.x;
  let theta=k*dot(d,xz)-w.shape.y*frame.settings.x+w.shape.z;let s=sin(theta);let c=cos(theta);
  p+=vec3f(q*a*d.x*c,a*s,q*a*d.y*c);
  tangent+=vec3f(-q*a*k*d.x*d.x*s,a*k*d.x*c,-q*a*k*d.x*d.y*s);
  binormal+=vec3f(-q*a*k*d.x*d.y*s,a*k*d.y*c,-q*a*k*d.y*d.y*s);
 }
 return Output(frame.camera*vec4f(p,1),normalize(cross(binormal,tangent)),p);
}
fn linear(d:f32)->f32 {return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
struct Result {@location(0) color:vec4f,@location(1) foam:vec4f}
@fragment fn fragment(i:Output)->Result{
 let pixel=vec2i(i.clip.xy);let gap=max(0.0,linear(textureLoad(depth,pixel,0))-linear(i.clip.z));
 let shore=1.0-smoothstep(0.0,frame.settings.z,gap);let old=textureLoad(history,pixel,0).r*exp(-frame.cameraData.z*2.0);let foam=max(shore,old);
 let n=normalize(i.normal);let v=normalize(frame.eye.xyz-i.world);let fresnel=0.02+0.98*pow(1.0-max(dot(n,v),0.0),5.0);
 var color=mix(frame.color.rgb*max(0.25,n.y),vec3f(0.35,0.65,0.85),fresnel);color=mix(color,vec3f(0.9),foam*0.85);
 if(frame.cameraData.w<0.5){color=pow(color/(vec3f(1)+color),vec3f(1.0/2.2));}
 return Result(vec4f(color,1),vec4f(foam,0,0,1));
}`;
let instances=0;
export class Water implements EnginePlugin {
 readonly name='water:'+ ++instances;private engine?:Engine;private source?:()=>GPUTexture|undefined;private shared?:ReturnType<typeof acquireDepth>;private uniform?:GPUBuffer;private vertices?:GPUBuffer;private indices?:GPUBuffer;
 private count=0;private pipeline?:GPURenderPipeline;private format='';private foam:GPUTexture[]=[];private current=0;private time=0;private readonly values=new Float32Array(96);private disposed=false;private readonly positions:Float32Array;private readonly triangles:Uint32Array;
 constructor(readonly options:WaterOptions={}){
  const {size=[100,100],segments=128,height=0,color=[0.01,0.18,0.25],foamDistance=1,waves=[{direction:[1,0.3],amplitude:0.3,wavelength:12},{direction:[-0.5,1],amplitude:0.15,wavelength:7}]}=options;
  if(size.length!==2||size.some(v=>!Number.isFinite(Math.fround(v))||v<=0||v>100000)||!Number.isInteger(segments)||segments<1||segments>512||!Number.isFinite(Math.fround(height))||!Number.isFinite(foamDistance)||foamDistance<=0||foamDistance>100||color.length!==3||color.some(v=>!Number.isFinite(v)||v<0||v>1)||waves.length<1||waves.length>8||options.depth!==undefined&&typeof options.depth!=='function')throw new RangeError('Invalid water options');
  this.values.set([0,height,foamDistance,waves.length],20);this.values.set(color,24);
  for(let i=0;i<waves.length;i++){const w=waves[i],length=Math.hypot(...w.direction),q=w.steepness??0.5;
   if(w.direction.length!==2||w.direction.some(v=>!Number.isFinite(v))||!length||!Number.isFinite(w.amplitude)||w.amplitude<0||w.amplitude>100||!Number.isFinite(w.wavelength)||w.wavelength<=0||w.wavelength>100000||!Number.isFinite(q)||q<0||q>1||!Number.isFinite(w.phase??0))throw new RangeError('Invalid Gerstner wave');
   const k=2*Math.PI/w.wavelength;if(q*w.amplitude*k>1/waves.length)throw new RangeError('Wave steepness would fold the surface');
   this.values.set([w.direction[0]/length,w.direction[1]/length,w.amplitude,k,q,Math.sqrt(9.81*k),w.phase??0,0],32+i*8);
  }
  this.positions=new Float32Array((segments+1)**2*2);this.triangles=new Uint32Array(segments**2*6);
  for(let z=0;z<=segments;z++)for(let x=0;x<=segments;x++){const o=(z*(segments+1)+x)*2;this.positions[o]=(x/segments-0.5)*size[0];this.positions[o+1]=(z/segments-0.5)*size[1];if(x<segments&&z<segments){const a=o/2,b=a+segments+1;this.triangles.set([a,b,a+1,a+1,b,b+1],(z*segments+x)*6);}}
  this.count=this.triangles.length;
 }
 static attach(engine:EngineKernel,options:WaterOptions={}):Water {const effect=new Water(options);engineRuntime(engine).use(effect);return effect;}
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Water requires WebGPU');this.engine=engine;
  this.shared=this.options.depth?undefined:acquireDepth(engine);this.source=this.options.depth??this.shared!.texture;
  this.uniform=engine.gpu.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.vertices=engine.gpu.createBuffer({size:this.positions.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});engine.gpu.queue.writeBuffer(this.vertices,0,this.positions as Float32Array<ArrayBuffer>);
  this.indices=engine.gpu.createBuffer({size:this.triangles.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});engine.gpu.queue.writeBuffer(this.indices,0,this.triangles as Uint32Array<ArrayBuffer>);
 }
 registerPasses(graph:FrameGraph):void {graph.add({name:this.name+':draw',order:4,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
 private draw(c:Context):void {
  const depth=this.source!();if(!depth||depth.width!==c.width||depth.height!==c.height||!depth.format.startsWith('depth')||!(depth.usage&GPUTextureUsage.TEXTURE_BINDING))throw new Error('Water needs viewport-sized sampleable scene depth');
  if(this.foam[0]?.width!==c.width||this.foam[0]?.height!==c.height){for(const t of this.foam)t.destroy();this.foam=[0,1].map(()=>c.device.createTexture({size:[c.width,c.height],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}));this.current=0;}
  if(this.format!==c.format){const module=c.device.createShaderModule({code:shader});this.pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:'float32x2'}]}]},fragment:{module,entryPoint:'fragment',targets:[{format:c.format},{format:'r8unorm'}]},primitive:{cullMode:'none'},depthStencil:{format:c.descriptor.depthStencil!.format,depthCompare:'greater-equal',depthWriteEnabled:false}});this.format=c.format;}
  this.time+=c.delta;this.values.set(c.camera.matrix);this.values.set(c.camera.position,16);this.values[20]=this.time;this.values.set([c.camera.near,c.camera.far,c.delta,+(c.format==='rgba16float')],28);c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
  const bind=group(c.device,this.pipeline!,[{buffer:this.uniform!},depth.createView({aspect:'depth-only'}),this.foam[this.current].createView()]);this.current=1-this.current;
  const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'},{view:this.foam[this.current].createView(),loadOp:'clear',clearValue:{r:0,g:0,b:0,a:0},storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthReadOnly:true,stencilReadOnly:true}});
  pass.setPipeline(this.pipeline!);pass.setBindGroup(0,bind);pass.setVertexBuffer(0,this.vertices!);pass.setIndexBuffer(this.indices!,'uint32');pass.drawIndexed(this.count);pass.end();
 }
 private release():void {this.shared?.release();this.shared=undefined;this.uniform?.destroy();this.vertices?.destroy();this.indices?.destroy();for(const t of this.foam)t.destroy();this.foam=[];this.uniform=this.vertices=this.indices=undefined;this.pipeline=undefined;this.format='';}
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=undefined;}
}
