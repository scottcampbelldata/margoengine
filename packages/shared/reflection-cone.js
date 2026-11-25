// Roughness-driven reflection blur with contact hardening, shared by environment's planar reflectors, water's planar
// reflection and post's SSR (docs/clean-room.md, "Reflection cone"). The reflected lobe is taken as a cone around the
// mirror ray (Uludag, GPU Pro 5, 2014): GGX alpha = roughness^2 (Karis 2013, after Burley 2012), used as Beckmann
// alpha, gives the Phong exponent n = 2 / alpha^2 - 2 (Walter et al. 2007). The share of a cos^n lobe inside
// angle t is 1 - cos^(n+1) t, so the half-vector cone holding 3/4 of it has cos^(n+1) t = 1/4 (the 3/4 share is
// Margo's); the reflected cone is twice that angle (the mirror ray turns by twice the normal's turn), capped at 1.4
// rad. At distance d along the ray the cone covers a disc of radius d tan(angle): the mip whose texel spans that
// disc's diameter is read, so a contact (d = 0) stays sharp and the blur grows with distance from the surface.

/** Largest reflected cone half-angle, radians. */
export const coneLimit = 1.4;
const lobe = Math.log(0.25);

/** Tangent of the reflected cone's half-angle for perceptual roughness 0..1. */
export function reflectionConeTangent(roughness) {
  const alpha = roughness * roughness,
    a2 = alpha * alpha,
    x = (2 * lobe * a2) / (2 - a2),
    // tan^2 = (1 - cos^2) / cos^2, cos^2 = e^x; expm1 keeps smooth surfaces from cancelling to 0.
    half = Math.sqrt(-Math.expm1(x) / Math.exp(x));
  return Math.tan(Math.min(2 * Math.atan(half), coneLimit));
}

/** Mip level for a cone of `roughness` reaching `distance` world units along the ray, where one world unit spans `pixelsPerUnit` level-0 texels; clamped to 0..maxLevel. */
export function reflectionConeLevel(roughness, distance, pixelsPerUnit, maxLevel) {
  const diameter = 2 * distance * reflectionConeTangent(roughness) * pixelsPerUnit;
  return Math.min(maxLevel, Math.max(0, Math.log2(Math.max(diameter, 1))));
}

// The same in WGSL. -expm1 by its series where exp would cancel (|x| < 0.01, error below 2e-9 relative).
// margoCaptureRay: for world point p seen through world-to-clip matrix m (any projection, reversed-Z), the distance s
// along the view ray through p to the point whose depth is d (cleared depth 0: 1e30), and how many texels of an image
// `height` texels tall one world unit spans there (row 1 of m is the vertical scale, unchanged by an oblique near plane).
// margoNearestDepth: the nearest (largest reversed-Z) depth of the 2x2 texels a bilinear lookup at uv reads, so the
// level at an object's silhouette follows the object, not the background beside it, and does not flip with rounding.
export const reflectionConeShader = `fn margoConeTangent(rough:f32)->f32 {
let alpha=rough*rough;let a2=alpha*alpha;let x=${(2 * lobe).toFixed(7)}*a2/(2.0-a2);
let m=select(1.0-exp(x),-x*(1.0+x*(0.5+x/6.0)),x>-0.01);
return tan(min(2.0*atan(sqrt(m/exp(x))),${coneLimit}));
}
fn margoConeLevel(rough:f32,distance:f32,pixelsPerUnit:f32,maxLevel:f32)->f32 {
return clamp(log2(max(2.0*distance*margoConeTangent(rough)*pixelsPerUnit,1.0)),0.0,maxLevel);
}
fn margoCaptureRay(m:mat4x4f,p:vec3f,d:f32,height:f32)->vec2f {
let c=m*vec4f(p,1.0);let ndc=c.xy/c.w;
let r0=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let r1=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);let r3=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);
var dir=normalize(cross((r0-ndc.x*r3).xyz,(r1-ndc.y*r3).xyz));var dz=m*vec4f(dir,0.0);
let away=select((dz.z*c.w-c.z*dz.w)<0.0,dz.w>0.0,abs(dz.w)>1e-6);
if(!away){dir=-dir;dz=-dz;}
let den=dz.z-d*dz.w;
let s=select(1e30,max((d*c.w-c.z)/den,0.0),d>0.0&&abs(den)>1e-30);
return vec2f(s,length(r1.xyz)*0.5*height/max(c.w+s*dz.w,1e-20));
}
fn margoNearestDepth(t:texture_depth_2d,uv:vec2f)->f32 {
let size=vec2i(textureDimensions(t));let p=vec2i(floor(uv*vec2f(size)-0.5));let last=size-1;
let a=textureLoad(t,clamp(p,vec2i(0),last),0);let b=textureLoad(t,clamp(p+vec2i(1,0),vec2i(0),last),0);
let c=textureLoad(t,clamp(p+vec2i(0,1),vec2i(0),last),0);let d=textureLoad(t,clamp(p+vec2i(1,1),vec2i(0),last),0);
return max(max(a,b),max(c,d));
}
`;
