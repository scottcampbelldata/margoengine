import { rangeError } from '../../shared/errors.js';
import type { ConstraintVolume, Vec3View } from './types.js';
import { validateVector } from './types.js';

/** A joint position in the common world frame. */
export type ChainPoint = [number, number, number];
/** Bounded, static obstacle-aware IK settings. */
export interface ChainOptions {
  /** Position solver. Default 'fabrik'. */
  algorithm?: 'ccd' | 'fabrik';
  /** Capsule radius, shared or one per link. Default 0. */
  radius?: number | readonly number[];
  /** Required gap beyond the capsule radii. Default 0. */
  minClearance?: number;
  /** Target and link-length tolerance in world units. Default 1e-5. */
  tolerance?: number;
  /** Maximum sweeps per candidate, 1..1024. Default 64. */
  iterations?: number;
  /** Maximum deterministic bend seeds and swivel candidates, 1..256. Default 32. */
  candidates?: number;
  /** Optional legal-pose test, called before accepting any candidate. Default none. */
  acceptPose?: (joints: readonly ChainPoint[]) => boolean;
}
/** Owned output; failed solves return the unchanged input pose and never claim clearance. */
export interface ChainResult {
  /** A reachable, length-preserving pose passed every obstacle and pose test. */
  resolved: boolean;
  /** Joint positions; safe to retain across calls. */
  joints: ChainPoint[];
  /** End-to-target distance of the returned pose. */
  distance: number;
  /** Smallest checked static gap, or -Infinity on failure. */
  clearance: number;
  /** Candidates examined. A failure is not a proof of infeasibility. */
  candidates: number;
}

const copy = (p: readonly Vec3View[]): ChainPoint[] => p.map((v) => [v[0], v[1], v[2]]);
const sub = (a: Vec3View, b: Vec3View): ChainPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3View, b: Vec3View) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3View, b: Vec3View): ChainPoint => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = (v: Vec3View) => Math.hypot(v[0], v[1], v[2]);
const distance = (a: Vec3View, b: Vec3View) => norm(sub(a, b));
const unit = (v: ChainPoint): ChainPoint => {
  const n = norm(v);
  return n > 1e-14 ? [v[0]/n, v[1]/n, v[2]/n] : [1, 0, 0];
};
function turn(v: Vec3View, axis: Vec3View, angle: number): ChainPoint {
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(v, axis)*(1-c), w = cross(axis, v);
  return [v[0]*c+w[0]*s+axis[0]*k, v[1]*c+w[1]*s+axis[1]*k, v[2]*c+w[2]*s+axis[2]*k];
}
function place(p: ChainPoint[], at: number, anchor: number, length: number, fallback: Vec3View): void {
  const delta = sub(p[at], p[anchor]), direction = norm(delta) > 1e-14 ? unit(delta) : unit([fallback[0],fallback[1],fallback[2]]);
  for (let k=0;k<3;k++) p[at][k] = p[anchor][k]+direction[k]*length;
}
function reach(p: ChainPoint[], target: Vec3View, lengths: number[], algorithm: string, sweeps: number, tolerance: number): void {
  const root: ChainPoint = [...p[0]], last = p.length-1;
  for (let step=0;step<sweeps && distance(p[last],target)>tolerance;step++) {
    if (algorithm === 'fabrik') {
      p[last] = [target[0],target[1],target[2]];
      for (let i=last-1;i>=0;i--) place(p,i,i+1,lengths[i],[-1,0,0]);
      p[0] = [...root];
      for (let i=1;i<=last;i++) place(p,i,i-1,lengths[i-1],[1,0,0]);
    } else {
      for (let i=last-1;i>=0;i--) {
        const a = unit(sub(p[last],p[i])), b = unit(sub(target,p[i]));
        let axis = cross(a,b);
        if (norm(axis)<1e-12) axis = cross(a,Math.abs(a[0])<0.8 ? [1,0,0] : [0,1,0]);
        axis=unit(axis);
        const angle = Math.acos(Math.max(-1,Math.min(1,dot(a,b))));
        for (let j=i+1;j<=last;j++) {
          const v=turn(sub(p[j],p[i]),axis,angle);
          for(let k=0;k<3;k++) p[j][k]=p[i][k]+v[k];
        }
      }
    }
  }
}

/**
 * N-link CCD or FABRIK with bounded deterministic redundancy search and complete capsule clearance checks.
 * Queries the existing capsule, hull, mesh and SDF volume protocol; no physics or renderer is loaded.
 * Candidate rotations preserve every length. Nonlinear searches may fail despite an existing solution.
 */
