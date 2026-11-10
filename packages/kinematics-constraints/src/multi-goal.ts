import { rangeError } from '../../shared/errors.js';
import { angularError, compose, dampedStep, identity } from './multi-goal-math.js';
import type { Pose, Q4, V3 } from './multi-goal-math.js';

/** Joint-local displacement in metres or axis direction. */
export type IKVector = readonly [number, number, number];
/** Quaternion in x, y, z, w order; finite nonzero inputs are normalized. */
export type IKQuaternion = readonly [number, number, number, number];
/** One scalar degree of freedom. Compose joints for spherical or floating joints. */
export interface IKJoint {
  /** Joint kind. Fixed joints supply link transforms without a variable. */
  type: 'fixed' | 'revolute' | 'prismatic';
  /** Parent index, in any input order. Omitted or -1 means the world. */
  parent?: number;
  /** Rest offset in the parent frame. Default [0,0,0]. */
  position?: IKVector;
  /** Rest orientation in the parent frame. Default identity. */
  rotation?: IKQuaternion;
  /** Motion axis in the rest joint frame. Default +Z; normalized on input. */
  axis?: IKVector;
  /** Initial angle in radians or translation in metres. Default 0. */
  value?: number;
  /** Hard lower bound. Default -Infinity. */
  min?: number;
  /** Hard upper bound. Default Infinity. Equal bounds lock the joint. */
  max?: number;
}
/** An attachment frame on a joint, or on the world when joint is -1. */
export interface IKFrame {
  /** Index into the constructor's joints, or -1 for the world. */
  joint: number;
  /** Attachment position in joint coordinates. Default origin. */
  position?: IKVector;
  /** Attachment orientation in joint coordinates. Default identity. */
  rotation?: IKQuaternion;
}
/** Position and orientation channels shared by goals and loop closures. */
export interface IKChannels {
  /** Position objective weight, >=0. Default 1; 0 disables this channel. */
  positionWeight?: number;
  /** Orientation objective weight, >=0. Default 1; 0 disables this channel. */
  orientationWeight?: number;
  /** Active world position axes. Default [true,true,true]. */
  positionAxes?: readonly [boolean, boolean, boolean];
  /** Active world rotation-vector axes. Default [true,true,true]. */
  orientationAxes?: readonly [boolean, boolean, boolean];
}
/** One world-space effector goal; all supplied goals are solved together. */
export interface IKGoal extends IKChannels {
  /** Attachment to constrain. */
  frame: IKFrame;
  /** World position target; omitted means no position goal. */
  position?: IKVector;
  /** World orientation target; omitted means no orientation goal. */
  rotation?: IKQuaternion;
}
/** Closes a cut in a kinematic tree by matching two attachment frames. */
export interface IKLoop extends IKChannels {
  /** First attachment. */
  a: IKFrame;
  /** Second attachment, possibly on another tree or the world. */
  b: IKFrame;
  /** Match position. Default true. */
  position?: boolean;
  /** Match orientation. Default false (a point closure). */
  orientation?: boolean;
}
/** Bounded local nonlinear solver settings. */
export interface MultiGoalIKOptions {
  /** Maximum iterations per seed, 1..4096. Default 128. */
  iterations?: number;
  /** Deterministic seeds, including the initial pose, 1..64. Default 4. */
  candidates?: number;
  /** Unweighted active position tolerance in metres. Default 1e-5. */
  positionTolerance?: number;
  /** Unweighted active orientation tolerance in radians. Default 1e-5. */
  orientationTolerance?: number;
  /** Positive initial DLS damping, 1e-6..1e3. Default 0.01. */
  damping?: number;
  /** Maximum absolute scalar change per step (radians/metres). Default 0.25. */
  maxStep?: number;
}
/** Owned world transform of a joint or attachment. */
export interface IKPose {
  /** World position in metres. */
  position: [number, number, number];
  /** World orientation in x,y,z,w order. */
  rotation: [number, number, number, number];
}
/** Solve request. Inputs are copied and never modified. */
export interface MultiGoalIKRequest {
  /** World goals. Default none; loops can be solved alone. */
  goals?: readonly IKGoal[];
  /** Explicit cuts that close loops. Default none. */
  loops?: readonly IKLoop[];
  /** Starting scalars, one per joint including fixed joints. Default constructor values. */
  values?: readonly number[];
  /** Optional cancellation, checked before work and every iteration. */
  signal?: AbortSignal;
}
/** One constraint's physical errors, after masks and before weights. */
export interface IKError {
  /** Active positional distance in metres, zero when disabled. */
  position: number;
  /** Active rotation-vector norm in radians, zero when disabled. */
  orientation: number;
}
/** Best bounded pose, including explicit nonconvergence diagnostics. */
export interface MultiGoalIKResult {
  /** True only when every active goal and loop is within both physical tolerances. */
  resolved: boolean;
  /** Converged, stationary after all seeds, or iteration budget exhausted. */
  status: 'converged' | 'stalled' | 'iteration-limit';
  /** One angle/translation per input joint; fixed joints have zero. */
  values: number[];
  /** Joint transforms in the original input order. */
  poses: IKPose[];
  /** Goal errors in request order. */
  goals: IKError[];
  /** Loop closure errors in request order. */
  loops: IKError[];
  /** Sum of weighted squared residuals. */
  objective: number;
  /** Total linearizations across all candidates. */
  iterations: number;
  /** Seeds attempted. */
  candidates: number;
}

