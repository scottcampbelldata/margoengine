
const glsl_K:f32=f32(0.75);



@diagnostic(off,derivative_uniformity) fn glsl_function_0(argument_0:f32)->f32{
var glsl_x:f32 = argument_0;
var temporary_0:f32;
if((glsl_x>glsl_K)){temporary_0=(f32(1.0)-glsl_x);}else{temporary_0=(glsl_x*(f32(1.0)/glsl_K));}
return temporary_0;
}
@diagnostic(off,derivative_uniformity) fn glsl_function_1(argument_0:vec2<f32>,argument_1:f32)->vec4<f32>{
var glsl_uv:vec2<f32> = argument_0;
var glsl_t:f32 = argument_1;
var glsl_a:bool=(((glsl_uv).x>f32(0.25))&&((glsl_uv).y<f32(0.75)));
var glsl_b:bool=((!((glsl_uv).x>f32(0.8)))||(glsl_t>f32(0.5)));
let temporary_1=((glsl_uv).x*f32(7.0));
let temporary_2=f32(1.0);
var glsl_m:f32=(temporary_1-temporary_2*floor(temporary_1/temporary_2));
var temporary_3:f32;
if(glsl_a){temporary_3=glsl_function_0((glsl_uv).y);}else{temporary_3=f32(0.2);}
var temporary_4:f32;
if(glsl_b){temporary_4=glsl_m;}else{temporary_4=f32(0.0);}
return vec4<f32>(temporary_3,temporary_4,f32(select(f32(0),f32(1),(glsl_a==glsl_b))),f32(1.0));
}
@diagnostic(off,derivative_uniformity) fn glsl_entry(a0:vec2f,a1:f32)->vec4f{return glsl_function_1(a0,a1);}