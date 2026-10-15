/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext, type Mesh} from '@margoengine/core/extension';
import {invertMatrixStable} from '@margoengine/math/mat4';
import {viewMatrix} from '../../shared/view.js';
import {Cleanup} from '../../shared/cleanup.js';
import {GLTFAsset, container, loadAsset, closeImages, entry, integer, overBudget, type GLTFImage, type AssetOptions, type GLTFDecoderHooks, type GLTFExtendedMaterials} from './asset.js';
import {pbrShader, physicalShader, factorPhysicalShader, transmissiveShader, transparentPBR, capturePBR, transmissionPBR, type ExtendedPlan, type PBRLighting, type PBRTransparency, type PBRCapture, type PBRTransmission} from './shader.js';
import {lightPBR} from '../../shared/pbr-hooks.js';
export type {PBRLighting, PBRTransparency, PBRCapture, PBRTransmission, ExtendedPlan} from './shader.js';
import {mipShader} from './mip.js';
// Type only: PBRInstances and the EXT_mesh_gpu_instancing reader load with @margoengine/gltf-pro/instancing.
import type {PBRInstances} from './instancing.js';
import {packed, packPrimitive} from './pack.js';
export {GLTFAsset} from './asset.js';
export type {GLTFDocument, GLTFDecoderHooks, GLTFCompressedImage, GLTFImage, GLTFExtendedMaterials} from './asset.js';
/** KHR_lights_punctual light on a scene node, as data. Intensity is candela (point, spot) or lux (directional); the light points down the node's -Z. */
export interface GLTFLight {node:Mesh;nodeIndex:number;type:'directional'|'point'|'spot';color:number[];intensity:number;range?:number;innerConeAngle?:number;outerConeAngle?:number;name?:string}
/** glTF camera on a scene node, as data; the camera looks down the node's -Z. */
export interface GLTFCamera {node:Mesh;nodeIndex:number;type:'perspective'|'orthographic';perspective?:{yfov:number;znear:number;zfar?:number;aspectRatio?:number};orthographic?:{xmag:number;ymag:number;znear:number;zfar:number};name?:string}
/** A node's glTF `extras` object (Blender: the object's custom properties, exported with Include > Custom Properties) and a copy of its world matrix (column-major, translation in 12-14). */
export interface GLTFNodeExtras {node:Mesh;nodeIndex:number;name:string;extras:Record<string,unknown>;matrix:Float32Array}
/** Point or spot light shaped for @margoengine/clustered `setLights`. */
export interface GLTFClusteredLight {position:[number,number,number];range:number;color:[number,number,number];intensity:number;direction?:[number,number,number];outerAngle?:number;innerAngle?:number}
/** What `applyGLTFLights` uses of @margoengine/clustered's `Clustered` (structural, so gltf-pro does not import it). */
export interface GLTFLightReceiver {setLights(lights:GLTFClusteredLight[]):unknown;add(model:PBRModel):()=>void}
export type GLTFLoadOptions = Omit<AssetOptions,'buffers'>;
const srgbMaps=[0,4,9,12,17],normalMaps=[2,7],blended=(m:any)=>m.settings[0]===2||!!m.tint;
// An extended material's binding plan, by material object (progressive loading swaps in copies with fewer maps).
const plans=new WeakMap<object,ExtendedPlan>();
const planOf=(m:any,x:GLTFExtendedMaterials):ExtendedPlan=>{let plan=plans.get(m);if(!plan)plans.set(m,plan=x.plan(m.maps,m.extended));return plan;};
// Map slot i of resource material m gets its own texture and sampler: base slots always; extension slots of extended
// materials only when bound, once per shared glTF texture.
const ownSlot=(m:any,i:number,x?:GLTFExtendedMaterials)=>{if(!m.extended||i<5)return true;const slots=planOf(m,x!).slots,j=slots[i];return j>=0&&slots.indexOf(j)===i;};
// What a transparency hook takes over: plain alpha blending (transmission tints and custom render state keep the sorted path).
const separable=(m:any)=>m.settings[0]===2&&!m.tint&&!m.renderState,transmits=(m:any)=>!!m.tint&&!m.renderState;
// Names the material + effects combination instead of an invalid pipeline when the shader declares more sampled textures or
// samplers than the device allows per stage (WebGPU's default and guaranteed minimum is 16 of each; README "Texture bindings").
// ponytail: counts declarations, not per-stage use, so a texture read only in the vertex stage still counts.
function checkLimits(device:GPUDevice,code:string,combination:()=>string[]):void {
  for(const [kind,pattern,limit] of [['sampled textures',/var\s*\w+\s*:\s*texture_(?!storage)/g,device.limits?.maxSampledTexturesPerShaderStage??16],['samplers',/var\s*\w+\s*:\s*sampler/g,device.limits?.maxSamplersPerShaderStage??16]] as const){
    const count=code.match(pattern)?.length??0;
    if(count>limit)throw new RangeError(`gltf-pro: ${combination().join(' + ')} needs ${count} ${kind} per shader stage; this device allows ${limit}`);
  }
}
declare const GPUBufferUsage: {UNIFORM:number;STORAGE:number;VERTEX:number;INDEX:number;COPY_DST:number};
declare const GPUTextureUsage: {TEXTURE_BINDING:number;COPY_DST:number;RENDER_ATTACHMENT:number};
type Context = Extract<PassContext,{backend:'webgpu'}>;
export interface PBRPrimitive {
  node: Mesh; nodeIndex: number; vertices: Float32Array; indices: Uint32Array;
  definition: any; material: any; weights: Float32Array; targetNames: string[];
  deformed?: GPUBuffer;
  /** Draw once per instance (node space) in one instanced draw, see `PBRInstances` (@margoengine/gltf-pro/instancing); set for EXT_mesh_gpu_instancing nodes when `decoders.instancing` is passed. */
  instances?: PBRInstances;
  /** The 80-byte-stride vertex and uint32 index buffers while the model is set up on a device (for picking and outlines). */
  buffers?: {vertex: GPUBuffer; index: GPUBuffer};
  /** Set for glTF POINTS (`point-list`) and LINES, LINE_LOOP, LINE_STRIP (`line-list`, as index pairs); absent for triangles. */
  topology?: 'point-list'|'line-list';
}
/** Packed geometry: 20 floats per vertex and uint32 indices; `topology` as on PBRPrimitive (absent: a triangle list). */
export interface PreparedGeometry {vertices:Float32Array;indices:Uint32Array;topology?:'point-list'|'line-list'}
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
interface DrawResource {primitive:PBRPrimitive;vertex:GPUBuffer;index:GPUBuffer;uniform:GPUBuffer;volume?:GPUBuffer;values:Float32Array;groups:Map<GPURenderPipeline,GPUBindGroup[]>;views:GPUTextureView[];samplers:GPUSampler[]}
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
// `extended`: decoders.materials (@margoengine/gltf-pro/extended), which reads iridescence, anisotropy and diffuse
// transmission; without it they are ignored, as glTF allows for an optional extension.
function material(def:any = {},extended?:GLTFExtendedMaterials): any {
  const p=def.pbrMetallicRoughness??{}, alpha=def.alphaMode??'OPAQUE', e=def.extensions??{};
  if (!['OPAQUE','MASK','BLEND'].includes(alpha)) throw new TypeError('Invalid glTF alpha mode');
  if (def.doubleSided!==undefined&&typeof def.doubleSided!=='boolean') throw new TypeError('Invalid glTF doubleSided');
  const cc=e.KHR_materials_clearcoat,tr=e.KHR_materials_transmission,sh=e.KHR_materials_sheen,sp=e.KHR_materials_specular,vo=e.KHR_materials_volume;
  const base=vector(p.baseColorFactor??[1,1,1,1],4,'base color',0,1),transmission=scalar(tr?.transmissionFactor??0,0,1,'transmission'),strength=scalar(e.KHR_materials_emissive_strength?.emissiveStrength??1,0,Infinity,'emissive strength');
  const attenuation=vector(vo?.attenuationColor??[1,1,1],3,'attenuation color',0,1),thickness=scalar(vo?.thicknessFactor??0,0,Infinity,'thickness'),distance=vo?.attenuationDistance===undefined?Infinity:scalar(vo.attenuationDistance,Number.MIN_VALUE,Infinity,'attenuation distance'),depth=thickness/distance;
  // Extended materials: thin film, anisotropy or diffuse transmission in use (factor > 0); maps 13-17 and three more uniform rows.
  const x=extended?.parse(e),physical=!!(x||cc||tr||sh||sp||vo||e.KHR_materials_ior);
  const maps=[p.baseColorTexture,p.metallicRoughnessTexture,def.normalTexture,def.occlusionTexture,def.emissiveTexture,...physical?[cc?.clearcoatTexture,cc?.clearcoatRoughnessTexture,cc?.clearcoatNormalTexture,tr?.transmissionTexture,sh?.sheenColorTexture,sh?.sheenRoughnessTexture,sp?.specularTexture,sp?.specularColorTexture]:[],
    ...x?x.maps:[]]
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
      ...vector(sp?.specularColorFactor??[1,1,1],3,'specular color',0),scalar(sp?.specularFactor??1,0,1,'specular'),...vector(sh?.sheenColorFactor??[0,0,0],3,'sheen color',0,1),scalar(sh?.sheenRoughnessFactor??0,0,1,'sheen roughness'),...x?x.rows:[]]:undefined,
    extended:x?.features,
    // Transmission blends the background by this per-material tint (base color, Beer-Lambert volume attenuation at thicknessFactor).
    tint:transmission?base.slice(0,3).map((v,i)=>v*transmission*attenuation[i]**depth):undefined,
    // Transmission hook only: thickness (mesh space) and transmittance per world unit, attenuationColor^(1/attenuationDistance).
    volume:transmission?[thickness,...attenuation.map(c=>c**(1/distance))]:undefined};
}
function primitive(asset:GLTFAsset, p:any, node:Mesh, nodeIndex:number, mesh:any, materials:any[], packs:Map<object,PreparedGeometry>):PBRPrimitive {
  // Packing depends only on the primitive definition, so nodes sharing a mesh share its arrays (and GPU buffers, keyed by array).
  let g=packed.get(p)??packs.get(p);if(!g)packs.set(p,g=packPrimitive(asset,p));
  const {vertices,indices}=g;
  const m=fit(asset,p,p.material===undefined?material():materials[integer(p.material,'material')],!!g.topology);
  const targets=p.targets??[];if(!Array.isArray(targets))throw new TypeError('Invalid morph targets');
  const weights=vector(asset.doc.nodes[nodeIndex].weights??mesh.weights??Array(targets.length).fill(0),targets.length,'morph weights');
  const made:PBRPrimitive={node,nodeIndex,vertices,indices,definition:p,material:m,weights:Float32Array.from(weights),targetNames:targets.map((_:unknown,i:number)=>mesh.extras?.targetNames?.[i]??'Target '+i)};
  if(g.topology)made.topology=g.topology;
  return made;
}
// Material `m` as primitive `p` draws it: every map must name a texture and a UV set the primitive has. glTF 2.0 3.9.2:
// points and lines without NORMAL are rendered without lighting (here: the base colour, as KHR_materials_unlit).
function fit(asset:GLTFAsset,p:any,m:any,pointsOrLines:boolean):any {
  if(!m) throw new TypeError('Missing glTF material');
  const a=p.attributes??{};
  for (const map of m.maps) if(map) {
    const set=integer(map.texCoord??0,'texture coordinate');
    if(set>1||a[set===0?'TEXCOORD_0':'TEXCOORD_1']===undefined) throw new Error('Material requires available TEXCOORD_0 or TEXCOORD_1');
    entry(asset.doc.textures,map.index,'texture');
  }
  return pointsOrLines&&a.NORMAL===undefined?{...m,ext:[1,...m.ext.slice(1)]}:m;
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
  /**
   * glTF POINTS, LINES, LINE_LOOP and LINE_STRIP primitives (`topology` set), drawn in the beauty pass only: no shadows,
   * SSAO, SSR or transparency hook. Kept out of `primitives`, which picking, BVH, outlines, walk collisions and exporters
   * read as triangles. Empty for `@margoengine/gltf-pro/progressive` loads, which leave points and lines out.
   */
  readonly pointsAndLines:PBRPrimitive[]=[];
  /** KHR_materials_variants names in file order (empty without the extension); `selectVariant` takes a name or its index. */
  readonly variants:readonly string[];
  private readonly materials:any[];private readonly defaults=new Map<PBRPrimitive,any>();
  disposed=false;private readonly created:Mesh[]=[];private resources:DrawResource[]=[];private textures:GPUTexture[]=[];
  private pipelines=new Map<string,GPURenderPipeline>();private readonly gpuCache=new Map<unknown,any>();private readonly inverse=new Float32Array(16);private readonly workspace=new Float64Array(52);private readonly view=new Float32Array(16);
  private engine:Engine;private readonly cleanupCallbacks=new Set<()=>void>();
  private readonly lighting=new Set<LightingEffect>();private readonly codes=new Map<string,number>();private codeCount=0;private readonly replays=new Map<string,string>();
  private readonly lightingGroups=new Map<GPURenderPipeline,{entries:GPUBindGroupEntry[];group:GPUBindGroup}>();private transparency?:PBRTransparency;private capture?:PBRCapture;private transmission?:PBRTransmission;
  constructor(instance:EngineKernel,readonly asset:GLTFAsset,private readonly images:readonly GLTFImage[]=[],prepared?:readonly (readonly PreparedGeometry[])[]) {
    this.engine=engineRuntime(instance);
    const doc=asset.doc,defs=doc.nodes??[],parents=new Int32Array(defs.length).fill(-1),materials=this.materials=(doc.materials??[]).map((def:any)=>material(def,asset.hooks.materials));
    const variants=doc.extensions?.KHR_materials_variants?.variants??[];
    if(!Array.isArray(variants)||variants.some((v:any)=>typeof v?.name!=='string'))throw new TypeError('Invalid glTF material variants');
    this.variants=variants.map((v:any)=>v.name);
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
      let geometryBytes=0;const checked=new Set<PreparedGeometry>(),packs=new Map<object,PreparedGeometry>(),counted=new Set<Float32Array|Uint32Array>(),reader=asset.hooks.instancing;
      // Like a missing draco/ktx2 decoder: a required extension without its reader fails, a used-only one falls back (each mesh once).
      if(!reader&&doc.extensionsRequired?.includes('EXT_mesh_gpu_instancing'))throw new Error('Required glTF extensions are unsupported: EXT_mesh_gpu_instancing (pass decoders.instancing from @margoengine/gltf-pro/instancing)');
      for(const i of active)if(defs[i].mesh!==undefined) {
        const mesh=entry(doc.meshes,defs[i].mesh,'mesh');if(!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError('Missing primitives');
        if(prepared&&prepared[defs[i].mesh]?.length!==mesh.primitives.length)throw new TypeError('Missing prepared PBR primitives');
        const gpu=defs[i].extensions?.EXT_mesh_gpu_instancing,instances=gpu&&reader?.read(asset,gpu);
        for(let j=0;j<mesh.primitives.length;j++){
          const p=mesh.primitives[j];
          // ponytail: progressive's placeholders are triangle boxes, so it leaves points and lines out; stream them if CAD edges need it.
          if(!prepared&&(p?.mode??4)<4&&packed.has(p)&&!packed.get(p)!.topology)continue;
          const made:PBRPrimitive=prepared?preparedPrimitive(asset,p,prepared[defs[i].mesh][j],this.nodes[i],i,materials,checked):primitive(asset,p,this.nodes[i],i,mesh,materials,packs);for(const data of [made.vertices,made.indices])if(!counted.has(data)){geometryBytes+=data.byteLength;counted.add(data);}if(geometryBytes>asset.maxBytes*4)throw overBudget('Decoded glTF geometry exceeds byte budget',asset.maxBytes*4);if(instances)made.instances=instances;(made.topology?this.pointsAndLines:this.primitives).push(made);}
      }
      if(!this.primitives.length&&!this.pointsAndLines.length)throw new Error('glTF contains no renderable meshes');
    } catch(error) {for(const node of this.created.reverse())node.dispose();throw error;}
  }
  setup(engine:Engine):void {
    if(engine!==this.engine||this.disposed)throw new Error('PBRModel belongs to another engine or is disposed');
    if(!engine.gpu)throw new Error('PBRModel requires WebGPU');
    // GPU objects by source (geometry array, image key, mip format), kept until releaseGPU so a later setup of more
    // primitives (@margoengine/gltf-pro/progressive) shares them as one setup would.
    const device=engine.gpu,cache=this.gpuCache,mipSampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
    const upload=(data:Float32Array|Uint32Array,usage:number)=>{
      const existing=cache.get(data);if(existing)return existing;
      if(data.byteLength>device.limits.maxBufferSize)throw new RangeError('PBR buffer exceeds device limit');
      const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
      try{device.queue.writeBuffer(b,0,data as Float32Array<ArrayBuffer>);}catch(e){b.destroy();throw e;}cache.set(data,b);return b;
    };
    for(const p of this.pointsAndLines.length?[...this.primitives,...this.pointsAndLines]:this.primitives) {
      const r:DrawResource={primitive:p,vertex:undefined!,index:undefined!,uniform:undefined!,values:undefined!,groups:new Map(),views:[],samplers:[]};
      this.resources.push(r);r.vertex=upload(p.vertices,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE);r.index=upload(p.indices,GPUBufferUsage.INDEX);p.buffers={vertex:r.vertex,index:r.index};
      this.bindMaterial(r,device,mipSampler);
    }
  }
  // The material's uniform buffer (880 bytes, 1088 for extended materials), textures and samplers; again after a variant switch.
  private bindMaterial(r:DrawResource,device:GPUDevice,mipSampler:GPUSampler):void {
    const m=r.primitive.material,floats=m.extended?272:220,cache=this.gpuCache;
    if(r.values?.length!==floats){r.uniform?.destroy();r.values=new Float32Array(floats);r.uniform=device.createBuffer({size:floats*4,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});}
    r.views=[];r.samplers=[];r.groups.clear();
    for(let i=0;i<m.maps.length;i++) {
      if(!ownSlot(m,i,this.asset.hooks.materials)){r.views.push(undefined!);r.samplers.push(undefined!);continue;}
      const map=m.maps[i],def=map?entry(this.asset.doc.textures,map.index,'texture'):null;
      // KHR_texture_basisu, EXT_texture_webp and EXT_texture_avif sources win when decoded; otherwise the fallback source.
      const source=def?['KHR_texture_basisu','EXT_texture_webp','EXT_texture_avif'].map(k=>def.extensions?.[k]?.source).find(s=>s!==undefined&&this.images[s])??integer(def.source,'image'):-1,image=this.images[source];
      if(def&&!image)throw new TypeError('Missing decoded glTF image');
      const compressed=image&&'mipmaps' in image?image:undefined,format=compressed?compressed.format:srgbMaps.includes(i)?'rgba8unorm-srgb':'rgba8unorm',size=image?[image.width,image.height]:[1,1];
      if(size.some(n=>n>device.limits.maxTextureDimension2D))throw new RangeError('Image exceeds device limit');
      const key=image?source+':'+format:'default:'+i;
      let texture:GPUTexture=cache.get(key);
      if(!texture) {
        const levels=compressed?compressed.mipmaps.length:image?Math.floor(Math.log2(Math.max(...size)))+1:1;
        texture=device.createTexture({size,format,mipLevelCount:levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|(compressed?0:GPUTextureUsage.RENDER_ATTACHMENT)});
        this.textures.push(texture);cache.set(key,texture);
        // Transcoded mips upload as-is: rgba8 rows, or 16-byte 4x4 blocks (BC7, ASTC 4x4, ETC2 RGBA8).
        if(compressed){const block=format.startsWith('rgba')?1:4,target=texture;compressed.mipmaps.forEach((m,mipLevel)=>{const w=Math.ceil(m.width/block),h=Math.ceil(m.height/block);device.queue.writeTexture({texture:target,mipLevel},m.data as Uint8Array<ArrayBuffer>,{bytesPerRow:w*(block>1?16:4),rowsPerImage:h},[w*block,h*block]);});}
        else if(image)device.queue.copyExternalImageToTexture({source:image as ImageBitmap},{texture},size);
        else device.queue.writeTexture({texture},new Uint8Array(normalMaps.includes(i)?[128,128,255,255]:[255,255,255,255]),{bytesPerRow:4},[1,1]);
        if(levels>1&&!compressed) {
          let pipeline:GPURenderPipeline=cache.get(format);
          if(!pipeline){const module=device.createShaderModule({code:mipShader});pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format}]}});cache.set(format,pipeline);}
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
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:1,execute:c=>{if(c.backend==='webgpu')this.draw(c,'beauty',c.color,c.depth);}});}
  addLighting(effect:LightingEffect):()=>void {
    if(this.disposed||!effect||typeof (effect.pbr??effect.shader)!=='function'||typeof effect.bindings!=='function')throw new TypeError('Invalid PBR lighting effect');
    if(effect.owner&&effect.owner!==this.engine)throw new Error('PBR lighting belongs to another engine');
    this.lighting.add(effect);return()=>this.lighting.delete(effect);
  }
  /** Hands this model's BLEND primitives to a transparency hook (README "Transparency hook"); returns a remover that restores sorted blending. */
  setTransparency(hook:PBRTransparency):()=>void {
    if(this.disposed||!hook||typeof hook.declarations!=='function'||typeof hook.bindings!=='function'||typeof hook.begin!=='function'||!Array.isArray(hook.targets))throw new TypeError('Invalid PBR transparency hook');
    this.transparency=hook;return()=>{if(this.transparency===hook)this.transparency=undefined;};
  }
  /** Lets a capture hook (README "Capture hook"; SSR's `ssr.add(model)`) draw this model's materials with `draw(c, 'capture', ...)`; returns a remover. */
  setCapture(hook:PBRCapture):()=>void {
    if(this.disposed||!hook||typeof hook.declarations!=='function'||typeof hook.begin!=='function'||!Array.isArray(hook.targets))throw new TypeError('Invalid PBR capture hook');
    this.capture=hook;return()=>{if(this.capture===hook)this.capture=undefined;};
  }
  /** Hands this model's transmission primitives to a transmission hook (README "Transmission hook"); returns a remover that restores the tinted blend. */
  setTransmission(hook:PBRTransmission):()=>void {
    if(this.disposed||!hook||typeof hook.declarations!=='function'||typeof hook.bindings!=='function'||typeof hook.begin!=='function'||!Array.isArray(hook.targets))throw new TypeError('Invalid PBR transmission hook');
    this.transmission=hook;return()=>{if(this.transmission===hook)this.transmission=undefined;};
  }
  /**
   * Shows a KHR_materials_variants variant (a name from `variants` or its index): every primitive with a mapping for it draws
   * that material, the others their own (the glTF fallback); `undefined` restores every primitive's own material. A variant's
   * textures upload on first use and stay cached. With `@margoengine/gltf-pro/progressive`, call it after `complete`.
   */
  selectVariant(variant?:string|number):void {
    const index=typeof variant==='string'?this.variants.indexOf(variant):variant??-1;
    if(this.disposed||variant!==undefined&&!(Number.isInteger(index)&&index>=0&&index<this.variants.length))throw new RangeError(`selectVariant: the model has no material variant ${variant}`);
    // Every material is resolved (and validated) before any primitive changes.
    const changes:[PBRPrimitive,any][]=[];
    for(const p of [...this.primitives,...this.pointsAndLines]){
      const mappings=p.definition.extensions?.KHR_materials_variants?.mappings;if(mappings===undefined)continue;
      if(!Array.isArray(mappings))throw new TypeError('Invalid glTF material variant mappings');
      const own=this.defaults.get(p)??p.material,hit=mappings.find((m:any)=>Array.isArray(m?.variants)&&m.variants.includes(index));
      const m=hit?fit(this.asset,p.definition,this.materials[integer(hit.material,'material')],!!p.topology):own;
      if(m!==p.material)changes.push([p,m]);
    }
    const device=this.engine.gpu,resources=new Map(this.resources.map(r=>[r.primitive,r]));let mipSampler:GPUSampler|undefined;
    for(const [p,m] of changes){
      if(!this.defaults.has(p))this.defaults.set(p,p.material);
      p.material=m;const r=resources.get(p);
      if(r&&device)this.bindMaterial(r,device,mipSampler??=device.createSampler({minFilter:'linear',magFilter:'linear'}));
    }
  }
  get shadowPrimitives() {
    return this.resources.filter(r=>r.primitive.material.settings[0]!==2&&!r.primitive.topology).map(r=>({node:r.primitive.node,vertex:r.primitive.deformed??r.vertex,index:r.index,count:r.primitive.indices.length,stride:80,
      alphaTexture:r.views[0],alphaSampler:r.samplers[0],alpha:r.primitive.material.base[3],cutoff:r.primitive.material.settings[0]===1?r.primitive.material.settings[1]:0,texCoord:r.primitive.material.maps[0]?.texCoord??0,instances:r.primitive.instances}));
  }
  /** `transparent` draws only the BLEND primitives a transparency hook took over (`setTransparency`), into its pass; `transmission`
   * those a transmission hook took over (`setTransmission`); `capture` the opaque and MASK ones into the capture hook's pass
   * (`setCapture`); for these `color`/`depth` are unused. */
  draw(c:Context,mode:'beauty'|'gbuffer'|'ambient'|'transparent'|'transmission'|'capture',color:GPUTextureView,depth:GPUTextureView):void {
    const transmission=mode==='transmission',oit=transmission?this.transmission:this.transparency,through=mode==='transparent'||transmission,hook=this.capture,capture=mode==='capture';
    if(this.disposed||through&&!oit||capture&&!hook)return;
    viewMatrix(this.view,c.camera);
    const resources=through||capture?this.resources:[...this.resources].sort((a,b)=>{
      const blendA=blended(a.primitive.material),blendB=blended(b.primitive.material);
      if(blendA!==blendB)return +blendA-+blendB;
      const distance=(r:DrawResource)=>Math.hypot(...c.camera.position.map((v,i)=>v-r.primitive.node.matrix[12+i]));
      return blendA?distance(b)-distance(a):0;
    });
    let pass:GPURenderPassEncoder|undefined,shared:GPURenderPassEncoder|undefined;
    try {for(const r of resources) {
      const p=r.primitive,m=p.material,node=p.node,inst=p.instances;
      if(p.topology?mode!=='beauty':through?!(transmission?transmits(m):separable(m)):capture?blended(m)||m.ext[0]:mode==='beauty'&&(oit&&separable(m)||!!this.transmission&&transmits(m)))continue;
      node.check();let visible=true;
      for(let id=node.id;id!==-1;id=this.engine.store.parents[id])if(this.engine.store.hidden[id])visible=false;
      if(!visible||inst&&!inst.count)continue;
      const instances=inst?.upload(c.device);
      const v=r.values;v.set(c.camera.matrix);v.set(node.matrix,16);
      if(!invertMatrixStable(node.matrix,this.inverse,this.workspace))throw new Error('Singular PBR transform');
      for(let i=0;i<16;i++)v[32+i]=this.inverse[(i%4)*4+Math.floor(i/4)];
      v.set(this.view,48);v.set(c.camera.position,64);v.set(this.engine.lighting.direction,68);v.set(this.engine.lighting.radiance,72);
      v.set(m.base,76);v.set(m.factors,80);v.set(m.emission,84);v.set(m.settings,88);v[91]=+(c.format==='rgba16float');
      // coordsA/coordsB.x name each base map's slot; uv() reads that slot's KHR_texture_transform row, which carries its UV set.
      for(let i=0;i<5;i++)v[92+i]=i;
      const a=node.matrix;v[97]=Math.sign(a[0]*(a[5]*a[10]-a[6]*a[9])-a[4]*(a[1]*a[10]-a[2]*a[9])+a[8]*(a[1]*a[6]-a[2]*a[5]));
      v.set(m.ext,100);v.set(m.uvt,104);if(m.physical)v.set(m.physical,m.extended?248:208);
      // Physical rows follow 26 UV rows (36 for extended materials); factor-only materials (five maps) use the same layout.
      // The transmission tint (margoTint) in spare Frame lanes coordsB.zw and ext.z; zero for every other material.
      if(m.tint){v[98]=m.tint[0];v[99]=m.tint[1];v[102]=m.tint[2];}
      c.device.queue.writeBuffer(r.uniform,0,v as Float32Array<ArrayBuffer>);
      // Physical materials listing only the five core maps (materials built in code) draw the factor-only variant;
      // transmission draws its transmissive form, extended materials the shader of decoders.materials.
      const x=this.asset.hooks.materials,physical=m.physical?m.maps.length>5?physicalShader():factorPhysicalShader():pbrShader;
      let code=m.extended?x!.shader(planOf(m,x!)):m.tint?transmissiveShader(physical):physical,entry=mode==='beauty'||transmission?'fragment':mode==='gbuffer'?'gbuffer':through?'transparent':capture?'capture':'ambientFragment',lit=mode==='beauty'||through||capture;
      if(mode!=='gbuffer'&&this.lighting.size){
        let patched=code,ambient=false;
        // Effects with `pbr` hooks compose at gltf-pro's hook points; others (materials, LOD baking) still patch the text.
        for(const effect of this.lighting){if(effect.pbr){const hooks=effect.pbr(2);if(hooks){patched=lightPBR(patched,hooks);ambient||=!!hooks.ambient;}}else patched=effect.shader!(patched,2);}
        // An `ambient` hook (environment IBL) is what SSAO's ambient replay returns from the lit fragment, `_=color` keeping every
        // lighting binding in the layout. Unlit materials have no ambient.
        if(lit)code=patched;else if(ambient){let replay=this.replays.get(patched);if(replay===undefined){if(this.replays.size>=64)this.replays.clear();this.replays.set(patched,replay=patched.replace('return vec4f(color,','_=color;return vec4f(select(margoAmbient,vec3f(0),f.ext.x>0.5),'));}code=replay;entry='fragment';lit=true;}}
      if(transmission)code=transmissionPBR(code,oit!.declarations(2));else if(through)code=transparentPBR(code,oit!.declarations(2));else if(capture)code=capturePBR(code,hook!.declarations(code));
      // Instancing patches the vertex stage last, so text-patching effects (shader NodeMaterial vertex nodes) keep their anchors.
      if(inst)code=inst.shader(code);
      // Keep the shader's original front-facing convention, including mirrored transforms.
      // Mirrored instances flip winding per instance: no culling, the shader's face test discards back faces instead.
      const face=+(!!inst?.mirrored&&m.settings[2]<0.5),cull:GPUCullMode=m.settings[2]<0.5&&!face?(v[97]>0?'back':'front'):'none';
      const state:PBRRenderState|undefined=mode==='beauty'?m.renderState:undefined;
      // Shader text enters the key as a small id: the code strings are cached objects, so the lookup hashes them once.
      // Discard only where it can happen: back faces are culled by the pipeline and only MASK materials alpha-test.
      const mask=+(m.settings[0]===1);let id=this.codes.get(code);if(id===undefined){if(this.codes.size>=256)this.codes.clear();this.codes.set(code,id=this.codeCount++);}
      const transmit=!!m.tint,blend=blended(m),tinted=transmit&&(mode==='beauty'||mode==='ambient')&&state?.blend===undefined,key=mode+':'+c.format+':'+blend+transmit+':'+cull+':'+c.descriptor.multisample?.count+':'+c.descriptor.depthStencil!.format+':'+entry+':'+id+':'+mask+(state?JSON.stringify(state):'')+(inst?':i'+face:'')+(p.topology?':'+p.topology:'');
      let pipeline=this.pipelines.get(key);
      if(!pipeline) {
        checkLimits(c.device,code,()=>[m.extended?'extended material':m.physical?'physical material':'material',...transmission?['transmission']:[],...[...this.lighting].flatMap(e=>{const x=e as {name?:string;shadow?:{name?:string}};return [x.name??'shader patch',...x.shadow?.name?[x.shadow.name]:[]];})]);
        const module=c.device.createShaderModule({code}),format=mode==='beauty'?c.format:'rgba16float';
        const descriptor:GPURenderPipelineDescriptor={layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:80,attributes:Array.from({length:5},(_,i)=>({shaderLocation:i,offset:i*16,format:'float32x4' as const}))},...inst?[inst.layout]:[]]},
          fragment:{module,entryPoint:entry,constants:{margoFaceTest:face,margoAlphaTest:mask},targets:through||capture?(through?oit!:hook!).targets as GPUColorTargetState[]:[{format,blend:state?.blend!==undefined?state.blend??undefined:blend&&mode!=='gbuffer'?{color:transmit?{srcFactor:'one',dstFactor:'one'}:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}:undefined}]},
          multisample:c.descriptor.multisample,primitive:p.topology?{topology:p.topology}:{cullMode:cull},depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:state?.depthWrite??((mode==='beauty'||capture)&&!blend),depthCompare:state?.depthCompare??(mode==='beauty'||through||capture?'greater-equal':'equal')}};
        pipeline=c.device.createRenderPipeline(descriptor);this.pipelines.set(key,pipeline);
        // Transmission's first draw: what is behind times the tint (no blend constant, see below).
        if(tinted)this.pipelines.set(key+':tint',c.device.createRenderPipeline({...descriptor,fragment:{module,entryPoint:'margoTint',targets:[{format,blend:{color:{srcFactor:'zero',dstFactor:'src'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]}}));
      }
      let groups=r.groups.get(pipeline);
      if(!groups) {
        groups=[c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.uniform}},...transmission?[{binding:1,resource:{buffer:r.volume??=c.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}}]:[]]}),
          c.device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:r.views.flatMap((view,i)=>{const b=i<5||!m.extended?i*2:10+planOf(m,x!).slots[i]*2;return view?[{binding:b,resource:view},{binding:b+1,resource:r.samplers[i]}]:[];})})];
        r.groups.set(pipeline,groups);
      }
      let target:GPURenderPassEncoder;
      if(through||capture)target=shared??=(through?oit!:hook!).begin();
      else {
      // Retain transparent pass boundaries so attachment-store rounding stays unchanged.
      if(blend&&mode!=='gbuffer'){pass?.end();pass=undefined;}
      target=pass??=c.encoder.beginRenderPass({colorAttachments:[{view:color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:depth,depthLoadOp:'load',depthStoreOp:'store',...(c.descriptor.depthStencil!.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})}});
      }
      if(transmission)c.device.queue.writeBuffer(r.volume!,0,new Float32Array(m.volume));
      // Transmission draws twice: margoTint multiplies the background by the tint, then the lit surface adds on top. One
      // draw with a blend constant (dst x tint) rendered black behind the glass in Edge on an Arc 140V (D3D12, 4x MSAA): the
      // constant read as 0 for pipelines used across frames (HANDOFF 5w.f).
      if(tinted){
        const tint=this.pipelines.get(key+':tint')!;let group=r.groups.get(tint);
        if(!group){group=[c.device.createBindGroup({layout:tint.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.uniform}}]})];r.groups.set(tint,group);}
        target.setPipeline(tint);target.setBindGroup(0,group[0]);target.setVertexBuffer(0,p.deformed??r.vertex);if(instances)target.setVertexBuffer(1,instances);target.setIndexBuffer(r.index,'uint32');
        if(inst)target.drawIndexed(p.indices.length,inst.count);else target.drawIndexed(p.indices.length);
      }
      target.setPipeline(pipeline);target.setBindGroup(0,groups[0]);target.setBindGroup(1,groups[1]);
      if(lit&&(this.lighting.size||through)){
        const entries=[...this.lighting].flatMap(effect=>effect.bindings());if(through)entries.push(...oit!.bindings());let cached=this.lightingGroups.get(pipeline);
        if(!cached||entries.length!==cached.entries.length||entries.some((entry,i)=>{
          const previous=cached!.entries[i],resource=entry.resource,old=previous.resource;
          return entry.binding!==previous.binding||!(resource===old||'buffer' in resource&&'buffer' in old&&resource.buffer===old.buffer&&resource.offset===old.offset&&resource.size===old.size);
        })){
          const snapshot=entries.map(({binding,resource})=>({binding,resource:'buffer' in resource?{buffer:resource.buffer,offset:resource.offset,size:resource.size}:resource}));
          const group=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries});cached={entries:snapshot,group};this.lightingGroups.set(pipeline,cached);
        }
        target.setBindGroup(2,cached.group);
      }
      target.setVertexBuffer(0,p.deformed??r.vertex);if(instances)target.setVertexBuffer(1,instances);target.setIndexBuffer(r.index,'uint32');
      if(inst)target.drawIndexed(p.indices.length,inst.count);else target.drawIndexed(p.indices.length);
      if(blend&&mode!=='gbuffer'&&!through){pass!.end();pass=undefined;}
      if(mode==='beauty'||through){this.engine.stats.visible+=inst?inst.count:1;this.engine.stats.drawCalls++;}
    }}catch(error){try{pass?.end();}catch{}throw error;}
    pass?.end();
  }
  get bounds():Float32Array {
    this.engine.store.tick(false);const out=new Float32Array([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]);
    for(const p of this.pointsAndLines.length?[...this.primitives,...this.pointsAndLines]:this.primitives){
      if(p.instances){p.instances.bounds(p.node.matrix,p.vertices,out);continue;}
      for(let i=0;i<p.vertices.length;i+=20)for(let r=0;r<3;r++){
        const m=p.node.matrix,v=m[r]*p.vertices[i]+m[4+r]*p.vertices[i+1]+m[8+r]*p.vertices[i+2]+m[12+r];out[r]=Math.min(out[r],v);out[r+3]=Math.max(out[r+3],v);
      }
    }
    return out;
  }
  /** World-space point and spot lights for `clustered.setLights()`. Directional lights are left to engine lighting; an unset range ends where intensity/d² reaches 1/256. */
  clusteredLights():GLTFClusteredLight[] {
    this.engine.store.tick(false);
    return this.lights.filter(l=>l.type!=='directional').map(l=>{
      const m=l.node.matrix,light:GLTFClusteredLight={position:[m[12],m[13],m[14]],range:l.range??(Math.sqrt(l.intensity*256)||1),color:l.color as [number,number,number],intensity:l.intensity};
      if(l.type==='spot')Object.assign(light,{direction:[-m[8],-m[9],-m[10]],outerAngle:Math.min(l.outerConeAngle!,Math.PI/2-1e-4),innerAngle:Math.min(l.innerConeAngle!,Math.PI/2-1e-4)});
      return light;
    });
  }
  /** Every node whose glTF `extras` is an object, in node order, with its current world matrix: markers and spawn points placed in Blender. Mesh and material extras stay in `asset.doc.meshes[i].extras` and `asset.doc.materials[i].extras`. */
  extras():GLTFNodeExtras[] {
    this.engine.store.tick(false);const out:GLTFNodeExtras[]=[];
    (this.asset.doc.nodes??[]).forEach((def:any,i:number)=>{const e=def.extras;if(e&&typeof e==='object'&&!Array.isArray(e))out.push({node:this.nodes[i],nodeIndex:i,name:this.nodes[i].name,extras:e,matrix:this.nodes[i].matrix.slice()});});
    return out;
  }
  onDispose(callback:()=>void):()=>void {if(typeof callback!=='function')throw new TypeError('Expected cleanup callback');if(this.disposed){callback();return()=>{};}this.cleanupCallbacks.add(callback);return()=>this.cleanupCallbacks.delete(callback);}
  private releaseGPU():void {const cleanup=new Cleanup(),buffers=new Set<GPUBuffer>();for(const r of this.resources)for(const b of [r.vertex,r.index,r.uniform,r.volume])if(b)buffers.add(b);for(const b of buffers)cleanup.run(()=>b.destroy());for(const t of this.textures)cleanup.run(()=>t.destroy());for(const p of [...this.primitives,...this.pointsAndLines]){p.buffers=undefined;cleanup.run(()=>p.instances?.dispose());}this.resources=[];this.textures=[];this.pipelines.clear();this.gpuCache.clear();this.lightingGroups.clear();cleanup.finish();}
  onDeviceRestored(engine:Engine):void {this.releaseGPU();for(const p of this.primitives)p.deformed=undefined;this.setup(engine);}
  dispose():void {
    if(this.disposed)return;this.disposed=true;const cleanup=new Cleanup();
    this.lighting.clear();
    cleanup.run(()=>this.engine.removePlugin(this.name)).run(()=>this.engine.frameGraph.removeOwner(this.name));
    for(const callback of this.cleanupCallbacks)cleanup.run(callback);this.cleanupCallbacks.clear();cleanup.run(()=>this.releaseGPU());
    for(let i=this.created.length-1;i>=0;i--)cleanup.run(()=>this.created[i].dispose());cleanup.run(()=>closeImages(this.images));cleanup.finish();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy():void {this.dispose();}
}
/** Synchronous parse of in-memory JSON/GLB with decoded `images`; `decoders` takes only the synchronous `instancing` reader and the `materials` shaders; `maxNodes` as for loadGLTF. */
export function parseGLTF(instance:EngineKernel,input:string|object|ArrayBuffer|ArrayBufferView,buffers:Array<ArrayBuffer|ArrayBufferView>=[],images:readonly ImageBitmap[]=[],decoders:Pick<GLTFDecoderHooks,'instancing'|'materials'>={},{maxNodes}:Pick<AssetOptions,'maxNodes'>={}):PBRModel {
  const {doc,binary}=container(input),model=new PBRModel(instance,new GLTFAsset(doc,buffers,binary,decoders,undefined,maxNodes),images);
  try{engineRuntime(instance).use(model);return model;}catch(error){model.dispose();throw error;}
}
/** A static scene whose geometry is already packed (as @margoengine/blender's .margo); `maxNodes` as for loadGLTF. */
export function parsePreparedPBR(instance:EngineKernel,doc:GLTFAsset['doc'],geometry:readonly (readonly PreparedGeometry[])[],images:readonly ImageBitmap[]=[],{maxNodes}:Pick<AssetOptions,'maxNodes'>={}):PBRModel {
  if(doc.buffers?.length||doc.skins?.length||doc.animations?.length||doc.nodes?.some((n:any)=>n.skin!==undefined)||!Array.isArray(geometry)||geometry.length!==doc.meshes?.length)throw new TypeError('Prepared PBR requires a static scene');
  const model=new PBRModel(instance,new GLTFAsset(doc,[],undefined,{},undefined,maxNodes),images,geometry);
  try{engineRuntime(instance).use(model);return model;}catch(error){model.dispose();throw error;}
}
/** Fetch a .gltf/.glb, decode its images and any compressed data with `decoders`, then add the model to the engine. */
export async function loadGLTF(instance:EngineKernel,url:string|URL,options:GLTFLoadOptions={}):Promise<PBRModel> {return attach(instance,await loadAsset(url,options),options.signal);}
/** Like parseGLTF for in-memory JSON/GLB, but async so Draco, meshopt and KTX2 decoders can run; also decodes embedded images. External URIs resolve against the page. */
export async function parseGLTFAsync(instance:EngineKernel,input:string|object|ArrayBuffer|ArrayBufferView,options:AssetOptions={}):Promise<PBRModel> {return attach(instance,await loadAsset(undefined,options,input),options.signal);}
/**
 * Applies a model's KHR_lights_punctual lights in one call. The first directional light becomes the engine's light
 * (`engine.lighting`: direction toward the light, its colour, and its lux x `exposure` as the strength; core's default
 * strength is 3 and core has one directional light, so further ones are ignored). Point and spot lights go to `clustered`
 * (@margoengine/clustered, candela x `exposure`), which then lights the model; without it they are ignored. Lights are
 * placed where their nodes are now: after moving the model, call `clustered.setLights(model.clusteredLights())` (or this
 * again for the sun). Call once per clustered instance; returns the remover from `clustered.add` (a no-op without one).
 */
