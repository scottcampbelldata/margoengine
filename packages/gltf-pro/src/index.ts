import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext, type Mesh} from '@margoengine/core/extension';
import {invert} from '../../shared/math.js';
import {viewMatrix} from '../../shared/view.js';
import {Cleanup} from '../../shared/cleanup.js';
import type {PBRSource} from '../../shared/pbr-source.js';
import {setMeshSource,clearMeshSource,type MeshSource} from '../../shared/mesh-source.js';
import {GLTFAsset, container, loadAsset, entry, integer, assetLimit, textureSource, decodeKTX2Images, type GLTFImage} from './asset.js';
import {createKTX2Texture} from '@margoengine/decoders';
import {pbrShader} from './shader.js';
import {mipShader} from './mip.js';
import {prepareMaterialExtension, materialExtensionShader, materialExtensionAmbientShader, bindMaterialExtension, type MaterialExtension, type MaterialExtensionResource} from './material-extension.js';
import {compressedIndices, decompressPrimitives, type GLTFLoadOptions} from './compression.js';
import {textureCoordinates, coordinateExtension, coordinateShader, type CoordinateExtension} from './texture-coordinates.js';
import {deviceRenderer,type PBRDeviceRenderer,type PBRDeformationRenderer} from './replica.js';
export type {PBRDeviceRenderer,PBRDeformationRenderer} from './replica.js';
export {GLTFAsset} from './asset.js';
export type {GLTFDocument} from './asset.js';
export type {GLTFImage, KTX2Image} from './asset.js';
export {textureCoordinates} from './texture-coordinates.js';
export type {TextureTransform} from './texture-coordinates.js';
export type {GLTFLoadOptions} from './compression.js';
export type {MaterialExtension, MaterialExtensionTexture} from './material-extension.js';
declare const GPUBufferUsage: {UNIFORM:number;STORAGE:number;VERTEX:number;INDEX:number;COPY_DST:number;COPY_SRC:number;MAP_READ:number};
declare const GPUMapMode:{READ:number};
declare const GPUTextureUsage: {TEXTURE_BINDING:number;COPY_DST:number;RENDER_ATTACHMENT:number};
type Context = Extract<PassContext,{backend:'webgpu'}>;
/** Narrow encoding hook for optional GPU deformation consumers. */
export type PBRDeformationContext=Pick<Context,'backend'|'device'|'encoder'>;
export interface PBRPickingGeometry {node:Mesh;vertices:Float32Array;indices:Uint32Array;doubleSided:boolean;matrix:Float32Array}
const opaquePasses=new WeakMap<Context,Set<PBRModel>>();
// A symbol keeps separately bundled optional consumers interoperable without
// importing the loader or attaching a second drawable core Geometry.
const cpuSource=Symbol.for('margoengine.pbr-source.v1');
export interface PBRMaterial {
  [key:string]:any;
  base:number[];factors:number[];emission:number[];settings:number[];maps:any[];
  extension?:MaterialExtension;
}
export interface PBRPrimitive {
  node: Mesh; nodeIndex: number; vertices: Float32Array; indices: Uint32Array;
  definition: any; material: PBRMaterial; weights: Float32Array; targetNames: string[];
  /** Overrides the material's shared extension when supplied. Attach after loading. */
  extension?:MaterialExtension;
  deformed?: GPUBuffer;
}
export interface PreparedGeometry {vertices:Float32Array;indices:Uint32Array}
export function validatePreparedGeometry(data:PreparedGeometry):void {
  const {vertices,indices}=data,count=vertices?.length/20;
  if(!(vertices instanceof Float32Array)||!(indices instanceof Uint32Array)||!Number.isInteger(count)||count<3||count>1_000_000||!indices.length||indices.length%3||indices.some(i=>i>=count))throw new RangeError('Invalid prepared PBR geometry');
  if(vertices.some(v=>!Number.isFinite(v)))throw new RangeError('Non-finite prepared PBR vertex');
  for(let i=0;i<vertices.length;i+=20){
    if(vertices[i+3]!==1||vertices[i+7]!==0||Math.abs(Math.hypot(vertices[i+4],vertices[i+5],vertices[i+6])-1)>1e-3||![0,-1,1].includes(vertices[i+11]))throw new RangeError('Invalid prepared PBR normal/tangent');
    if(vertices[i+11]&&Math.abs(Math.hypot(vertices[i+8],vertices[i+9],vertices[i+10])-1)>1e-3)throw new RangeError('Invalid prepared PBR tangent');
    for(let c=16;c<20;c++)if(vertices[i+c]<0||vertices[i+c]>1)throw new RangeError('Invalid prepared PBR color');
  }
}
function preparedPrimitive(asset:GLTFAsset,p:any,data:PreparedGeometry,node:Mesh,nodeIndex:number,materials:any[],checked:Set<PreparedGeometry>):PBRPrimitive {
  if(!checked.has(data)){validatePreparedGeometry(data);checked.add(data);}
  const {vertices,indices}=data;
  if((p.mode??4)!==4||p.targets||p.extensions)throw new TypeError('Prepared PBR requires static triangles');
  const m=p.material===undefined?material():materials[integer(p.material,'material')];if(!m)throw new TypeError('Missing prepared PBR material');
  for(const map of m.maps)if(map){if(integer(map.texCoord??0,'texture coordinate')>1)throw new RangeError('Invalid prepared PBR UV set');entry(asset.doc.textures,map.index,'texture');}
  return {node,nodeIndex,vertices,indices,definition:p,material:m,weights:new Float32Array(0),targetNames:[]};
}
interface DrawResource {primitive:PBRPrimitive;vertex:GPUBuffer;index:GPUBuffer;uniform:GPUBuffer;values:Float32Array;groups:Map<GPURenderPipeline,[GPUBindGroup,GPUBindGroup]>;views:GPUTextureView[];samplers:GPUSampler[];extension?:MaterialExtensionResource;coordinates?:CoordinateExtension}
export interface LightingEffect {readonly owner?:Engine;shader(source:string,group:number):string;bindings():GPUBindGroupEntry[]}
let modelId = 0;
const vector = (value:any, size:number, label:string, min=-Infinity, max=Infinity):number[] => {
  if (!Array.isArray(value) || value.length !== size || value.some(v=>typeof v!=='number'||!Number.isFinite(Math.fround(v))||v<min||v>max)) throw new TypeError('Invalid glTF '+label);
  return value;
};
function material(def:any = {}): PBRMaterial {
  const p=def.pbrMetallicRoughness??{}, alpha=def.alphaMode??'OPAQUE';
  if (!['OPAQUE','MASK','BLEND'].includes(alpha)) throw new TypeError('Invalid glTF alpha mode');
  if (def.doubleSided!==undefined&&typeof def.doubleSided!=='boolean') throw new TypeError('Invalid glTF doubleSided');
  const scalar=(v:any,min:number,max:number,label:string)=>vector([v],1,label,min,max)[0];
  return {...def,base:vector(p.baseColorFactor??[1,1,1,1],4,'base color',0,1),
    factors:[scalar(p.roughnessFactor??1,0,1,'roughness'),scalar(p.metallicFactor??1,0,1,'metallic'),scalar(def.normalTexture?.scale??1,-Infinity,Infinity,'normal scale'),scalar(def.occlusionTexture?.strength??1,0,1,'occlusion strength')],
    emission:vector(def.emissiveFactor??[0,0,0],3,'emissive',0,1),
    settings:[['OPAQUE','MASK','BLEND'].indexOf(alpha),scalar(def.alphaCutoff??0.5,0,Infinity,'alpha cutoff'),+(def.doubleSided??false),0],
    maps:[p.baseColorTexture,p.metallicRoughnessTexture,def.normalTexture,def.occlusionTexture,def.emissiveTexture].map(map=>map?.extensions?.KHR_texture_transform===undefined?map:{...map,texCoord:textureCoordinates(map).texCoord})};
}
function primitive(asset:GLTFAsset, p:any, node:Mesh, nodeIndex:number, mesh:any, materials:any[]):PBRPrimitive {
  if ((p.mode??4)!==4) throw new Error('PBR requires triangle primitives');
  const dracoIndices=compressedIndices(asset,p);
  const a=p.attributes??{}, positions=asset.accessor(a.POSITION,'VEC3'), count=positions.length/3;
  if(count<3)throw new RangeError('Expected bounded triangle geometry');
  for(const key of ['POSITION','NORMAL','TANGENT'])if(a[key]!==undefined){const def=entry(asset.doc.accessors,a[key],'attribute');if(def.componentType!==5126||def.normalized)throw new TypeError('Expected Float32 '+key);}
  for(const key of ['TEXCOORD_0','TEXCOORD_1','COLOR_0'])if(a[key]!==undefined){const def=entry(asset.doc.accessors,a[key],'attribute');if(![5126,5121,5123].includes(def.componentType)||def.componentType!==5126&&!def.normalized)throw new TypeError('Invalid normalized '+key);}
  let normals=a.NORMAL===undefined?new Float32Array(positions.length):asset.accessor(a.NORMAL,'VEC3');
  const indexValues=dracoIndices??(p.indices===undefined?null:asset.accessor(p.indices,'SCALAR'));
  if(indexValues?.some(i=>!Number.isInteger(i)||i<0||i>=count))throw new RangeError('Invalid glTF triangle indices');
  const indices=indexValues?Uint32Array.from(indexValues):Uint32Array.from({length:count},(_,i)=>i);
  if (!indices.length||indices.length%3||indices.some(i=>i>=count)) throw new RangeError('Invalid glTF triangle indices');
  if (p.indices!==undefined && (![5121,5123,5125].includes(entry(asset.doc.accessors,p.indices,'indices').componentType)||asset.doc.accessors[p.indices].normalized)) throw new TypeError('Invalid index component type');
  if (a.NORMAL===undefined) for (let i=0;i<indices.length;i+=3) {
    const x=indices[i]*3,y=indices[i+1]*3,z=indices[i+2]*3;
    const u=[positions[y]-positions[x],positions[y+1]-positions[x+1],positions[y+2]-positions[x+2]],v=[positions[z]-positions[x],positions[z+1]-positions[x+1],positions[z+2]-positions[x+2]];
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    for (const at of [x,y,z]) for(let c=0;c<3;c++) normals[at+c]+=n[c];
  }
  const uv0=a.TEXCOORD_0===undefined?null:asset.accessor(a.TEXCOORD_0,'VEC2'),uv1=a.TEXCOORD_1===undefined?null:asset.accessor(a.TEXCOORD_1,'VEC2');
  const tangent=a.TANGENT===undefined?null:asset.accessor(a.TANGENT,'VEC4'), colors=a.COLOR_0===undefined?null:asset.accessor(a.COLOR_0);
  const colorWidth=colors?colors.length/count:0;
  if (normals.length!==count*3||uv0&&uv0.length!==count*2||uv1&&uv1.length!==count*2||tangent&&tangent.length!==count*4||colors&&![3,4].includes(colorWidth)) throw new RangeError('Mismatched glTF attributes');
  const m=p.material===undefined?material():materials[integer(p.material,'material')]; if(!m) throw new TypeError('Missing glTF material');
  for (const map of m.maps) if(map) {
    const set=integer(map.texCoord??0,'texture coordinate');
    if(set>1||!(set===0?uv0:uv1)) throw new Error('Material requires available TEXCOORD_0 or TEXCOORD_1');
    entry(asset.doc.textures,map.index,'texture');
  }
  const vertices=new Float32Array(count*20);
  for(let i=0;i<count;i++) {
    vertices.set(positions.subarray(i*3,i*3+3),i*20);vertices[i*20+3]=1;
    const length=Math.hypot(...normals.subarray(i*3,i*3+3));if(!length) throw new RangeError('Zero glTF normal');
    for(let c=0;c<3;c++) vertices[i*20+4+c]=normals[i*3+c]/length;
    if(tangent) vertices.set(tangent.subarray(i*4,i*4+4),i*20+8);
    if(uv0)vertices.set(uv0.subarray(i*2,i*2+2),i*20+12);if(uv1)vertices.set(uv1.subarray(i*2,i*2+2),i*20+14);
    vertices.set(colors?[...colors.subarray(i*colorWidth,i*colorWidth+colorWidth),...(colorWidth===3?[1]:[])]:[1,1,1,1],i*20+16);
  }
  const targets=p.targets??[];if(!Array.isArray(targets))throw new TypeError('Invalid morph targets');
  const weights=vector(asset.doc.nodes[nodeIndex].weights??mesh.weights??Array(targets.length).fill(0),targets.length,'morph weights');
  return {node,nodeIndex,vertices,indices,definition:p,material:m,weights:Float32Array.from(weights),targetNames:targets.map((_:unknown,i:number)=>mesh.extras?.targetNames?.[i]??'Target '+i)};
}
function transform(node:Mesh,def:any):void {
  if(def.matrix!==undefined) {
    const m=vector(def.matrix,16,'matrix');
    if(def.translation||def.rotation||def.scale||m[3]||m[7]||m[11]||m[15]!==1)throw new TypeError('Invalid glTF affine matrix');
    const scale=[Math.hypot(m[0],m[1],m[2]),Math.hypot(m[4],m[5],m[6]),Math.hypot(m[8],m[9],m[10])];
    const det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);
    scale[0]*=Math.sign(det);if(scale.some(v=>v===0))throw new RangeError('Singular glTF matrix');
    const r=Array.from({length:9},(_,i)=>m[Math.floor(i/3)*4+i%3]/scale[Math.floor(i/3)]);
    for(const [a,b] of [[0,3],[0,6],[3,6]])if(Math.abs(r[a]*r[b]+r[a+1]*r[b+1]+r[a+2]*r[b+2])>1e-5)throw new Error('Sheared matrices are unsupported');
    const trace=r[0]+r[4]+r[8];let q:number[];
    if(trace>0){const s=2*Math.sqrt(trace+1);q=[(r[5]-r[7])/s,(r[6]-r[2])/s,(r[1]-r[3])/s,s/4];}
    else {const k=r[0]>r[4]&&r[0]>r[8]?0:r[4]>r[8]?1:2,s=2*Math.sqrt(1+r[k*4]-r[((k+1)%3)*4]-r[((k+2)%3)*4]);q=[0,0,0,0];q[k]=s/4;const a=(k+1)%3,b=(k+2)%3;q[a]=(r[a*3+k]+r[k*3+a])/s;q[b]=(r[b*3+k]+r[k*3+b])/s;q[3]=(r[a*3+b]-r[b*3+a])/s;}
    node.setPosition([m[12],m[13],m[14]]).setScale(scale as [number,number,number]).setQuaternion(q);
  } else node.setPosition(def.translation??[0,0,0]).setScale(def.scale??[1,1,1]).setQuaternion(def.rotation??[0,0,0,1]);
}
export class PBRModel implements EnginePlugin {
  /** Optional scene-wide opaque phase, used by caller-owned color captures. */
  static beginOpaquePass(context:Context):void {opaquePasses.set(context,new Set());}
  static cancelOpaquePass(context:Context):void {opaquePasses.delete(context);}
  static endOpaquePass(context:Context):void {
    const models=opaquePasses.get(context);opaquePasses.delete(context);
    for(const model of models??[])model.draw(context,'beauty',context.color,context.depth,'blend');
  }
  readonly name='gltf-pro:'+modelId++;
  readonly root:Mesh;readonly nodes:Mesh[]=[];readonly primitives:PBRPrimitive[]=[];
  /** Installed by optional deformation packages; does not advance animation time. */
  prepareDeformation?: (context:PBRDeformationContext)=>void;
  /** Optional isolated deformation kernels for another rendering device. */
  createDeformationRenderer?: (model:PBRModel,device:GPUDevice)=>PBRDeformationRenderer;
  disposed=false;private readonly created:Mesh[]=[];private resources:DrawResource[]=[];private textures:GPUTexture[]=[];
  private pipelines=new Map<string,GPURenderPipeline>();private readonly inverse=new Float32Array(16);private readonly workspace=new Float64Array(52);private readonly view=new Float32Array(16);
  private engine:Engine;private readonly cleanupCallbacks=new Set<()=>void>();
  private readonly lighting=new Set<LightingEffect>();
  private readonly lightingGroups=new Map<GPURenderPipeline,{entries:GPUBindGroupEntry[];group:GPUBindGroup}>();
  private gpuRevision=0;
  constructor(instance:EngineKernel,readonly asset:GLTFAsset,private readonly images:readonly GLTFImage[]=[],prepared?:readonly (readonly PreparedGeometry[])[]) {
    this.engine=engineRuntime(instance);
    const doc=asset.doc,defs=doc.nodes??[],parents=new Int32Array(defs.length).fill(-1),materials=(doc.materials??[]).map(material);
    defs.forEach((def:any,id:number)=>{
      if(!def||def.children!==undefined&&!Array.isArray(def.children))throw new TypeError('Invalid glTF node');
      for(const child of def.children??[]) {const c=integer(child,'child');if(c>=defs.length||parents[c]!==-1||c===id)throw new Error('Invalid glTF hierarchy');parents[c]=id;}
    });
    for(let i=0;i<defs.length;i++){let depth=0;for(let p=i;p!==-1;p=parents[p])if(++depth>62)throw new Error('glTF hierarchy cycle or depth limit');}
    const roots=doc.scenes?entry(doc.scenes,doc.scene??0,'scene').nodes??[]:defs.map((_:unknown,i:number)=>i).filter((i:number)=>parents[i]===-1);
    if(!Array.isArray(roots)||new Set(roots).size!==roots.length||roots.some((i:any)=>parents[integer(i,'scene root')]!==-1))throw new TypeError('Invalid scene roots');
    const active=new Set<number>(),visit=(id:number)=>{entry(defs,id,'node');active.add(id);for(const c of defs[id].children??[])visit(c);};for(const id of roots)visit(id);
    try {
      this.root=this.engine.createMesh();this.created.push(this.root);
      for(let i=0;i<defs.length;i++){const node=this.engine.createMesh();this.nodes.push(node);this.created.push(node);node.name=defs[i].name??'';transform(node,defs[i]);}
      for(let i=0;i<defs.length;i++)this.nodes[i].setParent(parents[i]<0?this.root:this.nodes[parents[i]]);
      let geometryBytes=0;const checked=new Set<PreparedGeometry>(),counted=new Set<Float32Array|Uint32Array>();
      for(const i of active)if(defs[i].mesh!==undefined) {
        const mesh=entry(doc.meshes,defs[i].mesh,'mesh');if(!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError('Missing primitives');
        if(prepared&&prepared[defs[i].mesh]?.length!==mesh.primitives.length)throw new TypeError('Missing prepared PBR primitives');
        for(let j=0;j<mesh.primitives.length;j++){const p=mesh.primitives[j],made=prepared?preparedPrimitive(asset,p,prepared[defs[i].mesh][j],this.nodes[i],i,materials,checked):primitive(asset,p,this.nodes[i],i,mesh,materials);for(const data of [made.vertices,made.indices])if(!counted.has(data)){geometryBytes+=data.byteLength;counted.add(data);}if(geometryBytes>assetLimit*4)throw new RangeError('Decoded glTF geometry exceeds byte budget');this.primitives.push(made);}
      }
      if(!this.primitives.length)throw new Error('glTF contains no renderable meshes');
      const source:PBRSource=this;
      for(const node of this.created)Object.defineProperty(node,cpuSource,{value:source,configurable:true});
      for(const node of new Set(this.primitives.map(p=>p.node))){
        const model=this,primitives=this.primitives.filter(p=>p.node===node);
        const source:MeshSource={model,node,primitives,stride:80,
          skinned:primitives.some(p=>doc.nodes?.[p.nodeIndex]?.skin!==undefined),morphed:primitives.some(p=>!!p.definition.targets?.length),
          get bounds(){const out=new Float32Array([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]);for(const p of primitives)for(let i=0;i<p.vertices.length;i+=20)for(let axis=0;axis<3;axis++){out[axis]=Math.min(out[axis],p.vertices[i+axis]);out[axis+3]=Math.max(out[axis+3],p.vertices[i+axis]);}return out;},
          get draws(){return model.pickingPrimitives.filter(p=>p.node===node);},
          get shadowPrimitives(){return model.shadowPrimitives.filter(p=>p.node===node);},
          prepareDeformation(context){model.prepareDeformation?.(context);},
          async readPickingGeometry(){return (await model.readPickingGeometry()).filter(p=>p.node===node);}
        };setMeshSource(node,source);
      }
    } catch(error) {for(const node of this.created.reverse()){clearMeshSource(node);Reflect.deleteProperty(node,cpuSource);node.dispose();}throw error;}
  }
  /** Current node transforms applied to bind-pose CPU positions. Does not perform GPU readback. */
  get bounds():Float32Array {
    if(this.disposed)throw new Error('PBRModel is disposed');this.engine.store.tick(false);
    const out=new Float32Array([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]);
    for(const p of this.primitives){if(this.engine.meshes.get(p.node.id)!==p.node)continue;const m=p.node.matrix,v=p.vertices;
      for(let i=0;i<v.length;i+=20)for(let axis=0;axis<3;axis++){const n=m[axis]*v[i]+m[axis+4]*v[i+1]+m[axis+8]*v[i+2]+m[axis+12];out[axis]=Math.min(out[axis],n);out[axis+3]=Math.max(out[axis+3],n);}
    }
    if(!Number.isFinite(out[0]))throw new Error('No geometry');return out;
  }
  /** Borrowed GPU buffers, preserving one record per primitive and current deformation. */
  get raw(){return this.pickingPrimitives.filter(p=>this.engine.meshes.get(p.node.id)===p.node);}
  setup(engine:Engine,device=engine.gpu):void {
    if(engine!==this.engine||this.disposed)throw new Error('PBRModel belongs to another engine or is disposed');
    if(!device)throw new Error('PBRModel requires WebGPU');
    const mipPipelines=new Map<GPUTextureFormat,GPURenderPipeline>(),mipSampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
    const imageTextures=new Map<string,GPUTexture>();
    const geometryBuffers=new Map<Float32Array|Uint32Array,GPUBuffer>();
    const upload=(data:Float32Array|Uint32Array,usage:number)=>{
      const existing=geometryBuffers.get(data);if(existing)return existing;
      if(data.byteLength>device.limits.maxBufferSize)throw new RangeError('PBR buffer exceeds device limit');
      const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
      try{device.queue.writeBuffer(b,0,data as Float32Array<ArrayBuffer>);}catch(e){b.destroy();throw e;}geometryBuffers.set(data,b);return b;
    };
    for(const p of this.primitives) {
      const r:DrawResource={primitive:p,vertex:undefined!,index:undefined!,uniform:undefined!,values:new Float32Array(100),groups:new Map(),views:[],samplers:[]};
      this.resources.push(r);r.vertex=upload(p.vertices,GPUBufferUsage.VERTEX);r.index=upload(p.indices,GPUBufferUsage.INDEX);
      r.uniform=device.createBuffer({size:400,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      for(let i=0;i<5;i++) {
        const map=p.material.maps[i],def=map?entry(this.asset.doc.textures,map.index,'texture'):null,source=def?textureSource(def):-1,image=def?this.images[source]:undefined;
        if(def&&!image)throw new TypeError('Missing decoded glTF image');
        const format=i===0||i===4?'rgba8unorm-srgb':'rgba8unorm',size=image?[image.width,image.height]:[1,1];
        if(size.some(n=>n>device.limits.maxTextureDimension2D))throw new RangeError('Image exceeds device limit');
        const key=image?source+':'+format:'default:'+i;
        let texture=imageTextures.get(key);
        if(!texture&&image&&'ktx2' in image){
          texture=this.uploadImage(source,device,i===0||i===4);this.textures.push(texture);imageTextures.set(key,texture);
        }
        if(!texture) {
          const levels=image?Math.floor(Math.log2(Math.max(...size)))+1:1;
          texture=device.createTexture({size,format,mipLevelCount:levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
          this.textures.push(texture);imageTextures.set(key,texture);
          if(image)device.queue.copyExternalImageToTexture({source:image as ImageBitmap},{texture},size);
          else device.queue.writeTexture({texture},new Uint8Array(i===2?[128,128,255,255]:[255,255,255,255]),{bytesPerRow:4},[1,1]);
          if(levels>1) {
            let pipeline=mipPipelines.get(format);
            if(!pipeline){const module=device.createShaderModule({code:mipShader});pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format}]}});mipPipelines.set(format,pipeline);}
            const encoder=device.createCommandEncoder();
            for(let level=1;level<levels;level++){
              const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView({baseMipLevel:level-1,mipLevelCount:1})},{binding:1,resource:mipSampler}]});
              const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView({baseMipLevel:level,mipLevelCount:1}),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]});
              pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
            }
            device.queue.submit([encoder.finish()]);
          }
        }
        r.views.push(texture.createView());
        const s=def?.sampler===undefined?{}:entry(this.asset.doc.samplers,def.sampler,'sampler');
        const wrap=(v:any)=>{if(v===undefined||v===10497)return 'repeat';if(v===33071)return 'clamp-to-edge';if(v===33648)return 'mirror-repeat';throw new TypeError('Invalid texture wrapping');};
        if(s.magFilter!==undefined&&![9728,9729].includes(s.magFilter)||s.minFilter!==undefined&&![9728,9729,9984,9985,9986,9987].includes(s.minFilter))throw new TypeError('Invalid texture filter');
        r.samplers.push(device.createSampler({addressModeU:wrap(s.wrapS),addressModeV:wrap(s.wrapT),magFilter:s.magFilter===9728?'nearest':'linear',minFilter:[9728,9984,9986].includes(s.minFilter)?'nearest':'linear',mipmapFilter:[9984,9985].includes(s.minFilter)?'nearest':'linear',lodMaxClamp:[9728,9729].includes(s.minFilter)?0:32}));
      }
    }
  }
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:1,execute:c=>{if(c.backend==='webgpu')this.draw(c,'beauty',c.color,c.depth);}});}
  /** Borrow a decoded image for optional material packages; the model owns its lifetime. */
  image(index:number):GLTFImage {
    if(this.disposed)throw new Error('PBRModel is disposed');
    const image=this.images[integer(index,'image')];if(!image)throw new TypeError('Missing decoded glTF image');return image;
  }
  /** Upload a retained image; the caller owns and destroys the returned texture. */
  uploadImage(index:number,device:GPUDevice,srgb=false):GPUTexture {
    const image=this.image(index);
    if('ktx2' in image){
      const format=(image.ktx2.format.replace(/-srgb$/,'')+(srgb?'-srgb':'')) as GPUTextureFormat;
      return createKTX2Texture(device,{...image.ktx2,format});
    }
    const size=[image.width,image.height],texture=device.createTexture({size,format:srgb?'rgba8unorm-srgb':'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    try{device.queue.copyExternalImageToTexture({source:image},{texture},size);return texture;}catch(error){texture.destroy();throw error;}
  }
  addLighting(effect:LightingEffect):()=>void {
    if(this.disposed||!effect||typeof effect.shader!=='function'||typeof effect.bindings!=='function')throw new TypeError('Invalid PBR lighting effect');
    if(effect.owner&&effect.owner!==this.engine)throw new Error('PBR lighting belongs to another engine');
    this.lighting.add(effect);return()=>this.lighting.delete(effect);
  }
  get shadowPrimitives() {
    return this.resources.filter(r=>r.primitive.material.settings[0]!==2).map(r=>({primitive:r.primitive,node:r.primitive.node,vertex:r.primitive.deformed??r.vertex,index:r.index,count:r.primitive.indices.length,stride:80,
      alphaTexture:r.views[0],alphaSampler:r.samplers[0],alpha:r.primitive.material.base[3],cutoff:r.primitive.material.settings[0]===1?r.primitive.material.settings[1]:0,texCoord:r.primitive.material.maps[0]?textureCoordinates(r.primitive.material.maps[0]).texCoord:0,
      ...(r.primitive.material.maps[0]?.extensions?.KHR_texture_transform?{alphaTransform:textureCoordinates(r.primitive.material.maps[0]).transform}:{})}));
  }
  /** Borrowed current draw buffers; picking never substitutes bind-pose geometry. */
  get pickingPrimitives() {
    if(this.disposed)return [];
    return this.resources.map(r=>({primitive:r.primitive,node:r.primitive.node,vertex:r.primitive.deformed??r.vertex,index:r.index,count:r.primitive.indices.length,stride:80 as const,
      alphaTexture:r.views[0],alphaSampler:r.samplers[0],alpha:r.primitive.material.base[3],cutoff:r.primitive.material.settings[0]===1?r.primitive.material.settings[1]:r.primitive.material.settings[0]===2?0.001:0,
      doubleSided:r.primitive.material.settings[2]>=0.5,texCoord:(r.primitive.material.maps[0]?textureCoordinates(r.primitive.material.maps[0]).texCoord:0) as 0|1,
      ...(r.primitive.material.maps[0]?.extensions?.KHR_texture_transform?{alphaTransform:textureCoordinates(r.primitive.material.maps[0]).transform}:{})}));
  }
  /** Explicit CPU-query snapshot. Only deformed geometry incurs GPU readback. */
  async readPickingGeometry():Promise<readonly PBRPickingGeometry[]> {
    const device=this.engine.gpu,revision=this.gpuRevision;
    if(this.disposed||this.engine.disposed||!device)return [];
    this.engine.store.tick(false);
    const records=this.resources.map(resource=>({resource,primitive:resource.primitive,deformed:resource.primitive.deformed,matrix:resource.primitive.node.matrix.slice(),vertices:resource.primitive.deformed?undefined:resource.primitive.vertices.slice(),indices:resource.primitive.indices.slice(),doubleSided:resource.primitive.material.settings[2]>=0.5,read:undefined as GPUBuffer|undefined}));
    try{
      if(this.prepareDeformation||records.some(record=>record.deformed)){
        const encoder=device.createCommandEncoder();this.prepareDeformation?.({backend:'webgpu',device,encoder});
        for(const record of records)if(record.deformed){
          if(!(record.deformed.usage&GPUBufferUsage.COPY_SRC))throw new TypeError('Deformed picking snapshots require COPY_SRC buffers');
          const size=record.primitive.vertices.byteLength;if(size>device.limits.maxBufferSize)throw new RangeError('Picking snapshot exceeds device buffer limit');
          record.read=device.createBuffer({label:'PBR picking snapshot',size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});encoder.copyBufferToBuffer(record.deformed,0,record.read,0,size);
        }
        device.queue.submit([encoder.finish()]);
        await Promise.all(records.filter(record=>record.read).map(record=>record.read!.mapAsync(GPUMapMode.READ)));
      }
      if(this.disposed||this.engine.disposed||this.engine.gpu!==device||revision!==this.gpuRevision||records.some(record=>record.primitive.deformed!==record.deformed))return [];
      return records.filter(record=>this.engine.meshes.get(record.primitive.node.id)===record.primitive.node).map(record=>({node:record.primitive.node,matrix:record.matrix,vertices:record.read?new Float32Array(record.read.getMappedRange()).slice():record.vertices!,indices:record.indices,doubleSided:record.doubleSided}));
    }catch(error){if(this.disposed||this.engine.disposed||this.engine.gpu!==device||revision!==this.gpuRevision||records.some(record=>record.primitive.deformed!==record.deformed))return [];throw error;}
    finally{for(const {read} of records)if(read){if(read.mapState==='mapped')read.unmap();read.destroy();}}
  }
  draw(c:Context,mode:'beauty'|'gbuffer'|'ambient',color:GPUTextureView,depth:GPUTextureView,phase:'all'|'opaque'|'blend'='all',external?:{pass:GPURenderPassEncoder;view:ArrayLike<number>;depthCompare:GPUCompareFunction}):void {
    if(this.disposed)return;
    const pending=mode==='beauty'&&phase==='all'?opaquePasses.get(c):undefined;
    if(pending){pending.add(this);phase='opaque';}
    if(external)this.view.set(external.view);else viewMatrix(this.view,c.camera);
    const resources=(phase==='all'?[...this.resources]:this.resources.filter(r=>(r.primitive.material.settings[0]===2)===(phase==='blend'))).sort((a,b)=>{
      const blendA=a.primitive.material.settings[0]===2,blendB=b.primitive.material.settings[0]===2;
      if(blendA!==blendB)return +blendA-+blendB;
      const distance=(r:DrawResource)=>Math.hypot(...c.camera.position.map((v,i)=>v-r.primitive.node.matrix[12+i]));
      return blendA?distance(b)-distance(a):0;
    });
    let pass:GPURenderPassEncoder|undefined=external?.pass;
    try {for(const r of resources) {
      const p=r.primitive,m=p.material,node=p.node;node.check();let visible=true;
      for(let id=node.id;id!==-1;id=this.engine.store.parents[id])if(this.engine.store.hidden[id])visible=false;
      if(!visible)continue;
      const v=r.values;v.set(c.camera.matrix);v.set(node.matrix,16);
      if(!invert(this.inverse,node.matrix,0,this.workspace))throw new Error('Singular PBR transform');
      for(let i=0;i<16;i++)v[32+i]=this.inverse[(i%4)*4+Math.floor(i/4)];
      v.set(this.view,48);v.set(c.camera.position,64);v.set(this.engine.lighting.direction,68);v.set(this.engine.lighting.radiance,72);
      v.set(m.base,76);v.set(m.factors,80);v.set(m.emission,84);v.set(m.settings,88);v[91]=+(c.format==='rgba16float');
      for(let i=0;i<5;i++)v[92+i]=m.maps[i]?.extensions?.KHR_texture_transform!==undefined?textureCoordinates(m.maps[i]).texCoord:m.maps[i]?.texCoord??0;
      const a=node.matrix;v[97]=Math.sign(a[0]*(a[5]*a[10]-a[6]*a[9])-a[4]*(a[1]*a[10]-a[2]*a[9])+a[8]*(a[1]*a[6]-a[2]*a[5]));
      c.device.queue.writeBuffer(r.uniform,0,v as Float32Array<ArrayBuffer>);
      const source=p.extension??m.extension;
      r.coordinates=coordinateExtension(m.maps,source,r.coordinates);
      let code=coordinateShader(pbrShader,r.coordinates,!!m.maps[2]&&v[94]===1);
      const extension=r.coordinates?.extension??source;
      if(extension){r.extension=prepareMaterialExtension(c.device,extension,r.extension);code=materialExtensionShader(code,extension);}
      else if(r.extension){r.extension.uniform?.destroy();r.extension=undefined;}
      const lighting=mode==='beauty'&&extension?.lighting!==false&&this.lighting.size>0;
      if(lighting)for(const effect of this.lighting)code=effect.shader(code,2);
      if(extension?.ambient)code=materialExtensionAmbientShader(code,extension);
      const blend=m.settings[0]===2,key=mode+':'+c.format+':'+blend+':'+c.descriptor.multisample?.count+':'+c.descriptor.depthStencil!.format+(extension?':material-extension:':'')+(external?':'+external.depthCompare:'')+code;
      let pipeline=this.pipelines.get(key);
      if(!pipeline) {
        const module=c.device.createShaderModule({code}),format=mode==='beauty'?c.format:'rgba16float';
        pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:80,attributes:Array.from({length:5},(_,i)=>({shaderLocation:i,offset:i*16,format:'float32x4' as const}))}]},
          fragment:{module,entryPoint:mode==='beauty'?'fragment':mode==='gbuffer'?'gbuffer':'ambientFragment',targets:[{format,blend:blend&&mode!=='gbuffer'?{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}:undefined}]},
          multisample:c.descriptor.multisample,primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:mode==='beauty'&&!blend,depthCompare:mode==='beauty'?(external?.depthCompare??'greater-equal'):'equal'}});
        this.pipelines.set(key,pipeline);
      }
      let groups=r.groups.get(pipeline);
      if(!groups) {
        groups=[c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.uniform}}]}),
          c.device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:r.views.flatMap((view,i)=>[{binding:i*2,resource:view},{binding:i*2+1,resource:r.samplers[i]}])})];
        r.groups.set(pipeline,groups);
      }
      // Retain transparent pass boundaries so attachment-store rounding stays unchanged.
      if(!external&&blend&&mode!=='gbuffer'){pass?.end();pass=undefined;}
      pass??=c.encoder.beginRenderPass({colorAttachments:[{view:color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:depth,depthLoadOp:'load',depthStoreOp:'store',...(c.descriptor.depthStencil!.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})}});
      pass.setPipeline(pipeline);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,groups[1]);
      if(lighting){
        const entries=[...this.lighting].flatMap(effect=>effect.bindings());let cached=this.lightingGroups.get(pipeline);
        if(!cached||entries.length!==cached.entries.length||entries.some((entry,i)=>{
          const previous=cached!.entries[i],resource=entry.resource,old=previous.resource;
          return entry.binding!==previous.binding||!(resource===old||'buffer' in resource&&'buffer' in old&&resource.buffer===old.buffer&&resource.offset===old.offset&&resource.size===old.size);
        })){
          const snapshot=entries.map(({binding,resource})=>({binding,resource:'buffer' in resource?{buffer:resource.buffer,offset:resource.offset,size:resource.size}:resource}));
          const group=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries});cached={entries:snapshot,group};this.lightingGroups.set(pipeline,cached);
        }
        pass.setBindGroup(2,cached.group);
      }
      if(extension)bindMaterialExtension(c.device,pass,pipeline,r.extension!,lighting);
      pass.setVertexBuffer(0,p.deformed??r.vertex);pass.setIndexBuffer(r.index,'uint32');pass.drawIndexed(p.indices.length);
      if(!external&&blend&&mode!=='gbuffer'){pass.end();pass=undefined;}
      if(mode==='beauty'&&!external){this.engine.stats.visible++;this.engine.stats.drawCalls++;}
    }}catch(error){if(!external)try{pass?.end();}catch{}throw error;}
    if(!external)pass?.end();
  }
  /** Isolated GPU resources for stereo eyes or another caller-owned WebGPU device. */
  createRenderer(device:GPUDevice):PBRDeviceRenderer {
    if(this.disposed||this.engine.disposed)throw new Error('PBRModel is disposed');
    // GPU texture views supplied by callers cannot cross devices. Fail explicitly
    // rather than drawing a bind pose or silently omitting an extended surface.
    for(const primitive of this.primitives)if((primitive.extension??primitive.material.extension)?.textures?.length)throw new Error('Cross-device PBR rendering requires recreating caller-owned material extension textures');
    const replica=Object.create(PBRModel.prototype) as PBRModel;
    Object.assign(replica,{name:this.name+':device:'+modelId++,root:this.root,nodes:this.nodes,primitives:this.primitives.map(primitive=>({...primitive,deformed:undefined})),asset:this.asset,images:this.images,
      disposed:false,created:[],resources:[],textures:[],pipelines:new Map(),inverse:new Float32Array(16),workspace:new Float64Array(52),view:new Float32Array(16),engine:this.engine,cleanupCallbacks:new Set(),lighting:new Set(),lightingGroups:new Map(),gpuRevision:0});
    let deformation:PBRDeformationRenderer|undefined,factory=this.createDeformationRenderer;
    const release=()=>{if(replica.disposed)return;replica.disposed=true;const cleanup=new Cleanup();cleanup.run(()=>deformation?.dispose()).run(()=>replica.releaseGPU());cleanup.finish();};
    try {
      replica.setup(this.engine,device);
      if(factory)deformation=factory(replica,device);
      else if(this.primitives.some(primitive=>primitive.deformed))throw new Error('Cross-device deformed PBR rendering requires an isolated deformation renderer');
      return deviceRenderer(device,context=>{
        for(let i=0;i<this.primitives.length;i++){const source=this.primitives[i],copy=replica.primitives[i];if((source.extension??source.material.extension)?.textures?.length)throw new Error('Cross-device PBR rendering requires recreating caller-owned material extension textures');copy.extension=source.extension;copy.material=source.material;copy.weights=source.weights;}
        if(factory!==this.createDeformationRenderer||factory&&!deformation){deformation?.dispose();deformation=undefined;const next=this.createDeformationRenderer;factory=undefined;if(next)deformation=next(replica,device);factory=next;}
        if(!factory&&this.primitives.some(primitive=>primitive.deformed))throw new Error('Cross-device deformed PBR rendering requires an isolated deformation renderer');
        deformation?.prepare(context);
      },(context,pass,view)=>replica.draw(context,'beauty',context.color,context.depth,'all',{pass,view,depthCompare:'less-equal'}),release,callback=>this.onDispose(callback));
    }catch(error){release();throw error;}
  }
  onDispose(callback:()=>void):()=>void {if(typeof callback!=='function')throw new TypeError('Expected cleanup callback');if(this.disposed){callback();return()=>{};}this.cleanupCallbacks.add(callback);return()=>this.cleanupCallbacks.delete(callback);}
  private releaseGPU():void {this.gpuRevision++;const cleanup=new Cleanup(),buffers=new Set<GPUBuffer>();for(const r of this.resources)for(const b of [r.vertex,r.index,r.uniform,r.extension?.uniform])if(b)buffers.add(b);for(const b of buffers)cleanup.run(()=>b.destroy());for(const t of this.textures)cleanup.run(()=>t.destroy());this.resources=[];this.textures=[];this.pipelines.clear();this.lightingGroups.clear();cleanup.finish();}
  onDeviceRestored(engine:Engine):void {this.releaseGPU();for(const p of this.primitives)p.deformed=undefined;this.setup(engine);}
  dispose():void {
    if(this.disposed)return;this.disposed=true;const cleanup=new Cleanup();
    for(const node of this.created){clearMeshSource(node);Reflect.deleteProperty(node,cpuSource);}
    this.lighting.clear();
    cleanup.run(()=>this.engine.removePlugin(this.name)).run(()=>this.engine.frameGraph.removeOwner(this.name));
    for(const callback of this.cleanupCallbacks)cleanup.run(callback);this.cleanupCallbacks.clear();cleanup.run(()=>this.releaseGPU());
    for(let i=this.created.length-1;i>=0;i--)cleanup.run(()=>this.created[i].dispose());for(const image of this.images)cleanup.run(()=>image?.close());cleanup.finish();
  }
  destroy():void {this.engine.removePlugin(this.name);if(!this.disposed)this.dispose();}
}
export function parseGLTF(instance:EngineKernel,input:string|object|ArrayBuffer|ArrayBufferView,buffers:Array<ArrayBuffer|ArrayBufferView>=[],images:readonly GLTFImage[]=[]):PBRModel {
  const {doc,binary}=container(input),model=new PBRModel(instance,new GLTFAsset(doc,buffers,binary),images);
  try{engineRuntime(instance).use(model);return model;}catch(error){model.dispose();throw error;}
}
export function parsePreparedPBR(instance:EngineKernel,doc:GLTFAsset['doc'],geometry:readonly (readonly PreparedGeometry[])[],images:readonly GLTFImage[]=[]):PBRModel {
  if(doc.buffers?.length||doc.skins?.length||doc.animations?.length||doc.nodes?.some((n:any)=>n.skin!==undefined)||!Array.isArray(geometry)||geometry.length!==doc.meshes?.length)throw new TypeError('Prepared PBR requires a static scene');
  const model=new PBRModel(instance,new GLTFAsset(doc,[]),images,geometry);
  try{engineRuntime(instance).use(model);return model;}catch(error){model.dispose();throw error;}
}
export async function parseGLTFAsync(instance:EngineKernel,input:string|object|ArrayBuffer|ArrayBufferView,buffers:Array<ArrayBuffer|ArrayBufferView>=[],images:readonly GLTFImage[]=[],options:GLTFLoadOptions={}):Promise<PBRModel> {
  options.signal?.throwIfAborted();
  const {doc,binary}=container(input),asset=new GLTFAsset(doc,buffers,binary);
  await decompressPrimitives(asset,options);
  images=await decodeKTX2Images(asset,images,{...options,device:engineRuntime(instance).gpu??undefined});
  options.signal?.throwIfAborted();
  const model=new PBRModel(instance,asset,images);
  try{engineRuntime(instance).use(model);return model;}catch(error){model.dispose();throw error;}
}
export async function loadGLTF(instance:EngineKernel,url:string|URL,options:GLTFLoadOptions={}):Promise<PBRModel> {
  const {signal}=options,{asset,images}=await loadAsset(url,signal,asset=>decompressPrimitives(asset,options),{...options,device:engineRuntime(instance).gpu??undefined});let model:PBRModel|undefined;
  try {signal?.throwIfAborted();model=new PBRModel(instance,asset,images);engineRuntime(instance).use(model);return model;}
  catch(error){if(model)model.dispose();else for(const image of images)image?.close();throw error;}
}
