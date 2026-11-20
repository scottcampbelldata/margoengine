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
}
struct Uniforms {
  user_shift__0:vec2f,
  user_shift__1:vec2f,
  user_rig__key__color:vec3f,
  user_rig__key__power:f32,
  user_rig__key__on:u32,
  user_rig__key__spin:vec4f,
  user_rig__fill__0__color:vec3f,
  user_rig__fill__0__power:f32,
  user_rig__fill__0__on:u32,
  user_rig__fill__0__spin:vec4f,
  user_rig__fill__1__color:vec3f,
  user_rig__fill__1__power:f32,
  user_rig__fill__1__on:u32,
  user_rig__fill__1__spin:vec4f,
  user_rig__weights__0:f32,
  user_rig__weights__1:f32,
  user_rig__weights__2:f32,
  user_gains__0:f32,
  user_gains__1:f32,
  user_gains__2:f32,
  user_gains__3:f32,
  user_offsets__0:vec2f,
  user_offsets__1:vec2f,
  user_steps__0:vec2i,
  user_steps__1:vec2i,
  user_palette:array<vec4f,3>,
  user_skew:mat4x4f,
  user_tone__lift:vec3f,
  user_tone__scale:f32,
  user_bias:f32,
}
@group(1) @binding(0) var<uniform> uniforms:Uniforms;

var<private> user_position:vec2<f32>;
var<private> user_vUv:vec2<f32>;

var<private> glsl_Position:vec4f;
var<private> glsl_PointSize:f32;
var<private> glsl_VertexID:i32;
var<private> glsl_InstanceID:i32;
var<private> user_shift:array<vec2f,2>;


@diagnostic(off,derivative_uniformity) fn user_function_0(){

user_vUv = (((user_position*vec2<f32>(f32(0.5)))+vec2<f32>(f32(0.5)))+user_shift[i32(1)]);
_=user_vUv;
glsl_Position = vec4<f32>(user_position,f32(0.0),f32(1.0));
_=glsl_Position;
return;
}

struct GLSLVaryings{@builtin(position) clip:vec4f,@location(0) v0:vec2f}
@vertex fn margoGLSLVertex(a:Attributes)->GLSLVaryings{
user_position=a.position;
user_shift=array<vec2f,2>(uniforms.user_shift__0,uniforms.user_shift__1);
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
}
struct Uniforms {
  user_shift__0:vec2f,
  user_shift__1:vec2f,
  user_rig__key__color:vec3f,
  user_rig__key__power:f32,
  user_rig__key__on:u32,
  user_rig__key__spin:vec4f,
  user_rig__fill__0__color:vec3f,
  user_rig__fill__0__power:f32,
  user_rig__fill__0__on:u32,
  user_rig__fill__0__spin:vec4f,
  user_rig__fill__1__color:vec3f,
  user_rig__fill__1__power:f32,
  user_rig__fill__1__on:u32,
  user_rig__fill__1__spin:vec4f,
  user_rig__weights__0:f32,
  user_rig__weights__1:f32,
  user_rig__weights__2:f32,
  user_gains__0:f32,
  user_gains__1:f32,
  user_gains__2:f32,
  user_gains__3:f32,
  user_offsets__0:vec2f,
  user_offsets__1:vec2f,
  user_steps__0:vec2i,
  user_steps__1:vec2i,
  user_palette:array<vec4f,3>,
  user_skew:mat4x4f,
  user_tone__lift:vec3f,
  user_tone__scale:f32,
  user_bias:f32,
}
@group(1) @binding(0) var<uniform> uniforms:Uniforms;
struct user_Light{user_color:vec3<f32>,user_power:f32,user_on:bool,user_spin:mat2x2<f32>}
struct user_Rig{user_key:user_Light,user_fill:array<user_Light,2>,user_weights:array<f32,3>}
struct user_Tone{user_lift:vec3<f32>,user_scale:f32}
var<private> user_vUv:vec2<f32>;
var<private> user_color:vec4<f32>;

