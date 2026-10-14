/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel,Mesh as MeshHandle} from '@margoengine/core';
import {engineRuntime,meshRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type Mesh} from '@margoengine/core/extension';
import {instanceLayout,instancedDepth} from '../../shared/instances.js';
import type {Clustered,ClusteredShadow} from './index.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;COPY_DST:number};
declare const GPUShaderStage:{VERTEX:number;FRAGMENT:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface LocalShadowOptions {
  /** The clustered lights whose `castShadow` lights get shadow maps. */
  lights:Clustered;
  /** Shadowed lights with maps (1-16, default 4); further `castShadow` lights stay unshadowed. A point light uses six layers, a spot light one. */
  maxLights?:number;
  /** Square size of each layer in texels (default 512). */
  resolution?:number;
  /** Receiver offset toward the light, in shadow-map texels at the receiver (default 1). */
  bias?:number;
  /** Receiver offset along its normal, in shadow-map texels at the receiver (default 1.5). */
  normalBias?:number;
}
/** A caster primitive: gltf-pro `shadowPrimitives` (80-byte vertices, optional alpha mask and `PBRInstances`). */
export interface LocalShadowPrimitive {node:Mesh;vertex:GPUBuffer;index:GPUBuffer;count:number;stride:number;alphaTexture?:GPUTextureView;alphaSampler?:GPUSampler;alpha?:number;cutoff?:number;texCoord?:number;instances?:{readonly count:number;readonly needsUpdate?:boolean;upload(device:GPUDevice):GPUBuffer}}
export interface LocalShadowSource {readonly shadowPrimitives:readonly LocalShadowPrimitive[];readonly shadowVersion?:number;readonly disposed?:boolean}
interface Source {source:LocalShadowSource|Mesh;dynamic:boolean;version?:number;mesh?:LocalShadowPrimitive[]}
interface Draw {uniform:GPUBuffer;group:GPUBindGroup;vertex:GPUBuffer;index:GPUBuffer;alpha?:GPUTextureView;sampler?:GPUSampler;matrix:Float32Array;values:Float32Array;visible:boolean;count:number;instances:number;seen:boolean;p?:LocalShadowPrimitive;key:string}
const MAX_LIGHTS=16,LAYERS=MAX_LIGHTS*6,FRAME_FLOATS=4+MAX_LIGHTS*4+LAYERS*16,SLOT_FLOATS=12;
// Reversed depth (near 1, far 0) for float precision. lights[k]: first layer, point (1) or spot (0), texel size per unit distance.
// A point light picks the cube face by the major axis of the offset receiver, so faces need no seam filtering.
const sampling=(group:number)=>/* wgsl */`
struct LocalShadowFrame {settings:vec4f,lights:array<vec4f,${MAX_LIGHTS}>,matrices:array<mat4x4f,${LAYERS}>}
@group(${group}) @binding(14) var<uniform> localShadowFrame:LocalShadowFrame;
@group(${group}) @binding(15) var localShadowMap:texture_depth_2d_array;
@group(${group}) @binding(16) var localShadowSampler:sampler_comparison;
fn clusterShadow(light:ClusterLight,position:vec3f,n:vec3f)->f32 {
  let slot=u32(light.params.z);if(slot==0u||f32(slot)>localShadowFrame.settings.x){return 1.0;}
  let info=localShadowFrame.lights[slot-1u];let delta=light.positionRange.xyz-position;let distance=length(delta);
  let texel=info.z*distance;let p=position+n*(texel*localShadowFrame.settings.z)+delta/max(distance,0.0001)*(texel*localShadowFrame.settings.y);
  var layer=u32(info.x);
  if(info.y>0.5){let d=p-light.positionRange.xyz;let a=abs(d);
    if(a.x>=a.y&&a.x>=a.z){layer+=select(1u,0u,d.x>0);}else if(a.y>=a.z){layer+=select(3u,2u,d.y>0);}else{layer+=select(5u,4u,d.z>0);}}
  let clip=localShadowFrame.matrices[layer]*vec4f(p,1);if(clip.w<=0){return 1.0;}
  let ndc=clip.xyz/clip.w;let uv=ndc.xy*vec2f(0.5,-0.5)+0.5;if(any(uv<vec2f(0))||any(uv>vec2f(1))||ndc.z<=0){return 1.0;}
  var lit=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){lit+=textureSampleCompareLevel(localShadowMap,localShadowSampler,uv+vec2f(f32(x),f32(y))*localShadowFrame.settings.w,i32(layer),ndc.z);}}
  return lit/9.0;
}
`;
// Same text shape as @margoengine/shadows' depth shader, so shared/instances.js instancedDepth applies.
const depth=(pbr:boolean)=>/* wgsl */`
@group(0) @binding(0) var<uniform> camera:mat4x4f;
struct Frame {model:mat4x4f,alpha:vec4f}
@group(1) @binding(0) var<uniform> f:Frame;
@group(1) @binding(1) var alphaMap:texture_2d<f32>;
@group(1) @binding(2) var alphaSampler:sampler;
struct In {@location(0) position:${pbr?'vec4f,@location(3) uv:vec4f,@location(4) color:vec4f':'vec3f'}}
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:In)->Out {var o:Out;o.clip=camera*f.model*vec4f(i.position.xyz,1);${pbr?'o.uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);o.alpha=i.color.a;':'o.uv=vec2f(0);o.alpha=1;'}return o;}
@fragment fn fragment(i:Out){if(textureSampleLevel(alphaMap,alphaSampler,i.uv,0).a*f.alpha.x*i.alpha<f.alpha.y){discard;}}
`;
const axes=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as const;
/** Reversed-depth perspective view-projection looking along unit `f` from `e` (column-major, into `out` at `o`). */
function lightMatrix(out:Float32Array,o:number,e:ArrayLike<number>,f:ArrayLike<number>,tan:number,near:number,far:number):void {
  const up=Math.abs(f[1])>0.9?[1,0,0]:[0,1,0];let r=[f[1]*up[2]-f[2]*up[1],f[2]*up[0]-f[0]*up[2],f[0]*up[1]-f[1]*up[0]];const length=Math.hypot(...r);r=r.map(v=>v/length);
  const u=[r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]],k=near/(far-near),dot=(a:ArrayLike<number>)=>a[0]*e[0]+a[1]*e[1]+a[2]*e[2];
  for(let c=0;c<3;c++){out[o+c*4]=r[c]/tan;out[o+c*4+1]=u[c]/tan;out[o+c*4+2]=-k*f[c];out[o+c*4+3]=f[c];}
  out[o+12]=-dot(r)/tan;out[o+13]=-dot(u)/tan;out[o+14]=k*far+k*dot(f);out[o+15]=-dot(f);
}
/**
 * Shadows for clustered point lights (six cube faces) and spot lights (one perspective map) in one depth texture array.
 * Lights with `castShadow` take slots in list order up to `maxLights`. Maps re-render only when their light changes or a
 * caster moves, shows/hides, changes instances or `shadowVersion`, or was added with `{dynamic:true}`.
 */
