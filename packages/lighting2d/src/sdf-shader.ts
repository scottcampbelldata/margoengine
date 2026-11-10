// Clean-room sampled-cell tracing. The exact EDT supplies conservative empty-space skips;
// cell-boundary traversal preserves one-pixel walls and all empty/full field cases.
export const sdfShader = /* wgsl */ `
struct PaintSettings { camera:vec4f, material:vec4f }
@group(3)@binding(0)var<uniform>paint:PaintSettings;
@group(3)@binding(1)var paintedColor:texture_2d<f32>;
@group(3)@binding(2)var paintedEmission:texture_2d<f32>;
@group(3)@binding(3)var paintedDistance:texture_2d<f32>;
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
  if(field.y>0){let e=textureLoad(paintedEmission,cell,0);return vec4f(e.rgb*e.a*paint.material.y,t);}
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
