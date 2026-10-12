import type {Engine,EnginePlugin,FrameGraph,PassContext,Vec3} from '@margoengine/core/extension';
import {invert} from '../../shared/math.js';
import {HDRRenderTarget} from './targets.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{TEXTURE_BINDING:number;STORAGE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
const atmosphere:AtmosphereOptions={},sun:Vec3=[0.3,0.6,-0.7],color:Vec3=[0.45,0.62,0.8],gain:Vec3=[1,1,1],lift:Vec3=[0,0,0];
const vertex=`struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;}`;
const frame=`struct Frame {inverse:mat4x4f,eye:vec4f,sun:vec4f,fog:vec4f,color:vec4f,grade:vec4f,lens:vec4f,settings:vec4f,gain:vec4f,lift:vec4f,camera:mat4x4f}
@group(0) @binding(0) var<uniform> f:Frame;
fn world(uv:vec2f,depth:f32)->vec3f{let p=f.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),depth,1);return p.xyz/p.w;}
fn sky(ray:vec3f)->vec3f{let cosine=dot(ray,normalize(f.sun.xyz));let g=f.fog.w;let rayleigh=0.0597*(1+cosine*cosine);let mie=0.0796*(1-g*g)/pow(max(0.01,1+g*g-2*g*cosine),1.5);let horizon=pow(1-clamp(ray.y,0.0,1.0),3.0);return mix(vec3f(0.04,0.16,0.38),f.color.xyz,horizon)*(1+rayleigh*4)+vec3f(1,0.8,0.5)*mie*f.sun.w;}`;
const filter=`@group(0) @binding(0) var input:texture_2d<f32>;
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(2) var<uniform> kernelParams:vec4f;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let size=textureDimensions(output);if(any(id.xy>=size)){return;}let source=vec2i(id.xy*textureDimensions(input)/size);var c=vec3f(0);var weight=0.0;
 for(var i=-2;i<=2;i++){let w=select(select(1.0,4.0,abs(i)==1),6.0,i==0);let p=clamp(source+vec2i(kernelParams.xy)*i,vec2i(0),vec2i(textureDimensions(input))-1);var sample=textureLoad(input,p,0).xyz;if(any(size!=textureDimensions(input))){let limit=vec2i(textureDimensions(input))-1;sample=(sample+textureLoad(input,min(p+vec2i(1,0),limit),0).xyz+textureLoad(input,min(p+vec2i(0,1),limit),0).xyz+textureLoad(input,min(p+vec2i(1,1),limit),0).xyz)*0.25;}c+=sample*w;weight+=w;}
 c/=weight;if(kernelParams.z>0){c*=max(0.0,max(max(c.r,c.g),c.b)-kernelParams.w)/max(0.0001,max(max(c.r,c.g),c.b));}textureStore(output,vec2i(id.xy),vec4f(c,1));}`;
