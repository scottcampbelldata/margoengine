// Differentiate homogeneous projection before division. Normalize in viewport pixels, then map the requested
// pixel displacement back to clip XY. Keep clip Z/W: only the silhouette expands, including orthographic views.
export const pixelHull = `
fn pixelHull(p:vec4f,n:vec4f,size:vec2f,width:f32)->vec4f{
  let direction=(n.xy*p.w-p.xy*n.w)*size;
  let magnitude=length(direction);
  var result=p;
  if(magnitude>1e-8&&p.w>0.0){result.x+=direction.x/magnitude*2.0*width/size.x*p.w;result.y+=direction.y/magnitude*2.0*width/size.y*p.w;}
  return result;
}`;
