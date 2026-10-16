import type {Mesh as MeshHandle} from '@margoengine/core';
import {meshRuntime,type Engine,type Mesh,type PassContext} from '@margoengine/core/extension';
import {finiteVector} from '../../shared/math.js';
import {meshTriangles} from '../../shared/mesh-source.js';
import {localShadowMatrix} from './local-shadow-math.js';
declare const GPUBufferUsage:{UNIFORM:number;STORAGE:number;COPY_DST:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;COPY_DST:number;COPY_SRC:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface LocalShadowOptions {resolution?:number;maxLights?:number}
export interface LocalLightShadow {near?:number;bias?:number;normalBias?:number}
export interface LocalShadowPrimitive {primitive?:object;node:Mesh;vertex:GPUBuffer;index:GPUBuffer;count:number;stride:number;alphaTexture?:GPUTextureView;alphaSampler?:GPUSampler;alpha?:number;cutoff?:number;texCoord?:number;alphaTransform?:Float32Array}
export interface LocalShadowSource {shadowPrimitives?:readonly LocalShadowPrimitive[];disposed?:boolean;drawShadow?:unknown}
interface ShadowLight {position:ArrayLike<number>;range:number;direction?:ArrayLike<number>;outerAngle?:number;shadow?:boolean|LocalLightShadow}
interface Source {source:Mesh|LocalShadowSource;primitive?:LocalShadowPrimitive[]}
interface DrawFace {uniform:GPUBuffer;group:GPUBindGroup}
interface Draw {faces:Map<number,DrawFace>;values:Float32Array;vertex:GPUBuffer;pipeline:GPURenderPipeline;alpha?:GPUTextureView;sampler?:GPUSampler;epoch:number}
const emptyPrimitives:readonly LocalShadowPrimitive[]=[];
const directions:readonly (readonly number[])[]=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const ups:readonly (readonly number[])[]=[[0,-1,0],[0,-1,0],[0,0,1],[0,0,-1],[0,-1,0],[0,-1,0]];
const upY=[0,1,0],upZ=[0,0,1];
/** Optional clustered-light depth maps; the owning Clustered effect controls its passes. */
export class LocalShadowMaps {
  readonly resolution:number;readonly maxLights:number;readonly stats={passes:0,draws:0};
  private engine?:Engine;private device?:GPUDevice;private depth?:GPUTexture;private white?:GPUTexture;private whiteView?:GPUTextureView;private uniform?:GPUBuffer;private alphaSampler?:GPUSampler;
  private views:GPUTextureView[]=[];private entries:GPUBindGroupEntry[]=[];private pipelines=new Map<number,GPURenderPipeline>();private draws=new Map<Mesh,Map<object,Draw>>();private sources:Source[]=[];
  private readonly values:Float32Array;private indices:number[]=[];private activeLayers:number[]=[];private matrices:Float32Array[]=[];private dirty=true;private disposed=false;private epoch=0;
  private readonly depthAttachment:GPURenderPassDepthStencilAttachment={view:undefined!,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'};
  private readonly depthPass:GPURenderPassDescriptor={colorAttachments:[],depthStencilAttachment:this.depthAttachment};
  constructor(options:LocalShadowOptions={}) {
    if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Invalid local shadow options');
    this.resolution=options.resolution??512;this.maxLights=options.maxLights??4;
    if(!Number.isInteger(this.resolution)||this.resolution<16||!Number.isInteger(this.maxLights)||this.maxLights<1||this.maxLights>32)throw new RangeError('Invalid local shadow options');
    this.values=new Float32Array(this.maxLights*6*20);this.matrices=Array.from({length:this.maxLights*6},(_,i)=>this.values.subarray(i*20,i*20+16));
  }
  /** Validate and stage the entire replacement before changing any live light state. */
  configure(lights:readonly ShadowLight[]):void {
    if(this.disposed||!Array.isArray(lights)||lights.length>1024)throw new RangeError('Expected at most 1,024 lights');
    const values=new Float32Array(this.values.length),indices:number[]=[],layers:number[]=[];let slot=0;
    for(let i=0;i<lights.length;i++){
      const light=lights[i];if(!light||typeof light!=='object')throw new TypeError('Invalid shadow light');
      const option=light.shadow;if(option===undefined||option===false){indices.push(0);continue;}
      if(option!==true&&(!option||typeof option!=='object'||Array.isArray(option)))throw new TypeError('Invalid local light shadow');
      if(slot===this.maxLights)throw new RangeError(`At most ${this.maxLights} lights may cast local shadows`);
      finiteVector(light.position,3,'Shadow light position');const settings=option===true?{}:option;
      if(typeof light.range!=='number'||[settings.near,settings.bias,settings.normalBias].some(value=>value!==undefined&&typeof value!=='number'))throw new TypeError('Local shadow settings must be numbers');
      const far=Math.fround(light.range);
      const near=Math.fround(settings.near??Math.min(0.1,far/100)),bias=Math.fround(settings.bias??0.0005),normalBias=Math.fround(settings.normalBias??0.02);
      if(!Number.isFinite(far)||far<=0||!Number.isFinite(near)||near<=0||near>=far||!Number.isFinite(bias)||bias<0||!Number.isFinite(normalBias)||normalBias<0)throw new RangeError('Invalid local light shadow settings');
      const spot=light.direction!==undefined;
      if(spot){finiteVector(light.direction,3,'Shadow spot direction');if(!Math.hypot(light.direction![0],light.direction![1],light.direction![2])||typeof light.outerAngle!=='number'||!Number.isFinite(light.outerAngle)||light.outerAngle<=0||light.outerAngle>=Math.PI/2)throw new RangeError('Invalid shadow spot cone');}
      for(let face=0;face<(spot?1:6);face++){
        const layer=slot*6+face,offset=layer*20,direction=spot?light.direction!:directions[face],up=spot?(Math.abs(direction[1])/Math.hypot(direction[0],direction[1],direction[2])>0.99?upZ:upY):ups[face];
        localShadowMatrix(values,offset,light.position,direction,up,near,far,spot?light.outerAngle!*2:Math.PI/2);values[offset+16]=bias;values[offset+17]=normalBias;layers.push(layer);
      }
      indices.push(++slot);
    }
    this.values.set(values);this.indices=indices;this.activeLayers=layers;this.dirty=true;
  }
  shadowIndex(index:number):number {return this.indices[index]??0;}
  add(source:MeshHandle|LocalShadowSource):()=>void {
    if(this.disposed||!source||typeof source!=='object')throw new TypeError('Invalid local shadow source');
    const runtime='id' in source?meshRuntime(source as MeshHandle):source as LocalShadowSource;
    this.validateSource(runtime,this.engine);
    if(this.sources.some(record=>record.source===runtime))throw new Error('Duplicate local shadow source');
    const record:Source={source:runtime};this.sources.push(record);
    return()=>{const index=this.sources.indexOf(record);if(index>=0){this.sources.splice(index,1);this.clearDraws();}};
  }
  private validateSource(source:Mesh|LocalShadowSource,engine?:Engine):void {
    if('disposed' in source&&source.disposed)throw new Error('Local shadow source is disposed');
    if('id' in source){source.check();if(engine&&source.engine!==engine)throw new Error('Local shadow mesh belongs to another engine');return;}
    if(!Array.isArray(source.shadowPrimitives))throw new TypeError('Local shadows require shadowPrimitives; custom drawShadow sources are unsupported');
    for(const primitive of source.shadowPrimitives){if(!primitive?.node||typeof primitive.node.check!=='function')throw new TypeError('Invalid local shadow primitive');primitive.node.check();if(engine&&primitive.node.engine!==engine)throw new Error('Local shadow source belongs to another engine');}
  }
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu||this.device)throw new Error('Local shadows require WebGPU and a live effect');
    const device=engine.gpu,size=this.resolution,layers=this.maxLights*6,bytes=this.values.byteLength;
    if(size>device.limits.maxTextureDimension2D||layers>device.limits.maxTextureArrayLayers||bytes>device.limits.maxStorageBufferBindingSize||bytes>device.limits.maxBufferSize)throw new RangeError('Local shadow maps exceed device limits');
    for(const record of this.sources)this.validateSource(record.source,engine);
    let depth:GPUTexture|undefined,white:GPUTexture|undefined,uniform:GPUBuffer|undefined;
    try{
      depth=device.createTexture({label:'clustered local shadow maps',size:[size,size,layers],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
      const views=Array.from({length:layers},(_,baseArrayLayer)=>depth!.createView({dimension:'2d',baseArrayLayer,arrayLayerCount:1}));
      uniform=device.createBuffer({label:'clustered local shadow matrices',size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      const sampler=device.createSampler({compare:'less-equal',magFilter:'linear',minFilter:'linear'}),alphaSampler=device.createSampler();
      white=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture:white},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);
      const whiteView=white.createView(),entries:GPUBindGroupEntry[]=[{binding:16,resource:{buffer:uniform}},{binding:17,resource:depth.createView({dimension:'2d-array'})},{binding:18,resource:sampler}];
      this.depth=depth;this.white=white;this.whiteView=whiteView;this.uniform=uniform;this.alphaSampler=alphaSampler;this.views=views;this.entries=entries;this.engine=engine;this.device=device;this.dirty=true;
    }catch(error){depth?.destroy();white?.destroy();uniform?.destroy();throw error;}
  }
  bindings():GPUBindGroupEntry[] {if(!this.device||this.disposed)throw new Error('Local shadows are not attached');return this.entries;}
  render(context:Context):void {
    if(!this.device||this.disposed)throw new Error('Local shadows are not attached');
    this.stats.passes=this.stats.draws=0;this.epoch++;
    for(let i=this.sources.length-1;i>=0;i--){const source=this.sources[i].source;if('disposed' in source&&source.disposed||'id' in source&&this.engine!.meshes.get(source.id)!==source)this.sources.splice(i,1);}
    if(this.dirty){context.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);this.dirty=false;}
    try{for(const layer of this.activeLayers){
      this.depthAttachment.view=this.views[layer];const pass=context.encoder.beginRenderPass(this.depthPass);this.stats.passes++;
      const submitted=new Map<Mesh,Set<object>>();
      try{for(const record of this.sources){
        const source=record.source;let primitives:readonly LocalShadowPrimitive[];
        if('id' in source){const triangles=meshTriangles(source);if(!triangles)continue;
          if(triangles.kind==='pbr')primitives=triangles.source.shadowPrimitives;
          else {const geometry=triangles.geometry,buffers=this.engine!.geometryBuffers(geometry);if(!buffers)continue;
          if(!record.primitive)record.primitive=[{node:source,vertex:buffers.vertex,index:buffers.index,count:geometry.indices.length,stride:24}];
          const primitive=record.primitive[0];primitive.vertex=buffers.vertex;primitive.index=buffers.index;primitive.count=geometry.indices.length;primitives=record.primitive;}
        }else primitives=source.shadowPrimitives??emptyPrimitives;
        for(const primitive of primitives){const node=primitive.node;if(this.engine!.meshes.get(node.id)!==node)continue;node.check();if(node.engine!==this.engine)throw new Error('Local shadow source belongs to another engine');let visible=true;
          for(let id=node.id;id!==-1;id=this.engine!.store.parents[id])if(this.engine!.store.hidden[id]){visible=false;break;}if(!visible)continue;
          const key=primitive.primitive??primitive.index;let indices=submitted.get(node);if(indices?.has(key))continue;if(!indices){indices=new Set();submitted.set(node,indices);}indices.add(key);
          this.draw(pass,primitive,layer);this.stats.draws++;
        }
      }}finally{pass.end();}
    }}finally{this.sweepDraws();}
  }
  private draw(pass:GPURenderPassEncoder,primitive:LocalShadowPrimitive,layer:number):void {
    const p=primitive,transform=p.alphaTransform;
    if(p.stride!==24&&p.stride!==80)throw new RangeError('Unsupported local shadow vertex stride');
    if(transform!==undefined&&(!(transform instanceof Float32Array)||transform.length!==8||transform.some(value=>!Number.isFinite(value))||p.stride!==80))throw new TypeError('Local shadow alpha transform requires finite affine rows and PBR vertices');
    if(!Number.isInteger(p.count)||p.count<0||p.texCoord!==undefined&&p.texCoord!==0&&p.texCoord!==1||!Number.isFinite(Math.fround(p.alpha??1))||!Number.isFinite(Math.fround(p.cutoff??0)))throw new RangeError('Invalid local shadow primitive');
    const key=p.stride+(transform?1:0);let pipeline=this.pipelines.get(key);
    if(!pipeline){const module=this.device!.createShaderModule({code:depthShader(p.stride===80,!!transform)});pipeline=this.device!.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:p.stride,attributes:p.stride===80?[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:3,offset:48,format:'float32x4'},{shaderLocation:4,offset:64,format:'float32x4'}]:[{shaderLocation:0,offset:0,format:'float32x3'}]}]},fragment:{module,entryPoint:'fragment',targets:[]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less-equal'}});this.pipelines.set(key,pipeline);}
    const identity=p.primitive??p.index;let records=this.draws.get(p.node);if(!records){records=new Map();this.draws.set(p.node,records);}let record=records.get(identity);
    if(!record||record.vertex!==p.vertex||record.pipeline!==pipeline||record.alpha!==p.alphaTexture||record.sampler!==p.alphaSampler){
      if(record)this.destroyDraw(record);records.delete(identity);
      record={faces:new Map(),values:new Float32Array(transform?44:36),vertex:p.vertex,pipeline,alpha:p.alphaTexture,sampler:p.alphaSampler,epoch:this.epoch};records.set(identity,record);
    }
    let face=record.faces.get(layer);
    if(!face){const uniform=this.device!.createBuffer({size:record.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      try{face={uniform,group:this.device!.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:p.alphaTexture??this.whiteView!},{binding:2,resource:p.alphaSampler??this.alphaSampler!}]})};record.faces.set(layer,face);}catch(error){uniform.destroy();throw error;}
    }
    record.epoch=this.epoch;record.values.set(this.matrices[layer]);record.values.set(p.node.matrix,16);record.values[32]=p.alpha??1;record.values[33]=p.cutoff??0;record.values[34]=p.texCoord??0;if(transform)record.values.set(transform,36);
    this.device!.queue.writeBuffer(face.uniform,0,record.values as Float32Array<ArrayBuffer>);pass.setPipeline(pipeline);pass.setBindGroup(0,face.group);pass.setVertexBuffer(0,p.vertex);pass.setIndexBuffer(p.index,'uint32');pass.drawIndexed(p.count);
  }
  private destroyDraw(record:Draw):void {for(const face of record.faces.values())face.uniform.destroy();}
  private clearDraws():void {for(const records of this.draws.values())for(const record of records.values())this.destroyDraw(record);this.draws.clear();}
  private sweepDraws():void {for(const [node,records] of this.draws){for(const [index,record] of records){if(record.epoch!==this.epoch){this.destroyDraw(record);records.delete(index);}else for(const [layer,face] of record.faces)if(!this.activeLayers.includes(layer)){face.uniform.destroy();record.faces.delete(layer);}}if(!records.size)this.draws.delete(node);}}
  release():void {this.clearDraws();this.depth?.destroy();this.white?.destroy();this.uniform?.destroy();this.depth=this.white=undefined;this.whiteView=undefined;this.uniform=undefined;this.alphaSampler=undefined;this.entries=[];this.views=[];this.pipelines.clear();this.device=undefined;}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.release();this.sources.length=0;this.engine=undefined;}
}

