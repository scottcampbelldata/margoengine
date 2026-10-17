// Normal-map frame for a surface without glTF tangents, from screen-space derivatives of position and UV: T and B
// are the surface gradients of u and of -v (the cotangent frame), each pixel's own. glTF puts texture (0, 0) at the
// image's top-left and a normal map's +Y up the image, so B follows decreasing v (b = cross(n, t) * w for glTF
// tangents). The sign of n . (dp1 x dp2) undoes WebGPU's downward screen Y, back faces and mirrored UVs. Scaling by
// the largest component first keeps distant (tiny-derivative) surfaces at full normal-map strength.
export const cotangentFrameShader = `fn margoCotangentFrame(n:vec3f,dp1:vec3f,dp2:vec3f,duv1:vec2f,duv2:vec2f)->mat3x3f{let p1=cross(n,dp1);let p2=cross(dp2,n);var t=p2*duv1.x+p1*duv2.x;var b=p2*duv1.y+p1*duv2.y;let largest=max(max(max(abs(t.x),abs(t.y)),abs(t.z)),max(max(abs(b.x),abs(b.y)),abs(b.z)));if(largest>0){t/=largest;b/=largest;let scale=sign(dot(cross(dp1,dp2),n))*inverseSqrt(max(dot(t,t),dot(b,b)));return mat3x3f(t*scale,-b*scale,n);}let k=normalize(cross(n,select(vec3f(1,0,0),vec3f(0,1,0),abs(n.x)>0.9)));return mat3x3f(k,cross(n,k),n);}`;
