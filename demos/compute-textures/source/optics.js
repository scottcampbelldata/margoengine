export const displayWGSL=`
struct Plate {
  shape: vec4f,
}
@group(0) @binding(0) var field: texture_2d<f32>;
@group(0) @binding(1) var optics: sampler;
@group(0) @binding(2) var<uniform> plate: Plate;

struct Screen { @builtin(position) position: vec4f, @location(0) panel: vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Screen {
  let at=vec2f(f32(i & 1u)*4.-1.,f32((i >> 1u)&1u)*4.-1.);
  return Screen(vec4f(at,0.,1.),at);
}
fn lut(a:f32)->vec3f {
  return mix(vec3f(.031,.065,.062),mix(vec3f(.077,.370,.322),vec3f(.855,.715,.403),smoothstep(.14,.35,a)),smoothstep(.021,.18,a));
}
fn hash(p:vec2f)->f32 {
  return fract(sin(dot(p,vec2f(102.61,61.23)))*23171.451);
}
@fragment fn fragment(i:Screen)->@location(0) vec4f {
  let point=i.panel*vec2f(max(plate.shape.x,1.),max(1./plate.shape.x,1.));
  let y=point.y;
  let slant=point.x / (.965+.045*y);
  let p=vec2f(slant,y*1.090);

  let bg=vec3f(.036,.056,.054)+(.054-.033*min(1.8,dot(point,point)))*vec3f(.18,.68,.54);
  let box=max(abs(p.x),abs(p.y));
  let grit=(hash(floor(i.position.xy))-.5)*.018;
  let steel=vec3f(.297,.210,.127)+.059*y;
  if(box>.835) {
    let shadow=exp(-max(0.,box-.84)*31.)*.51;
    if(box>.878){return vec4f(bg*(1.-shadow)+grit*.29,1.);}
    let lip=smoothstep(.836,.845,box)-smoothstep(.854,.878,box);
    let score=(1.-smoothstep(.001,.003,abs(box-.864)))*.08;
    return vec4f(mix(steel*.46,steel*1.44,lip)+score+grit,1.);
  }
  let uv=vec2f(p.x,-p.y)/1.67+.5;
  let f=textureSampleLevel(field,optics,uv,0.).g;
  let h=1./plate.shape.y;
  let dx=textureSampleLevel(field,optics,uv+vec2f(h,0.),0.).g-textureSampleLevel(field,optics,uv-vec2f(h,0.),0.).g;
  let dy=textureSampleLevel(field,optics,uv+vec2f(0.,h),0.).g-textureSampleLevel(field,optics,uv-vec2f(0.,h),0.).g;
  let relief=normalize(vec3f(-dx*8.,dy*8.,1.));
  let key=max(0.,dot(relief,normalize(vec3f(-.63,.80,.94))));
  let spec=pow(max(0.,dot(relief,normalize(vec3f(-.38,.46,1.8)))),23.);
  let etched=lut(f)*(.55+.71*key)+spec*vec3f(.37,.29,.18)*smoothstep(.06,.24,f);
  let wells=1.-smoothstep(.788,.835,box);
  let glass=.048*max(0.,1.-abs(dot(p,vec2f(.64,.77))-.52)*6.);
  return vec4f(mix(etched,etched*.53,wells)+vec3f(.16,.29,.28)*glass+grit,1.);
}`;

export const triangleGL=`#version 300 es
out vec2 panel;
void main(){
  panel=vec2(float(gl_VertexID&1)*4.-1.,float((gl_VertexID>>1)&1)*4.-1.);
  gl_Position=vec4(panel,0.,1.);
}`;
export const displayGL=`#version 300 es
precision highp float;
in vec2 panel;
out vec4 pixel;
uniform sampler2D field;
uniform vec2 dimensions;
vec3 lut(float a){
  return mix(vec3(.031,.065,.062),mix(vec3(.077,.370,.322),vec3(.855,.715,.403),smoothstep(.14,.35,a)),smoothstep(.021,.18,a));
}
float hash(vec2 p){return fract(sin(dot(p,vec2(102.61,61.23)))*23171.451);}
void main(){
  vec2 point=panel*vec2(max(dimensions.x,1.),max(1./dimensions.x,1.));
  float y=point.y;
  vec2 p=vec2(point.x/(.965+.045*y),y*1.090);

  vec3 bg=vec3(.036,.056,.054)+(.054-.033*min(1.8,dot(point,point)))*vec3(.18,.68,.54);
  float box=max(abs(p.x),abs(p.y));
  float grit=(hash(floor(gl_FragCoord.xy))-.5)*.018;
  vec3 steel=vec3(.297,.210,.127)+.059*y;
  if(box>.835){
    float shadow=exp(-max(0.,box-.84)*31.)*.51;
    if(box>.878){pixel=vec4(bg*(1.-shadow)+grit*.29,1.);return;}
    float lip=smoothstep(.836,.845,box)-smoothstep(.854,.878,box);
    float score=(1.-smoothstep(.001,.003,abs(box-.864)))*.08;
    pixel=vec4(mix(steel*.46,steel*1.44,lip)+score+grit,1.);return;
  }
  vec2 uv=vec2(p.x,-p.y)/1.67+.5;
  float f=textureLod(field,uv,0.).g;
  float h=1./dimensions.y;
  float dx=textureLod(field,uv+vec2(h,0.),0.).g-textureLod(field,uv-vec2(h,0.),0.).g;
  float dy=textureLod(field,uv+vec2(0.,h),0.).g-textureLod(field,uv-vec2(0.,h),0.).g;
  vec3 relief=normalize(vec3(-dx*8.,dy*8.,1.));
  float key=max(0.,dot(relief,normalize(vec3(-.63,.80,.94))));
  float spec=pow(max(0.,dot(relief,normalize(vec3(-.38,.46,1.8)))),23.);
  vec3 etched=lut(f)*(.55+.71*key)+spec*vec3(.37,.29,.18)*smoothstep(.06,.24,f);
  float wells=1.-smoothstep(.788,.835,box);
  float glass=.048*max(0.,1.-abs(dot(p,vec2(.64,.77))-.52)*6.);
  pixel=vec4(mix(etched,etched*.53,wells)+vec3(.16,.29,.28)*glass+grit,1.);
}`;
