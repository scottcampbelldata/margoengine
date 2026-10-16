export const frame = `struct Frame {camera:mat4x4f,view:mat4x4f,eye:vec4f,viewport:vec4f,settings:vec4f,counts:vec4u}
@group(0) @binding(0) var<uniform> f:Frame;
struct Ellipse {center:vec4f,axes:vec4f}`;
// Orthographic cameras (settings.w): the projection is affine, so the Jacobian is the constant pixel scale, sort keys
// count from the (possibly negative) near plane and spherical harmonics use the fixed view direction.
export const project =
  frame +
  `
@group(0) @binding(1) var<storage,read> positions:array<vec4f>;
@group(0) @binding(2) var<storage,read> covariances:array<vec4f>;
@group(0) @binding(3) var<storage,read> colors:array<vec4f>;
@group(0) @binding(4) var<storage,read> sh:array<f32>;
@group(0) @binding(5) var<storage,read_write> ellipses:array<Ellipse>;
@group(0) @binding(6) var<storage,read_write> evaluated:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> keys:array<vec2u>;
fn color(index:u32)->vec3f {
  if(f.counts.y==0){return colors[index].rgb;}
  var direction=normalize(positions[index].xyz-f.eye.xyz);if(f.settings.w>0.5){direction=-vec3f(f.view[0].z,f.view[1].z,f.view[2].z);}let x=direction.x;let y=direction.y;let z=direction.z;
  var basis:array<f32,16>;basis[0]=0.2820947918;basis[1]=-0.4886025119*y;basis[2]=0.4886025119*z;basis[3]=-0.4886025119*x;
  basis[4]=1.0925484306*x*y;basis[5]=-1.0925484306*y*z;basis[6]=0.3153915653*(3*z*z-1);basis[7]=-1.0925484306*x*z;basis[8]=0.5462742153*(x*x-y*y);
  basis[9]=-0.5900435899*y*(3*x*x-y*y);basis[10]=2.8906114426*x*y*z;basis[11]=-0.4570457995*y*(5*z*z-1);basis[12]=0.3731763326*z*(5*z*z-3);
  basis[13]=-0.4570457995*x*(5*z*z-1);basis[14]=1.4453057213*z*(x*x-y*y);basis[15]=-0.5900435899*x*(x*x-3*y*y);
  var c=vec3f(0.5);for(var i=0u;i<f.counts.y;i++){let at=(index*f.counts.y+i)*3;c+=basis[i]*vec3f(sh[at],sh[at+1],sh[at+2]);}return max(c,vec3f(0));
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {
  let index=id.x;if(index>=f.counts.x){return;}let world=positions[index];let p=f.view*vec4f(world.xyz,1);let depth=-p.z;
  var ellipse:Ellipse;ellipse.center=vec4f(2,2,0,0);ellipse.axes=vec4f(0);keys[index]=vec2u(0xffffffffu,index);
  if(depth>=f.settings.x&&depth<=f.settings.y&&world.w>0){
    let a=covariances[index*2];let b=covariances[index*2+1];let covariance=mat3x3f(vec3f(a.x,a.y,a.z),vec3f(a.y,a.w,b.x),vec3f(a.z,b.x,b.y));
    let rotation=mat3x3f(f.view[0].xyz,f.view[1].xyz,f.view[2].xyz);let c=rotation*covariance*transpose(rotation);
    var jx=vec3f(f.viewport.z/depth,0,f.viewport.z*p.x/(depth*depth));var jy=vec3f(0,f.viewport.w/depth,f.viewport.w*p.y/(depth*depth));
    if(f.settings.w>0.5){jx=vec3f(f.viewport.z,0,0);jy=vec3f(0,f.viewport.w,0);}
    let xx=dot(jx,c*jx)+0.3;let xy=dot(jx,c*jy);let yy=dot(jy,c*jy)+0.3;let mid=(xx+yy)*0.5;let radius=sqrt(max(0.0,(xx-yy)*(xx-yy)*0.25+xy*xy));
    let major=max(mid+radius,0.3);let minor=max(mid-radius,0.3);var axis=vec2f(1,0);
    if(abs(xy)>0.000001){axis=normalize(vec2f(xy,major-xx));}else if(yy>xx){axis=vec2f(0,1);}
    let scale=vec2f(2)/f.viewport.xy;let first=axis*(3*sqrt(major))*scale;let second=vec2f(-axis.y,axis.x)*(3*sqrt(minor))*scale;
    let clip=f.camera*vec4f(world.xyz,1);let ndc=clip.xyz/clip.w;let extent=abs(first)+abs(second);
    if(all(abs(ndc.xy)<=vec2f(1)+extent)) {ellipse.center=vec4f(ndc,world.w);ellipse.axes=vec4f(first,second);keys[index]=vec2u(~bitcast<u32>(select(depth,depth-f.settings.x,f.settings.w>0.5)),index);}
  }ellipses[index]=ellipse;evaluated[index]=vec4f(color(index),world.w);
}`;
export const render =
  frame +
  `
@group(0) @binding(1) var<storage,read> ellipses:array<Ellipse>;
@group(0) @binding(2) var<storage,read> colors:array<vec4f>;
@group(0) @binding(3) var<storage,read> sorted:array<vec2u>;
struct Out {@builtin(position) clip:vec4f,@location(0) corner:vec2f,@location(1) color:vec4f}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {
  let corners=array<vec2f,4>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(1,1));let index=sorted[instance].y;let e=ellipses[index];let corner=corners[vertex];var o:Out;
  o.clip=vec4f(e.center.xy+e.axes.xy*corner.x+e.axes.zw*corner.y,e.center.z,1);o.corner=corner;o.color=vec4f(colors[index].rgb,e.center.w);
  if(e.center.w==0){o.clip=vec4f(2,2,0,1);}return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {let power=-4.5*dot(i.corner,i.corner);if(power<-4.5){discard;}let alpha=min(0.99,i.color.a*exp(power));if(alpha<1.0/255){discard;}
  var c=i.color.rgb;if(f.settings.z<0.5){c=clamp(c,vec3f(0),vec3f(1));c=select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));}return vec4f(c,alpha);}`;
