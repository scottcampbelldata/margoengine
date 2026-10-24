// Per-pixel tangent frame for tangent-space normal maps on meshes without TANGENT, from the screen-space derivatives
// of the world position (dp1 = dpdx, dp2 = dpdy) and of the UV (duv1, duv2). This is the method published by
// Christian Schuler, "Followup: Normal Mapping Without Precomputed Tangents" (2013), and the surface gradients of
// Morten Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU" (2010).
//
// Derivation: a UV coordinate f has screen derivatives df_i = grad(f) . dp_i (i = 1, 2), with grad(f) in the
// tangent plane. Writing grad(f) = (df1 R1 + df2 R2) / det with
// R1 = dp2 x n and R2 = n x dp1 solves that 2x2 system, because dp1 . R1 = det, dp2 . R1 = 0, dp1 . R2 = 0 and
// dp2 . R2 = det, where det = dp1 . (dp2 x n) = n . (dp1 x dp2). T is grad(u); B is grad(-v), so it points up the
// image (glTF: UV (0, 0) at the upper-left, normal-map +Y up). Only det's sign survives the normalisation, and it is
// what turns the frame for WebGPU's downward screen y, back faces and mirrored UVs. T and B share one scale (the
// inverse of the longer one) so a stretched UV keeps its relative strength. Both inputs are first divided by their
// largest absolute component (a positive factor, so the result is unchanged) so the tiny derivatives of distant
// surfaces do not underflow in float32. Zero derivatives (degenerate UVs, helper lanes) give a fixed orthonormal
// frame around n, built from the x axis, or the z axis when |n.x| > 0.5 (at least 30 degrees from n).
export const cotangentFrameShader = /* wgsl */ `fn margoCotangentFrame(n:vec3f,dp1:vec3f,dp2:vec3f,duv1:vec2f,duv2:vec2f)->mat3x3f {
  let ps=max(max(max(abs(dp1.x),abs(dp1.y)),max(abs(dp1.z),abs(dp2.x))),max(abs(dp2.y),abs(dp2.z)));
  let us=max(max(abs(duv1.x),abs(duv1.y)),max(abs(duv2.x),abs(duv2.y)));
  if(ps>0.0&&us>0.0){
    let q1=dp1/ps;let q2=dp2/ps;let w1=duv1/us;let w2=duv2/us;
    let r1=cross(q2,n);let r2=cross(n,q1);let side=select(-1.0,1.0,dot(q1,r1)>=0.0);
    let gu=(r1*w1.x+r2*w2.x)*side;let gv=(r1*w1.y+r2*w2.y)*(-side);
    let longest=max(dot(gu,gu),dot(gv,gv));
    if(longest>1e-30){let k=inverseSqrt(longest);return mat3x3f(gu*k,gv*k,n);}
  }
  let axis=select(vec3f(1,0,0),vec3f(0,0,1),abs(n.x)>0.5);let t=normalize(axis-n*dot(n,axis));
  return mat3x3f(t,cross(n,t),n);
}
`;
