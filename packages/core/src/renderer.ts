import type { Camera } from './camera.js';
import type { Geometry } from './geometry.js';
import { wgsl } from './shaders.js';
import type { FrameGraph, PassContext, DrawOptions } from './plugin.js';
import {sceneSamples} from './quality.js';
// TypeScript's DOM library omits WebGPU flag namespaces and the canvas overload.
declare const GPUBufferUsage:{COPY_DST:number;COPY_SRC:number;MAP_READ:number;INDEX:number;VERTEX:number;UNIFORM:number;INDIRECT:number;STORAGE:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;COPY_SRC:number};
declare const GPUMapMode:{READ:number};

const defaultDraw:DrawOptions={};

/** `start`/`end`: float range of `instances` changed since the WebGPU renderer last uploaded it (absent: upload all).
 * `mask`: nonzero when a drawn instance needs back faces (double-sided material or mirrored transform); 0 lets core's
 * own pass draw the batch with its back-culled pipeline (absent counts as 0).
 * `redirect`: set by a GPU-culling package for the frame (core never sets it): every core draw of the batch reads instances
 * from `instances` and its drawIndexedIndirect arguments from `args` (offset 0) instead of core's instance buffer and
 * `count`; core still uploads the batch into its own buffer, which stays the source the package reads. */
export interface Batch { geometry: Geometry; instances: Float32Array; count: number; start?: number; end?: number; mask?: number; redirect?: {instances: GPUBuffer; args: GPUBuffer} }
export interface Lighting { direction: Float32Array; radiance: Float32Array }
export interface GeometryBuffers {readonly vertex:GPUBuffer;readonly index:GPUBuffer;readonly instance:GPUBuffer}
export interface Renderer {
  readonly backend: 'webgpu'|'webgl2';
  readonly gpu?:GPUDevice;
  onLost?:(error:Error)=>void;
  add(geometry: Geometry, capacity: number): void;
  remove(geometry: Geometry): void;
  geometryBuffers?(geometry:Geometry):GeometryBuffers;
  render(camera: Camera, lighting: Lighting, batches: Iterable<Batch>,graph:FrameGraph,delta:number): void;
  dispose(unconfigure?:boolean): void;
}

export class GPURenderer implements Renderer {
  onLost?:(error:Error)=>void;
  get gpu():GPUDevice{return this.device;}
  readonly backend = 'webgpu';
  private readonly frame = new Float32Array(28);
  private targets:GPUTexture[]=[];
  private views:GPUTextureView[]=[];
  private resolveTarget?:GPUTextureView;
  private preserveMSAA=false;
  private passDescriptor?:GPURenderPassDescriptor;
  private readonly drawBatches:Batch[]=[];
  private readonly commands:GPUCommandBuffer[]=[];
  private passContext?:Extract<PassContext,{backend:'webgpu'}>;
  private draw?:PassContext['draw'];
  private readonly bindings:GPUBindGroupEntry[]=[];
  private width = 0; private height = 0;
  private frameId=0;
  private lost?: Error;
  private deviceLost=false;
  private readonly resources = new Map<Geometry,{vertex: GPUBuffer; index: GPUBuffer; instance: GPUBuffer;frame:number;indirect?:GPUBuffer;command?:Uint32Array}>();
  private readonly variants=new Map<string,GPURenderPipeline>();
  private readonly groups=new WeakMap<GPURenderPipeline,{bindings:GPUBindGroupEntry[];group:GPUBindGroup}>();
  private readonly uniform: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly culledGroup: GPUBindGroup;
  private disposed = false;
  private picking=false;

