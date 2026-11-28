const d2r = Math.PI / 180;
const length = Math.hypot(.83,.38,-.40);
export const mountAxis = Object.freeze([.83/length,.38/length,-.40/length]);
export const roomAxis = Object.freeze([0,0,1]);

const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const clamp = (v) => Math.min(1,Math.max(-1,v));

function rotated(v,k,angle) {
  const c=Math.cos(angle),s=Math.sin(angle),d=dot(k,v)*(1-c);
  const cross=[k[1]*v[2]-k[2]*v[1],k[2]*v[0]-k[0]*v[2],k[0]*v[1]-k[1]*v[0]];
  return v.map((component,i)=>component*c+cross[i]*s+k[i]*d);
}

export function axisQuaternion(axis,angle) {
  const s=Math.sin(angle/2);
  return [...axis.map((v)=>v*s),Math.cos(angle/2)];
}

/**
 * Solve R_y(outer) R_x(inner) +Z for the desired local spin axis.
 * The lock case models pivots clamped at their zero-tilt calibration.
 */
export function gimbalPose(degrees,locked) {
  const tilt=degrees*d2r;
  const [x,y,z]=rotated(roomAxis,mountAxis,-tilt);
  const outer=locked ? 0 : Math.atan2(x,z);
  const inner=locked ? 0 : -Math.asin(clamp(y));
  const local=[Math.sin(outer)*Math.cos(inner),-Math.sin(inner),Math.cos(outer)*Math.cos(inner)];
  const axis=rotated(local,mountAxis,tilt);
  const deviation=Math.atan2(Math.hypot(axis[0],axis[1]),axis[2])/d2r;
  return { mount:axisQuaternion(mountAxis,tilt),outer,inner,axis,deviation };
}
