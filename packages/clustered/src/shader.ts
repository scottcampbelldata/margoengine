const declarations=(group:number)=>/* wgsl */`
struct ClusterFrame {view:mat4x4f,grid:vec4u,screen:vec4f,depth:vec4f,intensity:vec4f}
struct ClusterLight {positionRange:vec4f,colorIntensity:vec4f,directionOuter:vec4f,params:vec4f}
@group(${group}) @binding(4) var<uniform> clusterFrame:ClusterFrame;
@group(${group}) @binding(5) var<storage,read> clusterLights:array<ClusterLight>;
`;
// Orthographic cameras (intensity.w): linear depth slices, and x/y bounds constant in depth around the NDC offset intensity.yz.
export const cullingShader=declarations(0)+/* wgsl */`
@group(0) @binding(6) var<storage,read_write> clusterCounts:array<u32>;
@group(0) @binding(7) var<storage,read_write> clusterIndices:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) invocation:vec3u){
  let id=invocation.x;let grid=clusterFrame.grid.xyz;if(id>=grid.x*grid.y*grid.z){return;}
  let cell=vec3u(id%grid.x,(id/grid.x)%grid.y,id/(grid.x*grid.y));
  let ortho=clusterFrame.intensity.w>0.5;let near=clusterFrame.depth.x;let far=clusterFrame.depth.y;
  var z0=near*pow(far/near,f32(cell.z)/f32(grid.z));
  var z1=near*pow(far/near,f32(cell.z+1)/f32(grid.z));
  if(ortho){z0=mix(near,far,f32(cell.z)/f32(grid.z));z1=mix(near,far,f32(cell.z+1)/f32(grid.z));}
  let x0=(f32(cell.x)/f32(grid.x)*2-1-clusterFrame.intensity.y)*clusterFrame.screen.z*clusterFrame.screen.w;
  let x1=(f32(cell.x+1)/f32(grid.x)*2-1-clusterFrame.intensity.y)*clusterFrame.screen.z*clusterFrame.screen.w;
  let y0=(1-f32(cell.y+1)/f32(grid.y)*2-clusterFrame.intensity.z)*clusterFrame.screen.z;
  let y1=(1-f32(cell.y)/f32(grid.y)*2-clusterFrame.intensity.z)*clusterFrame.screen.z;
  let s0=select(z0,1.0,ortho);let s1=select(z1,1.0,ortho);
  let lo=vec3f(min(x0*s0,x0*s1),min(y0*s0,y0*s1),-z1);
  let hi=vec3f(max(x1*s0,x1*s1),max(y1*s0,y1*s1),-z0);
  let center=(lo+hi)*0.5;let radius=length(hi-lo)*0.5;var count=0u;
  for(var j=0u;j<clusterFrame.grid.w;j++){
    let light=clusterLights[j];let p=(clusterFrame.view*vec4f(light.positionRange.xyz,1)).xyz;
    let delta=p-clamp(p,lo,hi);if(dot(delta,delta)>light.positionRange.w*light.positionRange.w){continue;}
    if(light.params.y>0.5){
      let direction=normalize((clusterFrame.view*vec4f(light.directionOuter.xyz,0)).xyz);
      let relative=center-p;let axial=dot(relative,direction);let radial=length(relative-direction*axial);
      let cosine=light.directionOuter.w;let sine=sqrt(max(0.0,1-cosine*cosine));
      if(axial+radius<0||radial*cosine-axial*sine>radius){continue;}
    }
    clusterIndices[id*1024u+count]=j;count++;
  }
  clusterCounts[id]=count;
}`;
/** WGSL for custom materials. With `shadow` (`@margoengine/clustered/shadows`), each light is multiplied by its `clusterShadow`. */
export function clusteredSampling(group:number,shadow?:{declarations(group:number):string}):string {return declarations(group)+(shadow?shadow.declarations(group):'')+/* wgsl */`
@group(${group}) @binding(6) var<storage,read> clusterCounts:array<u32>;
@group(${group}) @binding(7) var<storage,read> clusterIndices:array<u32>;
fn clusterLighting(pixel:vec2f,position:vec3f,n:vec3f,eye:vec3f,base:vec3f,roughness:f32,metal:f32)->vec3f {
  let grid=clusterFrame.grid.xyz;let depth=-(clusterFrame.view*vec4f(position,1)).z;
  if(depth<clusterFrame.depth.x||depth>clusterFrame.depth.y){return vec3f(0);}
  let screenPixel=pixel-clusterFrame.depth.zw*clusterFrame.screen.xy;
  let xy=min(vec2u(max(screenPixel,vec2f(0))/clusterFrame.screen.xy*vec2f(grid.xy)),grid.xy-vec2u(1));
  let near=clusterFrame.depth.x;let far=clusterFrame.depth.y;
  let z=min(u32(max(0.0,select(log(depth/near)/log(far/near),(depth-near)/(far-near),clusterFrame.intensity.w>0.5)*f32(grid.z))),grid.z-1);
  let cell=xy.x+grid.x*(xy.y+grid.y*z);let count=clusterCounts[cell];var result=vec3f(0);
  let v=normalize(eye-position);let nv=clamp(dot(n,v),0.0001,1.0);let a=max(roughness,0.045)*max(roughness,0.045);let a2=a*a;
  for(var j=0u;j<count;j++){
    let light=clusterLights[clusterIndices[cell*1024u+j]];let delta=light.positionRange.xyz-position;let distance=length(delta);
    if(distance>=light.positionRange.w){continue;}let l=delta/max(distance,0.0001);let h=(v+l)/max(length(v+l),0.0001);
    let nl=clamp(dot(n,l),0.0,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
    let d=a2/(3.14159265*pow(nh*nh*(a2-1)+1,2.0));
    let g=2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001);
    let f0=mix(vec3f(0.04),base,metal);let fresnel=f0+(1-f0)*pow(1-vh,5.0);
    let falloff=pow(max(0.0,1-pow(distance/light.positionRange.w,4.0)),2.0)/max(distance*distance,0.01);
    var cone=1.0;if(light.params.y>0.5){cone=clamp((dot(-l,light.directionOuter.xyz)-light.directionOuter.w)/max(light.params.x-light.directionOuter.w,0.00001),0.0,1.0);cone*=cone*(3-2*cone);}
    result+=((1-fresnel)*(1-metal)*base/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl*light.colorIntensity.rgb*light.colorIntensity.w*falloff*cone${shadow?'*clusterShadow(light,position,n)':''};
  }
  return result*clusterFrame.intensity.x;
}`;}
