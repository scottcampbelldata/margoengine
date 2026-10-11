import {PbrMaterial,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type DrawOptions} from '@scottcampbelldata/vexel-core/extension';
import {invert} from '../../shared/math.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
type GPUContext=Extract<PassContext,{backend:'webgpu'}>;
const declaration=(binding:number)=>`struct Section {planes:array<vec4f,6>,settings:vec4f,color:vec4f,camera:mat4x4f,inverse:mat4x4f}\n@group(0) @binding(${binding}) var<uniform> section:Section;\n`;
const capShader=declaration(0)+`
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i];return o;}
struct Pixel {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn fragment(i:Out)->Pixel {
 let near=section.inverse*vec4f(i.uv,0,1);let far=section.inverse*vec4f(i.uv,1,1);let origin=near.xyz/near.w;let ray=far.xyz/far.w-origin;
 let plane=section.planes[u32(section.settings.y)];let denom=dot(plane.xyz,ray);if(abs(denom)<0.000001){discard;}
 let t=-(dot(plane.xyz,origin)+plane.w)/denom;if(t<0||t>1){discard;}let world=origin+ray*t;
 for(var p=0u;p<u32(section.settings.x);p++){if(p!=u32(section.settings.y)&&dot(section.planes[p].xyz,world)+section.planes[p].w < -0.00001){discard;}}
 let tangent=normalize(cross(plane.xyz,select(vec3f(0,0,1),vec3f(0,1,0),abs(plane.z)>0.8)));let hatch=select(1.0,0.55,fract(dot(world,tangent)*section.settings.w)<0.2&&section.settings.w>0);
 let linear=section.color.xyz*hatch;let mapped=linear/(1+linear);var o:Pixel;o.color=vec4f(select(pow(mapped,vec3f(1.0/2.2)),linear,section.settings.z>0),1);let clip=section.camera*vec4f(world,1);o.depth=clip.z/clip.w;return o;
}`;
export interface SectionOptions {planes:readonly (readonly number[])[];cap?:boolean;color?:string|readonly number[];hatch?:number}
export function boxSection(min:readonly [number,number,number],max:readonly [number,number,number]):number[][] {if(![...min,...max].every(Number.isFinite)||min.some((v,i)=>v>=max[i]))throw new RangeError('Invalid section box');return [[1,0,0,-min[0]],[-1,0,0,max[0]],[0,1,0,-min[1]],[0,-1,0,max[1]],[0,0,1,-min[2]],[0,0,-1,max[2]]];}
export class SectionPlanes implements EnginePlugin {
  readonly name='section-planes';private engine?:Engine;private buffers:GPUBuffer[]=[];private rows:Float32Array[]=[];private bindings:GPUBindGroupEntry[][]=[];
  private readonly pipelines=new Map<string,{back:GPURenderPipeline;front:GPURenderPipeline;cap:GPURenderPipeline;groups:GPUBindGroup[]}>();
  private readonly color:Float32Array;private readonly cap:boolean;private readonly hatch:number;private base='';
  private readonly inverse=new Float32Array(16);
  private readonly inverseWorkspace=new Float64Array(52);
  private pass?:GPURenderPassDescriptor;
  private readonly backDraw:DrawOptions={clear:false,stencilClear:0};private readonly frontDraw:DrawOptions={clear:false};
  constructor(readonly options:SectionOptions){this.cap=options.cap??true;this.hatch=options.hatch??8;this.color=new PbrMaterial({color:options.color??'#f2a65e'}).data.slice(0,4);this.validate();}
  private validate():void {if(!this.options.planes.length||this.options.planes.length>6||this.buffers.length&&this.options.planes.length!==this.buffers.length-1||!Number.isFinite(this.hatch)||this.hatch<0)throw new RangeError('Invalid section options or changed plane count');for(const p of this.options.planes)if(p.length!==4||!p.every(v=>typeof v==='number'&&Number.isFinite(Math.fround(v)))||!Math.hypot(p[0],p[1],p[2]))throw new TypeError('Invalid section plane');}
  setup(engine:Engine):void {if(!engine.gpu)throw new Error('SectionPlanes requires WebGPU');if(this.cap&&!engine.gpu.features.has('depth32float-stencil8'))throw new Error('Solid caps require depth32float-stencil8');this.engine=engine;for(let i=0;i<=this.options.planes.length;i++){const buffer=engine.gpu.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.buffers.push(buffer);this.rows.push(new Float32Array(64));this.bindings.push([{binding:1,resource:{buffer}}]);}}
  registerPasses(graph:FrameGraph):void {
    const clip=(context:PassContext)=>{if(context.backend!=='webgpu')return;this.validate();this.base=context.shader.split('@fragment')[0];const binding=context.bindings.length+1;
      context.shader=declaration(binding)+context.shader.replace('let facing=',`for(var p=0u;p<u32(section.settings.x);p++){if(dot(section.planes[p].xyz,i.position)+section.planes[p].w<0){discard;}}\nlet facing=`);
      context.bindings.push({binding,resource:this.bindings[0][0].resource});this.upload(context);
    };graph.add({name:'sections:clip',order:-30,execute:clip,prepare:clip});
    if(this.cap)graph.add({name:'sections:cap',order:5,execute:context=>{if(context.backend==='webgpu')this.drawCaps(context);}});
  }
  private upload(context:GPUContext):void {const inverse=this.inverse;if(!invert(inverse,context.camera.matrix,0,this.inverseWorkspace))throw new Error('Invalid cap camera');
    for(let i=0;i<this.rows.length;i++){const row=this.rows[i];for(let p=0;p<this.options.planes.length;p++){const plane=this.options.planes[p],length=Math.hypot(plane[0],plane[1],plane[2]);for(let c=0;c<4;c++)row[p*4+c]=plane[c]/length;}
      row[24]=this.options.planes.length;row[25]=Math.max(0,i-1);row[26]=context.format==='rgba16float'?1:0;row[27]=this.hatch;row.set(this.color,28);row.set(context.camera.matrix,32);row.set(inverse,48);context.device.queue.writeBuffer(this.buffers[i],0,row as Float32Array<ArrayBuffer>);}
  }
  private drawCaps(context:GPUContext):void {
    const key=context.format+this.base;let pipelines=this.pipelines.get(key);
    if(!pipelines){const pipeline=(back:boolean)=>{const module=context.device.createShaderModule({code:declaration(1)+this.base+`@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {let p=section.planes[u32(section.settings.y)];if(dot(p.xyz,i.position)+p.w<0||((front==(i.material.w>0))==${back})){discard;}return vec4f(0);}`});
      // Face selection in WGSL also handles instances with negative scales.
      return context.device.createRenderPipeline({...context.descriptor,vertex:{...context.descriptor.vertex,module},fragment:{module,entryPoint:'fragment',targets:[{format:context.format,writeMask:0}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float-stencil8',depthWriteEnabled:false,depthCompare:'always',stencilFront:{compare:'always',passOp:back?'increment-wrap':'decrement-wrap'},stencilBack:{compare:'always',passOp:back?'increment-wrap':'decrement-wrap'}}});};
      const cap=context.device.createShaderModule({code:capShader});pipelines={back:pipeline(true),front:pipeline(false),cap:context.device.createRenderPipeline({layout:'auto',vertex:{module:cap,entryPoint:'vertex'},fragment:{module:cap,entryPoint:'fragment',targets:[{format:context.format}]},primitive:{topology:'triangle-list'},depthStencil:{format:'depth32float-stencil8',depthWriteEnabled:true,depthCompare:'greater-equal',stencilFront:{compare:'not-equal'},stencilBack:{compare:'not-equal'},stencilWriteMask:0}}),groups:[]};pipelines.groups=this.buffers.map(buffer=>context.device.createBindGroup({layout:pipelines!.cap.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}}]}));this.pipelines.set(key,pipelines);
    }
    for(let i=1;i<this.buffers.length;i++){
      this.backDraw.pipeline=pipelines.back;this.backDraw.bindings=this.bindings[i];this.frontDraw.pipeline=pipelines.front;this.frontDraw.bindings=this.bindings[i];context.draw(this.backDraw);context.draw(this.frontDraw);
      const descriptor=this.pass??={colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:context.depth,depthLoadOp:'load',depthStoreOp:'store',stencilLoadOp:'load',stencilStoreOp:'store'}};
      (descriptor.colorAttachments as GPURenderPassColorAttachment[])[0].view=context.color;descriptor.depthStencilAttachment!.view=context.depth;
      const pass=context.encoder.beginRenderPass(descriptor);
      pass.setPipeline(pipelines.cap);pass.setStencilReference(0);pass.setBindGroup(0,pipelines.groups[i]);pass.draw(3);pass.end();
    }
  }
  onDeviceRestored(engine:Engine):void {this.dispose();this.setup(engine);}
  dispose():void {for(const buffer of this.buffers)buffer.destroy();this.buffers=[];this.rows=[];this.bindings=[];this.pipelines.clear();this.engine=undefined;this.pass=undefined;this.backDraw.pipeline=this.frontDraw.pipeline=undefined;this.backDraw.bindings=this.frontDraw.bindings=undefined;}
}
