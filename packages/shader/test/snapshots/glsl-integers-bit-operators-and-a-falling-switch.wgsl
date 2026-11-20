




@diagnostic(off,derivative_uniformity) fn glsl_function_0(argument_0:vec2<f32>,argument_1:f32)->vec4<f32>{
var glsl_uv:vec2<f32> = argument_0;
var glsl_t:f32 = argument_1;
var glsl_x:u32=(u32(u32(((glsl_uv).x*f32(255.0))))^(u32(u32(((glsl_uv).y*f32(255.0))))<<1u));
var glsl_k:i32=i32(i32((glsl_x&3u)));
var glsl_r:f32=f32(0.0);
switch(glsl_k){case i32(0){glsl_r = f32(0.1);
_=glsl_r;
break;}
case i32(1){glsl_r = f32(0.4);
_=glsl_r;
glsl_r = (glsl_r+f32(0.3));
_=glsl_r;
break;}
case i32(2){glsl_r = (glsl_r+f32(0.3));
_=glsl_r;
break;}
case default{glsl_r = f32(0.9);
_=glsl_r;}}
var glsl_g:f32=(f32(f32(((glsl_x>>2u)&15u)))/f32(15.0));
var glsl_b:f32=(f32(f32(((~glsl_x)&7u)))/f32(7.0));
return vec4<f32>(glsl_r,mix(glsl_g,(f32(1.0)-glsl_g),glsl_t),glsl_b,f32(1.0));
}
@diagnostic(off,derivative_uniformity) fn glsl_entry(a0:vec2f,a1:f32)->vec4f{return glsl_function_0(a0,a1);}