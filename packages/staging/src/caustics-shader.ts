export const causticState = `struct State {camera:mat4x4f,center:vec4f,size:vec4f,light:vec4f,optical:vec4f,display:vec4f,misc:vec4f}
@group(0) @binding(7) var<uniform> state:State;`;

/** GPU photon transport, using the public watertight BVH traversal contract. */
export function causticPhotons(bvh: string): string {
  return `${bvh}
${causticState}
@group(0) @binding(5) var<storage,read> original:array<u32>;
@group(0) @binding(6) var<storage,read> normals:array<f32>;
@group(0) @binding(8) var<storage,read_write> energy:array<atomic<u32>>;
fn vertexNormal(i:u32)->vec3f {return vec3f(normals[i*3u],normals[i*3u+1u],normals[i*3u+2u]);}
fn deposit(pixel:vec2i,value:f32){
 let n=i32(state.size.z);
 if(all(pixel>=vec2i(0))&&all(pixel<vec2i(n))){atomicAdd(&energy[u32(pixel.y*n+pixel.x)],u32(round(max(0.0,value)*1073741824.0)));}
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let side=u32(state.size.w);if(id.x>=side*side){return;}
 let uv=(vec2f(f32(id.x%side),f32(id.x/side))+.5)/f32(side)-.5;
 let aperture=state.center.xyz+vec3f(uv.x*state.size.x,state.center.w,uv.y*state.size.y);
 var origin=aperture;var direction=-state.light.xyz;var flux=abs(direction.y)/f32(side*side);
 if(state.light.w>0.0){
  origin=state.light.xyz;direction=normalize(aperture-origin);
  let delta=aperture-origin;flux=abs(direction.y)*state.misc.x/dot(delta,delta)/f32(side*side);
 }
 var touched=false;var done=false;
 let near=state.misc.z;
 for(var event=0u;event<u32(state.optical.w);event++){
  var floorDistance=BVH_NEVER;
  if(direction.y< -1e-8){floorDistance=(state.center.y-origin.y)/direction.y;}
  if(floorDistance<=near){return;}
  let hit=bvhClosest(origin,direction,near,min(floorDistance,BVH_NEVER),0u);
  if(hit.face==BVH_MISS){done=true;break;}
  let a=original[hit.face*3u];let b=original[hit.face*3u+1u];let c=original[hit.face*3u+2u];
  let geometric=normalize(cross(bvhVertex(b)-bvhVertex(a),bvhVertex(c)-bvhVertex(a)));
  var n=vertexNormal(a)*hit.barycoord.x+vertexNormal(b)*hit.barycoord.y+vertexNormal(c)*hit.barycoord.z;
  let largest=max(max(abs(n.x),abs(n.y)),abs(n.z));
  if(largest==0.0){n=geometric;}else{n=normalize(n/largest);}
  if(dot(n,geometric)<0.0){n=-n;}
  if(dot(n,direction)>0.0){n=-n;}
  let eta=select(state.optical.y,1.0/state.optical.x,hit.front);
  let cosine=clamp(-dot(n,direction),0.0,1.0);let sin2=eta*eta*(1.0-cosine*cosine);
  origin+=direction*hit.distance;
  if(sin2>=1.0){direction=reflect(direction,n);}else{
   let cost=sqrt(max(0.0,1.0-sin2));
   let rs=(eta*cosine-cost)/(eta*cosine+cost);let rp=(cosine-eta*cost)/(cosine+eta*cost);
   flux*=1.0-.5*(rs*rs+rp*rp);direction=normalize(eta*direction+(eta*cosine-cost)*n);
  }
  touched=true;
  // An open water interface has only the entry boundary. Closed products follow all exit boundaries.
  if(state.optical.z==0.0){done=true;break;}
 }
 if(!done||!touched||direction.y>= -1e-8){return;}
 let t=(state.center.y-origin.y)/direction.y;if(t<=near){return;}
 let point=origin+direction*t;
 let at=((point.xz-state.center.xz)/state.size.xy+.5)*state.size.z-.5;
 let base=vec2i(floor(at));let f=fract(at);
 deposit(base,flux*(1.0-f.x)*(1.0-f.y));deposit(base+vec2i(1,0),flux*f.x*(1.0-f.y));
 deposit(base+vec2i(0,1),flux*(1.0-f.x)*f.y);deposit(base+vec2i(1,1),flux*f.x*f.y);
}`;
}

/** Additive floor catcher, decoding the integer photon map without half-float saturation. */
export const causticFloor = `${causticState}
@group(0) @binding(8) var<storage,read> energy:array<u32>;
struct Out {@builtin(position) position:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) id:u32)->Out {
 let uv=vec2f(f32(id&1u),f32((id>>1u)&1u));var o:Out;o.uv=uv;
 let world=state.center.xyz+vec3f((uv.x-.5)*state.size.x,state.misc.z,(uv.y-.5)*state.size.y);
 o.position=state.camera*vec4f(world,1);return o;
}
fn loadPixel(pixel:vec2i)->f32{
 let n=i32(state.size.z);if(any(pixel<vec2i(0))||any(pixel>=vec2i(n))){return 0.0;}
 return f32(energy[u32(pixel.y*n+pixel.x)])/1073741824.0;
}
fn sampleMap(uv:vec2f)->f32{
 let at=uv*state.size.z-.5;let p=vec2i(floor(at));let f=fract(at);
 return mix(mix(loadPixel(p),loadPixel(p+vec2i(1,0)),f.x),mix(loadPixel(p+vec2i(0,1)),loadPixel(p+vec2i(1,1)),f.x),f.y);
}
@fragment fn fragment(v:Out)->@location(0) vec4f {
 var value=0.0;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let weight=select(1.0,2.0,x==0)*select(1.0,2.0,y==0)/16.0;
  value+=weight*sampleMap(v.uv+vec2f(f32(x),f32(y))*state.misc.y/state.size.xy);
 }}
 let scale=state.size.z*state.size.z*select(1.0,1.0/state.misc.x,state.light.w>0.0);
 return vec4f(state.display.rgb*value*scale/3.141592653589793,0);
}`;
