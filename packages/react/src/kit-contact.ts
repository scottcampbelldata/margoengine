import type {Engine,EnginePlugin,FrameGraph,PassContext} from '@margoengine/core/extension';
import type {Shadows} from '@margoengine/shadows';
import {live,type Registry} from './internal.js';

declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
export interface ContactGroundOptions {width?:number;height?:number;opacity?:number;color?:readonly [number,number,number]}
const shader=`
struct Frame {camera:mat4x4f,model:mat4x4f,color:vec4f,size:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
struct Vertex {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f}
@vertex fn vertex(@builtin(vertex_index) id:u32)->Vertex {
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(-1,1),vec2f(1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(1,1));
 let p=corners[id]*f.size.xy*0.5;let world=f.model*vec4f(p.x,0,p.y,1);var o:Vertex;
 o.clip=f.camera*world;o.position=world.xyz;o.normal=normalize(cross(f.model[2].xyz,f.model[0].xyz));return o;
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let direct=vec3f(1);let linear=direct*vec3f(1);let alpha=clamp((1.0-linear.x)*f.color.a,0,1);
 return vec4f(f.color.rgb*alpha,alpha);
}`;
let nextGround=0;
/** Draw a receiver against the shared shadow map without an opaque floor. */
export class ContactGround implements EnginePlugin {
  readonly name='margoengine-react:contact-shadows:'+nextGround++;
  private engine?:Engine;private buffer?:GPUBuffer;private pipeline?:GPURenderPipeline;private group?:GPUBindGroup;private key='';private bindings:GPUBindGroupEntry[]=[];private disposed=false;
  private readonly values=new Float32Array(40);
  constructor(private registry:Registry,private shadows:Shadows,private options:()=>ContactGroundOptions) {}
  setup(engine:Engine):void {if(!engine.gpu)throw new Error('ContactShadows requires WebGPU');this.engine=engine;}
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:4,execute:context=>{if(context.backend==='webgpu')this.draw(context);}});}
  private draw(context:Extract<PassContext,{backend:'webgpu'}>):void {
    const mesh=live(this.registry);if(!mesh||!mesh.visible)return;
    for(let id=mesh.id,depth=0;id>=0&&depth<64;id=this.engine!.store.parents[id],depth++)if(this.engine!.store.hidden[id])return;
    const {width=10,height=10,opacity=0.5,color=[0,0,0]}=this.options();
    if(!Number.isFinite(width)||width<=0||!Number.isFinite(height)||height<=0||!Number.isFinite(opacity)||opacity<0||opacity>1||color.length!==3||color.some(value=>!Number.isFinite(value)||value<0))throw new RangeError('Invalid contact shadows options');
    if(opacity===0)return;
    const key=context.format+':'+(context.descriptor.multisample?.count??1)+':'+context.descriptor.depthStencil?.format;
    if(!this.buffer)this.buffer=context.device.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    if(this.key!==key){
      const module=context.device.createShaderModule({code:this.shadows.shader(shader)});
      this.pipeline=context.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:context.format,blend:{color:{operation:'add',srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{operation:'add',srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list',cullMode:'none'},multisample:context.descriptor.multisample,depthStencil:{format:context.descriptor.depthStencil?.format??'depth24plus-stencil8',depthCompare:'greater-equal',depthWriteEnabled:false}});
      this.group=undefined;this.key=key;
    }
    const bindings=this.shadows.bindings();
    if(!this.group||bindings.some((entry,index)=>entry!==this.bindings[index])){
      this.group=context.device.createBindGroup({layout:this.pipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.buffer}},...bindings]});this.bindings=[...bindings];
    }
    this.values.set(context.camera.matrix);this.values.set(mesh.matrix,16);this.values.set(color,32);this.values[35]=opacity;this.values[36]=width;this.values[37]=height;
    context.device.queue.writeBuffer(this.buffer,0,this.values as Float32Array<ArrayBuffer>);
    const pass=context.encoder.beginRenderPass({colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:context.depth,depthReadOnly:true,stencilReadOnly:true}});
    pass.setPipeline(this.pipeline!);pass.setBindGroup(0,this.group!);pass.draw(6);pass.end();
  }
  private release():void {this.buffer?.destroy();this.buffer=undefined;this.pipeline=undefined;this.group=undefined;this.key='';this.bindings=[];}
  onDeviceRestored(engine:Engine):void {this.release();this.engine=engine;}
  dispose():void {if(this.disposed)return;this.disposed=true;this.release();this.engine=undefined;}
}
