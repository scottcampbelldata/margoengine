import type {Interpolation} from './sampling.js';

export type AnimationPath='translation'|'rotation'|'scale'|'weights';
export interface AnimationDocument {nodes:unknown[];accessors:unknown[];animations:unknown[];skins:unknown[]}
export interface AnimationChannel {sampler:unknown;target:{node:unknown;path:unknown}}
export interface AnimationSampler {input:unknown;output:unknown;interpolation:unknown}
export interface AnimationDefinition {name?:string;channels:unknown[];samplers:unknown[]}
export interface AnimationNode {matrix:unknown;skin:unknown}
export interface AnimationAccessor {componentType:unknown;normalized:unknown}
export interface Skin {joints:number[];inverseBindMatrices:unknown}
export interface MorphTarget {POSITION?:unknown;NORMAL?:unknown;TANGENT?:unknown}
export interface SkinAttributes extends Record<string,unknown> {JOINTS_0?:unknown;WEIGHTS_0?:unknown;JOINTS_1?:unknown;WEIGHTS_1?:unknown}
export interface MorphDefinition {targets:MorphTarget[];attributes:SkinAttributes}

function record(value:unknown,message:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(message);
  return value as Record<string,unknown>;
}
function array(value:unknown,message:string):unknown[] {if(!Array.isArray(value))throw new TypeError(message);return value;}
export function animationDocument(value:unknown):AnimationDocument {
  const doc=record(value,'Invalid glTF animation');
  return {nodes:array(doc.nodes,'Invalid glTF nodes'),accessors:array(doc.accessors??[],'Invalid glTF accessors'),animations:array(doc.animations??[],'Invalid glTF animations'),skins:array(doc.skins??[],'Invalid glTF skins')};
}
export function animationDefinition(value:unknown):AnimationDefinition {
  const def=record(value,'Invalid glTF animation');
  if(def.name!==undefined&&typeof def.name!=='string')throw new TypeError('Invalid glTF animation');
  return {name:def.name,channels:array(def.channels,'Invalid glTF animation'),samplers:array(def.samplers,'Invalid glTF animation')};
}
export function animationChannel(value:unknown):AnimationChannel {
  const channel=record(value,'Invalid glTF animation');
  const target=channel.target&&typeof channel.target==='object'&&!Array.isArray(channel.target)?channel.target as Record<string,unknown>:{};
  return {sampler:channel.sampler,target:{node:target.node,path:target.path}};
}
export function animationSampler(value:unknown):AnimationSampler {
  const sampler=record(value,'Invalid glTF animation');
  return {input:sampler.input,output:sampler.output,interpolation:sampler.interpolation};
}
export function animationNode(value:unknown):AnimationNode {
  const node=record(value,'Invalid animation target');return {matrix:node.matrix,skin:node.skin};
}
export function animationAccessor(doc:AnimationDocument,id:unknown):AnimationAccessor|undefined {
  const value=typeof id==='number'?doc.accessors[id]:undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const accessor=value as Record<string,unknown>;return {componentType:accessor.componentType,normalized:accessor.normalized};
}
export function animationIndex(value:unknown,length:number,label:string):number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>=length)throw new TypeError('Invalid animation '+label);
  return value;
}
export function animationPath(value:unknown):AnimationPath {
  if(value!=='translation'&&value!=='rotation'&&value!=='scale'&&value!=='weights')throw new TypeError('Invalid animation target');return value;
}
export function animationInterpolation(value:unknown):Interpolation {
  if(value===undefined)return 'LINEAR';
  if(value!=='STEP'&&value!=='LINEAR'&&value!=='CUBICSPLINE')throw new RangeError('Invalid animation time/interpolation');return value;
}
export function skinDefinition(value:unknown,nodeCount:number):Skin {
  const skin=record(value,'Invalid skin joints'),joints:unknown[]=array(skin.joints,'Invalid skin joints');
  if(!joints.length||new Set(joints).size!==joints.length||!joints.every((joint):joint is number=>typeof joint==='number'&&Number.isInteger(joint)&&joint>=0&&joint<nodeCount))throw new TypeError('Invalid skin joints');
  return {joints,inverseBindMatrices:skin.inverseBindMatrices};
}
export function morphDefinition(value:unknown):MorphDefinition {
  const primitive=record(value,'Invalid glTF morph target');
  const targets=array(primitive.targets??[],'Invalid glTF morph target').map(value=>{
    const target=record(value,'Invalid glTF morph target');return {POSITION:target.POSITION,NORMAL:target.NORMAL,TANGENT:target.TANGENT};
  });
  return {targets,attributes:record(primitive.attributes??{},'Invalid skin attributes')};
}
