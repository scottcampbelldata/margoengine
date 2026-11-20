




@diagnostic(off,derivative_uniformity) fn glsl_function_0(argument_0:vec2<f32>,argument_1:f32)->vec4<f32>{
var glsl_uv:vec2<f32> = argument_0;
var glsl_t:f32 = argument_1;
var glsl_c:vec3<f32>=vec3<f32>(glsl_uv,f32(0.25));
return vec4<f32>(mix(glsl_c,(glsl_c).zyx,vec3<f32>(glsl_t)),f32(1.0));
}
@diagnostic(off,derivative_uniformity) fn glsl_entry(a0:vec2f,a1:f32)->vec4f{return glsl_function_0(a0,a1);}