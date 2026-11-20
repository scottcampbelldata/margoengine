// Direct lighting is the glTF 2.0 metal-rough BRDF (specification Appendix B): GGX distribution (Walter et al. 2007),
// height-correlated Smith masking-shadowing (Heitz 2014, JCGT 3(2); shared/light-terms.js smithGCorrelated), Schlick
// Fresnel and Lambert diffuse. The display curve is Khronos PBR Neutral (the Khronos Group's published specification),
// then the exact sRGB encoding (IEC 61966-2-1); packages/shared/display.js holds the same curve for every other package. The curve sits above the vertex function: packages replace everything from
// "@vertex fn vertex(" up to "@fragment" with their own vertex stage. Tests read the shader as this file's first
// backtick-quoted text, so comments above it use none.
// Normals turn by the cofactor matrix (Turkowski, Graphics Gems 1990), which exists for a zero scale: a determinant of 0
// counts as not mirrored, and a normal the flattened matrix maps to zero becomes world +Y (glTF 2.0 section 3.5.3).
// Optional shader hooks depend on these WGSL names and line breaks.
export const wgsl = `
struct Frame { camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f }
@group(0) @binding(0) var<uniform> frame:Frame;
override C=false;
fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
struct Input { @location(0) position:vec3f,@location(1) normal:vec3f,@location(2) m0:vec4f,@location(3) m1:vec4f,@location(4) m2:vec4f,@location(5) m3:vec4f,@location(6) color:vec4f,@location(7) factors:vec4f }
struct Output { @builtin(position) @invariant clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) material:vec4f }
@vertex fn vertex(i:Input)->Output {
let model=mat4x4f(i.m0,i.m1,i.m2,i.m3);let p=model*vec4f(i.position,1);
var o:Output;o.clip=frame.camera*p;o.position=p.xyz;
o.normal=mat3x3f(cross(i.m1.xyz,i.m2.xyz),cross(i.m2.xyz,i.m0.xyz),cross(i.m0.xyz,i.m1.xyz))*i.normal*select(-1.0,1.0,dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz))>=0.0);o.normal=select(vec3f(0,1,0),o.normal,dot(o.normal,o.normal)>0.0);
o.color=i.color.rgb;o.material=vec4f(i.factors.xyz,select(-1.0,1.0,dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz))>=0.0));return o;
}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {
let facing=front==(i.material.w>0.0);if(!C&&!facing&&i.material.z<0.5){discard;}
let n=normalize(i.normal)*select(-1.0,1.0,facing);let v=normalize(frame.eye.xyz-i.position);let l=frame.light.xyz;let h=(v+l)/max(length(v+l),0.0001);
let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
let a=i.material.x*i.material.x;let a2=a*a;let k=cross(n,h);let q=max(dot(k,k),step(nh,0.0))+a2*nh*nh;let d=a2/(3.14159265*q*q);
let g=2.0*nl*nv/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),1e-30);
let f0=mix(vec3f(0.04),i.color,i.material.y);let w=1.0-pow(1.0-vh,5.0);let f=1.0-(1.0-f0)*w;
let direct=(0.96*w*(1.0-i.material.y)*i.color/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;
let linear=direct*frame.radiance.xyz*frame.light.w+i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb;
let mapped=pbrNeutral(max(linear,vec3f(0)));return vec4f(select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308)),1);
}`;
