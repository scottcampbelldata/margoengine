/**
 * WGSL that places one GPU scatter vertex. Instances store `position = (x, y, z, scale)` and
 * `rotation = (yaw, packed ground normal, LOD fade, fade mode)`; the ground normal's X and Z take 12 bits each in one
 * float (integers below 2^24 are exact). `ground.x` is the `alignToGround` amount; `blade` is
 * `(rootShade, widen / far, 1 / mesh top, 1 / far)`, all 0 without `blades`. Needs `windShader`.
 */
export const poseShader = /* wgsl */ `
fn scatterGround(packed:f32)->vec3f {
 let z=floor(packed/4096.0);let xz=vec2f(packed-z*4096.0,z)/2047.5-1.0;
 return vec3f(xz.x,sqrt(max(0.0,1.0-dot(xz,xz))),xz.y);
}
// Yaw about +Y, then the rotation taking +Y to up (Rodrigues about Y x up, whose length is the sine of the angle).
fn scatterTurn(v:vec3f,c:f32,s:f32,up:vec3f)->vec3f {
 let r=vec3f(c*v.x+s*v.z,v.y,-s*v.x+c*v.z);let k=vec3f(up.z,0,-up.x);
 return r*up.y+cross(k,r)+k*dot(k,r)/(1.0+up.y);
}
// ground.xyz is the terrain normal and ground.w how far the shading normal blends toward it; shade scales the albedo.
struct ScatterPose {world:vec3f,normal:vec3f,ground:vec4f,shade:f32}
fn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f,ground:vec4f,blade:vec4f,eye:vec3f,wind:vec4f)->ScatterPose {
 let c=cos(rotation.x);let s=sin(rotation.x);let g=scatterGround(rotation.y);let up=normalize(mix(vec3f(0,1,0),g,ground.x));
 // Blades: t is 0 at the root and 1 at the tip; distant blades widen so they do not thin below a pixel and alias.
 let d=distance(position.xyz,eye);let t=clamp(p.y*blade.z,0.0,1.0);let wide=1.0+d*blade.y;
 var world=scatterTurn(vec3f(p.x*wide,p.y,p.z*wide),c,s,up)*position.w+position.xyz;
 let bend=windBend(world.y-position.y,position.xz,wind);world+=vec3f(bend.x,0,bend.y);
 // Ground normal at the root, the blade's own normal at the tip, and all ground by the last LOD distance.
 let weight=select(0.0,1.0-t*(1.0-min(d*blade.w,1.0)),blade.w>0.0);
 return ScatterPose(world,windNormal(scatterTurn(n,c,s,up),bend,wind),vec4f(g,weight),1.0-blade.x*(1.0-t));
}
`;

/** WGSL `lodVisible`: the complementary 4x4 Bayer masks that cross-fade an instance between two adjacent LOD rings. */
export const fadeCode = `
fn lodVisible(pixel:vec2f,fade:vec2f)->bool {
 if(fade.y==0.0){return true;}
 let bayer=array<u32,16>(0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);let p=vec2u(pixel)%4u;
 let threshold=(f32(bayer[p.y*4u+p.x])+0.5)/16.0;
 return select(fade.x>=threshold,fade.x<threshold,fade.y==1.0);
}
`;