interface Joint { type: IKJoint['type']; parent: number; rest: Pose; axis: V3; value: number; min: number; max: number }
interface Frame { joint: number; local: Pose }
interface Constraint { a: Frame; b?: Frame; target: Pose; position: boolean; orientation: boolean; pw: number; ow: number; pa: boolean[]; oa: boolean[] }
interface Evaluation { residual: number[]; errors: IKError[]; objective: number; resolved: boolean; poses: Pose[] }
const fail = (message: string): never => { throw rangeError(`${message}; supply valid bounded IK data`, 'kinematics'); };
const finite = (x: number) => Number.isFinite(x) && Math.abs(x)<=1e6;
const clamp = (x: number, j: Joint) => Math.max(j.min,-1e6,Math.min(j.max,1e6,x));
function vector(v: readonly number[] | undefined, fallback: V3): V3 {
  if(v===undefined) return [...fallback];
  if(v.length!==3 || !v.every(finite)) fail('Expected three finite coordinates of magnitude at most 1e6');
  return [...v] as V3;
}
function quaternion(v?: IKQuaternion): Q4 {
  if(v===undefined) return [0,0,0,1];
  if(v.length!==4 || !v.every(Number.isFinite)) fail('Expected a finite nonzero quaternion');
  const scale=Math.max(...v.map(Math.abs));
  if(scale===0) fail('Expected a nonzero quaternion');
  const q=v.map(x=>x/scale), n=Math.hypot(...q);
  return q.map(x=>x/n) as Q4;
}
function axes(v?: readonly boolean[]): boolean[] {
  if(v===undefined) return [true,true,true];
  if(v.length!==3 || !v.every(x=>typeof x==='boolean')) fail('Expected three boolean axis flags');
  return [...v];
}
function weight(w=1): number {
  if(!Number.isFinite(w) || w<0 || w>1e6) fail('Expected a weight in 0..1e6');
  return w;
}

/**
 * Simultaneous weighted DLS for trees joined by explicit position/orientation closures.
 * Scalar joints compose into arbitrary translational/rotational DOFs; outputs remain caller-owned.
 * This bounded local search reports failure rather than claiming infeasibility or accepting an open loop.
 */
export class MultiGoalIKSolver {
  private readonly joints: Joint[];
  private readonly order: number[]=[];
  private readonly variables: number[];
  private readonly options: Required<MultiGoalIKOptions>;

  /** Copies topology, rest transforms, bounds and settings; rejects cyclic parent graphs. */
  constructor(joints: readonly IKJoint[], options: MultiGoalIKOptions={}) {
    if(!Array.isArray(joints) || joints.length<1 || joints.length>256) fail('Expected 1..256 joints');
    this.options={iterations:128,candidates:4,positionTolerance:1e-5,orientationTolerance:1e-5,damping:0.01,maxStep:0.25,...options};
    const o=this.options;
    if(!Number.isInteger(o.iterations) || o.iterations<1 || o.iterations>4096 ||
      !Number.isInteger(o.candidates) || o.candidates<1 || o.candidates>64 ||
      !finite(o.positionTolerance) || o.positionTolerance<=0 || !finite(o.orientationTolerance) || o.orientationTolerance<=0 ||
      !finite(o.maxStep) || o.maxStep<=0 || !Number.isFinite(o.damping) || o.damping<1e-6 || o.damping>1e3) fail('Invalid IK solver settings');
    this.joints=joints.map((j,i)=>{
      if(!j || !['fixed','revolute','prismatic'].includes(j.type)) fail('Expected fixed, revolute or prismatic joints');
      const parent=j.parent??-1, min=j.min??-Infinity, max=j.max??Infinity, value=j.value??0;
      if(!Number.isInteger(parent) || parent< -1 || parent>=joints.length || parent===i) fail('Invalid joint parent');
      if(!(min<=max) || min===Infinity || max===-Infinity || (Number.isFinite(min) && !finite(min)) ||
        (Number.isFinite(max) && !finite(max)) || !finite(value) || value<min || value>max) fail('Invalid joint value or bounds');
      if(j.type==='fixed' && (value!==0 || min>0 || max<0)) fail('Fixed joint value must be zero');
      const axis=vector(j.axis,[0,0,1]), n=Math.hypot(...axis);
      if(n===0) fail('Expected a nonzero joint axis');
      return {type:j.type,parent,rest:{position:vector(j.position,[0,0,0]),rotation:quaternion(j.rotation)},axis:axis.map(v=>v/n) as V3,value,min,max};
    });
    const seen=new Set<number>(), visiting=new Set<number>();
    const visit=(i:number):void=>{
      if(seen.has(i)) return;
      if(visiting.has(i)) fail('Parent graph has a cycle; express closures with loops');
      visiting.add(i);
      if(this.joints[i].parent>=0) visit(this.joints[i].parent);
      visiting.delete(i); seen.add(i); this.order.push(i);
    };
    joints.forEach((_,i)=>visit(i));
    this.variables=this.order.filter(i=>this.joints[i].type!=='fixed' && this.joints[i].min!==this.joints[i].max);
  }

