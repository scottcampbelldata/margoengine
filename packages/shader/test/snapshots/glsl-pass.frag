#version 300 es
precision highp float;
precision highp int;
struct qVertex { vec4 qposition; vec2 quv; };
in vec2 _v0;
layout(location = 0) out vec4 _o0;
vec4 qfragment(qVertex lv_0);
vec4 qglsl_uentry(vec2 la0_1, float la1_2);
vec4 qglsl_ufunction_u0(vec2 largument_u0_3, float largument_u1_4);
vec4 qfragment(qVertex lv_0) {
  return qglsl_uentry(lv_0.quv, 0.5);
}
vec4 qglsl_uentry(vec2 la0_1, float la1_2) {
  return qglsl_ufunction_u0(la0_1, la1_2);
}
vec4 qglsl_ufunction_u0(vec2 largument_u0_3, float largument_u1_4) {
  vec2 lglsl_uuv_5 = largument_u0_3;
  float lglsl_ut_6 = largument_u1_4;
  vec3 lglsl_uc_7 = vec3(lglsl_uuv_5, 0.25);
  return vec4(mix(lglsl_uc_7, lglsl_uc_7.zyx, vec3(lglsl_ut_6)), 1.0);
}
void main() {
  vec4 _r = qfragment(qVertex(gl_FragCoord, _v0));
  _o0 = gl_FragCoord.w > 0.0 ? _r : vec4(0.0);
}
