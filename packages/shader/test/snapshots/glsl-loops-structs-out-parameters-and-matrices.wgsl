struct glsl_Ring{glsl_centre:vec2<f32>,glsl_radius:f32}

struct glsl_function_0_result{out_1:f32,out_2:f32}

@diagnostic(off,derivative_uniformity) fn glsl_inverse2(m:mat2x2<f32>)->mat2x2<f32>{return mat2x2<f32>(m[1][1],-m[0][1],-m[1][0],m[0][0])*(1.0/determinant(m));}
@diagnostic(off,derivative_uniformity) fn glsl_function_0(argument_0:vec2<f32>,argument_1:f32,argument_2:f32)->glsl_function_0_result{
var glsl_p:vec2<f32> = argument_0;
var glsl_angle:f32 = f32();
var glsl_len:f32 = argument_2;
glsl_angle = atan2((glsl_p).y,(glsl_p).x);
_=glsl_angle;
glsl_len = (glsl_len+length(glsl_p));
_=glsl_len;
return glsl_function_0_result(glsl_angle,glsl_len);
}
@diagnostic(off,derivative_uniformity) fn glsl_function_1(argument_0:glsl_Ring,argument_1:vec2<f32>)->f32{
var glsl_r:glsl_Ring = argument_0;
var glsl_p:vec2<f32> = argument_1;
var glsl_a:f32;
var glsl_l:f32=f32(0.0);
let temporary_0=glsl_function_0((glsl_p-glsl_r.glsl_centre),glsl_a,glsl_l);
glsl_a = temporary_0.out_1;
glsl_l = temporary_0.out_2;
return ((f32(1.0)-smoothstep((glsl_r.glsl_radius-f32(0.05)),glsl_r.glsl_radius,glsl_l))*(f32(0.5)+(f32(0.5)*cos((glsl_a*f32(3.0))))));
}
@diagnostic(off,derivative_uniformity) fn glsl_function_2(argument_0:vec2<f32>,argument_1:f32)->vec4<f32>{
var glsl_uv:vec2<f32> = argument_0;
var glsl_t:f32 = argument_1;
var glsl_acc:f32=f32(0.0);
var glsl_i:i32=i32(0);
{
loop{
{glsl_acc = (glsl_acc+glsl_function_1(glsl_Ring(vec2<f32>((f32(0.3)+(f32(0.2)*f32(f32(glsl_i)))),f32(0.5)),(f32(0.15)+(f32(0.05)*glsl_t))),glsl_uv));
_=glsl_acc;
let temporary_1=glsl_i;
glsl_i = (glsl_i+i32(1));
_=temporary_1;}
continuing{
break if !((glsl_i<i32(3)));}}
}
var glsl_m:mat2x2<f32>=glsl_inverse2(mat2x2<f32>(f32(2.0),f32(1.0),f32(1.0),f32(3.0)));
var glsl_q:vec2<f32>=(glsl_m*glsl_uv);
let temporary_2=vec3<f32>(glsl_uv,f32(1.0));
let temporary_3=vec3<f32>(f32(0.5),f32(0.25),glsl_t);
var glsl_o:mat3x3<f32>=mat3x3<f32>(temporary_2*temporary_3[0],temporary_2*temporary_3[1],temporary_2*temporary_3[2]);
var glsl_s:f32=f32(0.0);
{
var glsl_k:i32=i32(0);
loop{if(!((glsl_k<i32(3)))){break;}
{if((glsl_k==i32(1))){continue;}
glsl_s = (glsl_s+glsl_o[glsl_k][glsl_k]);
_=glsl_s;}
continuing{let temporary_4=glsl_k;
glsl_k = (glsl_k+i32(1));}}
}
return vec4<f32>(clamp(glsl_acc,f32(0.0),f32(1.0)),((sin(((glsl_q).x*f32(6.0)))*f32(0.5))+f32(0.5)),(glsl_s*f32(0.5)),f32(1.0));
}
@diagnostic(off,derivative_uniformity) fn glsl_entry(a0:vec2f,a1:f32)->vec4f{return glsl_function_2(a0,a1);}