  private values(values?: readonly number[]): number[] {
    if(values===undefined) return this.joints.map(j=>j.value);
    if(values.length!==this.joints.length || !values.every((v,i)=>finite(v) && v>=this.joints[i].min && v<=this.joints[i].max && (this.joints[i].type!=='fixed' || v===0))) fail('Expected one in-bounds scalar per joint');
    return [...values];
  }
  private frame(frame: IKFrame): Frame {
    if(!frame || !Number.isInteger(frame.joint) || frame.joint< -1 || frame.joint>=this.joints.length) fail('Invalid attachment joint');
    return {joint:frame.joint,local:{position:vector(frame.position,[0,0,0]),rotation:quaternion(frame.rotation)}};
  }
  private forward(values: readonly number[]): Pose[] {
    const poses: Pose[]=Array(this.joints.length);
    for(const i of this.order) {
      const j=this.joints[i], v=values[i], motion=identity();
      if(j.type==='revolute') motion.rotation=[j.axis[0]*Math.sin(v/2),j.axis[1]*Math.sin(v/2),j.axis[2]*Math.sin(v/2),Math.cos(v/2)];
      if(j.type==='prismatic') motion.position=j.axis.map(x=>x*v) as V3;
      poses[i]=compose(j.parent<0?identity():poses[j.parent],compose(j.rest,motion));
    }
    return poses;
  }
  /** Computes owned world transforms, without solving or mutating the configured pose. */
  evaluate(values?: readonly number[], frame?: IKFrame): IKPose[] {
    const poses=this.forward(this.values(values));
    return frame ? [this.attachment(this.frame(frame),poses)] : poses;
  }
  private attachment(f: Frame, poses: Pose[]): Pose { return compose(f.joint<0?identity():poses[f.joint],f.local); }
  private constraints(request: MultiGoalIKRequest): Constraint[] {
    const goals=request.goals??[], loops=request.loops??[];
    if(!Array.isArray(goals) || !Array.isArray(loops) || goals.length+loops.length>256) fail('Expected at most 256 goals and loops');
    const channels=(s:IKChannels)=>({pw:weight(s.positionWeight),ow:weight(s.orientationWeight),pa:axes(s.positionAxes),oa:axes(s.orientationAxes)});
    const out:Constraint[]=goals.map(g=>{
      if(!g) fail('Expected a goal');
      return {a:this.frame(g.frame),target:{position:vector(g.position,[0,0,0]),rotation:quaternion(g.rotation)},position:g.position!==undefined,orientation:g.rotation!==undefined,...channels(g)};
    });
    for(const l of loops) {
      if(!l || (l.position!==undefined && typeof l.position!=='boolean') || (l.orientation!==undefined && typeof l.orientation!=='boolean')) fail('Expected boolean loop channels');
      out.push({a:this.frame(l.a),b:this.frame(l.b),target:identity(),position:l.position??true,orientation:l.orientation??false,...channels(l)});
    }
    for(const c of out) if(!(c.position && c.pw>0 && c.pa.some(Boolean)) && !(c.orientation && c.ow>0 && c.oa.some(Boolean))) fail('Each constraint needs an active channel');
    return out;
  }
  private residual(values: number[], constraints: Constraint[], reference?: Evaluation): Evaluation {
    const poses=this.forward(values), residual:number[]=[], errors:IKError[]=[];
    let resolved=true, row=0;
    for(const c of constraints) {
      const a=this.attachment(c.a,poses), b=c.b?this.attachment(c.b,poses):c.target;
      const p=a.position.map((v,k)=>v-b.position[k]), r=angularError(a.rotation,b.rotation);
      let pe=0, re=0;
      // Unwrap the logarithm across pi for central differences, including masked axes.
      const rawRow=row+(c.position && c.pw>0 ? c.pa.filter(Boolean).length : 0);
      if(reference && c.orientation && c.ow>0) {
        const n=Math.hypot(...r), alt=n>0?r.map(v=>v*(1-2*Math.PI/n)):r;
        let same=0, other=0, at=rawRow;
        for(let k=0;k<3;k++) if(c.oa[k]) {
          const ref=reference.residual[at++]/Math.sqrt(c.ow);
          same+=(r[k]-ref)**2; other+=(alt[k]-ref)**2;
        }
        if(other<same) for(let k=0;k<3;k++) r[k]=alt[k];
      }
      for(let k=0;k<3;k++) if(c.position && c.pw>0 && c.pa[k]) { residual.push(p[k]*Math.sqrt(c.pw)); pe+=p[k]*p[k]; row++; }
      for(let k=0;k<3;k++) if(c.orientation && c.ow>0 && c.oa[k]) { residual.push(r[k]*Math.sqrt(c.ow)); re+=r[k]*r[k]; row++; }
      const error={position:Math.sqrt(pe),orientation:Math.sqrt(re)};
      errors.push(error);
      resolved &&=error.position<=this.options.positionTolerance && error.orientation<=this.options.orientationTolerance;
    }
    return {poses,residual,errors,resolved,objective:residual.reduce((sum,v)=>sum+v*v,0)};
  }

