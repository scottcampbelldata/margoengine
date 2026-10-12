import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {acquireDepth,group} from '../../shared/gpu.js';
import {CoastalFlow,waterFrame} from './coastal.js';
import {Spray} from './spray.js';
declare const GPUBufferUsage:{VERTEX:number;INDEX:number;UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{COPY_SRC:number;COPY_DST:number;RENDER_ATTACHMENT:number;TEXTURE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface Wave {direction:readonly [number,number];amplitude:number;wavelength:number;steepness?:number;phase?:number}
export interface WaterTerrain {heightmap:()=>GPUTexture|undefined;origin:readonly [number,number];size:readonly [number,number]}
export interface WaterOptions {size?:readonly [number,number];segments?:number;height?:number;waves?:readonly Wave[];color?:readonly [number,number,number];foamDistance?:number;depth?:()=>GPUTexture|undefined;terrain?:WaterTerrain;reflection?:()=>GPUTexture|undefined;sceneColor?:()=>GPUTexture|undefined;spray?:boolean}
const shader=waterFrame+`
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var history:texture_2d<f32>;
@group(0) @binding(3) var coast:texture_2d<f32>;
@group(0) @binding(4) var environment:texture_2d<f32>;
@group(0) @binding(5) var skySampler:sampler;
@group(0) @binding(6) var opaque:texture_2d<f32>;
fn inCoast(xz:vec2f)->bool {let uv=(xz-frame.coast.xy)/frame.coast.zw;return frame.flow.w>0.5&&all(uv>=vec2f(0))&&all(uv<=vec2f(1));}
struct CoastalSample {water:vec4f,normal:vec3f,surface:f32}
fn coastal(xz:vec2f)->CoastalSample {
 let size=vec2i(textureDimensions(coast));let uv=(xz-frame.coast.xy)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let a=textureLoad(coast,lo,0);let b=textureLoad(coast,vec2i(hi.x,lo.y),0);let c=textureLoad(coast,vec2i(lo.x,hi.y),0);let d=textureLoad(coast,hi,0);
 let weights=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y)*step(vec4f(0.003),vec4f(a.x,b.x,c.x,d.x));
 let total=dot(weights,vec4f(1));let surface=select(frame.settings.y,dot(weights,vec4f(a.x+a.y,b.x+b.y,c.x+c.y,d.x+d.y))/max(0.0001,total),total>0.0001);
 let h=vec4f(select(surface,a.x+a.y,a.x>0.003),select(surface,b.x+b.y,b.x>0.003),select(surface,c.x+c.y,c.x>0.003),select(surface,d.x+d.y,d.x>0.003));
 let dx=mix(h.y-h.x,h.w-h.z,t.y)/max(0.0001,frame.flow.y);let dz=mix(h.z-h.x,h.w-h.y,t.x)/max(0.0001,frame.flow.z);
 return CoastalSample(mix(mix(a,b,t.x),mix(c,d,t.x),t.y),normalize(vec3f(-dx,1,-dz)),surface);
}
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) world:vec3f,@location(2) crest:f32}
@vertex fn vertex(@location(0) xz:vec2f)->Output {
 if(inCoast(xz)){let v=coastal(xz);let p=vec3f(xz.x,v.surface,xz.y);return Output(frame.camera*vec4f(p,1),v.normal,p,v.water.z);}
 var p=vec3f(xz.x,frame.settings.y,xz.y);var tangent=vec3f(1,0,0);var binormal=vec3f(0,0,1);var crest=0.0;
 for(var j=0u;j<u32(frame.settings.w);j++){
  let w=frame.waves[j];let d=w.wave.xy;let a=w.wave.z*w.shape.w;let k=w.wave.w;let q=w.shape.x;
  let theta=k*dot(d,xz)-w.shape.y*frame.settings.x+w.shape.z;let s=sin(theta);let c=cos(theta);
  p+=vec3f(q*a*d.x*c,a*s,q*a*d.y*c);
  tangent+=vec3f(-q*a*k*d.x*d.x*s,a*k*d.x*c,-q*a*k*d.x*d.y*s);
  binormal+=vec3f(-q*a*k*d.x*d.y*s,a*k*d.y*c,-q*a*k*d.y*d.y*s);
  crest=max(crest,smoothstep(0.75,0.98,s)*smoothstep(0.14,0.32,a*k));
 }
 return Output(frame.camera*vec4f(p,1),normalize(cross(binormal,tangent)),p,crest);
}
fn linear(d:f32)->f32 {return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
fn hash(p:vec2i)->f32 {var x=bitcast<u32>(p.x)*1664525u+bitcast<u32>(p.y)*1013904223u;x=(x^(x>>16u))*2246822519u;return f32(x^(x>>13u))/4294967295.0;}
fn noise(p:vec2f)->f32 {let a=vec2i(floor(p));let f=fract(p);let t=f*f*(3.0-2.0*f);return mix(mix(hash(a),hash(a+vec2i(1,0)),t.x),mix(hash(a+vec2i(0,1)),hash(a+vec2i(1)),t.x),t.y);}
fn skyColor(r:vec3f)->vec3f {
 if(frame.color.w>0.5){let uv=vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(clamp(r.y,-1.0,1.0))/3.14159265);return textureSampleLevel(environment,skySampler,uv,0).rgb;}
 let daylight=smoothstep(-0.15,0.2,frame.sun.y);return mix(vec3f(0.18,0.27,0.32),vec3f(0.035,0.10,0.20),sqrt(max(0.0,r.y)))*(0.015+daylight);
}
struct Result {@location(0) color:vec4f,@location(1) foam:vec4f}
@fragment fn fragment(i:Output)->Result{
 let pixel=vec2i(i.clip.xy);let waterDistance=linear(i.clip.z);
 var gap=max(0.0,linear(textureLoad(depth,pixel,0))-waterDistance)*abs(frame.eye.y-i.world.y)/max(0.0001,waterDistance);
 var movement=i.crest;let isCoast=inCoast(i.world.xz);
 if(isCoast){let v=coastal(i.world.xz).water;gap=v.x;movement=v.z;}
 let footprint=max(length(dpdx(i.world.xz)),length(dpdy(i.world.xz)));let edge=max(0.015,fwidth(gap)*1.5);
 let normalWidth=length(fwidth(i.normal));let detail=1.0-smoothstep(0.2,1.0,footprint);
 if(isCoast&&gap<0.003){discard;}
 let grainDetail=1.0-smoothstep(0.25,1.0,footprint*2.4);var grain=0.5;
 if(grainDetail>0){grain=mix(0.5,noise(i.world.xz*2.4+vec2f(frame.settings.x*0.22,0)),grainDetail);}
 let shore=1.0-smoothstep(0.0,max(frame.settings.z*0.5,edge*2.0),max(0.0,gap+(grain-0.5)*0.08));
 let pattern=mix(0.45,1.0,grain);let fresh=clamp((shore*0.08+movement*0.9)*pattern,0.0,1.0);
 var foam=fresh;if(frame.flow.w<0.5){foam=max(fresh,textureLoad(history,pixel,0).r*exp(-frame.cameraData.z*3.0)*shore);}
 var ripple=vec3f(0);
 if(detail>0){
 let wind=frame.waves[0].wave.xy;let across=vec2f(-wind.y,wind.x);let uv=vec2f(dot(i.world.xz,wind),dot(i.world.xz,across));
 let a=dot(uv,vec2f(1.73,0.04))-frame.settings.x*1.17;
 let b=dot(uv,vec2f(2.52,0.45))-frame.settings.x*1.63+2.17;
 let c=dot(uv,vec2f(4.13,-0.33))-frame.settings.x*2.11+4.91;
 // The gradient of one coherent height field avoids independent X/Z ripple lattices.
 let gradient=vec2f(1.73,0.04)*cos(a)*0.0144+vec2f(2.52,0.45)*cos(b)*0.0051+vec2f(4.13,-0.33)*cos(c)*0.00145;
 let slope=wind*gradient.x+across*gradient.y;
 ripple=vec3f(-slope.x,0,-slope.y)*detail*(1.0-foam);
 }
 let n=normalize(i.normal+ripple);let v=normalize(frame.eye.xyz-i.world);let nv=max(0.001,dot(n,v));let fresnel=0.02+0.98*pow(1.0-nv,5.0);
 let optical=min(50.0,gap/max(0.15,abs(v.y)));let transmission=exp(-vec3f(0.38,0.10,0.045)*optical);
 var bottom=vec3f(0.28,0.25,0.17);
 if(frame.radiance.w>0.5){let limit=vec2i(textureDimensions(opaque))-1;var q=clamp(pixel+vec2i(n.xz*min(6.0,gap*2.0)),vec2i(0),limit);if(textureLoad(depth,q,0)>i.clip.z){q=pixel;}bottom=textureLoad(opaque,q,0).rgb;}
 let l=normalize(frame.sun.xyz);let nl=max(0.0,dot(n,l));let h=(v+l)/max(0.0001,length(v+l));let nh=max(0.0,dot(n,h));let vh=max(0.0,dot(v,h));
 let rough=clamp(0.085+normalWidth*0.6+footprint*0.012,0.085,0.35);let alpha=rough*rough;let a2=alpha*alpha;
 let denominator=nh*nh*(a2-1.0)+1.0;let d=a2/(3.14159265*denominator*denominator);let k=(rough+1.0)*(rough+1.0)*0.125;
 let g=nv/(nv*(1.0-k)+k)*nl/max(0.001,nl*(1.0-k)+k);let fh=0.02+0.98*pow(1.0-vh,5.0);
 let daylight=smoothstep(-0.04,0.06,l.y);let glint=frame.radiance.rgb*frame.sun.w*d*g*fh/max(0.004,4.0*nv)*daylight;
 let body=bottom*transmission+frame.color.rgb*(vec3f(1)-transmission)*(0.3+nl*frame.sun.w*0.12);
 var color=mix(body,skyColor(reflect(-v,n)),fresnel)+glint;
 color=mix(color,vec3f(0.72,0.77,0.74)*(0.1+daylight*0.9),foam*0.95);
 if(frame.cameraData.w<0.5){color=pow(color/(vec3f(1)+color),vec3f(1.0/2.2));}
 return Result(vec4f(color,1),vec4f(foam,0,0,1));
}`;
const depthCopy=`
@group(0) @binding(0) var sceneDepth:texture_depth_2d;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {return textureLoad(sceneDepth,vec2i(p.xy),0);}
`;
let instances=0;
export class Water implements EnginePlugin {
 private readonly attachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
 private readonly foamAttachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}};
 private readonly depthAttachment:GPURenderPassDepthStencilAttachment={view:undefined!,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true};
 private readonly presentation:GPURenderPassDescriptor={colorAttachments:[this.attachment,this.foamAttachment],depthStencilAttachment:this.depthAttachment};
 private readonly copiedDepth:GPURenderPassDepthStencilAttachment={view:undefined!,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store',stencilReadOnly:true};
 private readonly depthPresentation:GPURenderPassDescriptor={colorAttachments:[],depthStencilAttachment:this.copiedDepth};
 private surfaceDepth?:GPUTexture;private surfaceView?:GPUTextureView;private copyPipeline?:GPURenderPipeline;private copyGroup?:GPUBindGroup;
 private reflected?:GPUTexture;private captured?:GPUTexture;private capturedView?:GPUTextureView;private skySampler?:GPUSampler;
 private spray?:Spray;
 private readonly colorSource:GPUTexelCopyTextureInfo={texture:undefined!};private readonly colorTarget:GPUTexelCopyTextureInfo={texture:undefined!};private readonly colorSize:GPUExtent3DDict={width:1,height:1,depthOrArrayLayers:1};
 private foamViews:GPUTextureView[]=[];private groups:GPUBindGroup[]=[];private sampledDepth?:GPUTexture;private coastal?:CoastalFlow;
 readonly name='water:'+ ++instances;private engine?:Engine;private source?:()=>GPUTexture|undefined;private shared?:ReturnType<typeof acquireDepth>;private uniform?:GPUBuffer;private vertices?:GPUBuffer;private indices?:GPUBuffer;
 private count=0;private pipeline?:GPURenderPipeline;private format='';private foam:GPUTexture[]=[];private current=0;private time=0;private readonly values=new Float32Array(112);private readonly waveHeights=new Float32Array(8);private maxWaveHeight=0;private disposed=false;private readonly positions:Float32Array;private readonly triangles:Uint32Array;
 constructor(readonly options:WaterOptions={}){
  const {size=[100,100],segments=128,height=0,color=[0.01,0.18,0.25],foamDistance=1,waves=[{direction:[1,0.3],amplitude:0.3,wavelength:12.73,phase:0.43},{direction:[1,0.6],amplitude:0.15,wavelength:7.19,phase:2.17}]}=options;
  if(size.length!==2||size.some(v=>!Number.isFinite(Math.fround(v))||v<=0||v>100000)||!Number.isInteger(segments)||segments<1||segments>512||!Number.isFinite(Math.fround(height))||!Number.isFinite(foamDistance)||foamDistance<=0||foamDistance>100||color.length!==3||color.some(v=>!Number.isFinite(v)||v<0||v>1)||waves.length<1||waves.length>8||options.depth!==undefined&&typeof options.depth!=='function')throw new RangeError('Invalid water options');
  this.values.set([0,height,foamDistance,waves.length],20);this.values.set(color,24);
  this.values.set([0.6,0.8,0,3,1,0.9,0.75,0],104);
  if(options.reflection!==undefined&&typeof options.reflection!=='function'||options.sceneColor!==undefined&&typeof options.sceneColor!=='function'||options.spray!==undefined&&typeof options.spray!=='boolean'||options.spray&&!options.terrain)throw new TypeError('Invalid water optics or spray options');
  this.values[98]=this.values[99]=1;
  const terrain=options.terrain;
  if(terrain){if(typeof terrain.heightmap!=='function'||terrain.origin.length!==2||terrain.origin.some(v=>!Number.isFinite(Math.fround(v)))||terrain.size.length!==2||terrain.size.some(v=>!Number.isFinite(Math.fround(v))||v<=0||v>100000))throw new RangeError('Invalid water terrain');this.values.set(terrain.origin,96);this.values.set(terrain.size,98);this.values[103]=1;}
  const edge=Math.hypot(size[0]/segments,size[1]/segments);
  for(let i=0;i<waves.length;i++){const w=waves[i],length=Math.hypot(...w.direction),q=w.steepness??0.5;
   if(w.direction.length!==2||w.direction.some(v=>!Number.isFinite(v))||!length||!Number.isFinite(w.amplitude)||w.amplitude<0||w.amplitude>100||!Number.isFinite(w.wavelength)||w.wavelength<=0||w.wavelength>100000||!Number.isFinite(q)||q<0||q>1||!Number.isFinite(w.phase??0))throw new RangeError('Invalid Gerstner wave');
   const k=2*Math.PI/w.wavelength;if(q*w.amplitude*k>1/waves.length)throw new RangeError('Wave steepness would fold the surface');
   // Fade waves shorter than four triangle edges to prevent mesh sampling artifacts.
   const t=Math.max(0,Math.min(1,(w.wavelength/edge-2)/2));
   this.values.set([w.direction[0]/length,w.direction[1]/length,w.amplitude,k,q,Math.sqrt(9.81*k),w.phase??0,t*t*(3-2*t)],32+i*8);
   this.waveHeights[i]=w.amplitude;this.maxWaveHeight=Math.max(this.maxWaveHeight,w.amplitude);
  }
  this.positions=new Float32Array((segments+1)**2*2);this.triangles=new Uint32Array(segments**2*6);
  for(let z=0;z<=segments;z++)for(let x=0;x<=segments;x++){const o=(z*(segments+1)+x)*2;this.positions[o]=(x/segments-0.5)*size[0];this.positions[o+1]=(z/segments-0.5)*size[1];if(x<segments&&z<segments){const a=o/2,b=a+segments+1;this.triangles.set([a,b,a+1,a+1,b,b+1],(z*segments+x)*6);}}
  this.count=this.triangles.length;
 }
 static attach(engine:EngineKernel,options:WaterOptions={}):Water {const effect=new Water(options);engineRuntime(engine).use(effect);return effect;}
 /** Scales the wave spectrum so its largest component has this amplitude in meters. */
 setWaveHeight(height:number):this {
  if(this.disposed||!Number.isFinite(height)||height<0||height>100||!this.maxWaveHeight&&height>0)throw new RangeError('Invalid water wave height');
  for(let i=0;i<this.values[23];i++){const o=32+i*8,amplitude=this.maxWaveHeight?height*this.waveHeights[i]/this.maxWaveHeight:0;if(this.values[o+4]*amplitude*this.values[o+3]>1/this.values[23])throw new RangeError('Wave steepness would fold the surface');}
  for(let i=0;i<this.values[23];i++)this.values[34+i*8]=this.maxWaveHeight?height*this.waveHeights[i]/this.maxWaveHeight:0;
  return this;
 }
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Water requires WebGPU');this.engine=engine;
  this.shared=this.options.depth?undefined:acquireDepth(engine);this.source=this.options.depth??this.shared!.texture;
  this.uniform=engine.gpu.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.skySampler=engine.gpu.createSampler({addressModeU:'repeat',addressModeV:'clamp-to-edge',minFilter:'linear',magFilter:'linear'});
  this.vertices=engine.gpu.createBuffer({size:this.positions.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});engine.gpu.queue.writeBuffer(this.vertices,0,this.positions as Float32Array<ArrayBuffer>);
  this.indices=engine.gpu.createBuffer({size:this.triangles.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});engine.gpu.queue.writeBuffer(this.indices,0,this.triangles as Uint32Array<ArrayBuffer>);
 }
 registerPasses(graph:FrameGraph):void {graph.add({name:this.name+':draw',order:4,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
 private draw(c:Context):void {
  const depth=this.source!();if(!depth||depth.width!==c.width||depth.height!==c.height||!depth.format.startsWith('depth')||!(depth.usage&GPUTextureUsage.TEXTURE_BINDING))throw new Error('Water needs viewport-sized sampleable scene depth');
  const reflection=this.options.reflection?.();if(this.options.reflection&&(!reflection||reflection.dimension!=='2d'||reflection.sampleCount!==1||reflection.depthOrArrayLayers>1||reflection.format!=='rgba16float'||!(reflection.usage&GPUTextureUsage.TEXTURE_BINDING)))throw new Error('Water reflection needs a sampleable rgba16float sky texture');
  if(this.reflected!==reflection){this.reflected=reflection;this.groups=[];}this.values[27]=+!!reflection;
  const scene=this.options.sceneColor?.();this.values[111]=+!!scene;
  if(this.options.sceneColor){
   if(!scene||scene.dimension!=='2d'||scene.sampleCount!==1||scene.depthOrArrayLayers>1||scene.width!==c.width||scene.height!==c.height||scene.format!=='rgba16float'||scene.format!==c.format||!(scene.usage&GPUTextureUsage.COPY_SRC))throw new Error('Water scene color needs a viewport-sized copyable HDR color texture');
   if(this.captured?.width!==c.width||this.captured?.height!==c.height||this.captured?.format!==c.format){this.captured?.destroy();this.captured=c.device.createTexture({size:[c.width,c.height],format:c.format,usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});this.capturedView=this.captured.createView();this.colorTarget.texture=this.captured;this.colorSize.width=c.width;this.colorSize.height=c.height;this.groups=[];}
   this.colorSource.texture=scene;c.encoder.copyTextureToTexture(this.colorSource,this.colorTarget,this.colorSize);
  }
  if(this.surfaceDepth?.width!==c.width||this.surfaceDepth?.height!==c.height||this.surfaceDepth?.format!==depth.format){
   const changed=this.surfaceDepth?.format!==depth.format;this.surfaceDepth?.destroy();this.surfaceDepth=c.device.createTexture({size:[c.width,c.height],format:depth.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.surfaceView=this.surfaceDepth.createView();this.copiedDepth.view=this.surfaceView;this.groups=[];
   if(changed){const module=c.device.createShaderModule({code:depthCopy});this.copyPipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[]},depthStencil:{format:depth.format,depthWriteEnabled:true,depthCompare:'always'}});this.format='';}
  }
  if(this.foam[0]?.width!==c.width||this.foam[0]?.height!==c.height){for(const t of this.foam)t.destroy();this.foam=[0,1].map(()=>c.device.createTexture({size:[c.width,c.height],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}));this.foamViews=this.foam.map(texture=>texture.createView());this.groups=[];this.current=0;}
  if(this.format!==c.format){const module=c.device.createShaderModule({code:shader});this.pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:'float32x2'}]}]},fragment:{module,entryPoint:'fragment',targets:[{format:c.format},{format:'r8unorm'}]},primitive:{cullMode:'none'},depthStencil:{format:depth.format,depthCompare:'greater-equal',depthWriteEnabled:true}});this.format=c.format;this.groups=[];}
  this.time+=c.delta;this.values.set(c.camera.matrix);this.values.set(c.camera.position,16);this.values[20]=this.time;this.values[28]=c.camera.near;this.values[29]=c.camera.far;this.values[30]=c.delta;this.values[31]=+(c.format==='rgba16float');
  const lighting=this.engine!.lighting;if(lighting){this.values.set(lighting.direction,104);this.values[108]=lighting.radiance[0];this.values[109]=lighting.radiance[1];this.values[110]=lighting.radiance[2];}
  if(this.options.terrain){
   const terrain=this.options.terrain.heightmap();if(!terrain||terrain.dimension!=='2d'||terrain.sampleCount!==1||terrain.depthOrArrayLayers>1||terrain.width<2||terrain.height<2||terrain.width>512||terrain.height>512||terrain.format!=='r32float'||!(terrain.usage&GPUTextureUsage.TEXTURE_BINDING))throw new Error('Water terrain needs a sampleable 2D r32float heightmap, 2..512 cells per side');
   if(this.coastal?.terrain!==terrain){this.spray?.dispose();this.spray=undefined;this.coastal?.dispose();this.coastal=new CoastalFlow(c.device,this.uniform!,terrain);if(this.options.spray)this.spray=new Spray(c.device,this.uniform!,this.coastal);this.values[101]=this.values[98]/terrain.width;this.values[102]=this.values[99]/terrain.height;this.groups=[];}
   this.values[100]=Math.min(Math.max(c.delta,0),1/15)/3;
  }
  c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);this.coastal?.step(c.encoder);this.spray?.step(c.encoder);
  if(this.sampledDepth!==depth||!this.groups.length){const view=depth.createView({aspect:'depth-only'});this.copyGroup=group(c.device,this.copyPipeline!,[view]);this.groups=[];for(let i=0;i<2;i++)for(let j=0;j<(this.coastal?2:1);j++)this.groups.push(group(c.device,this.pipeline!,[{buffer:this.uniform!},view,this.foamViews[i],this.coastal?.views[j]??this.foamViews[i],reflection?.createView()??this.foamViews[i],this.skySampler!,this.capturedView??this.foamViews[i]]));this.sampledDepth=depth;}
  const copy=c.encoder.beginRenderPass(this.depthPresentation);copy.setPipeline(this.copyPipeline!);copy.setBindGroup(0,this.copyGroup!);copy.draw(3);copy.end();
  const bind=this.groups[this.current*(this.coastal?2:1)+(this.coastal?.current??0)];this.current=1-this.current;
  this.attachment.view=c.color;this.foamAttachment.view=this.foamViews[this.current];this.depthAttachment.view=this.surfaceView!;const pass=c.encoder.beginRenderPass(this.presentation);
  pass.setPipeline(this.pipeline!);pass.setBindGroup(0,bind);pass.setVertexBuffer(0,this.vertices!);pass.setIndexBuffer(this.indices!,'uint32');pass.drawIndexed(this.count);pass.end();
  this.spray?.draw(c,this.surfaceDepth!,this.surfaceView!);
 }
 private release():void {this.shared?.release();this.shared=undefined;this.spray?.dispose();this.spray=undefined;this.coastal?.dispose();this.coastal=undefined;this.surfaceDepth?.destroy();this.surfaceDepth=undefined;this.surfaceView=undefined;this.copyPipeline=undefined;this.copyGroup=undefined;this.captured?.destroy();this.captured=undefined;this.capturedView=undefined;this.reflected=undefined;this.skySampler=undefined;this.uniform?.destroy();this.vertices?.destroy();this.indices?.destroy();for(const t of this.foam)t.destroy();this.foam=[];this.foamViews=[];this.groups=[];this.sampledDepth=undefined;this.uniform=this.vertices=this.indices=undefined;this.pipeline=undefined;this.format='';}
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=undefined;}
}