export function applyGLTFLights(model:PBRModel,{clustered,exposure=1}:{clustered?:GLTFLightReceiver;exposure?:number}={}):()=>void {
  if(!Number.isFinite(exposure)||exposure<0)throw new RangeError('applyGLTFLights: exposure must be a finite number >= 0');
  const engine=model['engine'],sun=model.lights.find(l=>l.type==='directional');
  if(sun){engine.store.tick(false);const m=sun.node.matrix,length=Math.hypot(m[8],m[9],m[10])||1;engine.lighting.direction.set([m[8]/length,m[9]/length,m[10]/length,sun.intensity*exposure]);engine.lighting.radiance.set(sun.color);}
  if(!clustered)return()=>{};
  const lights=model.clusteredLights();for(const light of lights)light.intensity*=exposure;
  clustered.setLights(lights);return clustered.add(model);
}
const orthographic=new WeakSet<object>();
/**
 * Views through one of the model's glTF cameras (`model.cameras[camera]`, default the first) with the engine camera:
 * position, view direction and up from the camera node's world matrix now. Perspective: `yfov` and `znear`, `zfar` when
 * set (else the camera keeps its `far`), with the canvas aspect. Orthographic: `ymag`, `znear` and `zfar` through
 * `camera.project`, the width following the canvas aspect; a later perspective camera removes that projection. The target
 * is 1 unit ahead, so orbit controls turn the view around that point (call their `saveState()` afterwards).
 */