// Kept in this optional package so local shadows never add a dependency to core or stage.
function depthShader(pbr:boolean,transformed:boolean):string {return /* wgsl */`
struct LocalDepthFrame {camera:mat4x4f,model:mat4x4f,alpha:vec4f${transformed?',alphaUV0:vec4f,alphaUV1:vec4f':''}}
@group(0) @binding(0) var<uniform> localDepth:LocalDepthFrame;
@group(0) @binding(1) var localAlphaMap:texture_2d<f32>;
@group(0) @binding(2) var localAlphaSampler:sampler;
struct LocalDepthIn {@location(0) position:${pbr?'vec4f':'vec3f'},${pbr?'@location(3) uv:vec4f,@location(4) color:vec4f':''}}
struct LocalDepthOut {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:LocalDepthIn)->LocalDepthOut {var o:LocalDepthOut;o.clip=localDepth.camera*localDepth.model*vec4f(i.position.xyz,1);${pbr?'o.uv=select(i.uv.xy,i.uv.zw,localDepth.alpha.z>0.5);o.alpha=i.color.a;':'o.uv=vec2f(0);o.alpha=1;'}${transformed?'let sourceUV=o.uv;o.uv=vec2f(dot(localDepth.alphaUV0.xy,sourceUV)+localDepth.alphaUV0.z,dot(localDepth.alphaUV1.xy,sourceUV)+localDepth.alphaUV1.z);':''}return o;}
@fragment fn fragment(i:LocalDepthOut){if(textureSampleLevel(localAlphaMap,localAlphaSampler,i.uv,0).a*localDepth.alpha.x*i.alpha<localDepth.alpha.y){discard;}}
`;}
