export function viewMatrix(out, camera) {
  let x = camera.position[0] - camera.target[0], y = camera.position[1] - camera.target[1], z = camera.position[2] - camera.target[2];
  const length = Math.hypot(x,y,z); x /= length; y /= length; z /= length;
  const horizontal = Math.hypot(x,z), xx = z / horizontal, xz = -x / horizontal, yx = y * xz, yy = z * xx - x * xz, yz = -y * xx;
  if (!length || !horizontal) throw new RangeError('Invalid camera view');
  out[0]=xx;out[1]=yx;out[2]=x;out[3]=0;out[4]=0;out[5]=yy;out[6]=y;out[7]=0;out[8]=xz;out[9]=yz;out[10]=z;out[11]=0;
  out[12]=-xx*camera.position[0]-xz*camera.position[2];
  out[13]=-yx*camera.position[0]-yy*camera.position[1]-yz*camera.position[2];
  out[14]=-x*camera.position[0]-y*camera.position[1]-z*camera.position[2];out[15]=1;
  return out;
}