export function viewGLTFCamera(model:PBRModel,camera:number|GLTFCamera=0):void {
  const def=typeof camera==='number'?model.cameras[camera]:camera;if(!def)throw new RangeError(`viewGLTFCamera: the model has no glTF camera ${camera}`);
  const engine=model['engine'],view=engine.camera;engine.store.tick(false);
  const m=def.node.matrix,z=Math.hypot(m[8],m[9],m[10])||1,y=Math.hypot(m[4],m[5],m[6])||1;
  view.position=[m[12],m[13],m[14]];view.target=[m[12]-m[8]/z,m[13]-m[9]/z,m[14]-m[10]/z];view.up=[m[4]/y,m[5]/y,m[6]/y];
  if(def.type==='perspective'){
    const p=def.perspective!;view.fov=p.yfov*180/Math.PI;view.near=p.znear;if(p.zfar!==undefined)view.far=p.zfar;if(view.project&&orthographic.has(view.project))view.project=undefined;
  }else{
    const {ymag,znear:near,zfar:far}=def.orthographic!,depth=far-near;view.near=near;view.far=far;
    // Column-major; WebGPU depth is reversed (near 1, far 0) like core's perspective.
    view.project=(out,aspect,webgpu)=>{out[0]=1/(Math.abs(ymag)*aspect);out[5]=1/Math.abs(ymag);out[10]=webgpu?1/depth:-2/depth;out[14]=webgpu?far/depth:-(far+near)/depth;out[15]=1;};
    orthographic.add(view.project);
  }
}
function attach(instance:EngineKernel,{asset,images}:{asset:GLTFAsset;images:GLTFImage[]},signal?:AbortSignal):PBRModel {
  let model:PBRModel|undefined;
  try {signal?.throwIfAborted();model=new PBRModel(instance,asset,images);engineRuntime(instance).use(model);return model;}
  catch(error){if(model)model.dispose();else closeImages(images);throw error;}
}
