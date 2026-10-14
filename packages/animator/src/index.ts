import {Animation,sampleTrackInto} from '@margoengine/animation';
import type {Engine,EnginePlugin,Mesh,Vec3} from '@margoengine/core/extension';
import {finiteVector} from '@margoengine/math/validate';
import {blend1D,blend2D,quaternionMultiply,quaternionBlend} from './blend.js';
import {solveTwoBoneIK,rotationBetween} from './ik.js';
export {blend1D,blend2D} from './blend.js';export {solveTwoBoneIK} from './ik.js';
export type BlendTree=string|{parameter:string;samples:readonly {value:number;clip:string}[]}|{parameters:readonly [string,string];samples:readonly {value:readonly [number,number];clip:string}[]};
export interface AnimatorTransition {from:string;to:string;when:(parameters:Readonly<Record<string,number>>)=>boolean;duration?:number}
export interface AnimatorOptions {states:Record<string,BlendTree>;initial:string;parameters?:Record<string,number>;transitions?:readonly AnimatorTransition[]}
export interface AdditiveLayer {clip:string;weight:number;mask:readonly number[];referenceTime?:number}
export interface GroundHit {position:Vec3;normal?:Vec3}
export interface FootIK {hip:number;knee:number;ankle:number;pole:Vec3;raycast:(origin:Vec3,direction:Vec3)=>GroundHit|null;offset?:number;probeHeight?:number}
interface Pose {position:number[][];rotation:number[][];scale:number[][];weights:Map<number,Float32Array>}
const clone=(p:Pose):Pose=>{const weights=new Map<number,Float32Array>();for(const [k,v] of p.weights)weights.set(k,v.slice());return {position:p.position.map(v=>v.slice()),rotation:p.rotation.map(v=>v.slice()),scale:p.scale.map(v=>v.slice()),weights};};
export class Animator implements EnginePlugin {
  readonly name:string;readonly parameters:Record<string,number>;state:string;time=0;
  private engine?:Engine;private readonly rest:Pose;private current:Pose;private fade?:{pose:Pose;elapsed:number;duration:number};private layers=new Set<AdditiveLayer>();private readonly scratch=new Map<number,Float32Array>();private feet=new Set<FootIK>();private disposed=false;private unsubscribe?:()=>void;private previousPlaying:boolean;
  constructor(readonly animation:Animation,readonly options:AnimatorOptions) {
    this.name='animator:'+animation.model.name;this.parameters={...options.parameters};this.state=options.initial;
    if(!options.states||!Object.hasOwn(options.states,this.state)||!Object.keys(options.states).length)throw new TypeError('Invalid animator states');
    for(const [name,tree] of Object.entries(options.states)){if(!name)throw new TypeError('Empty animator state');if(typeof tree==='string')this.clip(tree);else if('parameter' in tree){blend1D(tree.samples.map(s=>s.value),0);for(const s of tree.samples)this.clip(s.clip);}else{if(tree.parameters.length!==2)throw new TypeError('Invalid blend parameters');blend2D(tree.samples.map(s=>s.value),0,0);for(const s of tree.samples)this.clip(s.clip);}}
    for(const t of options.transitions??[])if(!Object.hasOwn(options.states,t.from)||!Object.hasOwn(options.states,t.to)||typeof t.when!=='function'||!Number.isFinite(t.duration??0.15)||(t.duration??0.15)<0)throw new TypeError('Invalid animator transition');
    const nodes=animation.model.nodes,t=animation.model.root.engine.store.transforms;
    this.rest={position:nodes.map(n=>[t.x[n.id],t.y[n.id],t.z[n.id]]),rotation:nodes.map(n=>[t.qx[n.id],t.qy[n.id],t.qz[n.id],t.qw[n.id]]),scale:nodes.map(n=>[t.sx[n.id],t.sy[n.id],t.sz[n.id]]),weights:new Map(animation.model.primitives.map(p=>[p.nodeIndex,p.weights.slice()]))};this.current=clone(this.rest);this.previousPlaying=animation.playing;
  }
  static attach(animation:Animation,options:AnimatorOptions):Animator {const animator=new Animator(animation,options);animation.model.root.engine.use(animator);return animator;}
  private clip(name:string) {const clip=this.animation.clips.find(c=>c.name===name);if(!clip)throw new RangeError('Unknown animator clip: '+name);return clip;}
  transition(state:string,duration=0.15):this {if(this.disposed||!Object.hasOwn(this.options.states,state)||!Number.isFinite(duration)||duration<0)throw new RangeError('Invalid animator transition');if(state===this.state)return this;this.fade=duration?{pose:clone(this.current),elapsed:0,duration}:undefined;this.state=state;this.time=0;return this;}
  addLayer(layer:AdditiveLayer):()=>void {this.clip(layer.clip);this.validateLayer(layer);this.layers.add(layer);return()=>this.layers.delete(layer);}
  private validateLayer(layer:AdditiveLayer):void {if(this.disposed||!Number.isFinite(layer.weight)||layer.weight<0||layer.weight>1||!Array.isArray(layer.mask)||layer.mask.some(i=>!Number.isInteger(i)||i<0||i>=this.animation.model.nodes.length)||!Number.isFinite(layer.referenceTime??0)||(layer.referenceTime??0)<0)throw new RangeError('Invalid additive layer');}
  addFootIK(foot:FootIK):()=>void {
    const nodes=this.animation.model.nodes;if(this.disposed||[foot.hip,foot.knee,foot.ankle].some(i=>!Number.isInteger(i)||i<0||i>=nodes.length)||typeof foot.raycast!=='function'||!Number.isFinite(foot.offset??0)||!Number.isFinite(foot.probeHeight??1)||(foot.probeHeight??1)<=0)throw new TypeError('Invalid foot IK');finiteVector(foot.pole,3,'IK pole');
    const parents=nodes[0].engine.store.parents;if(parents[nodes[foot.knee].id]!==nodes[foot.hip].id||parents[nodes[foot.ankle].id]!==nodes[foot.knee].id)throw new Error('IK requires a direct hip/knee/ankle chain');this.feet.add(foot);return()=>this.feet.delete(foot);
  }
  setup(engine:Engine):void {if(this.disposed||this.animation.model.disposed||engine!==this.animation.model.root.engine||!engine.hasPlugin(this.animation.name))throw new Error('Attach Animation before its Animator');this.engine=engine;this.animation.playing=false;this.unsubscribe=this.animation.model.onDispose(()=>this.dispose());}
  onPreUpdate(delta:number):void {
    if(this.disposed)return;if(this.engine&&!this.engine.hasPlugin(this.animation.name)){this.dispose();return;}if(!Number.isFinite(delta)||delta<0)throw new RangeError('Invalid animator delta');this.animation.playing=false;
    for(const v of Object.values(this.parameters))if(!Number.isFinite(v))throw new RangeError('Invalid blend parameter');
    for(const t of this.options.transitions??[])if(t.from===this.state&&t.when(this.parameters)){this.transition(t.to,t.duration);break;}
    this.time+=delta;const tree=this.options.states[this.state];let clips:string[],weights:Float32Array;
    if(typeof tree==='string'){clips=[tree];weights=new Float32Array([1]);}else if('parameter' in tree){clips=tree.samples.map(s=>s.clip);weights=blend1D(tree.samples.map(s=>s.value),this.parameters[tree.parameter]??0);}else{clips=tree.samples.map(s=>s.clip);weights=blend2D(tree.samples.map(s=>s.value),this.parameters[tree.parameters[0]]??0,this.parameters[tree.parameters[1]]??0);}
    let pose:Pose|undefined,total=0;
    for(let i=0;i<clips.length;i++)if(weights[i]>0){const sampled=this.sample(clips[i],this.time);total+=weights[i];pose=pose?this.mix(pose,sampled,weights[i]/total):sampled;}
    if(!pose)pose=clone(this.rest);
    if(this.fade){const f=this.fade;f.elapsed+=delta;pose=this.mix(clone(f.pose),pose,Math.min(1,f.elapsed/f.duration));if(f.elapsed>=f.duration)this.fade=undefined;}
    for(const layer of this.layers){this.validateLayer(layer);const sample=this.sample(layer.clip,this.time),reference=this.sample(layer.clip,layer.referenceTime??0,false);
      for(const i of layer.mask){for(let c=0;c<3;c++){pose.position[i][c]+=(sample.position[i][c]-reference.position[i][c])*layer.weight;pose.scale[i][c]*=1+(sample.scale[i][c]/reference.scale[i][c]-1)*layer.weight;}
        const weights=pose.weights.get(i),sampleWeights=sample.weights.get(i),referenceWeights=reference.weights.get(i);if(weights&&sampleWeights&&referenceWeights)for(let j=0;j<weights.length;j++)weights[j]+=(sampleWeights[j]-referenceWeights[j])*layer.weight;
        const inverse=[-reference.rotation[i][0],-reference.rotation[i][1],-reference.rotation[i][2],reference.rotation[i][3]],difference=quaternionMultiply(inverse,sample.rotation[i]);pose.rotation[i]=quaternionMultiply(pose.rotation[i],quaternionBlend([0,0,0,1],difference,layer.weight));
      }
    }
    this.current=pose;
    const nodes=this.animation.model.nodes;for(let i=0;i<nodes.length;i++)nodes[i].setPosition(pose.position[i] as [number,number,number]).setScale(pose.scale[i] as [number,number,number]).setQuaternion(pose.rotation[i]);
    for(const p of this.animation.model.primitives){const weights=pose.weights.get(p.nodeIndex);if(weights)p.weights.set(weights);}
    for(const foot of this.feet)this.foot(foot);
  }
  private sample(name:string,time:number,loop=true):Pose {
    const clip=this.clip(name),pose=clone(this.rest),t=loop&&clip.duration>0?time%clip.duration:Math.min(time,clip.duration);
    // Sample into one scratch buffer per track width, then copy into the vectors this pose already owns.
    for(const track of clip.tracks){
      const width=track.width;let scratch=this.scratch.get(width);if(!scratch)this.scratch.set(width,scratch=new Float32Array(width));
      const values=sampleTrackInto(track.times,track.values,width,t,track.interpolation,track.path==='rotation',scratch);
      if(track.path==='weights'){const own=pose.weights.get(track.node);if(own instanceof Float32Array&&own.length===width)own.set(values);else pose.weights.set(track.node,values.slice());continue;}
      const list=pose[track.path==='translation'?'position':track.path],own=list[track.node];
      if(own?.length===width)for(let c=0;c<width;c++)own[c]=values[c];else list[track.node]=Array.from(values);
    }
    return pose;
  }
  private mix(a:Pose,b:Pose,weight:number):Pose {
    const out=a;for(let i=0;i<out.position.length;i++){for(let c=0;c<3;c++){out.position[i][c]=a.position[i][c]*(1-weight)+b.position[i][c]*weight;out.scale[i][c]=a.scale[i][c]*(1-weight)+b.scale[i][c]*weight;}const q=a.rotation[i];out.rotation[i]=quaternionBlend(q,b.rotation[i],weight,q.length===4?q:undefined);}
    for(const [id,values] of out.weights){const other=b.weights.get(id);if(other)for(let i=0;i<values.length;i++)values[i]=values[i]*(1-weight)+other[i]*weight;}return out;
  }
  private worldRotation(node:Mesh):number[] {const t=node.engine.store.transforms,parents=node.engine.store.parents;let q=[0,0,0,1];const chain:number[]=[];for(let id=node.id;id!==-1;id=parents[id])chain.push(id);for(const id of chain.reverse()){
    if(t.sx[id]<=0||Math.abs(t.sx[id]-t.sy[id])>1e-5||Math.abs(t.sx[id]-t.sz[id])>1e-5)throw new Error('Foot IK requires positive uniform bone and ancestor scales');q=quaternionMultiply(q,[t.qx[id],t.qy[id],t.qz[id],t.qw[id]]);
  }return q;}
  private rotateWorld(node:Mesh,delta:number[]):void {const id=node.engine.store.parents[node.id],parent=id===-1?[0,0,0,1]:this.worldRotation(node.engine.meshes.get(id)!),world=quaternionMultiply(delta,this.worldRotation(node));node.setQuaternion(quaternionMultiply([-parent[0],-parent[1],-parent[2],parent[3]],world));}
  private foot(foot:FootIK):void {
    const nodes=this.animation.model.nodes,hip=nodes[foot.hip],knee=nodes[foot.knee],ankle=nodes[foot.ankle],position=(node:Mesh)=>Array.from(node.matrix.subarray(12,15)) as [number,number,number],subtract=(a:Vec3,b:Vec3)=>a.map((v,i)=>v-b[i]) as [number,number,number];
    this.engine!.store.tick(false);const start=position(ankle),hit=foot.raycast([start[0],start[1]+(foot.probeHeight??1),start[2]],[0,-1,0]);if(!hit)return;finiteVector(hit.position,3,'Ground hit');if(hit.normal)finiteVector(hit.normal,3,'Ground normal');
    const target:[number,number,number]=[hit.position[0],hit.position[1]+(foot.offset??0),hit.position[2]],root=position(hip),solved=solveTwoBoneIK(root,position(knee),start,target,foot.pole);
    this.rotateWorld(hip,rotationBetween(subtract(position(knee),root),subtract(solved.knee,root)));this.engine!.store.tick(false);
    this.rotateWorld(knee,rotationBetween(subtract(position(ankle),position(knee)),subtract(solved.ankle,position(knee))));this.engine!.store.tick(false);
    if(hit.normal){const m=ankle.matrix;this.rotateWorld(ankle,rotationBetween([m[4],m[5],m[6]],hit.normal));this.engine!.store.tick(false);}
  }
  onDeviceRestored():void {this.animation.playing=false;}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.unsubscribe?.();this.unsubscribe=undefined;this.animation.playing=this.previousPlaying;this.layers.clear();this.feet.clear();this.engine=undefined;}
  destroy():void {this.dispose();}
}
