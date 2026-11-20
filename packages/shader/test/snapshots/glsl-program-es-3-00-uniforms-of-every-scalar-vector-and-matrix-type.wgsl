fn margoNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn margoSRGB(x:vec3f)->vec3f {return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
fn margoDisplay(c:vec4f)->vec4f {if(camera.encoding==0.0){return c;}let x=margoNeutral(max(c.rgb,vec3f(0)));if(camera.encoding==2.0){return vec4f(x,c.a);}return vec4f(margoSRGB(x),c.a);}
fn margoEncode(c:vec4f)->vec4f {if(camera.encoding!=1.0){return c;}return vec4f(margoSRGB(max(c.rgb,vec3f(0))),c.a);}
struct MargoCamera { view:mat4x4f, projection:mat4x4f, viewProjection:mat4x4f, position:vec3f, time:f32, resolution:vec2f, deltaTime:f32, encoding:f32, viewport:vec4f }
struct MargoMesh { world:mat4x4f, normal:mat3x3f, pickId:u32 }
@group(0) @binding(0) var<uniform> camera:MargoCamera;
@group(0) @binding(1) var<uniform> mesh:MargoMesh;
struct MargoGBuffer { @location(0) normal:vec4f, @location(1) ambient:vec4f }
fn margoGBuffer(normal:vec3f,position:vec3f,ambient:vec3f)->MargoGBuffer {return MargoGBuffer(vec4f(normalize((camera.view*vec4f(normal,0)).xyz),-(camera.view*vec4f(position,1)).z),vec4f(ambient,1));}
struct Attributes {
  @location(0) position:vec2f,
  @location(1) uv:vec2f,
}
struct Uniforms {
  user_lift:mat4x4f,
  user_f:f32,
  user_f2:vec2f,
  user_f3:vec3f,
  user_f4:vec4f,
  user_i:i32,
  user_i2:vec2i,
  user_u:u32,
  user_u3:vec3u,
  user_b:u32,
  user_b2:vec2u,
  user_m2:vec4f,
  user_m3:mat3x3f,
}
@group(1) @binding(0) var<uniform> uniforms:Uniforms;

var<private> user_position:vec2<f32>;
var<private> user_uv:vec2<f32>;
var<private> user_vUv:vec2<f32>;

var<private> glsl_Position:vec4f;
var<private> glsl_PointSize:f32;
var<private> glsl_VertexID:i32;
var<private> glsl_InstanceID:i32;


@diagnostic(off,derivative_uniformity) fn user_function_0(){

user_vUv = user_uv;
_=user_vUv;
glsl_Position = (uniforms.user_lift*vec4<f32>(user_position,f32(0.0),f32(1.0)));
_=glsl_Position;
return;
}

struct GLSLVaryings{@builtin(position) clip:vec4f,@location(0) v0:vec2f}
@vertex fn margoGLSLVertex(a:Attributes)->GLSLVaryings{
user_position=a.position;
user_uv=a.uv;
user_function_0();
var o:GLSLVaryings;
o.clip=glsl_Position;
// GL clip z runs from -w to w with depth (z/w+1)/2; Margo stores 1 minus that depth (reversed Z).
o.clip.z=(o.clip.w-o.clip.z)*0.5;
o.v0=user_vUv;
return o;
}

// fragment
fn margoNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn margoSRGB(x:vec3f)->vec3f {return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
fn margoDisplay(c:vec4f)->vec4f {if(camera.encoding==0.0){return c;}let x=margoNeutral(max(c.rgb,vec3f(0)));if(camera.encoding==2.0){return vec4f(x,c.a);}return vec4f(margoSRGB(x),c.a);}
fn margoEncode(c:vec4f)->vec4f {if(camera.encoding!=1.0){return c;}return vec4f(margoSRGB(max(c.rgb,vec3f(0))),c.a);}
struct MargoCamera { view:mat4x4f, projection:mat4x4f, viewProjection:mat4x4f, position:vec3f, time:f32, resolution:vec2f, deltaTime:f32, encoding:f32, viewport:vec4f }
struct MargoMesh { world:mat4x4f, normal:mat3x3f, pickId:u32 }
@group(0) @binding(0) var<uniform> camera:MargoCamera;
@group(0) @binding(1) var<uniform> mesh:MargoMesh;
struct MargoGBuffer { @location(0) normal:vec4f, @location(1) ambient:vec4f }
fn margoGBuffer(normal:vec3f,position:vec3f,ambient:vec3f)->MargoGBuffer {return MargoGBuffer(vec4f(normalize((camera.view*vec4f(normal,0)).xyz),-(camera.view*vec4f(position,1)).z),vec4f(ambient,1));}
struct Attributes {
  @location(0) position:vec2f,
  @location(1) uv:vec2f,
}
struct Uniforms {
  user_lift:mat4x4f,
  user_f:f32,
  user_f2:vec2f,
  user_f3:vec3f,
  user_f4:vec4f,
  user_i:i32,
  user_i2:vec2i,
  user_u:u32,
  user_u3:vec3u,
  user_b:u32,
  user_b2:vec2u,
  user_m2:vec4f,
  user_m3:mat3x3f,
}
@group(1) @binding(0) var<uniform> uniforms:Uniforms;

var<private> user_vUv:vec2<f32>;
var<private> user_color:vec4<f32>;

var<private> glsl_FragCoord:vec4f;
var<private> glsl_FrontFacing:bool;
var<private> glsl_PointCoord:vec2f=vec2f(0.5);
var<private> glsl_FragColor:vec4f;
var<private> glsl_FragData:array<vec4f,1>;
var<private> glsl_FragDepth:f32;


@diagnostic(off,derivative_uniformity) fn user_function_0(){

var user_p:vec2<f32>=(mat2x2f(uniforms.user_m2.xy,uniforms.user_m2.zw)*user_vUv);
var user_q:vec3<f32>=(uniforms.user_m3*vec3<f32>(user_vUv,f32(1.0)));
var temporary_0:f32;
if((uniforms.user_b!=0u)){temporary_0=f32(0.125);}else{temporary_0=f32(0.0);}
var user_r:f32=(((uniforms.user_f*(user_p).x)+(((uniforms.user_f2).x*f32(f32(uniforms.user_i)))/f32(8.0)))+temporary_0);
var temporary_1:f32;
if(((uniforms.user_b2!=vec2u(0u))).y){temporary_1=f32(0.0625);}else{temporary_1=f32(0.0);}
var user_g:f32=(((((uniforms.user_f3).y*(user_q).y)+(f32(f32((uniforms.user_i2).y))/f32(16.0)))+temporary_1)+((uniforms.user_f4).w*f32(0.25)));
var user_bl:f32=((((f32(f32(uniforms.user_u))/f32(8.0))+(f32(f32((uniforms.user_u3).z))/f32(32.0)))+(((uniforms.user_f2).y*(user_q).z)*f32(0.25)))+((uniforms.user_f4).x*(user_vUv).x));
user_color = vec4<f32>(clamp(vec3<f32>(user_r,user_g,user_bl),vec3<f32>(f32(0.0)),vec3<f32>(f32(1.0))),f32(1.0));
_=user_color;
return;
}

fn margoGLSLOutput(c:vec4f)->vec4f{if(camera.encoding==1.0){return c;}let x=clamp(c.rgb,vec3f(0),vec3f(1));return vec4f(select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045)),c.a);}

struct GLSLFragmentIn{@builtin(position) margoPosition:vec4f,@builtin(front_facing) margoFront:bool,@location(0) v0:vec2f}
struct GLSLFragmentOut{@location(0) color:vec4f}
@fragment fn margoGLSLFragment(i:GLSLFragmentIn)->GLSLFragmentOut{
let p=i.margoPosition;
glsl_FragCoord=vec4f(p.x,camera.resolution.y-p.y,1.0-p.z,p.w);
glsl_FrontFacing=i.margoFront;
user_vUv=i.v0;
user_function_0();
var o:GLSLFragmentOut;
o.color=margoGLSLOutput(user_color);
return o;
}