export class ChainAvoidanceSolver {
  private readonly volumes: readonly ConstraintVolume[];
  private readonly options: ChainOptions;
  /** Copies the collider list and settings; moving volumes themselves remain live. */
  constructor(volumes: readonly ConstraintVolume[] = [], options: ChainOptions = {}) {
    this.volumes = [...volumes];
    this.options = {...options, radius: Array.isArray(options.radius) ? [...options.radius] : options.radius};
    const {algorithm='fabrik', minClearance=0, tolerance=1e-5, iterations=64, candidates=32} = options;
    if (!['ccd','fabrik'].includes(algorithm) || !(minClearance>=0 && Number.isFinite(minClearance)) ||
      !(tolerance>0 && Number.isFinite(tolerance)) || !Number.isInteger(iterations) || iterations<1 || iterations>1024 ||
      !Number.isInteger(candidates) || candidates<1 || candidates>256 ||
      (options.acceptPose!==undefined && typeof options.acceptPose!=='function'))
      throw rangeError('Invalid chain settings; choose CCD or FABRIK, finite gaps and bounded iteration counts', 'kinematics');
  }
  /** Returns an owned accepted pose, or the input unchanged. Never mutates caller joints or targets. */
  solve(initial: readonly Vec3View[], target: Vec3View): ChainResult {
    if (initial.length<2 || initial.length>257) throw rangeError('Supply 2..257 chain joints', 'kinematics');
    initial.forEach((v)=>validateVector(v,'chain joint'));
    validateVector(target,'chain target');
    const {algorithm='fabrik',minClearance=0,tolerance=1e-5,iterations=64,candidates=32,acceptPose} = this.options;
    const lengths = initial.slice(1).map((v,i)=>distance(v,initial[i]));
    if (lengths.some((v)=>!(v>1e-12 && v<1e50))) throw rangeError('Supply nonzero chain lengths below 1e50', 'kinematics');
    const radius = this.options.radius ?? 0;
    const radii = typeof radius==='number' ? lengths.map(()=>radius) : [...radius];
    if (radii.length!==lengths.length || radii.some((v)=>!(v>=0 && Number.isFinite(v))))
      throw rangeError('Supply a finite nonnegative radius for every link', 'kinematics');
    const fail = (count: number): ChainResult => ({resolved:false,joints:copy(initial),distance:distance(initial.at(-1)!,target),clearance:-Infinity,candidates:count});
    if (distance(initial[0],target)>lengths.reduce((a,b)=>a+b,0)+tolerance) return fail(0);
    const axis = unit(sub(target,initial[0]));
    const side = unit(cross(axis,Math.abs(axis[0])<0.8 ? [1,0,0] : [0,1,0]));
    for(let candidate=0;candidate<candidates;candidate++) {
      const p=copy(initial), angle=2*Math.PI*candidate/candidates;
      // Non-collinear seeds escape straight-chain fixed points, in several bend planes.
      if(candidate>0) for(let i=1;i<p.length-1;i++) {
        const offset=turn(side,axis,angle), amount=lengths.reduce((a,b)=>a+b,0)*0.15*Math.sin(Math.PI*i/(p.length-1));
        for(let k=0;k<3;k++) p[i][k]+=offset[k]*amount;
      }
      if(candidate>0) for(let i=1;i<p.length;i++) place(p,i,i-1,lengths[i-1],sub(initial[i],initial[i-1]));
      reach(p,target,lengths,algorithm,iterations,tolerance);
      if(distance(p.at(-1)!,target)>tolerance) continue;
      // Swivel around the fixed endpoints, preserving link lengths and the target.
      for(let i=1;i<p.length-1;i++) {
        const v=turn(sub(p[i],p[0]),axis,angle);
        for(let k=0;k<3;k++) p[i][k]=p[0][k]+v[k];
      }
      if(lengths.some((l,i)=>Math.abs(distance(p[i],p[i+1])-l)>tolerance)) continue;
      let gap=Infinity;
      const out = new Float64Array(1);
      for(let i=0;i<lengths.length;i++) for(const volume of this.volumes) {
        if(volume.segmentClearanceInto) volume.segmentClearanceInto(p[i],p[i+1],radii[i],out);
        else out[0]=volume.segmentClearance(p[i],p[i+1],radii[i]);
        // Nonfinite custom query results never certify an untested pose.
        gap = Math.min(gap,Number.isFinite(out[0]) ? out[0] : -Infinity);
      }
      if(gap<minClearance || (acceptPose && !acceptPose(copy(p)))) continue;
      return {resolved:true,joints:p,distance:distance(p.at(-1)!,target),clearance:gap,candidates:candidate+1};
    }
    return fail(candidates);
  }
}

/** Adapter for Animator FullBodyLimb.avoidance; a rejected search returns null for atomic body rollback. */
export function createLimbAvoidance(solver: ChainAvoidanceSolver): (joints: readonly ChainPoint[]) => ChainPoint | null {
  return (joints) => {
    if(joints.length!==3) throw rangeError('Full-body limb avoidance needs exactly three joints', 'kinematics');
    const result=solver.solve(joints,joints[2]);
    return result.resolved ? result.joints[1] : null;
  };
}
