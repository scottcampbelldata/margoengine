import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext, type Mesh} from '@margoengine/core/extension';
import {invertMatrixStable} from '@margoengine/math/mat4';
import {viewMatrix} from '../../shared/view.js';
import {Cleanup} from '../../shared/cleanup.js';
import {GLTFAsset, container, loadAsset, closeImages, entry, integer, assetLimit, type GLTFImage, type AssetOptions} from './asset.js';
import {pbrShader, physicalShader, lightPBR, type PBRLighting} from './shader.js';
export type {PBRLighting} from './shader.js';
import {mipShader} from './mip.js';
export {GLTFAsset} from './asset.js';
export type {GLTFDocument, GLTFDecoderHooks, GLTFCompressedImage, GLTFImage} from './asset.js';
/** KHR_lights_punctual light on a scene node, as data. Intensity is candela (point, spot) or lux (directional); the light points down the node's -Z. */
export interface GLTFLight {node:Mesh;nodeIndex:number;type:'directional'|'point'|'spot';color:number[];intensity:number;range?:number;innerConeAngle?:number;outerConeAngle?:number;name?:string}
/** glTF camera on a scene node, as data; the camera looks down the node's -Z. */
export interface GLTFCamera {node:Mesh;nodeIndex:number;type:'perspective'|'orthographic';perspective?:{yfov:number;znear:number;zfar?:number;aspectRatio?:number};orthographic?:{xmag:number;ymag:number;znear:number;zfar:number};name?:string}
/** Point or spot light shaped for @margoengine/clustered `setLights`. */
export interface GLTFClusteredLight {position:[number,number,number];range:number;color:number[];intensity:number;direction?:[number,number,number];outerAngle?:number;innerAngle?:number}
export type GLTFLoadOptions = Omit<AssetOptions,'buffers'>;
const srgbMaps=[0,4,9,12],normalMaps=[2,7],blended=(m:any)=>m.settings[0]===2||!!m.tint;
declare const GPUBufferUsage: {UNIFORM:number;STORAGE:number;VERTEX:number;INDEX:number;COPY_DST:number};
declare const GPUTextureUsage: {TEXTURE_BINDING:number;COPY_DST:number;RENDER_ATTACHMENT:number};
type Context = Extract<PassContext,{backend:'webgpu'}>;
export interface PBRPrimitive {
  node: Mesh; nodeIndex: number; vertices: Float32Array; indices: Uint32Array;
  definition: any; material: any; weights: Float32Array; targetNames: string[];
  deformed?: GPUBuffer;
  /** The 80-byte-stride vertex and uint32 index buffers while the model is set up on a device (for picking and outlines). */
  buffers?: {vertex: GPUBuffer; index: GPUBuffer};
}
export interface PreparedGeometry {vertices:Float32Array;indices:Uint32Array}
/**
 * Optional beauty-pass pipeline overrides, set as `primitive.material.renderState` (shared by every primitive using
 * that material). Unset fields keep gltf-pro's defaults; `blend: null` turns blending off. The state is part of the
 * pipeline cache key, so treat it as fixed (replace the object to change it). G-buffer and ambient passes ignore it.
 */