const resolve=frame+`
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var bloom:texture_2d<f32>;
@group(0) @binding(4) var output:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let size=textureDimensions(output);if(any(id.xy>=size)){return;}let p=vec2i(id.xy);let uv=(vec2f(id.xy)+0.5)/vec2f(size);let d=textureLoad(depth,p,0);let w=world(uv,d);let distance=length(w-f.eye.xyz);var c=textureLoad(scene,p,0).xyz;
 let radius=min(8.0,abs(distance-f.lens.x)/max(distance,0.001)*f.lens.y);
 if(radius>0.5){var blurred=vec3f(0);var weights=0.0;for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){let q=clamp(p+vec2i(round(vec2f(f32(x),f32(y))*radius*0.5)),vec2i(0),vec2i(size)-1);let neighbor=length(world((vec2f(q)+0.5)/vec2f(size),textureLoad(depth,q,0))-f.eye.xyz);let weight=exp(-f32(x*x+y*y)*0.25)*select(0.0,1.0,neighbor>=distance-radius);blurred+=textureLoad(scene,q,0).xyz*weight;weights+=weight;}}c=blurred/max(weights,0.001);}
 let density=f.fog.x*exp(clamp(-f.eye.y*f.fog.y,-20.0,20.0));let dy=(w.y-f.eye.y)*f.fog.y;let integral=select((1-exp(clamp(-dy,-20.0,20.0)))/select(dy,1.0,abs(dy)<0.001),1.0,abs(dy)<0.001);let visibility=exp(-max(0.0,density*distance*integral));c=mix(f.color.xyz,c,visibility);
 let sunWorld=f.eye.xyz+normalize(f.sun.xyz)*f.settings.y;let ray=normalize(sunWorld-f.eye.xyz);let farRay=normalize(w-f.eye.xyz);let alignment=pow(max(dot(ray,farRay),0.0),16.0);var shafts=0.0;
 let sunClip=f.camera*vec4f(sunWorld,1);if(sunClip.w>0&&f.fog.z>0){let sunUV=sunClip.xy/sunClip.w*vec2f(0.5,-0.5)+0.5;for(var i=1;i<=16;i++){let q=clamp(vec2i(mix(uv,sunUV,f32(i)*0.05)*vec2f(size)),vec2i(0),vec2i(size)-1);shafts+=select(0.0,1.0,textureLoad(depth,q,0)<0.000001)*pow(0.95,f32(i))/16.0;}}c+=vec3f(1,0.8,0.5)*shafts*alignment*f.fog.z;
 c+=textureLoad(bloom,vec2i(id.xy*textureDimensions(bloom)/size),0).xyz*f.grade.w;c=max(vec3f(0),c*exp2(f.grade.x)*f.gain.xyz+f.lift.xyz);let luminance=dot(c,vec3f(0.2126,0.7152,0.0722));c=mix(vec3f(luminance),c,f.grade.z);c=max(vec3f(0),(c-0.18)*f.grade.y+0.18);
 c=clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),vec3f(0),vec3f(1));c=select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));let noise=fract(sin(dot(vec2f(id.xy)+f.lens.w,vec2f(12.9898,78.233)))*43758.5453)-0.5;textureStore(output,p,vec4f(clamp(c+noise*f.lens.z,vec3f(0),vec3f(1)),1));}`;
