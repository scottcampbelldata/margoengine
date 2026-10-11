import {meshRuntime} from '@vexel/core/extension';
import type {Mesh as MeshHandle} from '@vexel/core';
import type {Engine,EnginePlugin,Mesh,Vec3} from '@vexel/core/extension';
export {Kinematics} from './kinematics.js';
export type {Joint,GearCoupling,PistonCoupling,IKTarget,DistanceConstraint,KinematicOptions} from './kinematics.js';
export {parseCAD,loadCAD,deduplicateParts,PartInstancer} from './cad.js';
export type {CADModel} from './cad.js';
export {SectionPlanes,boxSection} from './section.js';
export {AssemblyIndex} from './assembly.js';
export {vertexAnchor,faceAnchor,holeAnchor,snapAnchor,measureDistance} from './metrology.js';
export {industrialMaterials,industrialMaterial} from './materials.js';
export type {SectionOptions} from './section.js';
export {EngineeringAnnotations,worldAnchor,projectAnnotation} from './overlays.js';
export type {Anchor,Dimension,Callout,AnnotationOptions} from './overlays.js';
export interface ExplodedPart {node:MeshHandle;offset:Vec3}
export class ExplodedView implements EnginePlugin {
  readonly name='exploded-view';amount=0;private origins:number[][]=[];
  constructor(readonly parts:readonly ExplodedPart[]){}
  setup(engine:Engine):void {this.origins=this.parts.map(({node,offset})=>{node.check();if(meshRuntime(node).engine!==engine||offset.length!==3||offset.some(v=>!Number.isFinite(Math.fround(v))))throw new TypeError('Invalid exploded part');return [node.position.x,node.position.y,node.position.z];});}
  onPreUpdate():void {if(!Number.isFinite(this.amount)||this.amount<0||this.amount>1)throw new RangeError('Explode amount must be 0..1');for(let i=0;i<this.parts.length;i++){const {offset}=this.parts[i],node=meshRuntime(this.parts[i].node),p=this.origins[i],x=p[0]+offset[0]*this.amount,y=p[1]+offset[1]*this.amount,z=p[2]+offset[2]*this.amount;node.check();if(!Number.isFinite(Math.fround(x))||!Number.isFinite(Math.fround(y))||!Number.isFinite(Math.fround(z)))throw new RangeError('Invalid exploded position');const t=node.engine.store.transforms;t.x[node.id]=x;t.y[node.id]=y;t.z[node.id]=z;}}
  dispose():void {this.origins=[];}
}
