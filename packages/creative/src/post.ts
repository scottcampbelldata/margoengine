import type {Engine,EnginePlugin,FrameGraph,PassContext,Vec3} from '@margoengine/core/extension';
import {invertMatrixStable} from '@margoengine/math/mat4';
import {HDRRenderTarget} from './targets.js';
import type {StackHost,StackStage} from '../../shared/stack.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{TEXTURE_BINDING:number;STORAGE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
const atmosphere:AtmosphereOptions={},sun:Vec3=[0.3,0.6,-0.7],color:Vec3=[0.45,0.62,0.8],gain:Vec3=[1,1,1],lift:Vec3=[0,0,0];
const finite=(value:number)=>Number.isFinite(Math.fround(value));
const range=(value:number,min:number,max:number)=>finite(value)&&value>=min&&value<=max;
function vectorRange(value:Vec3,min:number,max:number):boolean {for(let i=0;i<value.length;i++)if(i in value&&(value[i]<min||value[i]>max))return false;return true;}
const vectorFinite=(value:Vec3)=>value.length===3&&value.every(finite);
const vertex=`struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;}`;
const frame=`struct Frame {inverse:mat4x4f,eye:vec4f,sun:vec4f,fog:vec4f,color:vec4f,grade:vec4f,lens:vec4f,settings:vec4f,gain:vec4f,lift:vec4f,camera:mat4x4f}
@group(0) @binding(0) var<uniform> f:Frame;
fn world(uv:vec2f,depth:f32)->vec3f{let p=f.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),depth,1);return p.xyz/p.w;}`;
const resolve=frame+`
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(4) var output:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let size=textureDimensions(output);if(any(id.xy>=size)){return;}let p=vec2i(id.xy);let uv=(vec2f(id.xy)+0.5)/vec2f(size);let d=textureLoad(depth,p,0);let w=world(uv,d);let distance=length(w-f.eye.xyz);var c=textureLoad(scene,p,0).xyz;
 let radius=min(8.0,abs(distance-f.lens.x)/max(distance,0.001)*f.lens.y);
 if(radius>0.5){var blurred=vec3f(0);var weights=0.0;for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){let q=clamp(p+vec2i(round(vec2f(f32(x),f32(y))*radius*0.5)),vec2i(0),vec2i(size)-1);let neighbor=length(world((vec2f(q)+0.5)/vec2f(size),textureLoad(depth,q,0))-f.eye.xyz);let weight=exp(-f32(x*x+y*y)*0.25)*select(0.0,1.0,neighbor>=distance-radius);blurred+=textureLoad(scene,q,0).xyz*weight;weights+=weight;}}c=blurred/max(weights,0.001);}
 let density=f.fog.x*exp(clamp(-f.eye.y*f.fog.y,-20.0,20.0));let dy=(w.y-f.eye.y)*f.fog.y;let integral=select((1-exp(clamp(-dy,-20.0,20.0)))/select(dy,1.0,abs(dy)<0.001),1.0,abs(dy)<0.001);let visibility=exp(-max(0.0,density*distance*integral));c=mix(f.color.xyz,c,visibility);
 let sunWorld=f.eye.xyz+normalize(f.sun.xyz)*f.settings.y;let ray=normalize(sunWorld-f.eye.xyz);let farRay=normalize(w-f.eye.xyz);let alignment=pow(max(dot(ray,farRay),0.0),16.0);var shafts=0.0;
 let sunClip=f.camera*vec4f(sunWorld,1);if(sunClip.w>0&&f.fog.z>0){let sunUV=sunClip.xy/sunClip.w*vec2f(0.5,-0.5)+0.5;for(var i=1;i<=16;i++){let q=clamp(vec2i(mix(uv,sunUV,f32(i)*0.05)*vec2f(size)),vec2i(0),vec2i(size)-1);shafts+=select(0.0,1.0,textureLoad(depth,q,0)<0.000001)*pow(0.95,f32(i))/16.0;}}c+=vec3f(1,0.8,0.5)*shafts*alignment*f.fog.z;
 c=max(vec3f(0),c*exp2(f.grade.x)*f.gain.xyz+f.lift.xyz);let luminance=dot(c,vec3f(0.2126,0.7152,0.0722));c=mix(vec3f(luminance),c,f.grade.z);c=max(vec3f(0),(c-0.18)*f.grade.y+0.18);
 c=clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),vec3f(0),vec3f(1));c=select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));let noise=fract(sin(dot(vec2f(id.xy)+f.lens.w,vec2f(12.9898,78.233)))*43758.5453)-0.5;textureStore(output,p,vec4f(clamp(c+noise*f.lens.z,vec3f(0),vec3f(1)),1));}`;
