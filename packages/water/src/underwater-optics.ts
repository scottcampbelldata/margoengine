// Clean-room dielectric boundary and projective pixel traversal. Research: docs/clean-room.md, batch 234 job 3.
// Kept separate so the numerical GPU oracle executes the identical production functions.
export const underwaterOptics = `
fn dielectric(c:f32,eta:f32)->f32 {
 if(eta==1.0){return 0.0;}
 let s=eta*eta*max(0.0,1.0-c*c);if(s>=1.0){return 1.0;}
 let t=sqrt(1.0-s);let a=(eta*c-t)/max(eta*c+t,1e-8);let b=(c-eta*t)/max(c+eta*t,1e-8);
 return (a*a+b*b)*0.5;
}
fn world(pixel:vec2f,z:f32)->vec3f {
 let xy=(pixel-u[14].xy)/u[14].zw*vec2f(2,-2)+vec2f(-1,1);return unproject(xy,z);
}
fn project(p:vec3f)->vec2f {
 let q=mat4x4f(u[0],u[1],u[2],u[3])*vec4f(p,1);
 return u[14].xy+(q.xy/q.w*vec2f(0.5,-0.5)+0.5)*u[14].zw;
}
fn depthPoint(p:vec2i,fallback:vec3f)->vec3f {
 let low=vec2i(u[14].xy);let high=low+vec2i(u[14].zw);
 if(any(p<low)||any(p>=high)){return fallback;}
 let z=textureLoad(depth,p,0);if(z==0){return fallback;}
 return world(vec2f(p)+0.5,z);
}
fn tracePixel(origin:vec3f,ray:vec3f,pixel:vec2i,lo:f32,hi:f32)->vec4f {
  let low=vec2i(u[14].xy);let high=low+vec2i(u[14].zw);
  if(any(pixel<low)||any(pixel>=high)){return vec4f(0,0,0,-1);}
  let z=textureLoad(depth,pixel,0);if(z==0){return vec4f(0,0,0,-1);}
  let p=world(vec2f(pixel)+0.5,z);
  let right=depthPoint(pixel+vec2i(1,0),p)-p;let left=p-depthPoint(pixel-vec2i(1,0),p);
  let down=depthPoint(pixel+vec2i(0,1),p)-p;let up=p-depthPoint(pixel-vec2i(0,1),p);
  let dx=select(right,left,dot(left,left)>0&&dot(left,left)<dot(right,right));
  let dy=select(down,up,dot(up,up)>0&&dot(up,up)<dot(down,down));
  let n=cross(dx,dy);let denom=dot(n,ray);
  if(abs(denom)<1e-12){return vec4f(0,0,0,-1);}
  let distance=dot(n,p-origin)/denom;
  if(distance<lo||distance>hi){return vec4f(0,0,0,-1);}
  let hit=origin+ray*distance;let at=project(hit);
  // Independent depth-plane reconstructions can straddle an exact texel edge
  // by float32 roundoff. A relative arithmetic envelope closes only that crack.
  let epsilon=max(abs(at),vec2f(1))*0.000002;
  if(any(at<vec2f(pixel)-epsilon)||any(at>vec2f(pixel)+1.0+epsilon)){return vec4f(0,0,0,-1);}
  let planeError=length(world(at,z)-hit);
  // The depth at a texel centre differs on a sloped plane. Its derivatives give
  // the physical footprint; depth discontinuities cannot enlarge this bound.
  if(planeError>u[21].y+length(dx)+length(dy)){return vec4f(0,0,0,-1);}
  return vec4f(textureLoad(opaque,pixel,0).rgb,distance);
}
// Frustum-clipped, supercover pixel traversal. At each grid edge visit the next
// crossed texel, including the short corner intervals a fixed DDA stride misses.
// Returns RGB and physical path length, or w=-1 for unavailable geometry.
fn trace(origin:vec3f,ray:vec3f)->vec4f {
 let m=mat4x4f(u[0],u[1],u[2],u[3]);let a=m*vec4f(origin,1);let b=m*vec4f(ray,0);
 let ds=array<f32,6>(a.w+a.x,a.w-a.x,a.w+a.y,a.w-a.y,a.z,a.w-a.z);
 let vs=array<f32,6>(b.w+b.x,b.w-b.x,b.w+b.y,b.w-b.y,b.z,b.w-b.z);
 var lo=0.001;var hi=u[19].y;
 for(var j=0;j<6;j++){
  if(vs[j]>0){lo=max(lo,-ds[j]/vs[j]);}else if(vs[j]<0){hi=min(hi,-ds[j]/vs[j]);}
  else if(ds[j]<0){return vec4f(0,0,0,-1);}
 }
 if(lo>=hi){return vec4f(0,0,0,-1);}
 hi=mix(lo,hi,0.999999);lo=mix(lo,hi,0.000001);
 let pa=project(origin+ray*lo);let pb=project(origin+ray*hi);let delta=pb-pa;
 var pixel=vec2i(floor(pa));let step=vec2i(sign(delta));
 let increment=1.0/max(abs(delta),vec2f(1e-20));
 var edge=(vec2f(pixel)+select(vec2f(0),vec2f(1),delta>=vec2f(0))-pa)/select(vec2f(1e-20),delta,abs(delta)>vec2f(1e-20));
 edge=select(vec2f(1e20),edge,abs(delta)>vec2f(1e-20));
 for(var i=0.0;i<u[21].x;i+=1.0){
  let hit=tracePixel(origin,ray,pixel,lo,hi);if(hit.w>=0.0){return hit;}
  if(min(edge.x,edge.y)>1.0){break;}
  if(edge.x<edge.y){pixel.x+=step.x;edge.x+=increment.x;}
  else {pixel.y+=step.y;edge.y+=increment.y;}
 }
 return vec4f(0,0,0,-1);
}
fn sky(ray:vec3f)->vec3f {
 if(u[23].w>0.5){return textureSampleLevel(environment,skySampler,vec2f(atan2(ray.z,ray.x)/6.283185307+0.5,acos(clamp(ray.y,-1.0,1.0))/3.141592654),0).rgb;}
 return mix(u[22].rgb,u[23].rgb,clamp(ray.y,0.0,1.0));
}
`;
