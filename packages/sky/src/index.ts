import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {fullscreen,group,compute,dispatch} from '../../shared/gpu.js';
import {invert,finiteVector} from '../../shared/math.js';
import {cloudShader} from './clouds.js';
import {celestialShader} from './celestial.js';
import {atmosphere,transmittance,single,density,multiple,add} from './atmosphere.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{STORAGE_BINDING:number;TEXTURE_BINDING:number};
type Color=readonly [number,number,number];
const moonColor:Color=[0.25,0.45,0.75];
export interface SkyLightingOptions {intensity?:number;minimum?:number;color?:Color;sunset?:Color;moon?:{intensity?:number;color?:Color};ambient?:{day:Color;night:Color}}
export interface SkyCloudOptions {coverage?:number;speed?:number;height?:number}
export interface SkyFogOptions {depth:()=>GPUTexture|undefined;density?:number;start?:number;
 /** 'exp2' (default): 1 - exp(-(d * density)^2); 'exp': 1 - exp(-d * density). */
 falloff?:'exp'|'exp2';
 /** Extra density per metre below y = 0, as a fraction (default 0). */
 height?:number;
 /** Fixed linear fog colour instead of the sky's radiance in the view direction. */
 color?:Color}
/** Stylized night: gradient, twinkling stars and a phased moon. Replaces the default night gradient when set; read every frame. */
export interface SkyNightOptions {zenithColor?:Color;horizonColor?:Color;moonColor?:Color;moonDirection?:Color;
 /** Angular radius in radians, between 0 and PI / 2 (exclusive). Default 0.038. */
 moonSize?:number;
 /** -1 new, 0 half, 1 full; clamped. Default 0.85. */
 moonPhase?:number;glowIntensity?:number;starIntensity?:number;
 /** Twinkle amplitude; zero holds stars steady. Default 1. */
 starTwinkleIntensity?:number;
 /** Horizon haze thickness; zero removes the gradient. Default 1. */
 hazeDensity?:number}