const present=vertex+`@group(0) @binding(0) var image:texture_2d<f32>;@fragment fn fragment(i:Out)->@location(0) vec4f{return textureLoad(image,clamp(vec2i(i.uv*vec2f(textureDimensions(image))),vec2i(0),vec2i(textureDimensions(image))-1),0);}`;
export interface AtmosphereOptions {density?:number;heightFalloff?:number;color?:Vec3;sun?:Vec3;scattering?:number;anisotropy?:number;godRays?:number;sky?:boolean}
export interface PostOptions {bloom?:number;threshold?:number;exposure?:number;contrast?:number;saturation?:number;gain?:Vec3;lift?:Vec3;focus?:number;aperture?:number;grain?:number;atmosphere?:AtmosphereOptions}
export class PostProcessing implements EnginePlugin {
  readonly name='post-processing';target?:HDRRenderTarget;private device?:GPUDevice;private uniform?:GPUBuffer;private filters:GPUBuffer[]=[];private textures:GPUTexture[]=[];private levels:Array<[GPUTexture,GPUTexture]>=[];private output?:GPUTexture;
  private blur?:GPUComputePipeline;private resolve?:GPUComputePipeline;private sky?:GPURenderPipeline;private present?:GPURenderPipeline;private original?:GPUTextureView;private readonly values=new Float32Array(68);private time=0;
  private readonly inverse=this.values.subarray(0,16);private readonly threshold=new Float32Array([0,0,1,1]);
  private readonly inverseWorkspace=new Float64Array(52);
  private colorView?:GPUTextureView;private depthView?:GPUTextureView;private filterGroups:GPUBindGroup[]=[];private resolveGroups:GPUBindGroup[]=[];private skyGroup?:GPUBindGroup;private presentGroup?:GPUBindGroup;private skyPass?:GPURenderPassDescriptor;private presentPass?:GPURenderPassDescriptor;
  constructor(readonly options:PostOptions={}){this.validate();}
  private validate():void {const o=this.options,a=o.atmosphere??{};for(const [key,value] of Object.entries(o))if(typeof value==='number'&&!Number.isFinite(Math.fround(value)))throw new RangeError(`Invalid post ${key}`);
    const ranges=[[o.bloom??0,0,4],[o.threshold??1,0,100],[o.exposure??0,-10,10],[o.contrast??1,0,4],[o.saturation??1,0,4],[o.focus??5,0.01,10000],[o.aperture??0,0,64],[o.grain??0,0,1],[a.density??0,0,10],[a.heightFalloff??0,0,10],[a.scattering??1,0,10],[a.anisotropy??0.76,-0.95,0.95],[a.godRays??0,0,4]];
    if(ranges.some(([v,min,max])=>!Number.isFinite(Math.fround(v))||v<min||v>max))throw new RangeError('Invalid post or atmosphere options');
    if(a.sky!==undefined&&typeof a.sky!=='boolean')throw new TypeError('Sky must be boolean');
    for(const [v,min,max] of [[o.gain??[1,1,1],0,16],[o.lift??[0,0,0],-4,4],[a.color??[0.45,0.62,0.8],0,1]] as const)if(v.some(n=>n<min||n>max))throw new RangeError('Post color vector exceeds limits');
    for(const v of [o.gain??[1,1,1],o.lift??[0,0,0],a.color??[0.45,0.62,0.8],a.sun??[0.3,0.6,-0.7]])if(v.length!==3||!v.every(n=>Number.isFinite(Math.fround(n))))throw new RangeError('Invalid post vector');if(!Math.hypot(...(a.sun??[0.3,0.6,-0.7])))throw new RangeError('Sun direction must be nonzero');
  }
  setup(engine:Engine):void {if(!engine.gpu)throw new Error('PostProcessing requires WebGPU');this.device=engine.gpu;this.uniform=this.device.createBuffer({size:272,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.blur=this.device.createComputePipeline({layout:'auto',compute:{module:this.device.createShaderModule({code:filter}),entryPoint:'main'}});this.resolve=this.device.createComputePipeline({layout:'auto',compute:{module:this.device.createShaderModule({code:resolve}),entryPoint:'main'}});
    for(const data of [[0,0,1,this.options.threshold??1],[1,0,0,0],[0,1,0,0]]){const b=this.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.device.queue.writeBuffer(b,0,new Float32Array(data));this.filters.push(b);}
  }
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'post:capture',order:-50,execute:context=>{if(context.backend!=='webgpu')return;this.validate();this.resize(context);this.original=context.color;this.target!.scene.begin(context);context.shader=context.shader.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);');this.update(context);}});
    graph.add({name:'atmosphere:sky',order:2,execute:context=>{if(context.backend==='webgpu'&&(this.options.atmosphere?.sky??false))this.drawSky(context);}});
    graph.add({name:'post:resolve',order:30,execute:context=>{if(context.backend==='webgpu')this.process(context);}});
  }
  private resize(c:Context):void {if(this.target?.width===c.width&&this.target.height===c.height)return;this.target?.dispose();for(const t of this.textures)t.destroy();this.textures=[];this.levels=[];this.target=new HDRRenderTarget(c.device,c.width,c.height,c.descriptor.multisample?.count??4);
    const create=(w:number,h:number,format:GPUTextureFormat)=>{const t=c.device.createTexture({size:[w,h],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});this.textures.push(t);return t;};let w=c.width,h=c.height;
    for(let i=0;i<4;i++){w=Math.max(1,Math.floor(w/2));h=Math.max(1,Math.floor(h/2));this.levels.push([create(w,h,'rgba16float'),create(w,h,'rgba16float')]);}this.output=create(c.width,c.height,'rgba8unorm');
    this.colorView=this.target.color.createView();this.depthView=this.target.depth.createView();const depthOnly=this.target.depth.createView({aspect:'depth-only'}),output=this.output.createView(),group=(pipeline:GPUComputePipeline|GPURenderPipeline,entries:GPUBindGroupEntry[])=>c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
    this.filterGroups=[];let input=this.colorView;for(let i=0;i<this.levels.length;i++){const [a,b]=this.levels[i],av=a.createView(),bv=b.createView();this.filterGroups.push(group(this.blur!,[{binding:0,resource:input},{binding:1,resource:av},{binding:2,resource:{buffer:this.filters[i===0?0:1]}}]),group(this.blur!,[{binding:0,resource:av},{binding:1,resource:bv},{binding:2,resource:{buffer:this.filters[2]}}]));input=bv;}
    this.resolveGroups=[this.colorView,input].map(view=>group(this.resolve!,[{binding:0,resource:{buffer:this.uniform!}},{binding:1,resource:this.colorView!},{binding:2,resource:depthOnly},{binding:3,resource:view},{binding:4,resource:output}]));
    if(!this.present){const module=c.device.createShaderModule({code:present});this.present=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},multisample:c.descriptor.multisample});}this.presentGroup=group(this.present,[{binding:0,resource:output}]);
  }
  private update(c:Context):void {const o=this.options,a=o.atmosphere??atmosphere,v=this.values;if(!invert(this.inverse,c.camera.matrix,0,this.inverseWorkspace))throw new Error('Invalid post camera');this.time+=c.delta;
    v.set(c.camera.position,16);v.set(a.sun??sun,20);v[23]=a.scattering??1;v[24]=a.density??0;v[25]=a.heightFalloff??0;v[26]=a.godRays??0;v[27]=a.anisotropy??0.76;v.set(a.color??color,28);v[32]=o.exposure??0;v[33]=o.contrast??1;v[34]=o.saturation??1;v[35]=o.bloom??0;v[36]=o.focus??5;v[37]=o.aperture??0;v[38]=o.grain??0;v[39]=this.time;v[40]=c.camera.near;v[41]=c.camera.far;v[42]=o.threshold??1;v[43]=+(a.sky??false);v.set(o.gain??gain,44);v.set(o.lift??lift,48);v.set(c.camera.matrix,52);
    c.device.queue.writeBuffer(this.uniform!,0,v as Float32Array<ArrayBuffer>);this.threshold[3]=o.threshold??1;c.device.queue.writeBuffer(this.filters[0],0,this.threshold as Float32Array<ArrayBuffer>);}
  private drawSky(c:Context):void {if(!this.sky){const module=c.device.createShaderModule({code:frame+vertex+`@fragment fn fragment(i:Out)->@location(0) vec4f{return vec4f(sky(normalize(world(i.uv,0)-f.eye.xyz)),1);}`});this.sky=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:'rgba16float'}]},depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:false,depthCompare:'greater-equal'},multisample:c.descriptor.multisample});}
    this.skyGroup??=c.device.createBindGroup({layout:this.sky.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform!}}]});const descriptor=this.skyPass??={colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthReadOnly:true,stencilReadOnly:true}};(descriptor.colorAttachments as GPURenderPassColorAttachment[])[0].view=c.color;descriptor.depthStencilAttachment!.view=c.depth;const pass=c.encoder.beginRenderPass(descriptor);pass.setPipeline(this.sky);pass.setBindGroup(0,this.skyGroup);pass.draw(3);pass.end();
  }
  private dispatch(c:Context,pipeline:GPUComputePipeline,group:GPUBindGroup,width:number,height:number):void {const pass=c.encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();}
  private process(c:Context):void {this.target!.scene.resolve(c.encoder,true);const bloom=(this.options.bloom??0)>0;
    if(bloom)for(let i=0;i<this.levels.length;i++){const [a,b]=this.levels[i];this.dispatch(c,this.blur!,this.filterGroups[i*2],a.width,a.height);this.dispatch(c,this.blur!,this.filterGroups[i*2+1],b.width,b.height);}
    this.dispatch(c,this.resolve!,this.resolveGroups[+bloom],c.width,c.height);
    const descriptor=this.presentPass??={colorAttachments:[{view:this.original!,loadOp:'clear',clearValue:{r:0,g:0,b:0,a:1},storeOp:'store'}]};(descriptor.colorAttachments as GPURenderPassColorAttachment[])[0].view=this.original!;
    const pass=c.encoder.beginRenderPass(descriptor);pass.setPipeline(this.present!);pass.setBindGroup(0,this.presentGroup!);pass.draw(3);pass.end();this.target!.scene.restore(c);
  }
  onDeviceRestored(engine:Engine):void {const time=this.time;this.dispose();this.setup(engine);this.time=time;}
  dispose():void {this.target?.dispose();this.target=undefined;for(const t of this.textures)t.destroy();for(const b of this.filters)b.destroy();this.uniform?.destroy();this.filters=[];this.textures=[];this.levels=[];this.uniform=undefined;this.device=undefined;this.blur=undefined;this.resolve=undefined;this.sky=undefined;this.present=undefined;this.original=undefined;this.colorView=this.depthView=undefined;this.filterGroups=[];this.resolveGroups=[];this.skyGroup=this.presentGroup=undefined;this.skyPass=this.presentPass=undefined;}
}



