// Clean-room rigid transforms and dense damped normal equations. See docs/clean-room.md.
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];
export interface Pose { position: V3; rotation: Q4 }
export const identity = (): Pose => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1] });
export function multiply(a: Q4, b: Q4): Q4 {
  return [
    a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
    a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
    a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
    a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2],
  ];
}
export function rotate(q: Q4, p: V3): V3 {
  const x=2*(q[1]*p[2]-q[2]*p[1]), y=2*(q[2]*p[0]-q[0]*p[2]), z=2*(q[0]*p[1]-q[1]*p[0]);
  return [p[0]+q[3]*x+q[1]*z-q[2]*y, p[1]+q[3]*y+q[2]*x-q[0]*z, p[2]+q[3]*z+q[0]*y-q[1]*x];
}
export function compose(a: Pose, b: Pose): Pose {
  const p=rotate(a.rotation,b.position), q=multiply(a.rotation,b.rotation), n=Math.hypot(...q);
  return {position: p.map((v,k)=>v+a.position[k]) as V3, rotation:q.map(v=>v/n) as Q4};
}
export function angularError(current: Q4, target: Q4): V3 {
  let q=multiply(current,[-target[0],-target[1],-target[2],target[3]]);
  // q and -q are the same rotation. Choose the shortest logarithm.
  if(q[3]<0) q=q.map(v=>-v) as Q4;
  const n=Math.hypot(q[0],q[1],q[2]), scale=n>1e-15 ? 2*Math.atan2(n,q[3])/n : 2;
  return [q[0]*scale,q[1]*scale,q[2]*scale];
}
// Positive definite normal equations by Cholesky. An active bound removes its column.
export function dampedStep(jac: Float64Array[], error: number[], damping: number, blocked: Set<number>): number[] {
  const n=jac.length, free=Array.from({length:n},(_,i)=>i).filter(i=>!blocked.has(i)), size=free.length;
  const l=new Float64Array(size*size), b=new Float64Array(size);
  for(let i=0;i<size;i++) {
    const a=jac[free[i]];
    for(let r=0;r<error.length;r++) b[i]-=a[r]*error[r];
    for(let k=0;k<=i;k++) {
      const c=jac[free[k]];
      let value=i===k ? damping*damping : 0;
      for(let r=0;r<error.length;r++) value+=a[r]*c[r];
      for(let j=0;j<k;j++) value-=l[i*size+j]*l[k*size+j];
      l[i*size+k]=i===k ? Math.sqrt(Math.max(value,damping*damping*1e-6)) : value/l[k*size+k];
    }
  }
  for(let i=0;i<size;i++) {
    for(let k=0;k<i;k++) b[i]-=l[i*size+k]*b[k];
    b[i]/=l[i*size+i];
  }
  const out=Array(n).fill(0);
  for(let i=size-1;i>=0;i--) {
    for(let k=i+1;k<size;k++) b[i]-=l[k*size+i]*out[free[k]];
    out[free[i]]=b[i]/l[i*size+i];
  }
  return out;
}
