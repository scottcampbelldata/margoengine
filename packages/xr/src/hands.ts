/// <reference lib="esnext.disposable" preserve="true" />
import type { PBRModel } from '@margoengine/gltf-pro';
import type { Animation } from '@margoengine/animation';
import { composeMatrix, invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { splitTRS } from '@margoengine/math/quat';
import { ownScene } from './scene-owner.js';
import { margoError } from '../../shared/errors.js';
import type { XRController } from './controller.js';
import type { XRFrameState, XRInputSource, XRNativeSession } from './types.js';

/** The 25 joint names in WebXR Hand Input order. */
export const HAND_JOINT_NAMES: readonly string[] = Object.freeze(['wrist',
  'thumb-metacarpal','thumb-phalanx-proximal','thumb-phalanx-distal','thumb-tip',
  ...['index','middle','ring','pinky'].flatMap(f=>['metacarpal','phalanx-proximal','phalanx-intermediate','phalanx-distal','tip'].map(b=>`${f}-finger-${b}`))]);
/** Session and inputs accepted by skinned hands. */
export interface SkinnedHandsHost {
  readonly session: XRNativeSession | null;
  readonly controllers: readonly XRController[];
  onFrame(callback: (state: XRFrameState) => void): () => void;
}
/** Caller-owned glTF hand models. At least one hand must be provided. */
export interface HandModels {
  /** A skinned glTF whose joint node names match WebXR or jointNames. */
  left?: PBRModel;
  /** A separate right-hand model. Mirroring is authored in the asset. */
  right?: PBRModel;
}
/** Options for skinned hand tracking. */
export interface SkinnedHandsOptions {
  /** WebXR joint name to glTF node name. Default the WebXR names, as in generic-hand profile assets. */
  jointNames?: Readonly<Record<string,string>>;
  /** Dispose when aborted; the caller retains the models. */
  signal?: AbortSignal;
}
type Pose = {position:[number,number,number];rotation:[number,number,number,number];scale:[number,number,number]};
type Rig = {hand:'left'|'right';model:PBRModel;player:Animation;visible:boolean;rest:Pose[];
  parents:number[];order:number[];world:Float64Array[];indices:number[];sources:WeakMap<XRInputSource,number[]>};

/** Drives actual GPU-skinned glTF meshes from the tracked 25-joint hands, retaining asset inverse binds and weights. */
export class SkinnedHands {
  private readonly rigs: Rig[]=[];
  private readonly stops:(()=>void)[]=[];
  private session:XRNativeSession|null=null;
  private stopSession?:()=>void;
  private disposed=false;
  private readonly local=new Float64Array(16);
  private readonly inverse=new Float64Array(16);
  private readonly scratch=new Float64Array(52);
  /** Loads the skinning entry lazily, then attaches borrowed models. No model URLs or network work are implicit. */
  static async create(xr:SkinnedHandsHost,models:HandModels,options:SkinnedHandsOptions={}):Promise<SkinnedHands> {
    options.signal?.throwIfAborted();
    if(typeof xr?.onFrame!=='function' || !Array.isArray(xr.controllers))
      throw new TypeError('SkinnedHands needs an XR host and hand models; pass the XR from XR.create and { left, right }');
    if(!models || (!models.left && !models.right) || (models.left && models.left===models.right))
      throw new TypeError('Provide at least one separate skinned hand model; pass { left, right }');
    const {Animation}=await import('@margoengine/animation');
    options.signal?.throwIfAborted();
    return new SkinnedHands(xr,models,options,Animation);
  }
  private constructor(private readonly xr:SkinnedHandsHost,models:HandModels,options:SkinnedHandsOptions,Player:typeof Animation) {
    try {
      for(const hand of ['left','right'] as const) {
        const model=models[hand];if(!model)continue;
        if(model.disposed)throw margoError('disposed','A hand model is disposed; load a live skinned glTF hand');
        const nodes=model.asset.doc.nodes??[], skins=model.asset.doc.skins??[];
        const indices=HAND_JOINT_NAMES.map(joint=>{
          const name=options.jointNames?.[joint]??joint;
          const matches=nodes.flatMap((node,i)=>node.name===name?[i]:[]);
          if(matches.length!==1)throw new TypeError(`Hand joint '${name}' needs exactly one glTF node; use jointNames to map all 25 joints`);
          return matches[0];
        });
        if(new Set(indices).size!==25 || !skins.some(skin=>indices.every(i=>skin.joints.includes(i))))
          throw new TypeError('Hand models need one skin containing all 25 unique joints; export a WebXR-compatible skinned glTF');
        const rest=model.nodes.map(node=>{
          const t=node.engine.store.transforms,i=node.id;
          return {position:[t.x[i],t.y[i],t.z[i]],rotation:[t.qx[i],t.qy[i],t.qz[i],t.qw[i]],scale:[t.sx[i],t.sy[i],t.sz[i]]} as Pose;
        });
        const parents=nodes.map(()=>-1),order:number[]=[];
        nodes.forEach((node,i)=>node.children?.forEach(child=>{parents[child]=i;}));
        const visit=(i:number)=>{order.push(i);nodes[i].children?.forEach(visit);};
        parents.forEach((parent,i)=>{if(parent===-1)visit(i);});
        const player=new Player(model);
        try { model.root.scene.use(player); } catch (error) { player.dispose(); throw error; }
        player.playing=false;
        this.rigs.push({hand,model,player,visible:model.root.visible,rest,parents,order,indices,world:nodes.map(()=>new Float64Array(16)),sources:new WeakMap()});
        model.root.visible=false;
      }
      for (const scene of new Set(this.rigs.map(rig => rig.model.root.scene))) this.stops.push(ownScene(scene, () => this.dispose()));
      this.listen(xr.session);
      this.stops.push(xr.onFrame(state=>this.update(state)));
      if(options.signal) {
        const abort=()=>this.dispose();options.signal.addEventListener('abort',abort,{once:true});
        this.stops.push(()=>options.signal!.removeEventListener('abort',abort));
      }
    }catch(error){this.dispose();throw error;}
  }
  private listen(session:XRNativeSession|null):void {
    if(session===this.session)return;
    this.stopSession?.();this.session=session;
    if(!session){this.stopSession=undefined;return;}
    const end=()=>{for(const rig of this.rigs)if(!rig.model.disposed)rig.model.root.visible=false;};
    session.addEventListener('end',end);
    this.stopSession=()=>session.removeEventListener('end',end);
  }
  private update(state:XRFrameState):void {
    if(this.disposed || state.frame.session!==this.xr.session)return;
    this.listen(this.xr.session);
    for(const rig of this.rigs){
      if(rig.model.disposed)continue;
      const input=this.xr.controllers.find(c=>c.source.handedness===rig.hand && c.source.hand);
      const visible=!!input && input.source.hand!.size===25 && input.handTracked.every(Boolean) && !(input.source as XRInputSource&{skipRendering?:boolean}).skipRendering;
      rig.model.root.visible=visible;
      if(visible)this.pose(rig,input!);
    }
  }
  private pose(rig:Rig,input:XRController):void {
    let map=rig.sources.get(input.source);
    if(!map){
      map=Array.from(input.source.hand!.keys()).map(name=>{
        const joint=HAND_JOINT_NAMES.indexOf(name);
        if(joint<0)throw new TypeError(`Unknown WebXR joint '${name}'; supply the standard 25-joint hand`);
        return rig.indices[joint];
      });
      if(new Set(map).size!==25)throw new TypeError('WebXR hand joint names repeat; supply the standard 25-joint hand');
      rig.sources.set(input.source,map);
    }
    const nodeToJoint=new Map(map.map((node,j)=>[node,j]));
    // Parent worlds are staged before child locals, including any untracked helper nodes in the asset hierarchy.
    const root=rig.model.root,store=root.engine.store,rt=store.transforms;
    const chain:number[]=[];
    for(let id=root.id;id!==-1;id=store.parents[id])chain.push(id);
    const rootWorld=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    for(let k=chain.length-1;k>=0;k--){const id=chain[k];
      composeMatrix([rt.x[id],rt.y[id],rt.z[id]],[rt.qx[id],rt.qy[id],rt.qz[id],rt.qw[id]],[rt.sx[id],rt.sy[id],rt.sz[id]],this.local);
      multiplyMatrices(rootWorld,this.local,this.inverse);rootWorld.set(this.inverse);
    }
    for(const i of rig.order){
      const parent=rig.parents[i]<0?rootWorld:rig.world[rig.parents[i]],joint=nodeToJoint.get(i),world=rig.world[i];
      if(joint===undefined){
        const rest=rig.rest[i];composeMatrix(rest.position,rest.rotation,rest.scale,this.local);multiplyMatrices(parent,this.local,world);
      }else{
        world.set(input.handMatrices.subarray(joint*16,joint*16+16));
        if(!invertMatrixStable(parent,this.inverse,this.scratch))throw new RangeError('Hand parent transform is singular; use a nonsingular hand model root');
        multiplyMatrices(this.inverse,world,this.local);
        const trs=splitTRS(this.local);
        if(!trs.ok)throw new RangeError(`Hand local transform has ${trs.reason}; use an unscaled or uniformly scaled model root`);
        rig.model.nodes[i].setPosition(trs.position).setQuaternion(trs.rotation).setScale(trs.scale);
      }
    }
  }
  /** Stops tracking and skinning, and restores the borrowed models' original local transforms and visibility. */
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    this.stopSession?.();this.stopSession=undefined;
    for(const stop of this.stops)stop();this.stops.length=0;
    for(const rig of this.rigs){
      rig.model.root.scene.removePlugin(rig.player.name);
      if(!rig.model.disposed){rig.rest.forEach((pose,i)=>rig.model.nodes[i].setPosition(pose.position).setQuaternion(pose.rotation).setScale(pose.scale));rig.model.root.visible=rig.visible;}
    }
    this.rigs.length=0;
  }
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void {this.dispose();}
}
