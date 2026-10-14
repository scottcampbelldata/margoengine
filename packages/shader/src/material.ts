import {Material,type MaterialOptions} from '@margoengine/materials';
import type {Engine} from '@margoengine/core/extension';
import {Program,builtin,cast,positionLocal,normalLocal,scalarOf,type Node,type Stage,type Input} from './node.js';

/** Material slots a node replaces. Nodes read `@margoengine/materials` maps and factors through `materialColor` and friends. */
export interface NodeMaterialOptions extends MaterialOptions {
  /** Base colour (linear); vec3f keeps the computed alpha. Replaces color x map x vertex colour. */
  colorNode?:Node<'vec3f'|'vec4f'>;
  opacityNode?:Input<'f32'>;roughnessNode?:Input<'f32'>;metalnessNode?:Input<'f32'>;
  emissiveNode?:Node<'vec3f'>;
  /** World-space shading normal. */
  normalNode?:Node<'vec3f'>;
  /** Object-space vertex position, e.g. `positionLocal.add(normalLocal.mul(offset))`. Beauty pass only. */
  positionNode?:Node<'vec3f'>;
}
/** The surface value this material computed before its nodes ran (fragment only). */
export const materialColor=/*@__PURE__*/builtin('materialColor','vec4f'),materialNormal=/*@__PURE__*/builtin('materialNormal','vec3f');
export const materialRoughness=/*@__PURE__*/builtin('materialRoughness','f32'),materialMetalness=/*@__PURE__*/builtin('materialMetalness','f32'),materialEmissive=/*@__PURE__*/builtin('materialEmissive','vec3f');
export const frontFacing=/*@__PURE__*/builtin('frontFacing','bool');
const world='(f.model * vec4f(i.position.xyz, 1.0)).xyz',maxVaryings=8;
const vertex:Stage={kind:'vertex',builtins:{uv:'i.uv.xy',vertexColor:'i.color',positionLocal:'i.position.xyz',normalLocal:'i.normal.xyz',positionWorld:world,
  normalWorld:'normalize((f.normalMatrix * vec4f(i.normal.xyz, 0.0)).xyz)',cameraPosition:'f.eye.xyz',viewDirection:`normalize(f.eye.xyz - ${world})`}};
const fragment:Stage={kind:'fragment',builtins:{uv:'i.uv.xy',vertexColor:'i.color',positionWorld:'i.position',normalWorld:'normalize(i.normal)',cameraPosition:'f.eye.xyz',
  viewDirection:'normalize(f.eye.xyz - i.position)',screenCoordinate:'i.clip.xy',screenUV:b=>`(${b.local('i.clip.xy')} / ${b.frame('resolution','vec2f')})`,
  positionLocal:b=>b.stage.varying!(b,positionLocal),normalLocal:b=>b.stage.varying!(b,normalLocal),
  materialColor:'s.base',materialNormal:'s.n',materialRoughness:'s.roughness',materialMetalness:'s.metal',materialEmissive:'s.emissive',frontFacing:'front'},
  varying(b,x){
    const list=b.program.varyings,c=b.program.canon(x);let i=list.findIndex(y=>b.program.canon(y)===c);
    if(i<0){if(list.length>=maxVaryings)throw new RangeError(`NodeMaterial supports ${maxVaryings} varyings`);i=list.push(x)-1;}
    return b.local('i.ndv'+i);
  }};
const fragmentSite='if(!facing&&f.settings.z<0.5){discard;}',vertexSite='let p=f.model*vec4f(i.position.xyz,1);';

/**
 * A `@margoengine/materials` Material whose colour, opacity, roughness, metalness, emissive, normal and vertex position come from
 * shader nodes. Every Material option still applies; nodes are fixed at construction, uniform values stay live.
 */
export class NodeMaterial extends Material {
  readonly program=new Program(48);
  /** Generated statements spliced into gltf-pro's surface() and vertex() (for inspection and tests). */
  readonly fragmentCode:string;readonly vertexCode:string;readonly varyingFields:string;
  private readonly patched=new Map<string,string>();
  constructor(options:NodeMaterialOptions={}) {
    const {colorNode,opacityNode,roughnessNode,metalnessNode,emissiveNode,normalNode,positionNode,...rest}=options;super(rest);
    if(colorNode!==undefined&&(colorNode?.type!=='vec3f'&&colorNode?.type!=='vec4f'))throw new TypeError('colorNode must be a vec3f or vec4f node');
    const slots:[Node|undefined,(v:string)=>string][]=[
      [colorNode,v=>colorNode!.type==='vec4f'?`s.base = ${v};`:`s.base = vec4f(${v}, s.base.a);`],
      [opacityNode===undefined?undefined:cast(opacityNode,'f32','opacityNode'),v=>`s.base.a = ${v};`],
      [roughnessNode===undefined?undefined:cast(roughnessNode,'f32','roughnessNode'),v=>`s.roughness = clamp(${v}, 0.045, 1.0);`],
      [metalnessNode===undefined?undefined:cast(metalnessNode,'f32','metalnessNode'),v=>`s.metal = clamp(${v}, 0.0, 1.0);`],
      [emissiveNode&&cast(emissiveNode,'vec3f','emissiveNode'),v=>`s.emissive = ${v};`],
      [normalNode&&cast(normalNode,'vec3f','normalNode'),v=>`s.n = normalize(${v});`]];
    const used=slots.filter(s=>s[0]),f=this.program.stage(fragment,used.map(s=>s[0]!));
    const position=positionNode&&cast(positionNode,'vec3f','positionNode'),v=this.program.stage(vertex,[...position?[position]:[],...this.program.varyings]),values=[...v.values];
    const pos=position?values.shift()!:'i.position.xyz';
    this.fragmentCode=[...f.lines,...used.map((s,i)=>s[1](f.values[i]))].map(l=>'  '+l+'\n').join('');
    this.vertexCode=[...v.lines,`let p=f.model*vec4f(${pos},1);`,...values.map((x,i)=>`o.ndv${i} = ${x};`)].map(l=>'  '+l+'\n').join('');
    this.varyingFields=this.program.varyings.map((x,i)=>`,\n  @location(${8+i})${scalarOf(x.type)==='f32'?'':' @interpolate(flat)'} ndv${i}:${x.type}`).join('');
  }
  shader(source:string,group:number):string {
    const key=group+source;let code=this.patched.get(key);if(code)return code;let count=0;
    code=super.shader(source,group).replace(fragmentSite,site=>{count++;return this.fragmentCode.trimStart()+'  '+site;}).replace(vertexSite,()=>{count++;return this.vertexCode.trim();});
    if(this.varyingFields)code=code.replace(/(struct Out \{[^}]*?)\n\}/,(_,body)=>{count++;return body+this.varyingFields+'\n}';});
    if(count!==(this.varyingFields?3:2))throw new Error('NodeMaterial requires the standard gltf-pro PBR shader');
    code=this.program.declare(group)+'\n'+code;this.patched.set(key,code);return code;
  }
  bindings(device:GPUDevice,engine?:Engine):GPUBindGroupEntry[] {
    const canvas=engine?.canvas;return [...super.bindings(device,engine),...this.program.entries(device,{width:canvas?.width??1,height:canvas?.height??1})];
  }
}