  static async create(canvas: HTMLCanvasElement, features: GPUFeatureName[] = []): Promise<GPURenderer> {
    const adapter = await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
    if (!adapter) throw new Error('adapter unavailable');
    const device = await adapter.requestDevice({requiredFeatures:['depth32float-stencil8' as GPUFeatureName,...features].filter(feature=>adapter.features.has(feature))});
    try {
      const format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({code:wgsl});
      const descriptor:GPURenderPipelineDescriptor = {
        layout:'auto', vertex:{module,entryPoint:'vertex',buffers:[
          {arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]},
          {arrayStride:96,stepMode:'instance',attributes:Array.from({length:6},(_,i)=>({shaderLocation:i+2,offset:i*16,format:'float32x4' as const}))}
        ]}, fragment:{module,entryPoint:'fragment',targets:[{format}]},
        depthStencil:{format:device.features.has('depth32float-stencil8')?'depth32float-stencil8':'depth32float',depthWriteEnabled:true,depthCompare:'greater-equal'},multisample:{count:sceneSamples()}
      };
      const pipeline=await device.createRenderPipelineAsync(descriptor),culled=await device.createRenderPipelineAsync({...descriptor,primitive:{cullMode:'back'},fragment:{...descriptor.fragment!,constants:{C:1}}});
      const context = canvas.getContext('webgpu') as GPUCanvasContext|null; if (!context) throw new Error('No WebGPU canvas');
      return new GPURenderer(canvas,device,context,format,pipeline,descriptor,culled);
    } catch(error) { device.destroy(); throw error; }
  }

  private constructor(private readonly canvas: HTMLCanvasElement, private readonly device: GPUDevice, private readonly context: GPUCanvasContext, private readonly format: GPUTextureFormat, private readonly pipeline: GPURenderPipeline,private readonly descriptor:GPURenderPipelineDescriptor,private readonly culled:GPURenderPipeline) {
    this.uniform=device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]});this.culledGroup=device.createBindGroup({layout:culled.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]});
    try { context.configure({device,format}); } catch(error) { this.uniform.destroy(); throw error; }
    device.lost.then(info=>{this.deviceLost=true;if(!this.disposed)this.onLost?.(new Error(`GPU lost: ${info.message}`));});
    device.addEventListener('uncapturederror',event=>{ this.lost=new Error(event.error.message); });
  }

  add(geometry: Geometry, capacity: number): void {
    const buffers: GPUBuffer[] = [];
    try {
      const upload=(data:Float32Array|Uint32Array,usage:number) => {
        if(data.byteLength>this.device.limits.maxBufferSize)throw new RangeError('GPU buffer limit');
        const buffer=this.device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST}); buffers.push(buffer);
        this.device.queue.writeBuffer(buffer,0,data as Float32Array<ArrayBuffer>); return buffer;
      };
      const vertex=upload(geometry.vertices,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE),index=upload(geometry.indices,GPUBufferUsage.INDEX|GPUBufferUsage.STORAGE);
      if(capacity*96>this.device.limits.maxBufferSize)throw new RangeError('GPU buffer limit');
      const instance=this.device.createBuffer({size:capacity*96,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}); buffers.push(instance);
      this.resources.set(geometry,{vertex,index,instance,frame:-1});
    } catch(error) { for(const buffer of buffers)buffer.destroy(); throw error; }
  }
  remove(geometry: Geometry): void {
    const resource=this.resources.get(geometry); if(!resource)return;
    resource.vertex.destroy(); resource.index.destroy(); resource.instance.destroy();resource.indirect?.destroy(); this.resources.delete(geometry);
  }
  geometryBuffers(geometry:Geometry):GeometryBuffers {const resource=this.resources.get(geometry);if(this.disposed||this.deviceLost||!resource)throw new Error('Geometry unavailable');return resource;}
  render(camera: Camera, lighting: Lighting, batches: Iterable<Batch>,graph:FrameGraph,delta:number): void {
    if(this.deviceLost||this.disposed)return;
    try{this.renderFrame(camera,lighting,batches,graph,delta);}catch(error){
      if(error instanceof DOMException&&['InvalidStateError','OperationError'].includes(error.name)){this.deviceLost=true;this.onLost?.(error);return;}throw error;
    }
  }
  private renderFrame(camera: Camera, lighting: Lighting, batches: Iterable<Batch>,graph:FrameGraph,delta:number): void {
    if(this.lost)throw this.lost;
    const {width,height}=this.canvas;
    if(width!==this.width||height!==this.height) {
      for(const target of this.targets)target.destroy();this.targets=[];this.views=[];
      for(const format of [this.format,this.descriptor.depthStencil!.format].slice(this.descriptor.multisample!.count===4?0:1)){const target=this.device.createTexture({size:[width,height],sampleCount:this.descriptor.multisample!.count,format,usage:GPUTextureUsage.RENDER_ATTACHMENT});this.targets.push(target);this.views.push(target.createView());}
      this.width=width;this.height=height;
    }
    this.frame.set(camera.matrix); this.frame.set(camera.position,16); this.frame.set(lighting.direction,20); this.frame.set(lighting.radiance,24);
    this.device.queue.writeBuffer(this.uniform,0,this.frame);
    const encoder=this.device.createCommandEncoder();
    this.frameId++;
    const drawBatches=this.drawBatches;let count=0;for(const batch of batches)drawBatches[count++]=batch;drawBatches.length=count;
    this.resolveTarget=this.context.getCurrentTexture().createView();const color=this.targets.length>1?this.views[0]:this.resolveTarget,depth=this.views.at(-1)!;
    this.preserveMSAA=graph.revision>0&&this.targets.length>1;
    const context=this.passContext??={backend:'webgpu',draw:(options:DrawOptions=defaultDraw)=>{
    const context=this.passContext!;
    let pipeline=options.pipeline??this.pipeline;const bindings=options.bindings??context.bindings;
    if(!options.pipeline&&(context.shader!==wgsl||context.format!==this.format||context.descriptor!==this.descriptor)){
      const key=context.descriptor.multisample?.count+context.format+context.descriptor.depthStencil?.format+context.shader;let cached=this.variants.get(key);
      if(!cached){if(this.variants.size>=64)throw new RangeError('Shader limit: 64');const module=this.device.createShaderModule({code:context.shader});cached=this.device.createRenderPipeline({...context.descriptor,vertex:{...this.descriptor.vertex,module},fragment:{...this.descriptor.fragment!,module,targets:[{format:context.format}]}});this.variants.set(key,cached);}pipeline=cached;
    }
    let group=this.bindGroup;
    if(pipeline!==this.pipeline||bindings.length){let cached=this.groups.get(pipeline);if(!cached||cached.bindings.length!==bindings.length||bindings.some((entry,i)=>{
      const previous=cached!.bindings[i],resource=entry.resource as GPUBufferBinding,old=previous.resource as GPUBufferBinding;
      return entry.binding!==previous.binding||(resource.buffer?resource.buffer!==old.buffer||resource.offset!==old.offset||resource.size!==old.size:resource!==old);
    })){
      const group=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},...bindings]});
      cached={bindings:bindings.map(({binding,resource})=>({binding,resource:(resource as GPUBufferBinding).buffer?{...resource}:resource})),group};this.groups.set(pipeline,cached);}group=cached.group;}
    const clear=options.clear??true;
    const descriptor=this.passDescriptor??={colorAttachments:[{view:context.color,clearValue:[0.018,0.023,0.035,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:context.depth,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}};
    const attachments=descriptor.colorAttachments as GPURenderPassColorAttachment[],attachment=attachments[0],depth=descriptor.depthStencilAttachment!;attachment.view=context.color;attachment.loadOp=clear?'clear':'load';depth.view=context.depth;depth.depthLoadOp=attachment.loadOp;
    attachment.resolveTarget=context.color===this.views[0]?this.resolveTarget:undefined;
    // Later scene passes load MSAA color and depth until the final resolve.
    attachment.storeOp=depth.depthStoreOp=attachment.resolveTarget&&!this.preserveMSAA?'discard':'store';
    attachments.length=1;if(options.colorAttachments)attachments.push(...options.colorAttachments);
    const stencil=context.descriptor.depthStencil!.format.includes('stencil');depth.stencilClearValue=stencil?options.stencilClear??0:undefined;depth.stencilLoadOp=stencil?(clear||options.stencilClear!==undefined?'clear':'load'):undefined;depth.stencilStoreOp=stencil?depth.depthStoreOp:undefined;
    const pass=context.encoder.beginRenderPass(descriptor);
    let current:GPURenderPipeline|undefined;
    for(const batch of drawBatches) if(batch.count) {
      const p=pipeline===this.pipeline&&!bindings.length&&!batch.mask?this.culled:pipeline;if(p!==current){current=p;pass.setPipeline(p);pass.setBindGroup(0,p===pipeline?group:this.culledGroup);}
      const resource=this.resources.get(batch.geometry)!;
      // Upload only the changed range, everything into a new buffer.
      if(resource.frame!==this.frameId){const start=resource.frame<0?0:batch.start??0,end=Math.min(resource.frame<0?1/0:batch.end??1/0,batch.count*24);if(end>start)this.device.queue.writeBuffer(resource.instance,start*4,batch.instances as Float32Array<ArrayBuffer>,start,end-start);batch.start=1/0;batch.end=0;resource.frame=this.frameId;}
      const redirect=batch.redirect;pass.setVertexBuffer(0,resource.vertex); pass.setVertexBuffer(1,redirect?.instances??resource.instance); pass.setIndexBuffer(resource.index,'uint32');
      if(redirect)pass.drawIndexedIndirect(redirect.args,0);else if(options.indirect??context.indirect){resource.indirect??=this.device.createBuffer({size:20,usage:GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST});resource.command??=new Uint32Array([batch.geometry.indices.length,0,0,0,0]);if(resource.command[1]!==batch.count){resource.command[1]=batch.count;this.device.queue.writeBuffer(resource.indirect,0,resource.command as Uint32Array<ArrayBuffer>);}pass.drawIndexedIndirect(resource.indirect,0);}else pass.drawIndexed(batch.geometry.indices.length,batch.count);
    }
    pass.end();}} as Extract<PassContext,{backend:'webgpu'}>;
    Object.assign(context,{batches:drawBatches,draw:this.draw??=context.draw,descriptor:this.descriptor,device:this.device,encoder,color,depth,camera,width,height,delta,format:this.format,shader:wgsl,bindings:this.bindings,indirect:false});this.bindings.length=0;
    graph.execute(context);if(!this.deviceLost&&!this.disposed){if(this.preserveMSAA)encoder.beginRenderPass({colorAttachments:[{view:color,resolveTarget:this.resolveTarget,loadOp:'load',storeOp:'discard'}],depthStencilAttachment:{view:depth,depthLoadOp:'load',depthStoreOp:'discard',stencilReadOnly:true}}).end();this.commands[0]=encoder.finish();this.device.queue.submit(this.commands);}
  }
  async pick(camera:Camera,lighting:Lighting,batches:Iterable<Batch>,graph:FrameGraph,x:number,y:number):Promise<number|null> {
    if(this.deviceLost||this.disposed)return null;if(this.picking)throw new Error('Pick pending');this.picking=true;
    let color:GPUTexture|undefined,depth:GPUTexture|undefined,read:GPUBuffer|undefined,uniform:GPUBuffer|undefined;
    try {
    const device=this.device;
    color=device.createTexture({size:[1,1],format:'r32uint',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});depth=device.createTexture({size:[1,1],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});read=device.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const matrix=camera.matrix.slice(),nx=2*(Math.floor(x)+0.5)/this.canvas.width-1,ny=1-2*(Math.floor(y)+0.5)/this.canvas.height;
    for(let c=0;c<4;c++){matrix[c*4]=(camera.matrix[c*4]-nx*camera.matrix[c*4+3])*this.canvas.width;matrix[c*4+1]=(camera.matrix[c*4+1]-ny*camera.matrix[c*4+3])*this.canvas.height;}
    const frame=new Float32Array(28);frame.set(matrix);frame.set(camera.position,16);frame.set(lighting.direction,20);frame.set(lighting.radiance,24);
    uniform=device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(uniform,0,frame);
      // Reuse shader pass hooks for fragment clipping; caps and FX draws are suppressed.
      const encoder=device.createCommandEncoder(),context:Extract<PassContext,{backend:'webgpu'}>={backend:'webgpu',device,encoder,color:color.createView(),depth:depth.createView(),camera,width:this.canvas.width,height:this.canvas.height,delta:0,format:this.format,shader:wgsl,bindings:[],indirect:false,descriptor:this.descriptor,draw:()=>{}};
      graph.prepare(context);
      const code=context.shader.replace('@location(3) material:vec4f','@location(3) material:vec4f,@location(4) @interpolate(flat) id:u32').replace('o.color=i.color.rgb','o.id=u32(i.factors.w);o.color=i.color.rgb').replace('->@location(0) vec4f {','->@location(0) u32 {').replace(/let n=normalize\(i.normal\)[\s\S]*$/,'return i.id;\n}');
      const module=device.createShaderModule({code}),pipeline=device.createRenderPipeline({...this.descriptor,multisample:{count:1},vertex:{...this.descriptor.vertex,module},fragment:{module,entryPoint:'fragment',targets:[{format:'r32uint'}]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater-equal'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},...context.bindings]});
      const pass=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),clearValue:[4294967295,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}});pass.setPipeline(pipeline);pass.setBindGroup(0,group);
      for(const batch of batches)if(batch.count){const r=this.resources.get(batch.geometry)!;device.queue.writeBuffer(r.instance,0,batch.instances as Float32Array<ArrayBuffer>,0,batch.count*24);r.frame=-1;pass.setVertexBuffer(0,r.vertex);pass.setVertexBuffer(1,r.instance);pass.setIndexBuffer(r.index,'uint32');pass.drawIndexed(batch.geometry.indices.length,batch.count);}pass.end();
      if(this.deviceLost||this.disposed)return null;encoder.copyTextureToBuffer({texture:color},{buffer:read},[1,1]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const id=new Uint32Array(read.getMappedRange())[0];read.unmap();return id===4294967295?null:id;
    }finally{uniform?.destroy();color?.destroy();depth?.destroy();read?.destroy();this.picking=false;}
  }
  dispose(unconfigure=true): void {
    if(this.disposed)return; this.disposed=true;
    for(const geometry of this.resources.keys())this.remove(geometry);
    for(const target of this.targets)target.destroy();this.uniform.destroy(); if(unconfigure)this.context.unconfigure(); this.device.destroy();
  }
}
