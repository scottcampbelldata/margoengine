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
  @location(0) position:vec3f,
  @location(1) layer:f32,
}

var<private> user_position:vec3<f32>;
var<private> user_layer:f32;
var<private> user_vUv:vec2<f32>;
var<private> user_vLayer:i32;

var<private> glsl_Position:vec4f;
var<private> glsl_PointSize:f32;
var<private> glsl_VertexID:i32;
var<private> glsl_InstanceID:i32;


@diagnostic(off,derivative_uniformity) fn user_function_0(){

user_vUv = (((user_position).xy*vec2<f32>(f32(0.5)))+vec2<f32>(f32(0.5)));
_=user_vUv;
user_vLayer = i32(i32(user_layer));
_=user_vLayer;
glsl_Position = vec4<f32>(user_position,f32(1.0));
_=glsl_Position;
return;
}

struct GLSLVaryings{@builtin(position) clip:vec4f,@location(0) v0:vec2f,@location(1) @interpolate(flat) v1:i32}
@vertex fn margoGLSLVertex(a:Attributes)->GLSLVaryings{
user_position=a.position;
user_layer=a.layer;
user_function_0();
var o:GLSLVaryings;
o.clip=glsl_Position;
// GL clip z runs from -w to w with depth (z/w+1)/2; Margo stores 1 minus that depth (reversed Z).
o.clip.z=(o.clip.w-o.clip.z)*0.5;
o.v0=user_vUv;
o.v1=user_vLayer;
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
  @location(0) position:vec3f,
  @location(1) layer:f32,
}

var<private> user_vUv:vec2<f32>;
var<private> user_vLayer:i32;
var<private> user_color:vec4<f32>;

var<private> glsl_FragCoord:vec4f;
var<private> glsl_FrontFacing:bool;
var<private> glsl_PointCoord:vec2f=vec2f(0.5);
var<private> glsl_FragColor:vec4f;
var<private> glsl_FragData:array<vec4f,1>;
var<private> glsl_FragDepth:f32;


@diagnostic(off,derivative_uniformity) fn user_function_0(){

if((user_vLayer==i32(0))){{glsl_FragDepth = (((user_vUv).y*f32(0.75))+f32(0.1));
_=glsl_FragDepth;
user_color = vec4<f32>((glsl_FragCoord).z,f32(0.0),f32(1.0),f32(1.0));
_=user_color;}}else{{glsl_FragDepth = (glsl_FragCoord).z;
_=glsl_FragDepth;
user_color = vec4<f32>(f32(0.0),(glsl_FragCoord).z,f32(0.25),f32(1.0));
_=user_color;}}
return;
}

fn margoGLSLOutput(c:vec4f)->vec4f{if(camera.encoding==1.0){return c;}let x=clamp(c.rgb,vec3f(0),vec3f(1));return vec4f(select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045)),c.a);}

struct GLSLFragmentIn{@builtin(position) margoPosition:vec4f,@builtin(front_facing) margoFront:bool,@location(0) v0:vec2f,@location(1) @interpolate(flat) v1:i32}
struct GLSLFragmentOut{@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn margoGLSLFragment(i:GLSLFragmentIn)->GLSLFragmentOut{
let p=i.margoPosition;
glsl_FragCoord=vec4f(p.x,camera.resolution.y-p.y,1.0-p.z,p.w);
glsl_FrontFacing=i.margoFront;
user_vUv=i.v0;
user_vLayer=i.v1;
glsl_FragDepth=glsl_FragCoord.z;
user_function_0();
var o:GLSLFragmentOut;
o.color=margoGLSLOutput(user_color);
o.depth=clamp(1.0-glsl_FragDepth,0.0,1.0);
return o;
}
