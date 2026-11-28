var e=`@group(0) @binding(0) var level:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> light:array<vec4f,11>;
fn basis(i:u32,w:vec3f)->f32{
 switch i {
  case 0u {return 1.0;}
  case 1u {return w.y;}
  case 2u {return w.z;}
  case 3u {return w.x;}
  case 4u {return w.x*w.y;}
  case 5u {return w.y*w.z;}
  case 6u {return 3.0*w.z*w.z-1.0;}
  case 7u {return w.x*w.z;}
  default {return w.x*w.x-w.y*w.y;}
 }
}
@compute @workgroup_size(9) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;var sums=array<vec3f,64>();var up=array<vec3f,64>();let ground=light[10].w>0.0;
 for(var t=0u;t<64u;t++){
  var c=vec3f(0);var e=vec3f(0);
  for(var k=t;k<512u;k+=64u){
   let x=k%32u;let y=k/32u;let phi=((f32(x)+0.5)/32.0-0.5)*6.2831853;let theta=(f32(y)+0.5)/16.0*3.14159265;
   let w=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
   let l=select(textureLoad(level,vec2i(i32(x),i32(y)),0).rgb*sin(theta)*0.0385531,vec3f(0),ground&&w.y<0.0);
   c+=l*basis(i,w);e+=l*max(w.y,0.0);
  }
  sums[t]=c;up[t]=e;
 }
 for(var s=32u;s>0u;s=s>>1u){for(var t=0u;t<s;t++){sums[t]+=sums[t+s];up[t]+=up[t+s];}}
 var scale=array<f32,9>(0.0795775,0.1591549,0.1591549,0.1591549,0.2984155,0.2984155,0.0248680,0.2984155,0.0746039);

 let lg=select(vec3f(0),light[10].w*(up[0]/3.14159265+light[10].rgb),ground);
 let add=select(select(vec3f(0),-lg*3.14159265,i==1u),lg*6.2831853,i==0u);
 light[i]=vec4f((sums[0]+add)*scale[i],0);
}`;export{e as projectRoute};