  /** Solves all goals and cuts simultaneously. Failure returns the best bounded pose with resolved=false. */
  solve(request: MultiGoalIKRequest={}): MultiGoalIKResult {
    request.signal?.throwIfAborted();
    const constraints=this.constraints(request), initial=this.values(request.values), o=this.options;
    let bestValues=[...initial], best=this.residual(initial,constraints), iterations=0, candidates=0, exhausted=false;
    for(let seed=0;seed<o.candidates && !best.resolved;seed++) {
      candidates++;
      let values=[...initial];
      if(seed>0) for(const i of this.variables) {
        const j=this.joints[i], span=Number.isFinite(j.max-j.min)?Math.min(j.max-j.min,2):2;
        values[i]=clamp(values[i]+Math.sin((i+1)*2.399963229728653+seed*1.618033988749895)*span*0.5,j);
      }
      let state=this.residual(values,constraints), damping=o.damping;
      for(let step=0;step<o.iterations;step++) {
        request.signal?.throwIfAborted();
        if(state.resolved || state.objective<best.objective) { best=state; bestValues=[...values]; }
        if(state.resolved || !this.variables.length) break;
        iterations++;
        const jac=this.variables.map(i=>{
          const h=Math.min(1e-3,1e-6*Math.max(1,Math.abs(values[i]))), plus=[...values], minus=[...values];
          plus[i]+=h; minus[i]-=h;
          const a=this.residual(plus,constraints,state).residual, b=this.residual(minus,constraints,state).residual;
          return Float64Array.from(a,(v,k)=>(v-b[k])/(2*h));
        });
        let accepted=false, stationary=false;
        for(let trial=0;trial<10;trial++) {
          const blocked=new Set<number>();
          let delta:number[]=[];
          for(let active=0;active<=this.variables.length;active++) {
            delta=dampedStep(jac,state.residual,damping,blocked);
            let added=false;
            this.variables.forEach((i,k)=>{
              const j=this.joints[i];
              if(!blocked.has(k) && ((values[i]<=j.min && delta[k]<0) || (values[i]>=j.max && delta[k]>0))) {blocked.add(k);added=true;}
            });
            if(!added) break;
          }
          const largest=Math.max(0,...delta.map(Math.abs)), scale=largest>o.maxStep?o.maxStep/largest:1;
          const next=[...values];
          this.variables.forEach((i,k)=>{next[i]=clamp(values[i]+delta[k]*scale,this.joints[i]);});
          if(next.every((v,i)=>Math.abs(v-values[i])<=1e-12)) { stationary=true; break; }
          const candidate=this.residual(next,constraints);
          if(candidate.objective<state.objective || candidate.resolved) {
            values=next; state=candidate; damping=Math.max(1e-6,damping*0.5); accepted=true;
            if(state.resolved || state.objective<best.objective) {best=state;bestValues=[...values];}
            break;
          }
          damping=Math.min(1e6,damping*4);
        }
        if(!accepted || stationary || state.resolved) break;
        if(step===o.iterations-1) exhausted=true;
      }
    }
    const count=request.goals?.length??0;
    return {resolved:best.resolved,status:best.resolved?'converged':exhausted?'iteration-limit':'stalled',values:bestValues,poses:best.poses,goals:best.errors.slice(0,count),loops:best.errors.slice(count),objective:best.objective,iterations,candidates};
  }
}
