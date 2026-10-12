import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext} from '@margoengine/core/extension';
import {finiteVector} from '../../shared/math.js';
import {sceneSamples} from '../../shared/quality.js';
import frameShader from './shaders/grass-frame.wgsl?raw';
import cullShader from './shaders/grass-cull.wgsl?raw';
import grassShader from './shaders/grass.wgsl?raw';

declare const GPUBufferUsage: {STORAGE:number;UNIFORM:number;VERTEX:number;INDIRECT:number;COPY_SRC:number;COPY_DST:number};
declare const GPUShaderStage: {VERTEX:number;FRAGMENT:number};
type Context = Extract<PassContext, {backend:'webgpu'}>;
type Variant = {near:GPURenderPipeline;far:GPURenderPipeline;group:GPUBindGroup;spores?:GPURenderPipeline;sporeGroup?:GPUBindGroup};
let fields = 0;

export interface GrassOptions {
  blades?: number;
  area?: readonly [number, number];
  bladeHeight?: number;
  windSpeed?: number;
  windStrength?: number;
  windDirection?: readonly [number, number];
  drawDistance?: number;
  spores?: boolean;
}

export class GrassField implements EnginePlugin {
  readonly name = `grass-field:${++fields}`;
  readonly blades: number;
  private engine?: Engine;
  private device?: GPUDevice;
  private instances?: GPUBuffer;
  private visible?: GPUBuffer;
  private indirect?: GPUBuffer;
  private vertices?: GPUBuffer;
  private uniform?: GPUBuffer;
  private compute?: GPUComputePipeline;
  private computeGroup?: GPUBindGroup;
  private readonly variants = new Map<string, Variant>();
  private readonly frame = new Float32Array(72);
  private time = 0;
  private readonly spores: boolean;
  private readonly color: GPURenderPassColorAttachment = {view:undefined!,loadOp:'load',storeOp:'store'};
  private readonly depth: GPURenderPassDepthStencilAttachment = {view:undefined!,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true};
  private readonly pass: GPURenderPassDescriptor = {colorAttachments:[this.color],depthStencilAttachment:this.depth};
  private readonly sporeDepth: GPURenderPassDepthStencilAttachment = {view:undefined!,depthReadOnly:true,stencilReadOnly:true};
  private readonly sporePass: GPURenderPassDescriptor = {colorAttachments:[this.color],depthStencilAttachment:this.sporeDepth};

  constructor(stage: {readonly engine:EngineKernel}, options: GrassOptions = {}) {
    const {blades=100_000,area=[50,50],bladeHeight=1.2,windSpeed=1.2,windStrength=0.45,windDirection=[1,0.35],drawDistance=100,spores=false} = options;
    finiteVector(area,2,'Grass area'); finiteVector(windDirection,2,'Wind direction');
    finiteVector([bladeHeight,drawDistance],2,'Grass dimensions');
    if (!Number.isSafeInteger(blades) || blades<1 || blades>16_777_216 || area.some(v=>Math.fround(v)<=0 || v>100_000) ||
        Math.fround(bladeHeight)<=0 || bladeHeight>100 || Math.fround(drawDistance)<=0 || drawDistance>100_000 ||
        !Math.hypot(...windDirection) || typeof spores!=='boolean') throw new RangeError('Invalid grass options');
    this.blades=blades; this.spores=spores;
    this.windSpeed=windSpeed; this.windStrength=windStrength;
    const length=Math.hypot(...windDirection);
    this.frame[52]=windDirection[0]/length; this.frame[53]=windDirection[1]/length;
    this.frame.set(area,56); this.frame[58]=bladeHeight; this.frame[60]=drawDistance; this.frame[61]=blades;
    engineRuntime(stage.engine).use(this);
  }

