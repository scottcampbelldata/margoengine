// WGSL for ParticleLiquid (screen-space liquid surface from particles). Written clean room from:
// - W. J. van der Laan, S. Green, M. Sainz, Screen Space Fluid Rendering with Curvature Flow, I3D 2009
//   (sphere sprites writing eye depth, additive thickness, normals from the smaller one-sided depth difference);
// - N. Truong, C. Yuksel, A Narrow-Range Filter for Screen-Space Fluid Rendering, PACM CGIT 1(1) 2018
//   (equations 1 to 9: clamped depth, bias-corrected symmetric weights, dynamic thresholds, world-sized kernel,
//   separable passes plus a small 2D clean-up pass);
// - the Beer-Lambert law for absorption along the thickness and the exact unpolarised Fresnel reflectance.
// Every render pass reads textures with textureLoad and needs no workgroup memory, barriers or float blending beyond
// r16float, so the WebGL2 compatibility layer runs each one as an ordinary draw.

/** Shared uniform block. Offsets in floats are listed in liquid.ts. */
export const liquidBlock = `
struct U {
 viewProj:mat4x4f,inverse:mat4x4f,
 eye:vec4f,forward:vec4f,viewport:vec4f,particles:vec4f,kernel:vec4f,
 absorption:vec4f,tint:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f,horizon:vec4f,zenith:vec4f,
}
@group(0) @binding(0) var<uniform> u:U;
fn ndc(px:vec2f)->vec2f {return (px-u.viewport.xy)/u.viewport.zw*vec2f(2,-2)+vec2f(-1,1);}
fn unproject(xy:vec2f,z:f32)->vec3f {let p=u.inverse*vec4f(xy,z,1);return p.xyz/p.w;}
// Unit view ray through a drawing-buffer pixel position (reversed-Z: ndc z 1 is the near plane).
fn rayAt(px:vec2f)->vec3f {return normalize(unproject(ndc(px),1.0)-u.eye.xyz);}
`;

/** Sphere sprites: pass 1 writes the nearest eye depth, pass 3 adds the chord through each sphere. */
export const spriteShader = `${liquidBlock}
@group(0) @binding(1) var<storage,read> points:array<f32>;
@group(0) @binding(2) var scene:texture_depth_2d;
struct Sprite {@builtin(position) clip:vec4f,@location(0) world:vec3f,@location(1) @interpolate(flat) center:vec3f}
@vertex fn sprite(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Sprite {
 let b=u32(u.particles.y)+i*u32(u.particles.x);
 let c=vec3f(points[b],points[b+1u],points[b+2u]);
 let r=u.eye.w;let to=c-u.eye.xyz;let d=length(to);
 var out:Sprite;out.center=c;out.world=c;out.clip=vec4f(2,2,2,1);
 // The eye inside a sphere, or a non-finite centre, draws nothing (a zero-area triangle outside the clip volume).
 if(!(d>r*1.0001)||!(d<3.0e38)){return out;}
 let n=to/d;let a=select(vec3f(0,1,0),vec3f(1,0,0),abs(n.y)>0.9);
 let x=normalize(cross(a,n));let y=cross(n,x);
 // Half-size of a quad through the centre, facing the eye, that covers the sphere's silhouette cone.
 let s=r*d/sqrt(d*d-r*r);
 let k=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[v];
 let w=c+(x*k.x+y*k.y)*s;
 out.world=w;out.clip=u.viewProj*vec4f(w,1);return out;
}
// Entry and exit distances along the ray (x < 0 when it misses), computed from the perpendicular offset so far
// particles keep their precision.
fn chord(dir:vec3f,c:vec3f)->vec2f {
 let oc=c-u.eye.xyz;let b=dot(oc,dir);let m=oc-dir*b;let h=u.eye.w*u.eye.w-dot(m,m);
 if(h<0.0){return vec2f(-1,-1);}let s=sqrt(h);return vec2f(b-s,b+s);
}
fn sceneDistance(at:vec4f,dir:vec3f)->f32 {
 let z=textureLoad(scene,vec2i(at.xy),0);if(z<=0.0){return 3.0e38;}
 return dot(unproject(ndc(at.xy),z)-u.eye.xyz,dir);
}
struct Depth {@location(0) depth:vec4f,@builtin(frag_depth) z:f32}
@fragment fn depth(i:Sprite)->Depth {
 let at=i.clip;
 let dir=normalize(i.world-u.eye.xyz);let t=chord(dir,i.center);
 if(t.x<=0.0||t.x>=sceneDistance(at,dir)){discard;}
 let p=u.eye.xyz+dir*t.x;let q=u.viewProj*vec4f(p,1);
 return Depth(vec4f(dot(p-u.eye.xyz,u.forward.xyz),0,0,1),clamp(q.z/q.w,0.0,1.0));
}
@fragment fn thickness(i:Sprite)->@location(0) vec4f {
 let at=i.clip;
 let dir=normalize(i.world-u.eye.xyz);let t=chord(dir,i.center);
 // Thickness pass runs at resolutionScale: map its pixel back to the full-resolution scene depth.
 let full=vec4f(at.xy/u.zenith.w,at.zw);
 let far=min(t.y,sceneDistance(full,dir));let near=max(t.x,0.0);
 if(t.x<0.0||far<=near){discard;}
 return vec4f((far-near)*u.particles.w,0,0,1);
}
`;