export interface SkyOptions {night?:SkyNightOptions;clouds?:SkyCloudOptions;fog?:SkyFogOptions;model?:'preetham'|'bruneton';hours?:number;timeScale?:number;turbidity?:number;exposure?:number;lighting?:SkyLightingOptions}
export function sunDirection(hours:number,out=new Float32Array(3)):Float32Array {if(!Number.isFinite(hours)||out.length!==3)throw new RangeError('Invalid sun clock');const angle=(hours%24-6)*Math.PI/12;out[0]=Math.cos(angle);out[1]=Math.sin(angle);out[2]=0;return out;}
const code=fullscreen+atmosphere+cloudShader+celestialShader+`
@group(0) @binding(1) var scattering:texture_2d<f32>;
@group(0) @binding(2) var transmission:texture_2d<f32>;
fn hash21(p:vec2f)->f32 {var q=fract(p.xyx*0.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
fn stylizedNight(r:vec3f)->vec3f {
 let haze=frame.nightHorizon.w;let moon=frame.nightMoon;let params=frame.nightParams;
 var color=mix(frame.nightZenith.rgb,frame.nightHorizon.rgb,pow(1.0-clamp(r.y,0.0,1.0),2.5/max(haze,0.01))*min(haze,1.0));
 let cosine=clamp(dot(r,moon.xyz),-1.0,1.0);
 if(r.y>0.258819){
  let cell=r.xz/(r.y+0.15)*250.0;let random=hash21(floor(cell));
  if(random>0.985){let twinkle=max(0.0,sin(params.w*2.0+random*6.28)*0.5*frame.nightZenith.w+0.5);
   color+=vec3f(0.8,0.9,1.0)*(1.0-smoothstep(0.01,0.12,length(fract(cell)-0.5)))*random*twinkle*params.z*smoothstep(0.258819,0.5,r.y)*(1.0-smoothstep(0.96,1.0,cosine));}
 }
 color+=frame.nightMoonColor.rgb*pow(max(cosine,0.0),32.0)*params.y*0.35;
 if(cosine>moon.w){
  let right=normalize(cross(moon.xyz,select(vec3f(0,1,0),vec3f(0,0,1),abs(moon.y)>0.99)));
  let disc=vec2f(dot(r,right),dot(r,cross(right,moon.xyz)))/frame.nightMoonColor.w;let radius=dot(disc,disc);let limb=sqrt(max(0.0,1.0-radius));
  let lit=disc.x*sqrt(max(0.0,1.0-params.x*params.x))+limb*params.x;
  color=mix(color,frame.nightMoonColor.rgb*(0.8+0.2*limb)*smoothstep(0.0,0.02,lit),1.0-smoothstep(0.96,1.0,radius));
 }
 return color;
}
fn nightSky(w:vec3f)->vec3f {
 if(frame.nightOn.x>0.5){return stylizedNight(w);}
 return mix(vec3f(0.012,0.019,0.038),vec3f(0.003,0.006,0.02),sqrt(max(0.0,w.y)));
}
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
fn daySky(direction:vec3f)->vec3f {
 // Keep the coarse table's dark ground hemisphere out of the visible ocean horizon.
 let w=normalize(vec3f(direction.x,max(0.01,direction.y),direction.z));
 let s=frame.sun.xyz;
 var color=vec3f(0);if(frame.settings.x<0.5){color=preetham(w,s);}else{let r=R+clamp(frame.eye.w,0.001,99.9);color=lookup(scattering,r,w.y,s.y,dot(w,s));}
 return color;
}
fn skyRadiance(w:vec3f)->vec3f {if(frame.sun.w>=1.0){return nightSky(w);}return mix(daySky(w),nightSky(w),frame.sun.w);}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=frame.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,0.000001,1);let w=normalize(p.xyz/p.w-frame.eye.xyz);let s=frame.sun.xyz;
 var color=skyRadiance(w);
 let footprint=max(length(dpdx(w)),length(dpdy(w)));let sun=celestialProfile(w,s,SUN_RADIUS,footprint);
 color+=(sun.x*60.0+sun.y*0.8)*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint);
 color=cloudSky(color,w,footprint);color*=exp2(frame.settings.y);if(frame.settings.w<0.5&&frame.nightOn.x<0.5){color=pow(color/(1.0+color),vec3f(1.0/2.2));}return vec4f(color,1);
}`;
const fogShader=code+`
@group(0) @binding(3) var sceneDepth:texture_depth_2d;
@group(0) @binding(4) var<uniform> fog:array<vec4f,2>;
@fragment fn fogFragment(i:Vertex)->@location(0) vec4f {
 let d=textureLoad(sceneDepth,vec2i(i.position.xy),0);if(d<=0.0){discard;}
 let p=frame.inverse*vec4f(i.uv*vec2f(2,-2)+vec2f(-1,1),d,1);let world=p.xyz/p.w;let offset=world-frame.eye.xyz;
 let distance=length(offset);let optical=max(0.0,distance-fog[0].y)*fog[0].x*(1.0+max(-world.y,0.0)*fog[0].w);if(optical<=0.0){discard;}
 let opacity=1.0-exp(-select(optical*optical,optical,fog[0].z>0.5));
 // shortcut: homogeneous distance haze, use volumetric scattering for local weather and light shafts.
 let ray=offset/max(distance,0.0001);var color=fog[1].rgb;if(fog[1].w<0.5){color=skyRadiance(normalize(vec3f(ray.x,max(0.0001,ray.y),ray.z)))*exp2(frame.settings.y);}
 if(frame.settings.w<0.5&&frame.nightOn.x<0.5){color=pow(color/(1.0+color),vec3f(1.0/2.2));}return vec4f(color,opacity);
}`;
const reflection=code+`
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 let uv=(vec2f(id.xy)+0.5)/vec2f(64,32);let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;
 let w=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));let s=frame.sun.xyz;
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=daySky(ray);
 color=mix(vec3f(0.015,0.018,0.012),color,smoothstep(-0.2,0.02,w.y));
 color=mix(color,nightSky(w),frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,0.1);
 color=cloudSky(color,w,0.1);
 textureStore(reflectionMap,vec2i(id.xy),vec4f(color*exp2(frame.settings.y),1));
}`;
export class Sky implements EnginePlugin {
 private readonly attachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
 private readonly depthAttachment:GPURenderPassDepthStencilAttachment={view:undefined!,depthReadOnly:true,stencilReadOnly:true};
 private readonly presentation:GPURenderPassDescriptor={colorAttachments:[this.attachment],depthStencilAttachment:this.depthAttachment};
 readonly name:string='sky';private engine?:Engine;private uniform?:GPUBuffer;private textures:GPUTexture[]=[];private pipelines:GPUComputePipeline[]=[];private groups:GPUBindGroup[]=[];private render?:GPURenderPipeline;private bind?:GPUBindGroup;private format='';private computedT=NaN;private scatteringT=NaN;private readonly values=new Float32Array(64);private time=0;private readonly inverse=this.values.subarray(0,16);private readonly scratch=new Float64Array(52);readonly sun=new Float32Array(3);readonly moon=Float32Array.from([-0.3,0.22,-1],v=>v/Math.hypot(0.3,0.22,1));private disposed=false;
 private cloudTime=0;private ambient?:GPUBuffer;private ambientEntry?:GPUBindGroupEntry;private readonly ambientValues=new Float32Array(4);private source='';private litShader='';
 private reflectionPipeline?:GPUComputePipeline;private reflectionGroup?:GPUBindGroup;private reflectionRequested=false;private readonly reflectionPass:GPUComputePassDescriptor={};
 private fogUniform?:GPUBuffer;private fogPipeline?:GPURenderPipeline;private fogGroup?:GPUBindGroup;private fogDepth?:GPUTexture;private fogFormat='';private readonly fogValues=new Float32Array(8);
 private readonly fogAttachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};private readonly fogPass:GPURenderPassDescriptor={colorAttachments:[this.fogAttachment]};
 /** Borrowed linear HDR sky environment; rebuilt on device restoration. */
 get reflectionTexture():GPUTexture|undefined{this.reflectionRequested=true;return this.textures[6];}
 /** Dusk/dawn blend, 0 in daylight and 1 at night, updated before rendering. */
 get nightFactor():number{return this.values[23];}
 /** Retained sun/moon directions (XYZ, intensity) and RGB radiance for direct reflections. */
 readonly lights=[{direction:new Float32Array([1,0,0,0]),radiance:new Float32Array(3)},{direction:new Float32Array([...this.moon,0]),radiance:new Float32Array(3)}] as const;
 constructor(readonly options:SkyOptions={}){this.validate();}
 private validate():void {
  const o=this.options;if(o.model!==undefined&&o.model!=='preetham'&&o.model!=='bruneton'||!Number.isFinite(o.hours??12)||!Number.isFinite(o.timeScale??1/3600)||Math.abs(o.timeScale??1/3600)>24||!Number.isFinite(o.turbidity??2)||(o.turbidity??2)<1||(o.turbidity??2)>10||!Number.isFinite(o.exposure??0)||Math.abs(o.exposure??0)>16||o.lighting!==undefined&&(typeof o.lighting!=='object'||o.lighting===null||!Number.isFinite(Math.fround(o.lighting.intensity??1))||(o.lighting.intensity??1)<0||!Number.isFinite(Math.fround(o.lighting.minimum??0))||(o.lighting.minimum??0)<0))throw new RangeError('Invalid sky options');
  const clouds=o.clouds;if(clouds!==undefined&&(typeof clouds!=='object'||clouds===null||!Number.isFinite(clouds.coverage??0.45)||(clouds.coverage??0.45)<0||(clouds.coverage??0.45)>1||!Number.isFinite(clouds.speed??8)||Math.abs(clouds.speed??8)>100||!Number.isFinite(clouds.height??1500)||(clouds.height??1500)<100||(clouds.height??1500)>10000))throw new RangeError('Invalid sky clouds');
  const fog=o.fog;if(fog?.color)finiteVector(fog.color,3,'Fog color');
  if(fog!==undefined&&(typeof fog!=='object'||fog===null||typeof fog.depth!=='function'||fog.falloff!==undefined&&fog.falloff!=='exp'&&fog.falloff!=='exp2'||!(Math.fround(fog.height??0)>=0)||!Number.isFinite(Math.fround(fog.height??0))||!Number.isFinite(Math.fround(fog.density??0.01))||(fog.density??0.01)<0||(fog.density??0.01)>1||!Number.isFinite(Math.fround(fog.start??40))||(fog.start??40)<0))throw new RangeError('Invalid sky fog');
  const n=o.night;if(n){
   for(const color of [n.zenithColor,n.horizonColor,n.moonColor])if(color!==undefined){finiteVector(color,3,'Sky color');if(color.some(v=>v<0))throw new RangeError('Sky colors must be non-negative');}
   if(n.moonDirection!==undefined){finiteVector(n.moonDirection,3,'Moon direction');if(!Math.hypot(...n.moonDirection))throw new RangeError('Moon direction must be nonzero');}
   for(const v of [n.moonSize,n.moonPhase,n.glowIntensity,n.starIntensity,n.starTwinkleIntensity,n.hazeDensity])if(v!==undefined&&!Number.isFinite(Math.fround(v)))throw new RangeError('Sky parameters must be finite Float32 numbers');
   if(n.moonSize!==undefined&&!(Math.fround(n.moonSize)>0&&Math.fround(n.moonSize)<Math.PI/2))throw new RangeError('Moon size must be between 0 and PI / 2');
  }
  const l=o.lighting;if(!l)return;
  if(l.moon!==undefined&&(typeof l.moon!=='object'||l.moon===null||!Number.isFinite(Math.fround(l.moon.intensity??(l.intensity??1)*0.1))||(l.moon.intensity??0)<0)||l.ambient!==undefined&&(typeof l.ambient!=='object'||l.ambient===null))throw new RangeError('Invalid sky night options');
  for(const color of [l.color,l.sunset,l.moon?.color,l.ambient?.day,l.ambient?.night])if(color!==undefined){finiteVector(color,3,'Sky color');if(color.some(v=>v<0))throw new RangeError('Invalid sky color');}
  if(l.ambient&&(!l.ambient.day||!l.ambient.night))throw new RangeError('Invalid sky ambient colors');
 }
 static attach(engine:EngineKernel,options:SkyOptions={}):Sky {const effect=new Sky(options);engineRuntime(engine).use(effect);return effect;}
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Sky requires WebGPU');this.engine=engine;const d=engine.gpu;
  this.uniform=d.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.ambient=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.ambientEntry={binding:8,resource:{buffer:this.ambient}};
  this.textures.push(d.createTexture({size:[128,32],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING}));
  for(let i=0;i<5;i++)this.textures.push(d.createTexture({size:[128,256],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING}));
  this.pipelines=[transmittance,single,density,multiple,add].map(s=>compute(d,s));const t=this.textures.map(t=>t.createView()),u={buffer:this.uniform};
  this.groups=[group(d,this.pipelines[0],[u,t[0]]),group(d,this.pipelines[1],[u,t[0],t[1],t[3]])];
  for(let order=0;order<3;order++){const previous=order%2,next=1-previous;
   this.groups.push(group(d,this.pipelines[2],[u,t[1+previous],t[5]]),group(d,this.pipelines[3],[u,t[5],t[1+next]]),group(d,this.pipelines[4],[t[3+previous],t[1+next],t[3+next]]));
  }
  const reflected=d.createTexture({size:[64,32],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});this.textures.push(reflected);this.reflectionPipeline=compute(d,reflection,'reflectSky');this.reflectionGroup=d.createBindGroup({layout:this.reflectionPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:u},{binding:1,resource:t[4]},{binding:3,resource:reflected.createView()}]});
 }
 registerPasses(graph:FrameGraph):void {
  graph.add({name:'sky:lighting',order:-6,execute:c=>{
   if(c.backend!=='webgpu'||!this.options.lighting?.ambient)return;
   if(this.source!==c.shader){const patched=c.shader.replace('frame.radiance.w','skyAmbient.rgb');if(patched===c.shader)throw new Error('Sky ambient requires the standard PBR shader');this.source=c.shader;this.litShader='@group(0) @binding(8) var<uniform> skyAmbient:vec4f;\n'+patched;}
   c.device.queue.writeBuffer(this.ambient!,0,this.ambientValues as Float32Array<ArrayBuffer>);c.shader=this.litShader;c.bindings.push(this.ambientEntry!);
  }});
  graph.add({name:'sky:atmosphere',order:2,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});
  graph.add({name:'sky:fog',order:5,execute:c=>{if(c.backend==='webgpu'&&this.options.fog)this.drawFog(c);}});
 }
 onPreUpdate(delta:number):void {
  this.validate();if(!Number.isFinite(delta)||delta<0)throw new RangeError('Invalid sky delta');
  this.cloudTime+=delta*(this.options.clouds?.speed??8);this.time+=delta;
  this.options.hours=(((this.options.hours??12)+delta*(this.options.timeScale??1/3600))%24+24)%24;sunDirection(this.options.hours,this.sun);
  const l=this.options.lighting,t=Math.max(0,Math.min(1,(this.sun[1]+0.12)/0.2)),night=1-t*t*(3-2*t);
  const moonT=Math.max(0,Math.min(1,-this.sun[1]/0.12)),moonVisibility=moonT*moonT*(3-2*moonT),moonIntensity=l?.moon?(l.moon.intensity??(l.intensity??1)*0.1):0;
  this.values[23]=night;this.values.set(this.moon,28);this.values[31]=moonIntensity*moonVisibility;this.values.set(l?.moon?.color??moonColor,32);
  this.lights[0].direction.set(this.sun);this.lights[0].direction[3]=Math.max(0,this.sun[1])*(l?.intensity??0);
  const elevation=Math.max(0,Math.min(1,(this.sun[1]-0.08)/0.42)),day=elevation*elevation*(3-2*elevation);
  for(let i=0;i<3;i++)this.lights[0].radiance[i]=(l?.color?.[i]??1)*day+(l?.sunset?.[i]??l?.color?.[i]??1)*(1-day);
  this.lights[1].direction.set(this.moon);this.lights[1].direction[3]=this.values[31];this.lights[1].radiance.set(l?.moon?.color??moonColor);
  if(l&&this.engine){
   const {direction,radiance}=this.engine.lighting,solar=Math.max(0,this.sun[1])*(l.intensity??1),lunar=moonIntensity*night,weight=solar+lunar>0?solar/(solar+lunar):1;
   // shortcut: one blended directional source shares PCSS, use separate shadow maps for simultaneous sun/moon shadows.
   direction.set(this.sun);if(l.moon){for(let i=0;i<3;i++)direction[i]=this.sun[i]*weight+this.moon[i]*(1-weight);const norm=Math.hypot(direction[0],direction[1],direction[2]);for(let i=0;i<3;i++)direction[i]/=norm;}
   direction[3]=Math.max(l.minimum??0,solar+lunar);
   if(l.color||l.sunset||l.moon)for(let i=0;i<3;i++)radiance[i]=this.lights[0].radiance[i]*weight+(l.moon?.color?.[i]??moonColor[i])*(1-weight);
   if(l.ambient){for(let i=0;i<3;i++)this.ambientValues[i]=l.ambient.day[i]*(1-night)+l.ambient.night[i]*night;radiance[3]=Math.max(...this.ambientValues);}
  }
 }
 private drawFog(c:Extract<PassContext,{backend:'webgpu'}>):void {
  const fog=this.options.fog!,depth=fog.depth();if(!depth||(fog.density??0.01)===0)return;
  const samples=c.descriptor.multisample?.count??1;
  if(!depth.format.startsWith('depth')||depth.dimension!=='2d'||depth.depthOrArrayLayers!==1||depth.width!==c.width||depth.height!==c.height||!(depth.usage&GPUTextureUsage.TEXTURE_BINDING)||depth.sampleCount!==1&&depth.sampleCount!==samples)throw new RangeError('Sky fog requires matching sampleable scene depth');
  const key=c.format+':'+samples+':'+depth.sampleCount;
  this.fogUniform??=c.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  if(this.fogFormat!==key){
   const source=depth.sampleCount===1?fogShader:fogShader.replace('sceneDepth:texture_depth_2d','sceneDepth:texture_depth_multisampled_2d').replace('fogFragment(i:Vertex)','fogFragment(i:Vertex,@builtin(sample_index) sample:u32)').replace('vec2i(i.position.xy),0','vec2i(i.position.xy),i32(sample)');
   const module=c.device.createShaderModule({code:source});this.fogPipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fogFragment',targets:[{format:c.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'zero',dstFactor:'one',operation:'add'}}}]},multisample:c.descriptor.multisample});this.fogFormat=key;this.fogDepth=undefined;
  }
  if(this.fogDepth!==depth){this.fogGroup=c.device.createBindGroup({layout:this.fogPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform!}},{binding:1,resource:this.textures[4].createView()},{binding:3,resource:depth.createView({aspect:'depth-only'})},{binding:4,resource:{buffer:this.fogUniform}}]});this.fogDepth=depth;}
  const v=this.fogValues;v[0]=fog.density??0.01;v[1]=fog.start??40;v[2]=+(fog.falloff==='exp');v[3]=fog.height??0;v.set(fog.color??[0,0,0],4);v[7]=+!!fog.color;c.device.queue.writeBuffer(this.fogUniform,0,this.fogValues as Float32Array<ArrayBuffer>);
  this.fogAttachment.view=c.color;const pass=c.encoder.beginRenderPass(this.fogPass);pass.setPipeline(this.fogPipeline!);pass.setBindGroup(0,this.fogGroup!);pass.draw(3);pass.end();
 }
 private draw(c:Extract<PassContext,{backend:'webgpu'}>):void {
  this.validate();
  if(!invert(this.inverse,c.camera.matrix,0,this.scratch))throw new Error('Invalid sky camera');this.values.set(c.camera.position,16);this.values[19]=Math.max(0.001,c.camera.position[1]/1000);this.values.set(this.sun,20);this.values[24]=+(this.options.model==='bruneton');this.values[25]=this.options.exposure??0;this.values[26]=this.options.turbidity??2;this.values[36]=this.options.clouds?(this.options.clouds.coverage??0.45):0;this.values[37]=this.cloudTime;this.values[38]=this.options.clouds?.height??1500;this.values[27]=+(c.format==='rgba16float');this.night();c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
  const turbidity=this.options.turbidity??2;
  if(this.computedT!==turbidity)dispatch(c,this.pipelines[0],this.groups[0],16,4);
  if(this.options.model==='bruneton'&&this.scatteringT!==turbidity){dispatch(c,this.pipelines[1],this.groups[1],16,32);
   for(let i=0;i<3;i++){dispatch(c,this.pipelines[2],this.groups[2+i*3],16,32);dispatch(c,this.pipelines[3],this.groups[3+i*3],16,32);dispatch(c,this.pipelines[4],this.groups[4+i*3],16,32);}this.scatteringT=turbidity;
  }
  this.computedT=turbidity;
  if(this.reflectionRequested){const reflected=c.encoder.beginComputePass(this.reflectionPass);reflected.setPipeline(this.reflectionPipeline!);reflected.setBindGroup(0,this.reflectionGroup!);reflected.dispatchWorkgroups(8,4);reflected.end();}
  const format=c.format+':'+c.descriptor.multisample?.count+':'+c.descriptor.depthStencil!.format;
  if(this.format!==format){const module=c.device.createShaderModule({code});this.render=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},multisample:c.descriptor.multisample,depthStencil:{format:c.descriptor.depthStencil!.format,depthCompare:'greater-equal',depthWriteEnabled:false}});this.bind=group(c.device,this.render,[{buffer:this.uniform!},this.textures[4].createView(),this.textures[0].createView()]);this.format=format;}
  this.attachment.view=c.color;this.depthAttachment.view=c.depth;const pass=c.encoder.beginRenderPass(this.presentation);pass.setPipeline(this.render!);pass.setBindGroup(0,this.bind!);pass.draw(3);pass.end();
 }
 private night():void {
  // Uniform layout of SkyNightOptions: zenith+twinkle, horizon+haze, moon direction+cos(size), moon colour+sin(size), phase/glow/stars/time, enabled.
  const n=this.options.night,v=this.values;v[60]=+!!n;if(!n)return;const d=n.moonDirection??[0.4,0.7,0.5],length=Math.hypot(d[0],d[1],d[2]),size=n.moonSize??0.038;
  v.set(n.zenithColor??[0.015,0.025,0.065],40);v[43]=Math.max(0,n.starTwinkleIntensity??1);v.set(n.horizonColor??[0.08,0.09,0.15],44);v[47]=Math.max(0,n.hazeDensity??1);
  for(let i=0;i<3;i++)v[48+i]=d[i]/length;v[51]=Math.cos(size);v.set(n.moonColor??[0.92,0.95,1],52);v[55]=Math.sin(size);
  v[56]=Math.max(-1,Math.min(1,n.moonPhase??0.85));v[57]=Math.max(0,n.glowIntensity??1.2);v[58]=Math.max(0,n.starIntensity??0.8);v[59]=this.time;
 }
 private release():void {this.uniform?.destroy();this.ambient?.destroy();this.fogUniform?.destroy();this.fogUniform=undefined;this.fogPipeline=undefined;this.fogGroup=undefined;this.fogDepth=undefined;this.fogFormat='';this.ambient=undefined;this.ambientEntry=undefined;this.source=this.litShader='';for(const t of this.textures)t.destroy();this.uniform=undefined;this.textures=[];this.pipelines=[];this.groups=[];this.render=undefined;this.bind=undefined;this.reflectionPipeline=undefined;this.reflectionGroup=undefined;this.format='';this.computedT=this.scatteringT=NaN;}
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=undefined;}
}
