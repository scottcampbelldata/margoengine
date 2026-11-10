// Clean-room sampled-cell tracing. The exact EDT supplies conservative empty-space skips;
// cell-boundary traversal preserves one-pixel walls and all empty/full field cases.
export const sdfShader = /* wgsl */ `
struct PaintSettings { camera:vec4f, material:vec4f }
@group(3)@binding(0)var<uniform>paint:PaintSettings;
@group(3)@binding(1)var paintedColor:texture_2d<f32>;
@group(3)@binding(2)var paintedEmission:texture_2d<f32>;
@group(3)@binding(3)var paintedDistance:texture_2d<f32>;
@group(3)@binding(4)var<storage,read>paintChanged:array<u32>;
// RGB radiance; W hit distance in world units, or -1 for no hit.
fn tracePaint(p:vec2f,d:vec2f,reach:f32)->vec4f {
 let size=textureDimensions(paintedDistance);let origin=(p-paint.camera.xy)*paint.camera.z;
 let ray=d*paint.camera.z;var near=0.0;var far=reach;
 for(var j=0u;j<2u;j++){
  if(abs(ray[j])<1e-20){if(origin[j]<0||origin[j]>=f32(size[j])){return vec4f(0,0,0,-1);}}
  else{let a=-origin[j]/ray[j];let b=(f32(size[j])-origin[j])/ray[j];near=max(near,min(a,b));far=min(far,max(a,b));}
 }
 if(near>far){return vec4f(0,0,0,-1);}
 var t=near;
 for(var step=0u;step<size.x+size.y+4u;step++){
  if(t>far){break;}
  let q=origin+ray*t;let cell=vec2i(floor(q+sign(ray)*1e-5));
  if(any(cell<vec2i(0))||any(cell>=vec2i(size))){break;}
  let field=textureLoad(paintedDistance,cell,0);
  if(field.y>0){
   let e=textureLoad(paintedEmission,cell,0);var rgb=e.rgb*e.a*paint.material.y;
   if(t>1e-6){
    let f=q-vec2f(cell);let delta=select(vec2f(1)-f,f,ray>vec2f(0));
    var face=select(1u,0u,ray.x>0);if(abs(ray.x)<1e-20||(abs(ray.y)>1e-20&&delta.y<delta.x)){face=select(3u,2u,ray.y>0);}
    rgb+=surfaces[u.counts.x*2u+(u32(cell.y)*size.x+u32(cell.x))*4u+face].rgb;
   }
   return vec4f(rgb,t);
  }
  var next=vec2f(1e30);
  for(var j=0u;j<2u;j++){
   if(abs(ray[j])>1e-20){let boundary=f32(cell[j])+select(0.0,1.0,ray[j]>0);next[j]=(boundary-q[j])/ray[j];}
  }
  let safe=max(0,field.x-.7071068-length(q-(vec2f(cell)+.5)))/paint.camera.z;
  t+=max(safe,min(next.x,next.y)+1e-5/paint.camera.z);
 }
 return vec4f(0,0,0,-1);
}
`;

export const paintedBounceShader = /* wgsl */ `
fn bouncePaint(index:u32){
 let size=textureDimensions(paintedDistance);let pixel=index/4u;if(pixel>=size.x*size.y){return;}
 let cell=vec2i(i32(pixel%size.x),i32(pixel/size.x));let face=index%4u;
 let at=u.counts.x*2u+index;
 if(textureLoad(paintedDistance,cell,0).y==0){output[at]=vec4f(0);return;}
 var n=vec2f(-1,0);if(face==1u){n=vec2f(1,0);}if(face==2u){n=vec2f(0,-1);}if(face==3u){n=vec2f(0,1);}
 let neighbour=cell+vec2i(n);
 if(all(neighbour>=vec2i(0))&&all(neighbour<vec2i(size))){
  if(textureLoad(paintedDistance,neighbour,0).y>0){output[at]=vec4f(0);return;}
 }
 let p=paint.camera.xy+(vec2f(cell)+.5+n*.501)/paint.camera.z;
 var rgb=direct(p,n);var cosineSum=0.0;
 for(var k=0u;k<32u;k++){cosineSum+=max(0,dot(n,direction(k,32u)));}
 for(var k=0u;k<32u;k++){
  let d=direction(k,32u);rgb+=trace(p,d,u.misc.w).rgb*(max(0,dot(n,d))/cosineSum);
 }
 output[at]=vec4f(rgb*clamp(textureLoad(paintedColor,cell,0).rgb,vec3f(0),vec3f(1))*u.material.x,0);
}
`;