/**
 * Narrow-range filter, Truong and Yuksel 2018. Depth here is eye depth d (positive, growing away from the eye); the
 * paper's z grows toward the eye, so z_j > z_i + delta reads d_i - d_j > delta. One pass filters along `dirs.xy` with a
 * kernel of 3 sigma_i pixels (eq. 5); `dirs.z` 1 runs the 5 x 5 two-dimensional clean-up pass instead.
 */
export const filterShader = `${liquidBlock}
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var<uniform> dirs:vec4f;
struct Vertex {@builtin(position) position:vec4f}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 return Vertex(vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index],0,1));
}
// Empty pixels hold 0 and read as infinitely far, so they clamp to d_i + mu and round the silhouette. Pixels outside
// the view read -1: nothing is known there, so their pair is left out and the image border does not bend the surface.
fn at(p:vec2i)->f32 {
 let low=vec2i(u.viewport.xy);let high=low+vec2i(u.viewport.zw);
 if(any(p<low)||any(p>=high)){return -1.0;}
 let d=textureLoad(source,p,0).x;return select(3.0e38,d,d>0.0);
}
struct Range {lo:f32,hi:f32,sum:f32,weight:f32}
// One symmetric pair j, k at Gaussian weight g (bias correction, eq. 6), clamped by f (eq. 2 with the dynamic range
// of eq. 7), then the thresholds widen along the surface (eqs. 8 and 9).
fn pair(s:Range,di:f32,dj:f32,dk:f32,g:f32)->Range {
 var r=s;
 if(dj<0.0||dk<0.0||di-dj>r.hi||di-dk>r.hi){return r;}
 let delta=u.kernel.y;let mu=u.kernel.z;
 for(var n=0;n<2;n++){
  let d=select(dk,dj,n==0);
  let inside=d<=di+r.lo;
  r.sum+=g*select(di+mu,d,inside);r.weight+=g;
  if(inside&&d>=di-r.hi){r.lo=max(r.lo,d-di+delta);r.hi=max(r.hi,di-d+delta);}
 }
 return r;
}
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f {
 let p=vec2i(position.xy);let di=textureLoad(source,p,0).x;
 if(di<=0.0){return vec4f(0);}
 var r=Range(u.kernel.y,u.kernel.y,di,1.0);
 if(dirs.z>0.5){
  // Clean-up: the twelve mirrored pairs of a 5 x 5 kernel, nearest first, sigma 1 pixel.
  let o=array<vec2i,12>(vec2i(1,0),vec2i(0,1),vec2i(1,1),vec2i(-1,1),vec2i(2,0),vec2i(0,2),vec2i(2,1),vec2i(1,2),
   vec2i(-1,2),vec2i(-2,1),vec2i(2,2),vec2i(-2,2));
  for(var n=0;n<12;n++){let q=o[n];r=pair(r,di,at(p-q),at(p+q),exp(-0.5*f32(dot(q,q))));}
 } else {
  // Equation 5: sigma_i = H sigma / (2 |z_i| tan(fov / 2)), kernel 3 sigma_i, clamped to 1..kernel.w pixels.
  let sigma=max(u.viewport.w*u.kernel.x/(2.0*di*u.forward.w),1e-3);
  let radius=i32(clamp(ceil(3.0*sigma),1.0,u.kernel.w));
  let dir=vec2i(dirs.xy);let inv=-0.5/(sigma*sigma);
  for(var o=1;o<=radius;o++){r=pair(r,di,at(p-dir*o),at(p+dir*o),exp(f32(o*o)*inv));}
 }
 return vec4f(r.sum/r.weight,0,0,1);
}
`;

