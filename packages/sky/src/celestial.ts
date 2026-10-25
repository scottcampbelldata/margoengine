// Margo stylised sun and moon: radii 0.014 / 0.018 rad are enlarged for readability (the real sun is about
// 0.00465 rad); the glow width (/8) and the moon's x4 + pow 8 x 0.025 limb are Margo tuning.
export const celestialShader = /* wgsl */ `
const SUN_RADIUS=0.014;const MOON_RADIUS=0.018;
fn celestialProfile(ray:vec3f,direction:vec3f,radius:f32,angularFootprint:f32)->vec2f {
 let angle=atan2(length(cross(ray,direction)),clamp(dot(ray,direction),-1.0,1.0));
 let edge=max(0.0002,angularFootprint*0.5);
 // Preserve coverage when a reflection texel is larger than the disc.
 let disk=(1.0-smoothstep(radius-edge,radius+edge,angle))*min(1.0,radius*radius/(edge*edge));
 return vec2f(disk,exp(-angle*angle/(radius*radius*8.0)));
}
fn moonRadiance(ray:vec3f,direction:vec3f,angularFootprint:f32)->f32 {
 let moon=celestialProfile(ray,direction,MOON_RADIUS,angularFootprint);
 // The moon needs a readable limb rather than the sun's saturated bloom.
 return moon.x*4.0+pow(moon.y,8.0)*0.025;
}
`;
