import { fullscreen } from '../../shared/gpu.js';
export const kinds = ['wipe', 'dissolve', 'radial', 'chromatic'];
export const shader =
  fullscreen +
  `
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f {let size=vec2i(textureDimensions(t));return textureLoad(t,clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1),0);}
// Dissolve threshold per pixel of the new frame: the PCG hash (Jarzynski and Olano, JCGT 9(3), 2020) nested over the
// pixel's two coordinates, top 24 bits as [0, 1). Fixed per pixel for the whole transition.
fn dissolvePcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn dissolveThreshold(pixel:vec2u)->f32 {return f32(dissolvePcg(pixel.x+dissolvePcg(pixel.y))>>8u)*5.9604645e-8;}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let uv=i.position.xy/vec2f(textureDimensions(after));
 let p=settings.x;if(p<=0.0){return sample(before,uv);}if(p>=1.0){return sample(after,uv);}
 if(settings.y==4.0){return mix(sample(before,uv),sample(after,uv),p);}
 var edge=uv.x;
 if(settings.y==1.0){edge=dissolveThreshold(vec2u(i.position.xy));}
 if(settings.y==2.0){edge=fract(atan2(uv.x-0.5,0.5-uv.y)/6.2831853+1.0);}
 if(settings.y==3.0){let shift=vec2f(sin(p*3.14159265)*settings.z,0);let a=sample(after,uv+shift);let b=sample(after,uv-shift);return mix(sample(before,uv),vec4f(a.r,sample(after,uv).g,b.b,1),p);}
 return mix(sample(before,uv),sample(after,uv),1.0-smoothstep(p-0.01,p+0.01,edge));
}`;