export interface PBRRenderState {blend?:GPUBlendState|null;depthWrite?:boolean;depthCompare?:GPUCompareFunction}
export function validatePreparedGeometry(data:PreparedGeometry):void {
  const {vertices,indices}=data,count=vertices?.length/20;
  if(!(vertices instanceof Float32Array)||!(indices instanceof Uint32Array)||!Number.isInteger(count)||count<3||count>1_000_000||!indices.length||indices.length%3)throw new RangeError('Invalid prepared PBR geometry');
  for(let i=0;i<indices.length;i++)if(indices[i]>=count)throw new RangeError('Invalid prepared PBR geometry');
  for(let i=0;i<vertices.length;i++)if(!Number.isFinite(vertices[i]))throw new RangeError('Non-finite prepared PBR vertex');
  for(let i=0;i<vertices.length;i+=20){
    const sign=vertices[i+11];
    if(vertices[i+3]!==1||vertices[i+7]!==0||Math.abs(Math.hypot(vertices[i+4],vertices[i+5],vertices[i+6])-1)>1e-3||sign!==0&&sign!==-1&&sign!==1)throw new RangeError('Invalid prepared PBR normal/tangent');
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
interface DrawResource {primitive:PBRPrimitive;vertex:GPUBuffer;index:GPUBuffer;uniform:GPUBuffer;values:Float32Array;groups:Map<GPURenderPipeline,[GPUBindGroup,GPUBindGroup]>;views:GPUTextureView[];samplers:GPUSampler[]}
/** A lighting or shading effect for `addLighting`: `pbr` hooks (lighting; preferred) or a `shader` text patch (materials, LOD baking). */
export interface LightingEffect {readonly owner?:Engine;pbr?(group:number):PBRLighting|undefined;shader?(source:string,group:number):string;bindings():GPUBindGroupEntry[]}
let modelId = 0;
const vector = (value:any, size:number, label:string, min=-Infinity, max=Infinity):number[] => {
  if (!Array.isArray(value) || value.length !== size || value.some(v=>typeof v!=='number'||!Number.isFinite(Math.fround(v))||v<min||v>max)) throw new TypeError('Invalid glTF '+label);
  return value;
};
const scalar=(v:any,min:number,max:number,label:string)=>vector([v],1,label,min,max)[0];
/** UV offset, scale and rotation (radians), with KHR_texture_transform semantics: uv' = offset * rotation * scale * uv. */
export interface TextureTransform {offset?:readonly number[];scale?:readonly number[];rotation?:number}
/** One map's two uniform rows (offset*rotation*scale) as gltf-pro's shader reads them; the first row's w holds the UV set. */
export function textureTransform(x:TextureTransform={},texCoord=0):number[] {
  const [ox,oy]=vector(x.offset??[0,0],2,'texture offset'),[sx,sy]=vector(x.scale??[1,1],2,'texture scale'),r=scalar(x.rotation??0,-Infinity,Infinity,'texture rotation'),c=Math.cos(r),s=Math.sin(r);
  return [c*sx,s*sy,ox,texCoord,-s*sx,c*sy,oy,0];
}
function material(def:any = {}): any {
  const p=def.pbrMetallicRoughness??{}, alpha=def.alphaMode??'OPAQUE', e=def.extensions??{};
  if (!['OPAQUE','MASK','BLEND'].includes(alpha)) throw new TypeError('Invalid glTF alpha mode');
  if (def.doubleSided!==undefined&&typeof def.doubleSided!=='boolean') throw new TypeError('Invalid glTF doubleSided');
  const cc=e.KHR_materials_clearcoat,tr=e.KHR_materials_transmission,sh=e.KHR_materials_sheen,sp=e.KHR_materials_specular,vo=e.KHR_materials_volume,physical=!!(cc||tr||sh||sp||vo||e.KHR_materials_ior);
  const base=vector(p.baseColorFactor??[1,1,1,1],4,'base color',0,1),transmission=scalar(tr?.transmissionFactor??0,0,1,'transmission'),strength=scalar(e.KHR_materials_emissive_strength?.emissiveStrength??1,0,Infinity,'emissive strength');
  const attenuation=vector(vo?.attenuationColor??[1,1,1],3,'attenuation color',0,1),depth=scalar(vo?.thicknessFactor??0,0,Infinity,'thickness')/(vo?.attenuationDistance===undefined?Infinity:scalar(vo.attenuationDistance,Number.MIN_VALUE,Infinity,'attenuation distance'));
  const maps=[p.baseColorTexture,p.metallicRoughnessTexture,def.normalTexture,def.occlusionTexture,def.emissiveTexture,...physical?[cc?.clearcoatTexture,cc?.clearcoatRoughnessTexture,cc?.clearcoatNormalTexture,tr?.transmissionTexture,sh?.sheenColorTexture,sh?.sheenRoughnessTexture,sp?.specularTexture,sp?.specularColorTexture]:[]]
    .map(t=>t?.extensions?.KHR_texture_transform?.texCoord===undefined?t:{...t,texCoord:t.extensions.KHR_texture_transform.texCoord});
  return {...def,base,
    factors:[scalar(p.roughnessFactor??1,0,1,'roughness'),scalar(p.metallicFactor??1,0,1,'metallic'),scalar(def.normalTexture?.scale??1,-Infinity,Infinity,'normal scale'),scalar(def.occlusionTexture?.strength??1,0,1,'occlusion strength')],
    emission:vector(def.emissiveFactor??[0,0,0],3,'emissive',0,1).map(v=>v*strength),
    settings:[['OPAQUE','MASK','BLEND'].indexOf(alpha),scalar(def.alphaCutoff??0.5,0,Infinity,'alpha cutoff'),+(def.doubleSided??false),0],
    maps,
    // KHR_texture_transform per map as two rows of offset*rotation*scale; the first row's w holds the UV set.
    uvt:maps.flatMap(t=>textureTransform(t?.extensions?.KHR_texture_transform??{},t?.texCoord??0)),
    ext:[+!!e.KHR_materials_unlit,scalar(e.KHR_materials_ior?.ior??1.5,0,Infinity,'ior'),0,0],
    physical:physical?[scalar(cc?.clearcoatFactor??0,0,1,'clearcoat'),scalar(cc?.clearcoatRoughnessFactor??0,0,1,'clearcoat roughness'),scalar(cc?.clearcoatNormalTexture?.scale??1,-Infinity,Infinity,'clearcoat normal scale'),transmission,
      ...vector(sp?.specularColorFactor??[1,1,1],3,'specular color',0),scalar(sp?.specularFactor??1,0,1,'specular'),...vector(sh?.sheenColorFactor??[0,0,0],3,'sheen color',0,1),scalar(sh?.sheenRoughnessFactor??0,0,1,'sheen roughness')]:undefined,
    // Transmission blends the background by this per-material tint (base color, Beer-Lambert volume attenuation at thicknessFactor).
    tint:transmission?base.slice(0,3).map((v,i)=>v*transmission*attenuation[i]**depth):undefined};
}
function primitive(asset:GLTFAsset, p:any, node:Mesh, nodeIndex:number, mesh:any, materials:any[]):PBRPrimitive {
  if ((p.mode??4)!==4) throw new Error('PBR requires triangle primitives');
  const a=p.attributes??{}, positions=asset.accessor(a.POSITION,'VEC3'), count=positions.length/3, quantized=asset.doc.extensionsUsed?.includes('KHR_mesh_quantization');
  if(count<3)throw new RangeError('Expected bounded triangle geometry');
  for(const key of ['POSITION','NORMAL','TANGENT'])if(a[key]!==undefined&&!quantized){const def=entry(asset.doc.accessors,a[key],'attribute');if(def.componentType!==5126||def.normalized)throw new TypeError('Expected Float32 '+key);}
  for(const key of ['TEXCOORD_0','TEXCOORD_1','COLOR_0'])if(a[key]!==undefined&&!(quantized&&key!=='COLOR_0')){const def=entry(asset.doc.accessors,a[key],'attribute');if(![5126,5121,5123].includes(def.componentType)||def.componentType!==5126&&!def.normalized)throw new TypeError('Invalid normalized '+key);}
  let normals=a.NORMAL===undefined?new Float32Array(positions.length):asset.accessor(a.NORMAL,'VEC3');
  const indexValues=p.indices===undefined?null:asset.accessor(p.indices,'SCALAR');
  if(indexValues)for(let i=0;i<indexValues.length;i++){const v=indexValues[i];if(!Number.isInteger(v)||v<0||v>=count)throw new RangeError('Invalid glTF triangle indices');}
  const indices=indexValues?new Uint32Array(indexValues):new Uint32Array(count);
  if(!indexValues)for(let i=0;i<count;i++)indices[i]=i;
  if (!indices.length||indices.length%3) throw new RangeError('Invalid glTF triangle indices');
  if (p.indices!==undefined && (![5121,5123,5125].includes(entry(asset.doc.accessors,p.indices,'indices').componentType)||asset.doc.accessors[p.indices].normalized)) throw new TypeError('Invalid index component type');
  if (a.NORMAL===undefined) for (let i=0;i<indices.length;i+=3) {
    const x=indices[i]*3,y=indices[i+1]*3,z=indices[i+2]*3;
    const ux=positions[y]-positions[x],uy=positions[y+1]-positions[x+1],uz=positions[y+2]-positions[x+2],vx=positions[z]-positions[x],vy=positions[z+1]-positions[x+1],vz=positions[z+2]-positions[x+2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    normals[x]+=nx;normals[x+1]+=ny;normals[x+2]+=nz;normals[y]+=nx;normals[y+1]+=ny;normals[y+2]+=nz;normals[z]+=nx;normals[z+1]+=ny;normals[z+2]+=nz;
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
  // Packed vertex: position+1, normal+0, tangent, uv0 uv1, color.
  for(let i=0,o=0;i<count;i++,o+=20) {
    const p=i*3,nx=normals[p],ny=normals[p+1],nz=normals[p+2],length=Math.hypot(nx,ny,nz);
    vertices[o]=positions[p];vertices[o+1]=positions[p+1];vertices[o+2]=positions[p+2];vertices[o+3]=1;
    if(!length) throw new RangeError('Zero glTF normal');
    vertices[o+4]=nx/length;vertices[o+5]=ny/length;vertices[o+6]=nz/length;
    if(tangent){const t=i*4;vertices[o+8]=tangent[t];vertices[o+9]=tangent[t+1];vertices[o+10]=tangent[t+2];vertices[o+11]=tangent[t+3];}
    if(uv0){vertices[o+12]=uv0[i*2];vertices[o+13]=uv0[i*2+1];}if(uv1){vertices[o+14]=uv1[i*2];vertices[o+15]=uv1[i*2+1];}
    if(colors){const c=i*colorWidth;vertices[o+16]=colors[c];vertices[o+17]=colors[c+1];vertices[o+18]=colors[c+2];vertices[o+19]=colorWidth===3?1:colors[c+3];}
    else{vertices[o+16]=1;vertices[o+17]=1;vertices[o+18]=1;vertices[o+19]=1;}
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
  readonly name='gltf-pro:'+modelId++;
  readonly root:Mesh;readonly nodes:Mesh[]=[];readonly primitives:PBRPrimitive[]=[];readonly lights:GLTFLight[]=[];readonly cameras:GLTFCamera[]=[];
  disposed=false;private readonly created:Mesh[]=[];private resources:DrawResource[]=[];private textures:GPUTexture[]=[];
  private pipelines=new Map<string,GPURenderPipeline>();private readonly inverse=new Float32Array(16);private readonly workspace=new Float64Array(52);private readonly view=new Float32Array(16);
  private engine:Engine;private readonly cleanupCallbacks=new Set<()=>void>();
  private readonly lighting=new Set<LightingEffect>();private readonly codes=new Map<string,number>();private codeCount=0;private readonly replays=new Map<string,string>();
  private readonly lightingGroups=new Map<GPURenderPipeline,{entries:GPUBindGroupEntry[];group:GPUBindGroup}>();
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
      for(const i of active){
        const d=defs[i],light=d.extensions?.KHR_lights_punctual;
        if(light){
          const def=entry(doc.extensions?.KHR_lights_punctual?.lights,light.light,'light'),spot=def.type==='spot'?{innerConeAngle:scalar(def.spot?.innerConeAngle??0,0,Math.PI/2,'spot cone'),outerConeAngle:scalar(def.spot?.outerConeAngle??Math.PI/4,0,Math.PI/2,'spot cone')}:{};
          if(!['directional','point','spot'].includes(def.type)||def.range!==undefined&&!(def.range>0)||spot.innerConeAngle!>=spot.outerConeAngle!)throw new TypeError('Invalid glTF light');
          this.lights.push({...def,...spot,color:vector(def.color??[1,1,1],3,'light color',0),intensity:scalar(def.intensity??1,0,Infinity,'light intensity'),node:this.nodes[i],nodeIndex:i});
        }
        if(d.camera!==undefined){const def=entry(doc.cameras,d.camera,'camera');if(!['perspective','orthographic'].includes(def.type)||typeof def[def.type]!=='object')throw new TypeError('Invalid glTF camera');this.cameras.push({...def,node:this.nodes[i],nodeIndex:i});}
      }
      let geometryBytes=0;const checked=new Set<PreparedGeometry>(),counted=new Set<Float32Array|Uint32Array>();
      for(const i of active)if(defs[i].mesh!==undefined) {
        const mesh=entry(doc.meshes,defs[i].mesh,'mesh');if(!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError('Missing primitives');
        if(prepared&&prepared[defs[i].mesh]?.length!==mesh.primitives.length)throw new TypeError('Missing prepared PBR primitives');
        for(let j=0;j<mesh.primitives.length;j++){const p=mesh.primitives[j],made=prepared?preparedPrimitive(asset,p,prepared[defs[i].mesh][j],this.nodes[i],i,materials,checked):primitive(asset,p,this.nodes[i],i,mesh,materials);for(const data of [made.vertices,made.indices])if(!counted.has(data)){geometryBytes+=data.byteLength;counted.add(data);}if(geometryBytes>assetLimit*4)throw new RangeError('Decoded glTF geometry exceeds byte budget');this.primitives.push(made);}
      }
      if(!this.primitives.length)throw new Error('glTF contains no renderable meshes');
    } catch(error) {for(const node of this.created.reverse())node.dispose();throw error;}
  }
  setup(engine:Engine):void {
    if(engine!==this.engine||this.disposed)throw new Error('PBRModel belongs to another engine or is disposed');
    if(!engine.gpu)throw new Error('PBRModel requires WebGPU');
    const device=engine.gpu;
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
      const r:DrawResource={primitive:p,vertex:undefined!,index:undefined!,uniform:undefined!,values:new Float32Array(220),groups:new Map(),views:[],samplers:[]};
      this.resources.push(r);r.vertex=upload(p.vertices,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE);r.index=upload(p.indices,GPUBufferUsage.INDEX);p.buffers={vertex:r.vertex,index:r.index};
      r.uniform=device.createBuffer({size:880,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      for(let i=0;i<p.material.maps.length;i++) {
        const map=p.material.maps[i],def=map?entry(this.asset.doc.textures,map.index,'texture'):null;
        // KHR_texture_basisu, EXT_texture_webp and EXT_texture_avif sources win when decoded; otherwise the fallback source.
        const source=def?['KHR_texture_basisu','EXT_texture_webp','EXT_texture_avif'].map(k=>def.extensions?.[k]?.source).find(s=>s!==undefined&&this.images[s])??integer(def.source,'image'):-1,image=this.images[source];
        if(def&&!image)throw new TypeError('Missing decoded glTF image');
        const compressed=image&&'mipmaps' in image?image:undefined,format=compressed?compressed.format:srgbMaps.includes(i)?'rgba8unorm-srgb':'rgba8unorm',size=image?[image.width,image.height]:[1,1];
        if(size.some(n=>n>device.limits.maxTextureDimension2D))throw new RangeError('Image exceeds device limit');
        const key=image?source+':'+format:'default:'+i;
        let texture=imageTextures.get(key);
        if(!texture) {
          const levels=compressed?compressed.mipmaps.length:image?Math.floor(Math.log2(Math.max(...size)))+1:1;
          texture=device.createTexture({size,format,mipLevelCount:levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|(compressed?0:GPUTextureUsage.RENDER_ATTACHMENT)});
          this.textures.push(texture);imageTextures.set(key,texture);
          // Transcoded mips upload as-is: rgba8 rows, or 16-byte 4x4 blocks (BC7, ASTC 4x4, ETC2 RGBA8).
          if(compressed){const block=format.startsWith('rgba')?1:4,target=texture;compressed.mipmaps.forEach((m,mipLevel)=>{const w=Math.ceil(m.width/block),h=Math.ceil(m.height/block);device.queue.writeTexture({texture:target,mipLevel},m.data as Uint8Array<ArrayBuffer>,{bytesPerRow:w*(block>1?16:4),rowsPerImage:h},[w*block,h*block]);});}
          else if(image)device.queue.copyExternalImageToTexture({source:image as ImageBitmap},{texture},size);
          else device.queue.writeTexture({texture},new Uint8Array(normalMaps.includes(i)?[128,128,255,255]:[255,255,255,255]),{bytesPerRow:4},[1,1]);
          if(levels>1&&!compressed) {
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
  addLighting(effect:LightingEffect):()=>void {
    if(this.disposed||!effect||typeof (effect.pbr??effect.shader)!=='function'||typeof effect.bindings!=='function')throw new TypeError('Invalid PBR lighting effect');
    if(effect.owner&&effect.owner!==this.engine)throw new Error('PBR lighting belongs to another engine');
    this.lighting.add(effect);return()=>this.lighting.delete(effect);
  }
  get shadowPrimitives() {
    return this.resources.filter(r=>r.primitive.material.settings[0]!==2).map(r=>({node:r.primitive.node,vertex:r.primitive.deformed??r.vertex,index:r.index,count:r.primitive.indices.length,stride:80,
      alphaTexture:r.views[0],alphaSampler:r.samplers[0],alpha:r.primitive.material.base[3],cutoff:r.primitive.material.settings[0]===1?r.primitive.material.settings[1]:0,texCoord:r.primitive.material.maps[0]?.texCoord??0}));
  }
  draw(c:Context,mode:'beauty'|'gbuffer'|'ambient',color:GPUTextureView,depth:GPUTextureView):void {
    if(this.disposed)return;
    viewMatrix(this.view,c.camera);
    const resources=[...this.resources].sort((a,b)=>{
      const blendA=blended(a.primitive.material),blendB=blended(b.primitive.material);
      if(blendA!==blendB)return +blendA-+blendB;
      const distance=(r:DrawResource)=>Math.hypot(...c.camera.position.map((v,i)=>v-r.primitive.node.matrix[12+i]));
      return blendA?distance(b)-distance(a):0;
    });
    let pass:GPURenderPassEncoder|undefined;
    try {for(const r of resources) {
      const p=r.primitive,m=p.material,node=p.node;node.check();let visible=true;
      for(let id=node.id;id!==-1;id=this.engine.store.parents[id])if(this.engine.store.hidden[id])visible=false;
      if(!visible)continue;
      const v=r.values;v.set(c.camera.matrix);v.set(node.matrix,16);
      if(!invertMatrixStable(node.matrix,this.inverse,this.workspace))throw new Error('Singular PBR transform');
      for(let i=0;i<16;i++)v[32+i]=this.inverse[(i%4)*4+Math.floor(i/4)];
      v.set(this.view,48);v.set(c.camera.position,64);v.set(this.engine.lighting.direction,68);v.set(this.engine.lighting.radiance,72);
      v.set(m.base,76);v.set(m.factors,80);v.set(m.emission,84);v.set(m.settings,88);v[91]=+(c.format==='rgba16float');
      // coordsA/coordsB.x name each base map's slot; uv() reads that slot's KHR_texture_transform row, which carries its UV set.
      for(let i=0;i<5;i++)v[92+i]=i;
      const a=node.matrix;v[97]=Math.sign(a[0]*(a[5]*a[10]-a[6]*a[9])-a[4]*(a[1]*a[10]-a[2]*a[9])+a[8]*(a[1]*a[6]-a[2]*a[5]));
      v.set(m.ext,100);v.set(m.uvt,104);if(m.physical)v.set(m.physical,208);
      c.device.queue.writeBuffer(r.uniform,0,v as Float32Array<ArrayBuffer>);
      let code=m.physical?physicalShader():pbrShader,entry=mode==='beauty'?'fragment':mode==='gbuffer'?'gbuffer':'ambientFragment',lit=mode==='beauty';
      if(mode!=='gbuffer'&&this.lighting.size){let patched=code,ambient=false;
        // Effects with `pbr` hooks compose at gltf-pro's hook points; others (materials, LOD baking) still patch the text.
        for(const effect of this.lighting){if(effect.pbr){const hooks=effect.pbr(2);if(hooks){patched=lightPBR(patched,hooks);ambient||=!!hooks.ambient;}}else patched=effect.shader!(patched,2);}
        // An `ambient` hook (environment IBL) is what SSAO's ambient replay returns from the lit fragment, `_=color` keeping every
        // lighting binding in the layout. Unlit materials have no ambient.
        if(lit)code=patched;else if(ambient){let replay=this.replays.get(patched);if(replay===undefined){if(this.replays.size>=64)this.replays.clear();this.replays.set(patched,replay=patched.replace('return vec4f(color,','_=color;return vec4f(select(margoAmbient,vec3f(0),f.ext.x>0.5),'));}code=replay;entry='fragment';lit=true;}}
      // Keep the shader's original front-facing convention, including mirrored transforms.
      const cull:GPUCullMode=m.settings[2]<0.5?(v[97]>0?'back':'front'):'none';
      const state:PBRRenderState|undefined=mode==='beauty'?m.renderState:undefined;
      // Shader text enters the key as a small id: the code strings are cached objects, so the lookup hashes them once.
      let id=this.codes.get(code);if(id===undefined){if(this.codes.size>=256)this.codes.clear();this.codes.set(code,id=this.codeCount++);}
      const transmit=!!m.tint,blend=blended(m),key=mode+':'+c.format+':'+blend+transmit+':'+cull+':'+c.descriptor.multisample?.count+':'+c.descriptor.depthStencil!.format+':'+entry+':'+id+(state?JSON.stringify(state):'');
      let pipeline=this.pipelines.get(key);
      if(!pipeline) {
        const module=c.device.createShaderModule({code}),format=mode==='beauty'?c.format:'rgba16float';
        pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:80,attributes:Array.from({length:5},(_,i)=>({shaderLocation:i,offset:i*16,format:'float32x4' as const}))}]},
          fragment:{module,entryPoint:entry,targets:[{format,blend:state?.blend!==undefined?state.blend??undefined:blend&&mode!=='gbuffer'?{color:transmit?{srcFactor:'one',dstFactor:'constant'}:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}:undefined}]},
          multisample:c.descriptor.multisample,primitive:{cullMode:cull},depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:state?.depthWrite??(mode==='beauty'&&!blend),depthCompare:state?.depthCompare??(mode==='beauty'?'greater-equal':'equal')}});
        this.pipelines.set(key,pipeline);
      }
      let groups=r.groups.get(pipeline);
      if(!groups) {
        groups=[c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.uniform}}]}),
          c.device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:r.views.flatMap((view,i)=>[{binding:i*2,resource:view},{binding:i*2+1,resource:r.samplers[i]}])})];
        r.groups.set(pipeline,groups);
      }
      // Retain transparent pass boundaries so attachment-store rounding stays unchanged.
      if(blend&&mode!=='gbuffer'){pass?.end();pass=undefined;}
      pass??=c.encoder.beginRenderPass({colorAttachments:[{view:color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:depth,depthLoadOp:'load',depthStoreOp:'store',...(c.descriptor.depthStencil!.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})}});
      pass.setPipeline(pipeline);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,groups[1]);
      if(transmit&&mode!=='gbuffer')pass.setBlendConstant([...m.tint,1]);
      if(lit&&this.lighting.size){
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
      pass.setVertexBuffer(0,p.deformed??r.vertex);pass.setIndexBuffer(r.index,'uint32');pass.drawIndexed(p.indices.length);
      if(blend&&mode!=='gbuffer'){pass.end();pass=undefined;}
      if(mode==='beauty'){this.engine.stats.visible++;this.engine.stats.drawCalls++;}
    }}catch(error){try{pass?.end();}catch{}throw error;}
    pass?.end();
  }
  get bounds():Float32Array {
    this.engine.store.tick(false);const out=new Float32Array([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]);
    for(const p of this.primitives)for(let i=0;i<p.vertices.length;i+=20)for(let r=0;r<3;r++){
      const m=p.node.matrix,v=m[r]*p.vertices[i]+m[4+r]*p.vertices[i+1]+m[8+r]*p.vertices[i+2]+m[12+r];out[r]=Math.min(out[r],v);out[r+3]=Math.max(out[r+3],v);
    }
    return out;
  }
  /** World-space point and spot lights for `clustered.setLights()`. Directional lights are left to engine lighting; an unset range ends where intensity/d² reaches 1/256. */
  clusteredLights():GLTFClusteredLight[] {
    this.engine.store.tick(false);
    return this.lights.filter(l=>l.type!=='directional').map(l=>{
      const m=l.node.matrix,light:GLTFClusteredLight={position:[m[12],m[13],m[14]],range:l.range??(Math.sqrt(l.intensity*256)||1),color:l.color,intensity:l.intensity};
      if(l.type==='spot')Object.assign(light,{direction:[-m[8],-m[9],-m[10]],outerAngle:Math.min(l.outerConeAngle!,Math.PI/2-1e-4),innerAngle:Math.min(l.innerConeAngle!,Math.PI/2-1e-4)});
      return light;
    });
  }
  onDispose(callback:()=>void):()=>void {if(typeof callback!=='function')throw new TypeError('Expected cleanup callback');if(this.disposed){callback();return()=>{};}this.cleanupCallbacks.add(callback);return()=>this.cleanupCallbacks.delete(callback);}
  private releaseGPU():void {const cleanup=new Cleanup(),buffers=new Set<GPUBuffer>();for(const r of this.resources)for(const b of [r.vertex,r.index,r.uniform])if(b)buffers.add(b);for(const b of buffers)cleanup.run(()=>b.destroy());for(const t of this.textures)cleanup.run(()=>t.destroy());for(const p of this.primitives)p.buffers=undefined;this.resources=[];this.textures=[];this.pipelines.clear();this.lightingGroups.clear();cleanup.finish();}
  onDeviceRestored(engine:Engine):void {this.releaseGPU();for(const p of this.primitives)p.deformed=undefined;this.setup(engine);}
  dispose():void {
    if(this.disposed)return;this.disposed=true;const cleanup=new Cleanup();
    this.lighting.clear();
    cleanup.run(()=>this.engine.removePlugin(this.name)).run(()=>this.engine.frameGraph.removeOwner(this.name));
    for(const callback of this.cleanupCallbacks)cleanup.run(callback);this.cleanupCallbacks.clear();cleanup.run(()=>this.releaseGPU());
    for(let i=this.created.length-1;i>=0;i--)cleanup.run(()=>this.created[i].dispose());cleanup.run(()=>closeImages(this.images));cleanup.finish();
  }
  destroy():void {this.engine.removePlugin(this.name);if(!this.disposed)this.dispose();}
}
export function parseGLTF(instance:EngineKernel,input:string|object|ArrayBuffer|ArrayBufferView,buffers:Array<ArrayBuffer|ArrayBufferView>=[],images:readonly ImageBitmap[]=[]):PBRModel {
  const {doc,binary}=container(input),model=new PBRModel(instance,new GLTFAsset(doc,buffers,binary),images);
  try{engineRuntime(instance).use(model);return model;}catch(error){model.dispose();throw error;}
}
export function parsePreparedPBR(instance:EngineKernel,doc:GLTFAsset['doc'],geometry:readonly (readonly PreparedGeometry[])[],images:readonly ImageBitmap[]=[]):PBRModel {
  if(doc.buffers?.length||doc.skins?.length||doc.animations?.length||doc.nodes?.some((n:any)=>n.skin!==undefined)||!Array.isArray(geometry)||geometry.length!==doc.meshes?.length)throw new TypeError('Prepared PBR requires a static scene');
  const model=new PBRModel(instance,new GLTFAsset(doc,[]),images,geometry);
  try{engineRuntime(instance).use(model);return model;}catch(error){model.dispose();throw error;}
}
/** Fetch a .gltf/.glb, decode its images and any compressed data with `decoders`, then add the model to the engine. */
export async function loadGLTF(instance:EngineKernel,url:string|URL,options:GLTFLoadOptions={}):Promise<PBRModel> {return attach(instance,await loadAsset(url,options),options.signal);}
/** Like parseGLTF for in-memory JSON/GLB, but async so Draco, meshopt and KTX2 decoders can run; also decodes embedded images. External URIs resolve against the page. */
export async function parseGLTFAsync(instance:EngineKernel,input:string|object|ArrayBuffer|ArrayBufferView,options:AssetOptions={}):Promise<PBRModel> {return attach(instance,await loadAsset(undefined,options,input),options.signal);}
function attach(instance:EngineKernel,{asset,images}:{asset:GLTFAsset;images:GLTFImage[]},signal?:AbortSignal):PBRModel {
  let model:PBRModel|undefined;
  try {signal?.throwIfAborted();model=new PBRModel(instance,asset,images);engineRuntime(instance).use(model);return model;}
  catch(error){if(model)model.dispose();else closeImages(images);throw error;}
}