  get windSpeed(): number {return this.frame[54];}
  set windSpeed(value: number) {
    if (typeof value!=='number' || !Number.isFinite(value) || value<0 || value>100) throw new RangeError('Wind speed must be 0..100');
    this.frame[54]=value;
  }
  get windStrength(): number {return this.frame[55];}
  set windStrength(value: number) {
    if (typeof value!=='number' || !Number.isFinite(value) || value<0 || value>2) throw new RangeError('Wind strength must be 0..2');
    this.frame[55]=value;
  }
  get windTime(): number {return this.time;}
  set windTime(value: number) {
    if (typeof value!=='number' || !Number.isFinite(Math.fround(value)) || value<0) throw new RangeError('Wind time must be finite and nonnegative');
    this.time=value;
  }

  setup(engine: Engine): void {
    if (this.device) throw new Error('Grass field already attached');
    const device=engine.gpu;
    if (!device) throw new Error('GrassField requires WebGPU');
    if (this.blades*24>Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize) ||
        Math.ceil(this.blades/64)>device.limits.maxComputeWorkgroupsPerDimension) throw new RangeError('Grass storage or dispatch exceeds GPU limits');
    this.engine=engine; this.device=device;
    this.instances=device.createBuffer({label:'grass:instances',size:this.blades*24,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.visible=device.createBuffer({label:'grass:visible',size:this.blades*8,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    this.indirect=device.createBuffer({label:'grass:indirect',size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
    this.uniform=device.createBuffer({label:'grass:frame',size:this.frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.vertices=device.createBuffer({label:'grass:blade',size:200,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    const data=new Float32Array(this.blades*6),columns=Math.min(this.blades,Math.ceil(Math.sqrt(this.blades*this.frame[56]/this.frame[57]))),rows=Math.ceil(this.blades/columns);
    let seed=0x12345678;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for (let i=0;i<this.blades;i++) {
      data[i*6]=((i%columns+random())/columns-0.5)*this.frame[56];
      data[i*6+2]=((Math.floor(i/columns)+random())/rows-0.5)*this.frame[57];
      data[i*6+3]=random()*Math.PI*2; data[i*6+4]=0.7+random()*0.55; data[i*6+5]=0.75+random()*0.5;
    }
    device.queue.writeBuffer(this.instances,0,data);
    device.queue.writeBuffer(this.indirect,0,new Uint32Array([7,0,0,0,3,0,7,0]));
    device.queue.writeBuffer(this.vertices,0,new Float32Array([
      -0.5,0,0,0,0, 0.5,0,0,1,0,
      -0.34,1/3,0,0,1/3, 0.34,1/3,0,1,1/3,
      -0.17,2/3,0,0,2/3, 0.17,2/3,0,1,2/3, 0,1,0,0.5,1,
      -0.5,0,0,0,0, 0.5,0,0,1,0, 0,1,0,0.5,1,
    ]));
    const computeModule=device.createShaderModule({label:'grass:cull',code:frameShader+cullShader});
    this.compute=device.createComputePipeline({layout:'auto',compute:{module:computeModule,entryPoint:'cull'}});
    const entries=[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.instances}},{binding:2,resource:{buffer:this.visible}}];
    this.computeGroup=device.createBindGroup({layout:this.compute.getBindGroupLayout(0),entries:[...entries,{binding:3,resource:{buffer:this.indirect}}]});
    const module=device.createShaderModule({label:'grass:render',code:frameShader+grassShader});
    const depthFormat=device.features.has('depth32float-stencil8')?'depth32float-stencil8':'depth32float';
    for (const format of [navigator.gpu.getPreferredCanvasFormat(),'rgba16float'] as GPUTextureFormat[]) for(const count of sceneSamples()===1?[1]:[1,4]) {
      const buffers: GPUVertexBufferLayout[]=[{arrayStride:20,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x2'}]}];
      // Explicit shared layout lets both LOD pipelines reuse one bind group.
      const layout=device.createBindGroupLayout({entries:[
        {binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
        {binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
        {binding:2,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
      ]});
      const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
      const pipeline=(entryPoint:string)=>device.createRenderPipeline({layout:pipelineLayout,vertex:{module,entryPoint,buffers},fragment:{module,entryPoint:'fragment',targets:[{format}]},primitive:{topology:'triangle-strip',cullMode:'none'},multisample:{count},depthStencil:{format:depthFormat,depthWriteEnabled:true,depthCompare:'greater-equal'}});
      const variant: Variant={near:pipeline('nearVertex'),far:pipeline('farVertex'),group:device.createBindGroup({layout,entries})};
      if (this.spores) {
        variant.spores=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'sporeVertex'},fragment:{module,entryPoint:'sporeFragment',targets:[{format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},multisample:{count},depthStencil:{format:depthFormat,depthWriteEnabled:false,depthCompare:'greater-equal'}});
        variant.sporeGroup=device.createBindGroup({layout:variant.spores.getBindGroupLayout(0),entries:[entries[0]]});
      }
      this.variants.set(format+':'+count,variant);
    }
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({name:this.name+':cull',order:-10,execute:this.update});
    graph.add({name:this.name+':draw',order:5,execute:this.draw});
    if (this.spores) graph.add({name:this.name+':spores',order:11,execute:this.drawSpores});
  }
  private readonly update = (c: PassContext): void => {
    if (c.backend!=='webgpu') throw new Error('GrassField requires WebGPU');
    this.windTime=this.time+c.delta;
    const f=this.frame,camera=c.camera;
    f.set(camera.matrix); f.set(camera.planes,16); f.set(camera.position,40);
    f.set(this.engine!.lighting.direction,44); f.set(this.engine!.lighting.radiance,48);
    f[59]=this.time; f[62]=+(c.format==='rgba16float');
    const dx=camera.target[0]-camera.position[0],dy=camera.target[1]-camera.position[1],dz=camera.target[2]-camera.position[2];
    const length=Math.hypot(dx,dy,dz),horizontal=Math.hypot(dx,dz),rx=-dz/horizontal,rz=dx/horizontal;
    f[64]=rx; f[66]=rz; f[68]=-rz*dy/length; f[69]=(rz*dx-rx*dz)/length; f[70]=rx*dy/length;
    c.device.queue.writeBuffer(this.uniform!,0,f);
    c.encoder.clearBuffer(this.indirect!,4,4); c.encoder.clearBuffer(this.indirect!,20,4);
    const pass=c.encoder.beginComputePass(); pass.setPipeline(this.compute!); pass.setBindGroup(0,this.computeGroup!);
    pass.dispatchWorkgroups(Math.ceil(this.blades/64)); pass.end();
  };
  private readonly draw = (c: PassContext): void => {
    if (c.backend!=='webgpu') return;
    const variant=this.variant(c);
    this.color.view=c.color; this.depth.view=c.depth;
    const pass=c.encoder.beginRenderPass(this.pass);
    pass.setBindGroup(0,variant.group); pass.setVertexBuffer(0,this.vertices!);
    pass.setPipeline(variant.near); pass.drawIndirect(this.indirect!,0);
    pass.setPipeline(variant.far); pass.drawIndirect(this.indirect!,16); pass.end();
  };
  private readonly drawSpores = (c: PassContext): void => {
    if (c.backend!=='webgpu') return;
    const variant=this.variant(c);
    this.color.view=c.color; this.sporeDepth.view=c.depth;
    const pass=c.encoder.beginRenderPass(this.sporePass);
    pass.setPipeline(variant.spores!); pass.setBindGroup(0,variant.sporeGroup!); pass.draw(6,240); pass.end();
  };
  private variant(c: Context): Variant {
    const variant=this.variants.get(c.format+':'+(c.descriptor.multisample?.count??1));
    if (!variant) throw new Error('Unsupported grass target format');
    return variant;
  }
  private release(): void {
    this.instances?.destroy(); this.visible?.destroy(); this.indirect?.destroy(); this.vertices?.destroy(); this.uniform?.destroy();
    this.instances=this.visible=this.indirect=this.vertices=this.uniform=undefined;
    this.device=undefined; this.compute=undefined; this.computeGroup=undefined; this.variants.clear();
  }
  onDeviceRestored(engine: Engine): void {this.release(); try {this.setup(engine);} catch (error) {this.release(); throw error;}}
  destroy(): void {this.dispose();}
  dispose(): void {
    if (this.engine?.hasPlugin(this.name)) {this.engine.removePlugin(this.name); return;}
    this.release(); this.engine=undefined;
  }
}
