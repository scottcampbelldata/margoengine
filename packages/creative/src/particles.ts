import type {Engine,EnginePlugin,FrameGraph,PassContext,Vec3} from '@margoengine/core/extension';
declare const GPUBufferUsage:{STORAGE:number;COPY_SRC:number;COPY_DST:number;UNIFORM:number};
declare const GPUTextureUsage:{COPY_DST:number;TEXTURE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
const noObstacles:readonly WindObstacle[]=[];
const declarations=`struct Particle {position:vec4f,velocity:vec4f}
struct Obstacle {center:vec4f,extent:vec4f}
struct Frame {camera:mat4x4f,gravity:vec4f,wind:vec4f,settings:vec4f,right:vec4f,up:vec4f,eye:vec4f,forward:vec4f,params:vec4f,obstacles:array<Obstacle,64>}
@group(0) @binding(0) var<storage,read_write> particles:array<Particle>;
@group(0) @binding(1) var<uniform> frame:Frame;`;
const shader=declarations+`
@compute @workgroup_size(64) fn update(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=u32(frame.settings.z)){return;}let dt=frame.settings.x;var p=particles[id.x];let phase=p.position.xyz+frame.settings.w;
 var wind=frame.wind.xyz+vec3f(cos(phase.y)-sin(phase.z),cos(phase.z)-sin(phase.x),cos(phase.x)-sin(phase.y))*frame.params.x;
 p.velocity=vec4f(clamp(p.velocity.xyz+(frame.gravity.xyz+wind)*dt,vec3f(-3),vec3f(3)),0);p.position=vec4f(p.position.xyz+p.velocity.xyz*dt,p.position.w);
 for(var i=0u;i<u32(frame.params.y);i++){let o=frame.obstacles[i];let relative=p.position.xyz-o.center.xyz;var normal=vec3f(0,1,0);var distance=0.0;
  if(o.center.w<0.5){let distanceToCenter=length(relative);normal=select(vec3f(0,1,0),relative/max(0.0001,distanceToCenter),dot(relative,relative)>0.00001);distance=distanceToCenter-o.extent.x;}
  else{let q=abs(relative)-o.extent.xyz;let outside=max(q,vec3f(0));let nearest=length(outside);distance=nearest+min(max(q.x,max(q.y,q.z)),0.0);
   if(nearest>0.0001){normal=outside*sign(relative)/nearest;}else{if(q.x>=q.y&&q.x>=q.z){normal=vec3f(select(-1.0,1.0,relative.x>=0),0,0);}else if(q.y>=q.z){normal=vec3f(0,select(-1.0,1.0,relative.y>=0),0);}else{normal=vec3f(0,0,select(-1.0,1.0,relative.z>=0));}}}
  if(distance<1){p.velocity=vec4f(p.velocity.xyz-normal*min(dot(wind,normal),0.0)*(1-clamp(distance,0.0,1.0))*dt,0);}
  if(distance<frame.settings.y){p.position=vec4f(p.position.xyz+normal*(frame.settings.y-distance),p.position.w);p.velocity=vec4f(p.velocity.xyz-normal*min(dot(p.velocity.xyz,normal),0.0)*1.5,0);}}
 if(p.position.y < -3.0){p.position.y=3.0;p.velocity=vec4f(0);}if(p.position.x>3.0){p.position.x = -3.0;}if(p.position.x < -3.0){p.position.x=3.0;}if(p.position.z>3.0){p.position.z = -3.0;}if(p.position.z < -3.0){p.position.z=3.0;}if(p.position.y>3.0){p.position.y = -3.0;p.velocity=vec4f(0);}particles[id.x]=p;
}`;
const sorter=declarations+`
@group(0) @binding(2) var<storage,read_write> order:array<u32>;
@group(0) @binding(3) var<uniform> stage:vec4u;
fn key(id:u32)->f32{if(id>=u32(frame.settings.z)){return -1e30;}return dot(particles[id].position.xyz-frame.eye.xyz,frame.forward.xyz);}
@compute @workgroup_size(64) fn initialize(@builtin(global_invocation_id) id:vec3u){if(id.x>=u32(frame.params.w)){return;}order[id.x]=id.x;}
@compute @workgroup_size(64) fn sort(@builtin(global_invocation_id) id:vec3u){let a=id.x;let b=a^stage.x;if(b<=a||b>=u32(frame.params.w)){return;}let ia=order[a];let ib=order[b];let ka=key(ia);let kb=key(ib);let descending=(a&stage.y)==0;if((descending&&ka<kb)||(!descending&&ka>kb)){order[a]=ib;order[b]=ia;}}`;
const drawShader=declarations.replace('read_write','read')+`
@group(0) @binding(2) var sprite:texture_2d<f32>;
@group(0) @binding(3) var filtering:sampler;
@group(0) @binding(4) var<storage,read> order:array<u32>;
struct Output {@builtin(position) clip:vec4f,@location(0) color:vec3f,@location(1) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Output {
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));var id=instance;if(frame.params.z>0){id=order[instance];}
 let p=particles[id].position;let angle=p.w*6.283+frame.settings.w;let c=cos(angle);let s=sin(angle);let q=corners[vertex]*frame.settings.y;
 let offset=frame.right.xyz*(c*q.x-s*q.y)+frame.up.xyz*(s*q.x+c*q.y);var o:Output;o.clip=frame.camera*vec4f(p.xyz+offset,1);o.color=mix(vec3f(0.95,0.36,0.12),vec3f(0.9,0.7,0.22),p.w);o.uv=corners[vertex]*vec2f(0.5,-0.5)+0.5;return o;
}
@fragment fn fragment(i:Output)->@location(0) vec4f{let texel=textureSample(sprite,filtering,i.uv);if(texel.a<0.02){discard;}return vec4f(i.color*texel.rgb,texel.a*0.85);}`;
export type WindObstacle={kind:'sphere';center:Vec3;radius:number}|{kind:'box';center:Vec3;halfSize:Vec3};
export interface ParticleTexture {width:number;height:number;data:Uint8Array|Uint8ClampedArray}
export interface ParticleOptions {count?:number;gravity?:Vec3;wind?:Vec3;size?:number;curl?:number;obstacles?:readonly WindObstacle[];sort?:boolean;texture?:ParticleTexture}
export class GPUParticles implements EnginePlugin {
 readonly name='gpu-particles';readonly count:number;private device?:GPUDevice;private particles?:GPUBuffer;private uniform?:GPUBuffer;private indices?:GPUBuffer;private texture?:GPUTexture;private sampler?:GPUSampler;
 private compute?:GPUComputePipeline;private computeGroup?:GPUBindGroup;private initialize?:GPUComputePipeline;private sort?:GPUComputePipeline;private stages:Array<{buffer:GPUBuffer;group:GPUBindGroup}>=[];private initializeGroup?:GPUBindGroup;
 private readonly variants=new Map<string,{pipeline:GPURenderPipeline;group:GPUBindGroup}>();private time=0;private readonly frame=new Float32Array(560);private readonly capacity:number;private sprite:ParticleTexture;
 private pass?:GPURenderPassDescriptor;
 constructor(readonly options:ParticleOptions={}) {
  const {count=5000,gravity=[0,-0.5,0],wind=[0.4,0,0],size=0.035,curl=0}=options;
  if(!Number.isSafeInteger(count)||count<1||count>100_000||!Number.isFinite(size)||size<=0||gravity.length!==3||wind.length!==3||[...gravity,...wind,size,curl].some(v=>!Number.isFinite(Math.fround(v)))||curl<0||curl>10||options.sort!==undefined&&typeof options.sort!=='boolean')throw new RangeError('Invalid particle options');
  this.count=count;this.capacity=2**Math.ceil(Math.log2(count));this.frame.set(gravity,16);this.frame.set(wind,20);this.frame[25]=size;this.frame[26]=count;this.frame[44]=curl;this.frame[46]=+(options.sort??false);this.frame[47]=this.capacity;this.obstacles();
  const data=new Uint8Array(8*8*4);for(let y=0;y<8;y++)for(let x=0;x<8;x++){const i=(y*8+x)*4;data.set([255,255,255,Math.abs((x-3.5)/3.5)+Math.abs((y-3.5)/3.5)<1.1?255:0],i);}this.sprite={width:8,height:8,data};if(options.texture)this.setTexture(options.texture);
 }
 private obstacles():void {
  const list=this.options.obstacles??noObstacles,count=list.length,f=this.frame;
  if(count>64)throw new RangeError('Obstacle limit is 64');f[45]=count;
  for(let i=0;i<count;i++){
   const o=list[i],center=o.center,x=center[0],y=center[1],z=center[2];
   if(o.kind!=='sphere'&&o.kind!=='box'||center.length!==3||!Number.isFinite(Math.fround(x))||!Number.isFinite(Math.fround(y))||!Number.isFinite(Math.fround(z)))throw new RangeError('Invalid wind obstacle');
   let ex:number,ey:number,ez:number;
   if(o.kind==='sphere')ex=ey=ez=o.radius;
   else{const extent=o.halfSize;if(extent.length!==3)throw new RangeError('Invalid wind obstacle extent');ex=extent[0];ey=extent[1];ez=extent[2];}
   if(!Number.isFinite(Math.fround(ex))||ex<=0||!Number.isFinite(Math.fround(ey))||ey<=0||!Number.isFinite(Math.fround(ez))||ez<=0)throw new RangeError('Invalid wind obstacle extent');
   const at=48+i*8;f[at]=x;f[at+1]=y;f[at+2]=z;f[at+3]=+(o.kind==='box');f[at+4]=ex;f[at+5]=ey;f[at+6]=ez;f[at+7]=0;
  }
 }
 setTexture(source:ParticleTexture):void {if(!Number.isSafeInteger(source.width)||!Number.isSafeInteger(source.height)||Math.min(source.width,source.height)<1||Math.max(source.width,source.height)>4096||!(source.data instanceof Uint8Array||source.data instanceof Uint8ClampedArray)||source.data.length!==source.width*source.height*4)throw new RangeError('Invalid RGBA particle texture');const sprite={width:source.width,height:source.height,data:Uint8Array.from(source.data)};if(this.device)this.uploadTexture(sprite);this.sprite=sprite;}
 private uploadTexture(s=this.sprite):void {const d=this.device!,texture=d.createTexture({size:[s.width,s.height],format:'rgba8unorm-srgb',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});try{d.queue.writeTexture({texture},s.data as Uint8Array<ArrayBuffer>,{bytesPerRow:s.width*4},[s.width,s.height]);}catch(error){texture.destroy();throw error;}this.texture?.destroy();this.texture=texture;this.variants.clear();}
 setup(engine:Engine):void {
  if(this.device)throw new Error('Particles already attached');const device=engine.gpu;if(!device)throw new Error('GPUParticles requires WebGPU; the base engine supports WebGL2');this.device=device;
  if(this.count*32>device.limits.maxStorageBufferBindingSize)throw new RangeError('Particle storage exceeds GPU limit');this.particles=device.createBuffer({size:this.count*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});this.uniform=device.createBuffer({size:2240,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.indices=device.createBuffer({size:this.capacity*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});this.uploadTexture();
  const data=new Float32Array(this.count*8);let seed=0x12345678;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};for(let i=0;i<this.count;i++){data[i*8]=random()*6-3;data[i*8+1]=random()*6-3;data[i*8+2]=random()*4-2;data[i*8+3]=random();}device.queue.writeBuffer(this.particles,0,data);
  this.compute=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:shader}),entryPoint:'update'}});const entries=[{binding:0,resource:{buffer:this.particles}},{binding:1,resource:{buffer:this.uniform}}];this.computeGroup=device.createBindGroup({layout:this.compute.getBindGroupLayout(0),entries});
  if(this.options.sort){const module=device.createShaderModule({code:sorter});this.initialize=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'initialize'}});this.sort=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'sort'}});this.initializeGroup=device.createBindGroup({layout:this.initialize.getBindGroupLayout(0),entries:[entries[1],{binding:2,resource:{buffer:this.indices}}]});
   for(let k=2;k<=this.capacity;k*=2)for(let j=k/2;j>=1;j/=2){const buffer=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});try{device.queue.writeBuffer(buffer,0,new Uint32Array([j,k,0,0]));const group=device.createBindGroup({layout:this.sort.getBindGroupLayout(0),entries:[...entries,{binding:2,resource:{buffer:this.indices}},{binding:3,resource:{buffer}}]});this.stages.push({buffer,group});}catch(error){buffer.destroy();throw error;}}}
 }
 registerPasses(graph:FrameGraph):void {graph.add({name:'particles:update',order:-10,execute:context=>this.update(context)});graph.add({name:'particles:draw',order:10,execute:context=>{if(context.backend!=='webgpu')throw new Error('Particles require WebGPU');this.draw(context);}});}
 private update(context:PassContext):void {if(context.backend!=='webgpu')throw new Error('Particles require WebGPU');this.obstacles();this.time+=context.delta;const f=this.frame;f.set(context.camera.matrix);f[24]=context.delta;f[27]=this.time;
  const [x,y,z]=context.camera.position,[tx,ty,tz]=context.camera.target,length=Math.hypot(tx-x,ty-y,tz-z),fx=(tx-x)/length,fy=(ty-y)/length,fz=(tz-z)/length;
  let rx=fy*0-fz,ry=fz*0-fx*0,rz=fx-fy*0;const rl=Math.hypot(rx,ry,rz);rx/=rl;ry/=rl;rz/=rl;
  f[28]=rx;f[29]=ry;f[30]=rz;f[31]=0;f[32]=ry*fz-rz*fy;f[33]=rz*fx-rx*fz;f[34]=rx*fy-ry*fx;f[35]=0;
  f[36]=x;f[37]=y;f[38]=z;f[39]=0;f[40]=fx;f[41]=fy;f[42]=fz;f[43]=0;this.device!.queue.writeBuffer(this.uniform!,0,f);
  const pass=context.encoder.beginComputePass();try{pass.setPipeline(this.compute!);pass.setBindGroup(0,this.computeGroup!);pass.dispatchWorkgroups(Math.ceil(this.count/64));
  if(this.initialize){pass.setPipeline(this.initialize);pass.setBindGroup(0,this.initializeGroup!);pass.dispatchWorkgroups(Math.ceil(this.capacity/64));pass.setPipeline(this.sort!);for(const stage of this.stages){pass.setBindGroup(0,stage.group);pass.dispatchWorkgroups(Math.ceil(this.capacity/64));}}}finally{pass.end();}
 }
 private draw(c:Context):void {const key=c.format+':'+c.descriptor.multisample?.count+':'+c.descriptor.depthStencil!.format;let variant=this.variants.get(key);if(!variant){const module=c.device.createShaderModule({code:drawShader});const pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},multisample:c.descriptor.multisample,depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:false,depthCompare:'greater-equal'}});
   variant={pipeline,group:c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.particles!}},{binding:1,resource:{buffer:this.uniform!}},{binding:2,resource:this.texture!.createView()},{binding:3,resource:this.sampler!},{binding:4,resource:{buffer:this.indices!}}]})};this.variants.set(key,variant);}
  const descriptor=this.pass??={colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthReadOnly:true,stencilReadOnly:true}};(descriptor.colorAttachments as GPURenderPassColorAttachment[])[0].view=c.color;descriptor.depthStencilAttachment!.view=c.depth;
  const pass=c.encoder.beginRenderPass(descriptor);try{pass.setPipeline(variant.pipeline);pass.setBindGroup(0,variant.group);pass.draw(6,this.count);}finally{pass.end();}
 }
 onDeviceRestored(engine:Engine):void {const time=this.time;this.dispose();try{this.setup(engine);this.time=time;}catch(error){this.dispose();throw error;}}
 dispose():void {this.particles?.destroy();this.uniform?.destroy();this.indices?.destroy();this.texture?.destroy();for(const s of this.stages)s.buffer.destroy();this.stages=[];this.variants.clear();this.particles=undefined;this.uniform=undefined;this.indices=undefined;this.texture=undefined;this.device=undefined;this.time=0;this.initialize=undefined;this.sort=undefined;this.compute=undefined;this.computeGroup=undefined;this.initializeGroup=undefined;this.sampler=undefined;this.pass=undefined;}
}



