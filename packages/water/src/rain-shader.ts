// Rain rings. Each cell of three offset grids holds at most one drop per lifetime slot, at a hashed place and phase,
// present when a hashed number falls below the rain intensity. The ring is the radial slope of a travelling Gaussian
// bump, normalized so its steepest tilt is `strength`, fading as (1 - age)^2 and with the screen footprint.
// Hashes reuse Water's PCG (Jarzynski and Olano, JCGT 9(3), 2020).
export function rainShader(binding: number): string {
  return `
struct RainFrame {settings:vec4f,shape:vec4f}
@group(0) @binding(${binding}) var<uniform> rainFrame:RainFrame;
fn rainHash(c:vec2i,salt:u32)->f32 {let u=bitcast<vec2u>(c);return f32(ripplePcg(u.x+ripplePcg(u.y+ripplePcg(salt)))>>8u)*5.9604645e-8;}
fn rainRipple(xz:vec2f,footprint:f32)->vec3f {
 let cell=rainFrame.settings.z;let width=cell*0.05;let fade=1.0-smoothstep(width,width*4.0,footprint);
 if(rainFrame.settings.y<=0.0||fade<=0.0){return vec3f(0);}
 var slope=vec2f(0);
 for(var layer=0u;layer<3u;layer++){
  let p=xz/cell+vec2f(f32(layer)*0.37,f32(layer)*0.71);let c=vec2i(floor(p));
  let clock=rainFrame.settings.x/rainFrame.shape.x+rainHash(c,layer);let slot=floor(clock);let age=clock-slot;
  let k=ripplePcg(bitcast<u32>(i32(slot))*3u+layer);
  if(rainHash(c,k)>=rainFrame.settings.y){continue;}
  let centre=vec2f(0.25)+0.5*vec2f(rainHash(c,k+1u),rainHash(c,k+2u));
  let offset=(p-floor(p)-centre)*cell;let d=length(offset);if(d<=0.0){continue;}
  let g=(d-age*0.25*cell)/width;
  // d/dd exp(-g^2) is -2g exp(-g^2)/width; its largest magnitude, sqrt(2) exp(-1/2), scales the tilt to strength.
  slope+=offset/d*(-2.0*g*exp(-g*g)/0.85776388)*(1.0-age)*(1.0-age);
 }
 slope*=rainFrame.settings.w*fade;
 return vec3f(-slope.x,0,-slope.y);
}
`;
}