var<private> glsl_FragCoord:vec4f;
var<private> glsl_FrontFacing:bool;
var<private> glsl_PointCoord:vec2f=vec2f(0.5);
var<private> glsl_FragColor:vec4f;
var<private> glsl_FragData:array<vec4f,1>;
var<private> glsl_FragDepth:f32;
var<private> user_rig:user_Rig;
var<private> user_gains:array<f32,4>;
var<private> user_offsets:array<vec2f,2>;
var<private> user_steps:array<vec2i,2>;
var<private> user_tone:user_Tone;


@diagnostic(off,derivative_uniformity) fn user_function_0(argument_0:user_Light,argument_1:vec2<f32>)->vec3<f32>{
var user_l:user_Light = argument_0;
var user_p:vec2<f32> = argument_1;
var temporary_0:vec3<f32>;
if(user_l.user_on){temporary_0=((user_l.user_color*vec3<f32>(user_l.user_power))*vec3<f32>(((user_l.user_spin*user_p)).x));}else{temporary_0=vec3<f32>(f32(0.0));}
return temporary_0;
}
@diagnostic(off,derivative_uniformity) fn user_function_1(){

var user_p:vec2<f32>=((user_vUv+(user_offsets[i32(0)]*vec2<f32>(f32(0.5))))+(user_offsets[i32(1)]*vec2<f32>(f32(0.25))));
var user_c:vec3<f32>=((user_function_0(user_rig.user_key,user_p)+(user_function_0(user_rig.user_fill[i32(0)],user_p)*vec3<f32>(f32(0.5))))+(user_function_0(user_rig.user_fill[i32(1)],user_p)*vec3<f32>(f32(0.25))));
var user_q:vec2<f32>=min(user_vUv,vec2<f32>(f32(0.999)));
var user_k:i32=i32(i32(((user_q).x*f32(2.99))));
user_c = (user_c+(((vec3<f32>(user_rig.user_weights[user_k])*vec3<f32>(f32(0.25)))+((uniforms.user_palette[user_k]).xyz*vec3<f32>(f32(0.25))))+(vec3<f32>(user_gains[i32(i32(((user_q).y*f32(3.99))))])*vec3<f32>(f32(0.125)))));
_=user_c;
user_c = (user_c+(((mat2x3f(uniforms.user_skew[0].xyz,uniforms.user_skew[1].xyz)*vec2<f32>(f32(0.25),f32(0.5)))*vec3<f32>(f32(0.25)))+(vec3<f32>(f32(f32((user_steps[i32(1)]).y)))/vec3<f32>(f32(64.0)))));
_=user_c;
user_color = vec4<f32>(clamp((((user_c*vec3<f32>(user_tone.user_scale))+user_tone.user_lift)+vec3<f32>(uniforms.user_bias)),vec3<f32>(f32(0.0)),vec3<f32>(f32(1.0))),f32(1.0));
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
user_rig=user_Rig(user_Light(uniforms.user_rig__key__color,uniforms.user_rig__key__power,(uniforms.user_rig__key__on!=0u),mat2x2f(uniforms.user_rig__key__spin.xy,uniforms.user_rig__key__spin.zw)),array<user_Light,2>(user_Light(uniforms.user_rig__fill__0__color,uniforms.user_rig__fill__0__power,(uniforms.user_rig__fill__0__on!=0u),mat2x2f(uniforms.user_rig__fill__0__spin.xy,uniforms.user_rig__fill__0__spin.zw)),user_Light(uniforms.user_rig__fill__1__color,uniforms.user_rig__fill__1__power,(uniforms.user_rig__fill__1__on!=0u),mat2x2f(uniforms.user_rig__fill__1__spin.xy,uniforms.user_rig__fill__1__spin.zw))),array<f32,3>(uniforms.user_rig__weights__0,uniforms.user_rig__weights__1,uniforms.user_rig__weights__2));
user_gains=array<f32,4>(uniforms.user_gains__0,uniforms.user_gains__1,uniforms.user_gains__2,uniforms.user_gains__3);
user_offsets=array<vec2f,2>(uniforms.user_offsets__0,uniforms.user_offsets__1);
user_steps=array<vec2i,2>(uniforms.user_steps__0,uniforms.user_steps__1);
user_tone=user_Tone(uniforms.user_tone__lift,uniforms.user_tone__scale);
user_vUv=i.v0;
user_function_1();
var o:GLSLFragmentOut;
o.color=margoGLSLOutput(user_color);
return o;
}