const present=vertex+`@group(0) @binding(0) var image:texture_2d<f32>;@fragment fn fragment(i:Out)->@location(0) vec4f{return textureLoad(image,clamp(vec2i(i.uv*vec2f(textureDimensions(image))),vec2i(0),vec2i(textureDimensions(image))-1),0);}`;
/** Height fog and god rays. For a sky backdrop use `Sky` from `@margoengine/sky`. */
export interface AtmosphereOptions {density?:number;heightFalloff?:number;color?:Vec3;sun?:Vec3;godRays?:number}
/** For bloom, put `Bloom` from `@margoengine/post/bloom` before this effect in a `PostStack`. */
export interface PostOptions {exposure?:number;contrast?:number;saturation?:number;gain?:Vec3;lift?:Vec3;focus?:number;aperture?:number;grain?:number;atmosphere?:AtmosphereOptions}
export class PostProcessing implements EnginePlugin {
  readonly name='post-processing';target?:HDRRenderTarget;private device?:GPUDevice;private uniform?:GPUBuffer;private output?:GPUTexture;
  private resolve?:GPUComputePipeline;private present?:GPURenderPipeline;private original?:GPUTextureView;private readonly values=new Float32Array(68);private time=0;private ready=false;private presentKey='';
  private readonly inverse=this.values.subarray(0,16);
  private readonly inverseWorkspace=new Float64Array(52);private shaderSource?:string;private linearShader='';
  private colorView?:GPUTextureView;private depthView?:GPUTextureView;private resolveGroup?:GPUBindGroup;private presentGroup?:GPUBindGroup;private presentPass?:GPURenderPassDescriptor;
  private host?:StackHost;private sceneDepth?:GPUTexture;
  constructor(readonly options:PostOptions={}){this.validate();}
  /** In a PostStack, grades (fog, focus blur, ACES, grain) the stack's HDR result as its display effect. */
  private joinStack(host:StackHost):StackStage {
    if(this.device||this.host)throw new Error('PostProcessing is already attached');
    this.host=host;return {kind:'display',render:(c,input,output)=>{
      const depth=host.depthTexture!;if(this.colorView!==input||this.sceneDepth!==depth){this.colorView=input;this.sceneDepth=depth;this.bind(c,input,depth.createView({aspect:'depth-only'}));}
      this.preparePresent(c,output.format,output.multisample);this.apply(c,output.view);
    }};
  }
  private validate():void {const o=this.options,a=o.atmosphere??atmosphere;
    if('bloom' in o||'threshold' in o)throw new TypeError('PostProcessing has no bloom: put Bloom from @margoengine/post/bloom before it in a PostStack');
    if('sky' in a||'scattering' in a||'anisotropy' in a)throw new TypeError('PostProcessing draws no sky: attach Sky from @margoengine/sky');for(const key in o)if(Object.hasOwn(o,key)){const value=o[key as keyof PostOptions];if(typeof value==='number'&&!finite(value))throw new RangeError(`Invalid post ${key}`);}
    if(!range(o.exposure??0,-10,10)||!range(o.contrast??1,0,4)||!range(o.saturation??1,0,4)||!range(o.focus??5,0.01,10000)||!range(o.aperture??0,0,64)||!range(o.grain??0,0,1)||!range(a.density??0,0,10)||!range(a.heightFalloff??0,0,10)||!range(a.godRays??0,0,4))throw new RangeError('Invalid post or atmosphere options');
    const g=o.gain??gain,l=o.lift??lift,c=a.color??color,s=a.sun??sun;
    if(!vectorRange(g,0,16)||!vectorRange(l,-4,4)||!vectorRange(c,0,1))throw new RangeError('Post color vector exceeds limits');
    if(!vectorFinite(g)||!vectorFinite(l)||!vectorFinite(c)||!vectorFinite(s))throw new RangeError('Invalid post vector');if(!Math.hypot(...s))throw new RangeError('Sun direction must be nonzero');
  }
  setup(engine:Engine):void {if(!engine.gpu)throw new Error('PostProcessing requires WebGPU');this.device=engine.gpu;this.uniform=this.device.createBuffer({size:272,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.resolve=this.device.createComputePipeline({layout:'auto',compute:{module:this.device.createShaderModule({code:resolve}),entryPoint:'main'}});
  }
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'post:capture',order:-50,execute:context=>{if(context.backend!=='webgpu')return;this.validate();this.resize(context);
      if(this.host){this.update(context);return;}
      this.preparePresent(context,context.format,context.descriptor.multisample);this.update(context);this.original=context.color;this.target!.scene.begin(context);
      // The patch depends only on the source text, so it is redone only when another plugin changes the shader.
      if(this.shaderSource!==context.shader){this.shaderSource=context.shader;this.linearShader=context.shader.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);');}context.shader=this.linearShader;}});
    graph.add({name:'post:resolve',order:30,execute:context=>{if(context.backend==='webgpu'&&!this.host)this.process(context);}});
  }
  private resize(c:Context):void {const samples=c.descriptor.multisample?.count??4,depth=c.descriptor.depthStencil!.format;if(this.ready&&(this.host?this.output!.width===c.width&&this.output!.height===c.height:this.target?.width===c.width&&this.target.height===c.height&&this.target.samples===samples&&this.target.depthFormat===depth))return;this.ready=false;this.target?.dispose();this.output?.destroy();if(!this.host)this.target=new HDRRenderTarget(c.device,c.width,c.height,samples,depth);this.presentGroup=undefined;
    this.output=c.device.createTexture({size:[c.width,c.height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
    // Stacked, the scene views are bound on the first render that sees them.
    if(this.host)this.colorView=undefined;else{this.colorView=this.target!.color.createView();this.depthView=this.target!.depth.createView();this.bind(c,this.colorView,this.target!.depth.createView({aspect:'depth-only'}));}
    this.ready=true;
  }
  private bind(c:Context,color:GPUTextureView,depthOnly:GPUTextureView):void {const output=this.output!.createView(),group=(pipeline:GPUComputePipeline|GPURenderPipeline,entries:GPUBindGroupEntry[])=>c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
    this.resolveGroup=group(this.resolve!,[{binding:0,resource:{buffer:this.uniform!}},{binding:1,resource:color},{binding:2,resource:depthOnly},{binding:4,resource:output}]);
  }
  private preparePresent(c:Context,format:GPUTextureFormat,multisample:GPUMultisampleState|undefined):void {const key=format+':'+(multisample?.count??1);if(!this.present||this.presentKey!==key){const module=c.device.createShaderModule({code:present});this.present=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format}]},multisample});this.presentKey=key;this.presentGroup=undefined;}this.presentGroup??=c.device.createBindGroup({layout:this.present.getBindGroupLayout(0),entries:[{binding:0,resource:this.output!.createView()}]});
  }
  private update(c:Context):void {const o=this.options,a=o.atmosphere??atmosphere,v=this.values;if(!invertMatrixStable(c.camera.matrix,this.inverse,this.inverseWorkspace))throw new Error('Invalid post camera');this.time+=c.delta;
    v.set(c.camera.position,16);v.set(a.sun??sun,20);v[24]=a.density??0;v[25]=a.heightFalloff??0;v[26]=a.godRays??0;v.set(a.color??color,28);v[32]=o.exposure??0;v[33]=o.contrast??1;v[34]=o.saturation??1;v[36]=o.focus??5;v[37]=o.aperture??0;v[38]=o.grain??0;v[39]=this.time;v[40]=c.camera.near;v[41]=c.camera.far;v.set(o.gain??gain,44);v.set(o.lift??lift,48);v.set(c.camera.matrix,52);
    c.device.queue.writeBuffer(this.uniform!,0,v as Float32Array<ArrayBuffer>);}
  private dispatch(c:Context,pipeline:GPUComputePipeline,group:GPUBindGroup,width:number,height:number):void {const pass=c.encoder.beginComputePass();try{pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));}finally{pass.end();}}
  private failed(c:Context,error:unknown):never {try{this.target!.scene.restore(c);}catch{}throw error;}
  private process(c:Context):void {try{this.target!.scene.resolve(c.encoder,true);this.apply(c,this.original!);this.target!.scene.restore(c);}catch(error){this.failed(c,error);}}
  private apply(c:Context,view:GPUTextureView):void {
    this.dispatch(c,this.resolve!,this.resolveGroup!,c.width,c.height);
    const descriptor=this.presentPass??={colorAttachments:[{view,loadOp:'clear',clearValue:{r:0,g:0,b:0,a:1},storeOp:'store'}]};(descriptor.colorAttachments as GPURenderPassColorAttachment[])[0].view=view;
    const pass=c.encoder.beginRenderPass(descriptor);try{pass.setPipeline(this.present!);pass.setBindGroup(0,this.presentGroup!);pass.draw(3);}finally{pass.end();}
  }
  onDeviceRestored(engine:Engine):void {const time=this.time;this.dispose();this.setup(engine);this.time=time;}
  dispose():void {this.sceneDepth=undefined;this.target?.dispose();this.target=undefined;this.output?.destroy();this.uniform?.destroy();this.output=this.uniform=undefined;this.device=undefined;this.ready=false;this.presentKey='';this.resolve=undefined;this.present=undefined;this.original=undefined;this.colorView=this.depthView=undefined;this.resolveGroup=this.presentGroup=undefined;this.presentPass=undefined;}
}