/** Normals, refraction, absorption, Fresnel reflection and the sun's highlight over the scene colour. */
export const compositeShader = (encode: boolean, display: string) => `${liquidBlock}${encode ? display : ''}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_2d<f32>;
@group(0) @binding(3) var thick:texture_2d<f32>;
@group(0) @binding(4) var linear:sampler;
@group(0) @binding(5) var environment:texture_2d<f32>;
@group(0) @binding(6) var whitewater:texture_2d<f32>;
struct Vertex {@builtin(position) position:vec4f}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 return Vertex(vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index],0,1));
}
fn eyeDepth(p:vec2i)->f32 {
 let low=vec2i(u.viewport.xy);let high=low+vec2i(u.viewport.zw);
 if(any(p<low)||any(p>=high)){return 0.0;}return textureLoad(depth,p,0).x;
}
fn surface(p:vec2i,d:f32)->vec3f {let r=rayAt(vec2f(p)+0.5);return u.eye.xyz+r*(d/dot(r,u.forward.xyz));}
// van der Laan et al.: of the two one-sided differences take the one with the smaller depth step, so a silhouette
// does not tilt the normal; an empty neighbour leaves only the other side.
fn side(p:vec2i,d:f32,c:vec3f,e:vec2i)->vec3f {
 let a=eyeDepth(p+e);let b=eyeDepth(p-e);
 let fa=select(vec3f(0),surface(p+e,a)-c,a>0.0);let fb=select(vec3f(0),c-surface(p-e,b),b>0.0);
 if(a<=0.0){return fb;}if(b<=0.0){return fa;}
 return select(fa,fb,abs(b-d)<abs(a-d));
}
fn sky(r:vec3f)->vec3f {
 if(u.horizon.w>0.5){return textureSampleLevel(environment,linear,vec2f(atan2(r.z,r.x)/6.283185307+0.5,acos(clamp(r.y,-1.0,1.0))/3.141592654),0).rgb;}
 return mix(u.horizon.rgb,u.zenith.rgb,clamp(r.y,0.0,1.0));
}
// Exact unpolarised Fresnel reflectance from air (index 1) into index n at incidence cosine c.
fn fresnel(c:f32,n:f32)->f32 {
 let s=max(0.0,1.0-c*c)/(n*n);if(s>=1.0){return 1.0;}
 let t=sqrt(1.0-s);let a=(c-n*t)/(c+n*t);let b=(n*c-t)/(n*c+t);return 0.5*(a*a+b*b);
}
// The premultiplied whitewater layer over the liquid (ambient.w 1 when whitewater is drawn).
fn foamOver(rgb:vec3f,p:vec2i)->vec3f {
 if(u.ambient.w<0.5){return rgb;}let l=textureLoad(whitewater,p,0);return rgb*(1.0-l.a)+l.rgb;
}
fn sceneAt(px:vec2f)->vec3f {
 let low=u.viewport.xy;let high=low+u.viewport.zw-vec2f(1);
 return textureLoad(scene,vec2i(clamp(px,low,high)),0).rgb;
}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let now=textureLoad(scene,p,0);let d=eyeDepth(p);
 if(u.tint.w<0.5||d<=0.0){let bare=foamOver(now.rgb,p);return vec4f(${encode ? 'toDisplay(bare)' : 'bare'},now.a);}
 let c=surface(p,d);let view=normalize(u.eye.xyz-c);
 var n=cross(side(p,d,c,vec2i(1,0)),side(p,d,c,vec2i(0,1)));
 n=select(view,normalize(n),dot(n,n)>0.0);n=select(n,-n,dot(n,view)<0.0);
 let size=vec2f(textureDimensions(thick));
 let t=textureSampleLevel(thick,linear,at.xy*u.zenith.w/size,0).x;
 let ior=u.absorption.w;let cosine=clamp(dot(n,view),0.0,1.0);let f=fresnel(cosine,ior);
 // Refraction: follow the refracted ray for the thickness and read the scene where it leaves the liquid.
 let bent=refract(-view,n,1.0/ior);let exit=c+bent*t;let q=u.viewProj*vec4f(exit,1);
 let behind=select(now.rgb,sceneAt(u.viewport.xy+(q.xy/q.w*vec2f(0.5,-0.5)+0.5)*u.viewport.zw),q.w>0.0);
 let transmitted=behind*exp(-u.absorption.rgb*t)*u.tint.rgb;
 let reflected=sky(reflect(-view,n));
 let h=normalize(u.light.xyz+view);
 let highlight=u.radiance.rgb*f*pow(max(dot(n,h),0.0),u.light.w)*(u.light.w+8.0)/25.13274123*max(dot(n,u.light.xyz),0.0);
 let rgb=foamOver(mix(transmitted,reflected,f)+highlight,p);
 return vec4f(${encode ? 'toDisplay(rgb)' : 'rgb'},now.a);
}
`;
