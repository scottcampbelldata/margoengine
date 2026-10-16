/// <reference lib="esnext.disposable" preserve="true" />
import type {MaterialExtension, MaterialExtensionTexture, PBRModel, PBRPrimitive} from '@margoengine/gltf-pro';
import type {Engine, EnginePlugin} from '@margoengine/core/extension';
import type {MaterialGraph, NodeMaterialOptions} from './node-types.js';
import {clearcoatShader} from './shader.js';
import {transmissionShader} from './transmission-shader.js';
import {acquireOpaqueColor} from './opaque-color.js';
import {Cleanup} from '../../shared/cleanup.js';

type Kind=1|3|4|'metalRough'|'clearcoat'|'transmission'|'emit';
interface Value {node:any;kind:Kind;deps:Value[];constant?:number[];coord?:0|1;name:string}
const fields:Record<string,readonly string[]>={color:['value'],scalar:['value'],texture:['texture','texCoord'],add:['a','b'],mul:['a','b'],mix:['a','b','factor'],normalMap:['texture','scale','texCoord'],metalRough:['texture','roughness','metal'],clearcoat:['factor','roughness','normal'],transmission:['factor','ior','volume'],emit:['color','normal','metalRough','clearcoat','transmission']};
function object(value:any,label:string):void {if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid node '+label);}
function keys(value:any,allowed:readonly string[],label:string):void {object(value,label);for(const key of Object.keys(value))if(!allowed.includes(key))throw new TypeError('Unsupported node '+label+' field: '+key);}
function number(value:any,label:string):number {if(typeof value!=='number'||!Number.isFinite(Math.fround(value)))throw new TypeError('Non-finite node '+label);return Math.fround(value);}
function uv(value:any):0|1 {if(value!==undefined&&value!==0&&value!==1)throw new TypeError('Node texture requires UV0 or UV1');return value??0;}
function numeric(value:Value,label:string):void {if(value.kind!==1&&value.kind!==4)throw new TypeError('Node '+label+' requires scalar or vec4');}
function width(value:Value,kind:Kind,label:string):void {if(value.kind!==kind)throw new TypeError('Node '+label+' requires '+(kind===1?'scalar':kind===4?'vec4':kind));}
function component(value:Value|undefined,channel:string,fallback:string):string {return value?value.name+(value.kind===4?'.'+channel:''):fallback;}
function child(value:Value,key:string,values:Map<object,Value>):Value|undefined {return value.node[key]===undefined?undefined:values.get(value.node[key]);}
function constantChannel(value:Value|undefined,channel=0,fallback=0):number|undefined {
  // Only literal zeros can remove a lobe: GPU arithmetic may fuse or round differently.
  return value?(value.node.type==='scalar'||value.node.type==='color'?value.constant?.[value.kind===1?0:channel]:undefined):fallback;
}

const normalShader=/* wgsl */`
fn materialNodeNormal(i:Out,front:bool,sample:vec4f,scale:f32,coord:f32)->vec3f {
  let facing=front==(f.coordsB.y>0);let n=normalize(i.normal)*select(-1.0,1.0,facing);
  var t=i.tangent.xyz-n*dot(n,i.tangent.xyz);var b=cross(n,t)*i.tangent.w;
  let dp1=dpdx(i.position);let dp2=dpdy(i.position);let duv1=dpdx(uv(i,coord));let duv2=dpdy(uv(i,coord));
  if(abs(i.tangent.w)<0.5||f.coordsA.z!=coord){
    let p1=cross(n,dp1);let p2=cross(dp2,n);t=p2*duv1.x+p1*duv2.x;b=p2*duv1.y+p1*duv2.y;
    let k=inverseSqrt(max(max(dot(t,t),dot(b,b)),0.000001));t*=k;b*=k;
  }else{t/=max(length(t),0.000001);b=cross(n,t);b=b/max(length(b),0.000001)*i.tangent.w;}
  let sampled=sample.xyz*2-1;let magnitude=max(abs(scale),1.0);
  let mapped=t*sampled.x*(scale/magnitude)+b*sampled.y*(scale/magnitude)+n*(sampled.z/magnitude);
  let size=length(mapped);return select(n,mapped/max(size,0.000001),size>0.000001);
}
`;

function compile(graph:MaterialGraph,options:NodeMaterialOptions={},allowMissing=false):{extension:MaterialExtension;transmits:boolean;opaqueIndex?:number;uvSets:Set<0|1>} {
  keys(graph,['nodes'],'graph');keys(options,['opaqueColor'],'options');
  if(!Array.isArray(graph.nodes)||!graph.nodes.length||graph.nodes.length>256)throw new RangeError('Node graph requires 1 to 256 nodes');
  const values=new Map<object,Value>(),active=new Set<object>(),order:Value[]=[],emits:Value[]=[];
  const visit=(node:any,depth=0):Value=>{
    object(node,'reference');if(active.has(node))throw new Error('Node graph cycle');const ready=values.get(node);if(ready)return ready;
    if(depth>128||values.size+active.size>=256)throw new RangeError('Node graph exceeds size or depth limit');
    if(typeof node.type!=='string'||!Object.hasOwn(fields,node.type))throw new TypeError('Unsupported node type or attribute: '+String(node.type));
    keys(node,['type',...fields[node.type]],node.type);active.add(node);
    const deps:Value[]=[],ref=(key:string,required=false):Value|undefined=>{
      if(node[key]===undefined){if(required)throw new TypeError('Node '+node.type+' requires '+key);return undefined;}
      const value=visit(node[key],depth+1);deps.push(value);return value;
    };
    const value:Value={node,kind:1,deps,name:''};
    switch(node.type){
      case 'scalar':value.constant=[number(node.value,'scalar')];break;
      case 'color':
        if(!Array.isArray(node.value)||node.value.length!==4)throw new TypeError('Node color requires vec4');
        value.kind=4;value.constant=Array.from(node.value,(n:any)=>number(n,'color'));break;
      case 'texture':
        keys(node.texture,['view','sampler'],'texture');if(!node.texture.view||node.texture.sampler!==undefined&&!node.texture.sampler)throw new TypeError('Node texture requires a view and optional sampler');
        value.kind=4;value.coord=uv(node.texCoord);break;
      case 'add':case 'mul':case 'mix':{
        const a=ref('a',true)!,b=ref('b',true)!;numeric(a,node.type);numeric(b,node.type);value.kind=a.kind===4||b.kind===4?4:1;
        const factor=node.type==='mix'?ref('factor',true):undefined;
        if(factor){numeric(factor,'mix factor');if(factor.kind!==1&&factor.kind!==value.kind)throw new TypeError('Node mix factor width mismatch');}
        if(a.coord!==undefined&&a.coord===b.coord)value.coord=a.coord;else value.coord=a.coord??b.coord;
        if(a.constant&&b.constant&&(!factor||factor.constant))value.constant=Array.from({length:value.kind as number},(_,i)=>{
          const x=a.constant![a.kind===1?0:i],y=b.constant![b.kind===1?0:i],t=factor?.constant?.[factor.kind===1?0:i]??0;
          return number(node.type==='add'?x+y:node.type==='mul'?x*y:x*(1-t)+y*t,'arithmetic result');
        });break;
      }
      case 'normalMap':{
        const texture=ref('texture',true)!,scale=ref('scale');width(texture,4,'normalMap texture');if(scale)width(scale,1,'normal scale');value.kind=3;value.coord=node.texCoord===undefined?texture.coord??0:uv(node.texCoord);break;
      }
      case 'metalRough':{
        const texture=ref('texture'),roughness=ref('roughness'),metal=ref('metal');if(texture)width(texture,4,'metalRough texture');if(roughness)numeric(roughness,'roughness');if(metal)numeric(metal,'metal');value.kind='metalRough';break;
      }
      case 'clearcoat':{
        const factor=ref('factor'),roughness=ref('roughness'),normal=ref('normal');if(factor)numeric(factor,'clearcoat factor');if(roughness)numeric(roughness,'clearcoat roughness');if(normal)width(normal,3,'clearcoat normal');value.kind='clearcoat';break;
      }
      case 'transmission':{
        const factor=ref('factor'),ior=ref('ior');if(factor)numeric(factor,'transmission factor');if(ior){width(ior,1,'IOR');if(ior.constant&&ior.constant[0]<1)throw new RangeError('Node IOR must be at least 1');}
        if(node.volume!==undefined){
          keys(node.volume,['thickness','attenuationColor','attenuationDistance'],'volume');
          if((constantChannel(factor)??1)<=0)throw new Error('KHR_materials_volume requires transmission');
          for(const field of ['thickness','attenuationColor'])if(node.volume[field]!==undefined){const v=visit(node.volume[field],depth+1);deps.push(v);if(field==='thickness')numeric(v,'thickness');else width(v,4,'attenuation color');}
          const distance=node.volume.attenuationDistance;
          if(distance!==undefined&&(typeof distance!=='number'||distance<=0||Number.isNaN(distance)||!Number.isFinite(Math.fround(1/distance))))throw new RangeError('Invalid node attenuation distance');
        }
        value.kind='transmission';break;
      }
      case 'emit':{
        width(ref('color',true)!,4,'emit color');
        for(const [field,kind] of [['normal',3],['metalRough','metalRough'],['clearcoat','clearcoat'],['transmission','transmission']] as const){const v=ref(field);if(v)width(v,kind,'emit '+field);}
        value.kind='emit';emits.push(value);break;
      }
    }
    active.delete(node);values.set(node,value);order.push(value);return value;
  };
  for(const node of graph.nodes)visit(node);
  if(emits.length!==1)throw new Error('Node graph requires exactly one emit');
  const emit=emits[0],reachable=new Set<Value>(),mark=(value:Value)=>{if(reachable.has(value))return;reachable.add(value);for(const dep of value.deps)mark(dep);};mark(emit);
  const factors:number[]=[],textures:MaterialExtensionTexture[]=[],uvSets=new Set<0|1>();let statements='',declarations='',direct='',output='',needsNormal=false;
  const uniform=(values:readonly number[])=>{const index=factors.length/4;factors.push(...values,...Array(4-values.length).fill(0));return `materialFactors[${index}]`;};
  for(const value of order)if(reachable.has(value)){
    const node=value.node;value.name='materialNode'+order.indexOf(value);
    switch(node.type){
      case 'scalar':statements+=`let ${value.name}=${uniform(value.constant!)}.x;\n`;break;
      case 'color':statements+=`let ${value.name}=${uniform(value.constant!)};\n`;break;
      case 'texture':{
        const index=textures.length;uvSets.add(value.coord!);textures.push({view:node.texture.view,...(node.texture.sampler?{sampler:node.texture.sampler}:{})});
        const image=`materialTexture${index}`,coords=`uv(i,${value.coord}.0)`,size=`vec2f(textureDimensions(${image},0))`;
        statements+=`let ${value.name}=${node.texture.sampler?`textureSample(${image},materialSampler${index},${coords})`:`textureLoad(${image},vec2i(clamp(${coords}*${size},vec2f(0),${size}-vec2f(1))),0)`};\n`;break;
      }
      case 'add':case 'mul':case 'mix':{
        const a=child(value,'a',values)!,b=child(value,'b',values)!,factor=child(value,'factor',values);
        const cast=(v:Value)=>value.kind===4&&v.kind===1?`vec4f(${v.name})`:v.name;
        statements+=`let ${value.name}=${node.type==='mix'?`mix(${cast(a)},${cast(b)},${factor!.name})`:`(${cast(a)}${node.type==='add'?'+':'*'}${cast(b)})`};\n`;break;
      }
      case 'normalMap':{
        needsNormal=true;uvSets.add(value.coord!);statements+=`let ${value.name}=materialNodeNormal(i,front,${child(value,'texture',values)!.name},${child(value,'scale',values)?.name??'1.0'},${value.coord}.0);\n`;break;
      }
    }
  }
  const color=child(emit,'color',values)!,normal=child(emit,'normal',values),mr=child(emit,'metalRough',values),coat=child(emit,'clearcoat',values),transmission=child(emit,'transmission',values);
  statements+=`s.base=${color.name};s.roughness=1.0;s.metal=0.0;s.emissive=vec3f(0);s.occlusion=1.0;\n`;
  if(normal)statements+=`s.n=${normal.name};\n`;
  if(mr){
    const texture=child(mr,'texture',values);
    statements+=`s.roughness=clamp(${component(child(mr,'roughness',values),'g','1.0')}${texture?'*'+texture.name+'.g':''},0.045,1.0);s.metal=clamp(${component(child(mr,'metal',values),'b',texture?'1.0':'0.0')}${texture?'*'+texture.name+'.b':''},0.0,1.0);\n`;
  }
  if(coat){
    const shader=clearcoatShader({}, {factor:component(child(coat,'factor',values),'r','0.0'),roughness:component(child(coat,'roughness',values),'g','0.0'),normal:child(coat,'normal',values)?.name});
    statements+=shader.wgsl+'\n';declarations+=shader.declarations;direct=shader.direct??'';
  }
  let transmits=false,opaqueIndex:number|undefined;
  if(transmission&&(constantChannel(child(transmission,'factor',values))??1)>0){
    transmits=true;opaqueIndex=textures.length;if(!options.opaqueColor&&!allowMissing)throw new TypeError('Node transmission requires opaqueColor or installNodeMaterial(model,graph)');
    textures.push({view:options.opaqueColor!});const volume=transmission.node.volume;
    const thick=volume?.thickness===undefined?undefined:values.get(volume.thickness),attenuation=volume?.attenuationColor===undefined?undefined:values.get(volume.attenuationColor);
    const inverse=volume?.attenuationDistance===undefined||volume.attenuationDistance===Infinity?0:1/volume.attenuationDistance;
    const inv=uniform([inverse]);
    const shader=transmissionShader({opaque:opaqueIndex},{factor:`clamp(${component(child(transmission,'factor',values),'r','0.0')},0.0,1.0)`,ior:`max(${child(transmission,'ior',values)?.name??'1.5'},1.0)`,thickness:`max(${component(thick,'g','0.0')},0.0)`,attenuation:attenuation?`clamp(${attenuation.name}.rgb,vec3f(0),vec3f(1))`:'vec3f(1)',inverseDistance:inv+'.x'});
    declarations+=shader.declarations;output=shader.output??'';
  }
  if(needsNormal)declarations=normalShader+declarations;
  const extension:MaterialExtension={wgsl:statements,...(declarations?{declarations}:{}),...(direct?{direct}:{}),...(output?{output,lighting:false}:{}),...(factors.length?{factors:Float32Array.from(factors)}:{}),...(textures.length?{textures}:{})};
  return {extension,transmits,opaqueIndex,uvSets};
}

/** Compile the closed TypeScript graph into the isolated material extension slot. */
export function nodeMaterial(graph:MaterialGraph,options:NodeMaterialOptions={}):MaterialExtension {return compile(graph,options).extension;}

/** Applies one graph to a model; owns only its optional shared opaque capture. */
export class NodeMaterialInstallation implements EnginePlugin {
  static attach(model:PBRModel,graph:MaterialGraph):NodeMaterialInstallation {return installNodeMaterial(model,graph);}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
  readonly name:string;
  disposed=false;
  private readonly compiled:ReturnType<typeof compile>;
  private readonly previous=new Map<PBRPrimitive,MaterialExtension|undefined>();
  private readonly modes=new Map<PBRPrimitive['material'],number>();
  private capture?:ReturnType<typeof acquireOpaqueColor>;
  private unsubscribe?:()=>void;
  constructor(readonly model:PBRModel,readonly graph:MaterialGraph){
    if(model.disposed)throw new Error('Node material model is disposed');
    this.name='node-material:'+model.name;this.compiled=compile(graph,{},true);
    for(const p of model.primitives){
      for(const coord of this.compiled.uvSets)if(p.definition.attributes&&p.definition.attributes['TEXCOORD_'+coord]===undefined)throw new Error('Node material requires available TEXCOORD_'+coord);
      this.previous.set(p,p.extension);this.modes.set(p.material,p.material.settings[0]);
    }
  }
  setup(engine:Engine):void {
    if(this.disposed||this.model.disposed||engine!==this.model.root.engine||!engine.gpu)throw new Error('Node material requires its WebGPU model');
    if(this.compiled.transmits&&!this.capture)this.capture=acquireOpaqueColor(engine,view=>{this.compiled.extension.textures![this.compiled.opaqueIndex!].view=view;});
    for(const p of this.model.primitives){p.extension=this.compiled.extension;if(this.compiled.transmits)p.material.settings[0]=2;}
    this.unsubscribe??=this.model.onDispose(()=>this.dispose());
  }
  onDeviceRestored(_engine:Engine):void {/* Constants and borrowed views remain CPU blueprints; the shared capture restores itself. */}
  dispose():void {
    if(this.disposed)return;this.disposed=true;const cleanup=new Cleanup();
    cleanup.run(()=>this.model.root.engine.removePlugin(this.name));this.unsubscribe?.();this.unsubscribe=undefined;
    const restored=new Set<PBRPrimitive['material']>(),replaced=new Set<PBRPrimitive['material']>();
    for(const [p,previous] of this.previous)if(p.extension===this.compiled.extension){p.extension=previous;restored.add(p.material);}else replaced.add(p.material);
    for(const m of restored)if(!replaced.has(m)&&this.compiled.transmits&&m.settings[0]===2)m.settings[0]=this.modes.get(m)!;
    cleanup.run(()=>this.capture?.release());this.capture=undefined;cleanup.finish();
  }
  destroy():void {this.dispose();}
}
export function installNodeMaterial(model:PBRModel,graph:MaterialGraph):NodeMaterialInstallation {const installation=new NodeMaterialInstallation(model,graph);model.root.engine.use(installation);return installation;}
