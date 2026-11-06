// Bump mapping from screen-space derivatives (Mikkelsen 2010, "Bump Mapping Unparametrized Surfaces on the GPU"): the
// height's screen gradient through the surface's, R1 = dP/dy x N, R2 = N x dP/dx, N' = |det| N - sign(det) (dH/dx R1 +
// dH/dy R2). det takes the face's sign so a back face sees the bump mirrored, as the surface's other side. One WGSL text
// for @margoengine/materials `bumpMap` and gltf-pro's EXT_materials_bump.
/** `margoBumpGradient(n, p, dhdx, dhdy, facing)`: `n` tilted by a height with these screen differences at world point `p`. */
export const bumpGradientWgsl = `fn margoBumpGradient(n:vec3f,p:vec3f,dhdx:f32,dhdy:f32,facing:bool)->vec3f {
  let sx=dpdx(p); let sy=dpdy(p); let r1=cross(sy,n); let r2=cross(n,sx);
  let det=dot(sx,r1)*select(-1.0,1.0,facing); let o=abs(det)*n-sign(det)*(dhdx*r1+dhdy*r2);
  return select(n,normalize(o),dot(o,o)>0.0);
}
`;
