




@diagnostic(off,derivative_uniformity) fn glsl_function_0(argument_0:vec2<f32>,argument_1:f32,argument_2:texture_2d<f32>,argument_2s:sampler)->vec4<f32>{
var glsl_uv:vec2<f32> = argument_0;
var glsl_t:f32 = argument_1;

var glsl_cell:vec2<f32>=((floor((glsl_uv*vec2<f32>(f32(8.0))))+vec2<f32>(f32(0.5)))/vec2<f32>(f32(8.0)));
var glsl_c:vec4<f32>=textureSampleLevel(argument_2,argument_2s,glsl_cell,f32(0.0));
let temporary_1=i32(0);
var glsl_size:vec2<i32>=vec2<i32>(textureDimensions(argument_2,temporary_1));
let temporary_2=vec2<i32>(vec2<i32>((glsl_cell*vec2<f32>(vec2<f32>(glsl_size)))));
let temporary_3=i32(0);
var glsl_d:vec4<f32>=textureLoad(argument_2,temporary_2.xy,temporary_3);
if(((glsl_uv).x>f32(0.5))){glsl_c = textureSample(argument_2,argument_2s,(glsl_cell).yx);
_=glsl_c;}
return vec4<f32>((glsl_c).xy,mix((glsl_d).z,(glsl_c).w,glsl_t),f32(1.0));
}
@diagnostic(off,derivative_uniformity) fn glsl_entry(a0:vec2f,a1:f32,a2:texture_2d<f32>,a2s:sampler)->vec4f{return glsl_function_0(a0,a1,a2,a2s);}