/**
 * WGSL that places one GPU scatter vertex. Instances store `position = (x, y, z, scale)` and
 * `rotation = (yaw, packed ground normal, LOD fade, fade mode)`; the ground normal's X and Z take 12 bits each in one
 * float (integers below 2^24 are exact). `ground.x` is the `alignToGround` amount. Needs `windShader`.
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
struct ScatterPose {world:vec3f,normal:vec3f}
fn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f,ground:vec4f,wind:vec4f)->ScatterPose {
 let c=cos(rotation.x);let s=sin(rotation.x);let up=normalize(mix(vec3f(0,1,0),scatterGround(rotation.y),ground.x));
 var world=scatterTurn(p,c,s,up)*position.w+position.xyz;
 let bend=windBend(world.y-position.y,position.xz,wind);world+=vec3f(bend.x,0,bend.y);
 return ScatterPose(world,windNormal(scatterTurn(n,c,s,up),bend,wind));
}
`;
