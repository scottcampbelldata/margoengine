// Core Camera.update's view matrix, including its `up` hook (default +Y), for passes that need view space.
export function viewMatrix(out, camera) {
  const p = camera.position, u = camera.up ?? [0,1,0];
  let x = p[0] - camera.target[0], y = p[1] - camera.target[1], z = p[2] - camera.target[2];
  const length = Math.hypot(x,y,z); x /= length; y /= length; z /= length;
  let xx = u[1]*z - u[2]*y, xy = u[2]*x - u[0]*z, xz = u[0]*y - u[1]*x; const side = Math.hypot(xx,xy,xz);
  if (!length || !side) throw new RangeError('Invalid camera view');
  xx /= side; xy /= side; xz /= side; const yx = y*xz - z*xy, yy = z*xx - x*xz, yz = x*xy - y*xx;
  out[0]=xx;out[1]=yx;out[2]=x;out[3]=0;out[4]=xy;out[5]=yy;out[6]=y;out[7]=0;out[8]=xz;out[9]=yz;out[10]=z;out[11]=0;
  out[12]=-xx*p[0]-xy*p[1]-xz*p[2];out[13]=-yx*p[0]-yy*p[1]-yz*p[2];out[14]=-x*p[0]-y*p[1]-z*p[2];out[15]=1;
  return out;
}