export class LocalShadows implements EnginePlugin,ClusteredShadow {
  readonly name='clustered:shadows';readonly lights:Clustered;
  /** Last frame: layers re-rendered, caster draws, frames that re-rendered nothing. */
  readonly stats={layers:0,draws:0,cacheHits:0};
  private engine?:Engine;private device?:GPUDevice;private frame?:GPUBuffer;private cameras?:GPUBuffer;private map?:GPUTexture;private white?:GPUTexture;private whiteView?:GPUTextureView;
  private sampler?:GPUSampler;private alphaSampler?:GPUSampler;private cameraLayout?:GPUBindGroupLayout;private drawLayout?:GPUBindGroupLayout;private cameraGroup?:GPUBindGroup;
  private layerViews:GPUTextureView[]=[];private entries:GPUBindGroupEntry[]=[];private pipelines=new Map<string,GPURenderPipeline>();private draws=new Map<Mesh,Map<GPUBuffer,Draw>>();private sources:Source[]=[];
  private readonly values=new Float32Array(FRAME_FLOATS);private readonly matrices=new Float32Array(LAYERS*64);private readonly slots=new Float32Array(MAX_LIGHTS*SLOT_FLOATS).fill(NaN);
  private readonly dirtyLayers=new Uint8Array(LAYERS);private readonly bases=new Int32Array(MAX_LIGHTS);private readonly list:Draw[]=[];private layers=0;private changed=true;private disposed=false;
  private readonly depthAttachment:GPURenderPassDepthStencilAttachment={view:undefined!,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'};
  private readonly depthPass:GPURenderPassDescriptor={colorAttachments:[],depthStencilAttachment:this.depthAttachment};
  private readonly offset=[0];
  constructor(readonly options:LocalShadowOptions) {if(!options?.lights||typeof options.lights.setLights!=='function')throw new TypeError('LocalShadows needs the Clustered lights');this.lights=options.lights;this.validate();}
  get owner():Engine|undefined {return this.engine;}
  static attach(instance:EngineKernel,options:LocalShadowOptions):LocalShadows {const effect=new LocalShadows(options);engineRuntime(instance).use(effect);return effect;}
  private validate():void {const o=this.options,max=o.maxLights??4,size=o.resolution??512;
    if(!Number.isInteger(max)||max<1||max>MAX_LIGHTS||!Number.isInteger(size)||size<16||[o.bias??1,o.normalBias??1.5].some(v=>!Number.isFinite(Math.fround(v))||v<0))throw new RangeError('Invalid local shadow options');
  }
  /** Adds a caster: a core mesh, or a gltf-pro model / materials mesh (`shadowPrimitives`). `dynamic` re-renders its lights every frame (skinned or morphing geometry). */
  add(source:LocalShadowSource|MeshHandle,{dynamic=false}:{dynamic?:boolean}={}):()=>void {
    if(this.disposed||!source||typeof dynamic!=='boolean')throw new TypeError('Invalid shadow caster');
    if('disposed' in source&&source.disposed)throw new Error('Shadow caster is disposed');
    const runtime='id' in source?meshRuntime(source as MeshHandle):source as LocalShadowSource;
    if('id' in runtime){runtime.check();if(this.engine&&runtime.engine!==this.engine)throw new Error('Shadow mesh belongs to another engine');}
    else if(!('shadowPrimitives' in runtime))throw new TypeError('Invalid shadow caster');
    if(this.sources.some(r=>r.source===runtime))throw new Error('Duplicate shadow caster');
    const r:Source={source:runtime,dynamic};this.sources.push(r);this.invalidate();
    return()=>{const index=this.sources.indexOf(r);if(index>=0){this.sources.splice(index,1);this.invalidate();}};
  }
  /** Re-renders every shadow map next frame. */
  invalidate():void {this.changed=true;}
  /** @internal ClusteredShadow: WGSL for the light loop. */
  declarations(group:number):string {return sampling(group);}
  /** @internal ClusteredShadow: bindings 14-16 of the lit shader's group. */
  bindings():GPUBindGroupEntry[] {if(!this.frame||this.disposed)throw new Error('Local shadows are not attached');return this.entries;}
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('Local shadows require WebGPU and a live effect');this.validate();this.engine=engine;const device=this.device=engine.gpu;
    if((this.options.resolution??512)>device.limits.maxTextureDimension2D)throw new RangeError('Shadow map exceeds device limit');
    for(const r of this.sources)if('id' in r.source&&r.source.engine!==engine)throw new Error('Shadow mesh belongs to another engine');
    this.frame=device.createBuffer({size:FRAME_FLOATS*4,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.cameras=device.createBuffer({size:LAYERS*256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.sampler=device.createSampler({compare:'greater-equal',magFilter:'linear',minFilter:'linear'});this.alphaSampler=device.createSampler();
    this.white=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture:this.white},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);this.whiteView=this.white.createView();
    const V=GPUShaderStage.VERTEX,F=GPUShaderStage.FRAGMENT;
    this.cameraLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:V,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:64}}]});
    this.drawLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:V|F,buffer:{type:'uniform'}},{binding:1,visibility:F,texture:{sampleType:'float'}},{binding:2,visibility:F,sampler:{type:'filtering'}}]});
    this.cameraGroup=device.createBindGroup({layout:this.cameraLayout,entries:[{binding:0,resource:{buffer:this.cameras,size:64}}]});
    this.allocate(1);this.lights.shadow=this;
  }
  private allocate(layers:number):void {
    this.map?.destroy();const size=this.options.resolution??512;this.layers=layers;
    this.map=this.device!.createTexture({size:[size,size,layers],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    this.layerViews=Array.from({length:layers},(_,baseArrayLayer)=>this.map!.createView({dimension:'2d',baseArrayLayer,arrayLayerCount:1}));
    this.entries=[{binding:14,resource:{buffer:this.frame!}},{binding:15,resource:this.map.createView({dimension:'2d-array'})},{binding:16,resource:this.sampler!}];this.changed=true;
  }
  // Runs after skinning (-10) and before directional shadows (-5), which upload pending instance rows.
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:-5.5,execute:c=>{if(c.backend==='webgpu')this.render(c);}});}
  private render(c:Context):void {
    this.validate();const o=this.options,size=o.resolution??512,max=o.maxLights??4,data=this.lights['data'],count=this.lights['lightCount'],slots=this.slots,values=this.values;
    // Slots from the clustered list: params.z is the 1-based shadow ordinal.
    let used=0,layers=0;const bases=this.bases.fill(0);
    for(let j=0;j<count;j++){const at=j*16,slot=data[at+14]-1;if(slot<0||slot>=max)continue;used=Math.max(used,slot+1);
      const point=data[at+13]<0.5;bases[slot]=point?6:1;}
    for(let s=0;s<used;s++){const n=bases[s];bases[s]=layers;layers+=n;}
    for(let s=used;s<MAX_LIGHTS;s++)slots[s*SLOT_FLOATS+11]=NaN;
    if(layers>this.layers)this.allocate(layers);
    for(let j=0;j<count;j++){const at=j*16,slot=data[at+14]-1;if(slot<0||slot>=max)continue;
      const point=data[at+13]<0.5,base=bases[slot],range=data[at+3],s=slot*SLOT_FLOATS;
      let same=slots[s+11]===base&&slots[s+10]===(point?1:0);for(let k=0;k<8;k++)if(slots[s+k]!==data[at+(k<4?k:k+4)])same=false;if(slots[s+8]!==size)same=false;
      if(same&&!this.changed)continue;
      for(let k=0;k<8;k++)slots[s+k]=data[at+(k<4?k:k+4)];slots[s+8]=size;slots[s+10]=point?1:0;slots[s+11]=base;
      // Two texels of margin per side keep the 3x3 filter inside a cube face; the spot frustum covers the outer cone.
      const margin=size/(size-4),cos=data[at+11],tan=(point?1:Math.sqrt(1-cos*cos)/cos)*margin,near=range*1e-3;
      values[4+slot*4]=base;values[5+slot*4]=point?1:0;values[6+slot*4]=2*tan/size;
      for(let face=0;face<(point?6:1);face++){lightMatrix(this.matrices,(base+face)*64,data.subarray(at,at+3),point?axes[face]:data.subarray(at+8,at+11),tan,near,range);this.dirtyLayers[base+face]=1;}
    }
    values[0]=used;values[1]=o.bias??1;values[2]=o.normalBias??1.5;values[3]=1/size;
    for(let l=0;l<layers;l++)values.set(this.matrices.subarray(l*64,l*64+16),4+MAX_LIGHTS*4+l*16);
    c.device.queue.writeBuffer(this.frame!,0,values as Float32Array<ArrayBuffer>,0,4+MAX_LIGHTS*4+layers*16);
    // Casters: any change re-renders every layer (ponytail: per-light caster bounds would limit it to the lights it reaches).
    const engine=this.engine!;let casters=this.changed;
    for(const records of this.draws.values())for(const d of records.values())d.seen=false;
    const list=this.list;list.length=0;
    for(let i=this.sources.length-1;i>=0;i--){const r=this.sources[i];if('disposed' in r.source&&r.source.disposed||'id' in r.source&&engine.meshes.get(r.source.id)!==r.source){this.sources.splice(i,1);casters=true;}}
    for(const r of this.sources){
      if(r.dynamic)casters=true;
      let primitives:readonly LocalShadowPrimitive[];
      if('id' in r.source){const node=r.source;const buffers=node.geometry&&engine.geometryBuffers(node.geometry);if(!buffers)continue;
        const p=(r.mesh??=[{node,vertex:buffers.vertex,index:buffers.index,count:0,stride:24}])[0];p.vertex=buffers.vertex;p.index=buffers.index;p.count=node.geometry!.indices.length;primitives=r.mesh;}
      else{primitives=r.source.shadowPrimitives;if(r.version!==r.source.shadowVersion){r.version=r.source.shadowVersion;casters=true;}}
      for(const p of primitives){const node=p.node;node.check();if(node.engine!==engine)throw new Error('Shadow caster belongs to another engine');
        let visible=true;for(let id=node.id;id!==-1;id=engine.store.parents[id])if(engine.store.hidden[id])visible=false;
        const inst=p.instances,d=this.record(p);d.seen=true;d.p=p;
        let moved=d.visible!==visible||d.count!==p.count||(inst?inst.count!==d.instances||!!inst.needsUpdate:false);for(let k=0;k<16;k++)if(d.matrix[k]!==node.matrix[k])moved=true;
        if(moved){casters=true;d.matrix.set(node.matrix);d.visible=visible;d.count=p.count;d.instances=inst?.count??0;}
        if(visible&&p.count&&(!inst||inst.count))list.push(d);
      }
    }
    for(const [node,records] of this.draws){for(const [index,d] of records)if(!d.seen){d.uniform.destroy();records.delete(index);casters=true;}if(!records.size)this.draws.delete(node);}
    if(casters)this.dirtyLayers.fill(1,0,layers);
    this.changed=false;this.stats.layers=this.stats.draws=0;
    let any=false;for(let l=0;l<layers;l++)if(this.dirtyLayers[l])any=true;
    if(!any){this.stats.cacheHits++;return;}
    c.device.queue.writeBuffer(this.cameras!,0,this.matrices as Float32Array<ArrayBuffer>,0,layers*64);
    for(const d of list){const p=d.p!;d.values.set(p.node.matrix);d.values[16]=p.alpha??1;d.values[17]=p.cutoff??0;d.values[18]=p.texCoord??0;c.device.queue.writeBuffer(d.uniform,0,d.values as Float32Array<ArrayBuffer>);}
    for(let l=0;l<layers;l++){if(!this.dirtyLayers[l])continue;this.dirtyLayers[l]=0;this.stats.layers++;
      this.depthAttachment.view=this.layerViews[l];const pass=c.encoder.beginRenderPass(this.depthPass);this.offset[0]=l*256;
      try{pass.setBindGroup(0,this.cameraGroup!,this.offset);
        for(const d of list){const p=d.p!;pass.setPipeline(this.pipeline(d.key));pass.setBindGroup(1,d.group);pass.setVertexBuffer(0,p.vertex);pass.setIndexBuffer(p.index,'uint32');
          if(p.instances){pass.setVertexBuffer(1,p.instances.upload(c.device));pass.drawIndexed(p.count,p.instances.count);}else pass.drawIndexed(p.count);this.stats.draws++;}
      }catch(error){try{pass.end();}catch{}throw error;}pass.end();
    }
  }
  private record(p:LocalShadowPrimitive):Draw {
    if(![24,80].includes(p.stride)||p.instances&&p.stride!==80)throw new RangeError('Unsupported shadow caster vertex stride');
    let records=this.draws.get(p.node);if(!records)this.draws.set(p.node,records=new Map());let d=records.get(p.index);
    if(!d||d.vertex!==p.vertex||d.alpha!==p.alphaTexture||d.sampler!==p.alphaSampler||d.key.includes('i')!==!!p.instances||d.key.includes('m')!==(p.cutoff??0)>0){
      d?.uniform.destroy();const uniform=this.device!.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      try{const group=this.device!.createBindGroup({layout:this.drawLayout!,entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:p.alphaTexture??this.whiteView!},{binding:2,resource:p.alphaSampler??this.alphaSampler!}]});
        d={uniform,group,vertex:p.vertex,index:p.index,alpha:p.alphaTexture,sampler:p.alphaSampler,matrix:new Float32Array(16).fill(NaN),values:new Float32Array(20),visible:false,count:-1,instances:-1,seen:true,key:`${p.stride}${p.instances?'i':''}${(p.cutoff??0)>0?'m':''}`};records.set(p.index,d);this.changed=true;
      }catch(error){uniform.destroy();throw error;}
    }
    return d;
  }
  private pipeline(key:string):GPURenderPipeline {
    let pipeline=this.pipelines.get(key);if(pipeline)return pipeline;
    const pbr=key.startsWith('80'),code=depth(pbr),module=this.device!.createShaderModule({code:key.includes('i')?instancedDepth(code):code});
    pipeline=this.device!.createRenderPipeline({layout:this.device!.createPipelineLayout({bindGroupLayouts:[this.cameraLayout!,this.drawLayout!]}),
      vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:pbr?80:24,attributes:pbr?[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:3,offset:48,format:'float32x4'},{shaderLocation:4,offset:64,format:'float32x4'}]:[{shaderLocation:0,offset:0,format:'float32x3'}]},...key.includes('i')?[instanceLayout as GPUVertexBufferLayout]:[]]},
      // Opaque casters need no fragment stage, which keeps early depth testing.
      ...key.includes('m')?{fragment:{module,entryPoint:'fragment',targets:[]}}:{},
      depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'}});
    this.pipelines.set(key,pipeline);return pipeline;
  }
  private release():void {
    if(this.lights.shadow===this)this.lights.shadow=undefined;
    for(const records of this.draws.values())for(const d of records.values())d.uniform.destroy();this.draws.clear();
    for(const resource of [this.map,this.white,this.frame,this.cameras])resource?.destroy();
    this.map=this.white=this.frame=this.cameras=undefined;this.whiteView=this.sampler=this.alphaSampler=this.cameraLayout=this.drawLayout=this.cameraGroup=undefined;
    this.layerViews=[];this.entries=[];this.pipelines.clear();this.layers=0;this.slots.fill(NaN);this.changed=true;
  }
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.sources.length=0;this.release();this.engine=this.device=undefined;}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
