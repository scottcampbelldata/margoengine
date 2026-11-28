import {Engine} from '@margoengine/core';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
import {atlas,vapor} from './coast-field.mjs';

const vertex=`#version 300 es
out vec2 ndc;
void main(){
  vec2 point=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2))*2.-1.;
  ndc=point;gl_Position=vec4(point,0.,1.);
}`;
const fragment=`#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 ndc;
out vec4 pixel;
uniform sampler2D relief;
uniform sampler2D pigment;
uniform sampler3D vapor;
uniform vec3 eye,forwardAxis,rightAxis,upAxis,sun;
uniform vec2 plane;
uniform vec4 options;
const float range=19000., base=940., top=3340.;
vec2 surfaceUV(vec2 xz){return xz/range+.5;}
vec4 surface(vec2 xz){
  vec2 uv=surfaceUV(xz);
  if(min(uv.x,uv.y)<0.||max(uv.x,uv.y)>1.)return vec4(0.,0.,.5,.5);
  return texture(relief,uv);
}
float elevation(vec4 t){return (t.r*65280.+t.g*255.)/64.-.4;}
float groundDistance(vec3 ray){
  float t=0.;
  for(int i=0;i<37;i++){
    vec3 a=eye+ray*t;
    float gap=a.y-elevation(surface(a.xz));
    if(gap<2.)return t;
    t+=clamp(gap/(abs(ray.y)+.32)*.72,28.,1210.);
    if(t>28000.)break;
  }
  if(ray.y<-.002){
    float floorDistance=(eye.y+.5)/-ray.y;
    if(floorDistance<30000.)return floorDistance;
  }
  return 30000.;
}
float cloudHeight(vec3 p){return p.y+dot(p.xz,p.xz)/12720000.;}
float density(vec3 p){
  float h=(cloudHeight(p)-base)/(top-base);
  if(h<=0.||h>=1.)return 0.;
  vec3 advect=p-vec3(options.w*13.,0.,options.w*3.);
  vec3 m=advect*.000155+vec3(.49,.47,.55);
  float b=texture(vapor,m*.62+vec3(.20,.00,.12)).r;
  float s=texture(vapor,m).r;
  float detail=texture(vapor,m*4.1+vec3(.21,.63,.12)).r;
  float thresh=mix(.73,.39,options.x);
  float edge=smoothstep(0.,.20,h)*(1.-smoothstep(.58,1.,h));
  float body=smoothstep(thresh,thresh+.18,.72*s+.28*b-.12*(1.-detail)+.085*edge);
  return body*edge;
}
float shadow(vec3 p){
  float altitude=cloudHeight(p);
  if(altitude>=top)return 1.;
  float begin=max(0.,(base-altitude)/sun.y),end=(top-altitude)/sun.y;
  float step=(end-begin)/8.,depth=0.;
  for(int i=0;i<8;i++)depth+=density(p+sun*(begin+(float(i)+.5)*step))*step;
  return exp(-.010*depth);
}
vec3 skyColor(vec3 ray){
  const vec3 topTint=vec3(.056,.17,.35), lowTint=vec3(.50,.67,.73);
  float halo=max(0.,dot(ray,sun));
  vec3 color=mix(lowTint,topTint,smoothstep(-.08,.58,ray.y));
  color+=vec3(.60,.35,.132)*pow(halo,10.)*(1.-.58*smoothstep(.17,.7,ray.y));
  color+=vec3(2.3,1.65,1.04)*smoothstep(.99983,.99996,halo);
  return color;
}
vec3 floorColor(vec3 p,vec3 ray){
  vec2 uv=surfaceUV(p.xz);
  vec4 info=surface(p.xz);
  vec3 tint=vec3(.022,.074,.122);
  if(min(uv.x,uv.y)>=0.&&max(uv.x,uv.y)<=1.)tint=texture(pigment,uv).rgb;
  vec3 n=normalize(vec3(1.-2.*info.b,1.,1.-2.*info.a));
  float direct=mix(1.,shadow(p),options.y),cosine=max(0.,dot(n,sun));
  vec3 incident=vec3(.44,.60,.67)+direct*vec3(1.30,1.07,.77)*cosine;
  vec3 shaded=tint*incident;
  if(elevation(info)<1.){
    float trail=pow(1.-max(0.,-dot(n,ray)),3.3);
    vec3 waterRef=skyColor(reflect(ray,n));
    shaded=mix(shaded,waterRef,.085+trail*.22);
  }
  return shaded;
}
void main(){
  vec3 ray=normalize(forwardAxis+rightAxis*ndc.x*plane.x+upAxis*ndc.y*plane.y);
  float surfaceRange=groundDistance(ray);
  vec3 below=skyColor(ray);
  if(surfaceRange<30000.){
    vec3 shading=floorColor(eye+ray*surfaceRange,ray);
    float haze=1.-exp(-surfaceRange*.000063);
    below=mix(shading,below,haze*.71);
  }
  float first=0.,last=min(surfaceRange,23500.);
  float vertical=ray.y;
  float altitude=cloudHeight(eye);
  if(abs(vertical)>.002){
    float a=(base-altitude)/vertical,b=(top-altitude)/vertical;
    first=clamp(min(a,b),0.,last);
    last=clamp(max(a,b),0.,last);
  }else if(altitude<base||altitude>top)last=0.;
  vec3 cloudRgb=vec3(0.);
  float transmit=1.;
  const int samples=34;
  const vec3 facing=vec3(.84,.96,1.20),gold=vec3(1.47,1.22,.94);
  float jitter=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  float ds=(last-first)/float(samples);
  if(ds>1.)for(int i=0;i<samples;i++){
    vec3 pos=eye+ray*(first+(float(i)+mix(.28,.72,jitter))*ds);
    float amount=density(pos);
    if(amount>.0035){
      float incoming=0.;
      for(int k=1;k<=3;k++)incoming+=density(pos+sun*float(k)*205.);
      float height=smoothstep(base,top,pos.y),shade=exp(-2.1*incoming);
      float phase=pow(max(0.,dot(ray,sun)),4.0);
      vec3 scattering=mix(facing*.42,gold,clamp(.14+height*.36+shade*.68,0.,1.))*(.78+.18*phase);
      float opacity=1.-exp(-amount*ds*.013);
      cloudRgb+=scattering*transmit*opacity;
      transmit*=1.-opacity;
      if(transmit<.012)break;
    }
  }
  vec3 c=cloudRgb+transmit*below;
  if(options.z>.01&&eye.y<top){
    float amount=0.,take=min(min(surfaceRange,first),5900.);
    if(take>1.)for(int i=0;i<7;i++){
      vec3 p=eye+ray*take*(float(i)+.5)/7.;
      amount+=shadow(p)/7.;
    }
    float shaft=amount*(1.-exp(-take*.00016))*pow(max(0.,dot(ray,sun)),10.);
    c+=options.z*transmit*shaft*vec3(.61,.46,.27);
  }
  c=max(vec3(0.),c);
  c=(c*(2.51*c+.03))/(c*(2.43*c+.59)+.14);
  pixel=vec4(pow(clamp(c,0.,1.),vec3(.45455)),1.);
}`;
const unit=v=>{const d=Math.hypot(...v);return v.map(x=>x/d);};
function apply(gl){
  const p=gl.createProgram();
  for(const [type,text] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
    const sh=gl.createShader(type);
    gl.shaderSource(sh,text);gl.compileShader(sh);
    if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){
      const reason=gl.getShaderInfoLog(sh);gl.deleteShader(sh);gl.deleteProgram(p);throw Error(reason);
    }
    gl.attachShader(p,sh);gl.deleteShader(sh);
  }
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const reason=gl.getProgramInfoLog(p);gl.deleteProgram(p);throw Error(reason);}
  const vao=gl.createVertexArray(),locations=Object.fromEntries(
    ['relief','pigment','vapor','eye','forwardAxis','rightAxis','upAxis','sun','plane','options'].map(name=>[name,gl.getUniformLocation(p,name)]));
  const size=177,cloudSize=42,ground=atlas(size),shape=vapor(cloudSize,7538),textures=[];
  function texture(unit,target,format,type,data,n){
    const t=gl.createTexture();textures.push(t);
    gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(target,t);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    if(target===gl.TEXTURE_3D){
      gl.texImage3D(target,0,gl.R8,n,n,n,0,format,type,data);
      gl.texParameteri(target,gl.TEXTURE_WRAP_R,gl.REPEAT);
    }else gl.texImage2D(target,0,gl.RGBA8,n,n,0,format,type,data);
    gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(target,gl.TEXTURE_WRAP_S,target===gl.TEXTURE_3D?gl.REPEAT:gl.CLAMP_TO_EDGE);
    gl.texParameteri(target,gl.TEXTURE_WRAP_T,target===gl.TEXTURE_3D?gl.REPEAT:gl.CLAMP_TO_EDGE);
  }
  texture(0,gl.TEXTURE_2D,gl.RGBA,gl.UNSIGNED_BYTE,ground.elevation,size);
  texture(1,gl.TEXTURE_2D,gl.RGBA,gl.UNSIGNED_BYTE,ground.diffuse,size);
  texture(2,gl.TEXTURE_3D,gl.RED,gl.UNSIGNED_BYTE,shape,cloudSize);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
  gl.useProgram(p);
  for(const [index,name] of ['relief','pigment','vapor'].entries())gl.uniform1i(locations[name],index);
  gl.useProgram(null);
  return {
    draw(frame,w,h){
      gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);
      gl.viewport(0,0,w,h);gl.useProgram(p);gl.bindVertexArray(vao);
      for(let i=0;i<3;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(i===2?gl.TEXTURE_3D:gl.TEXTURE_2D,textures[i]);}
      const f=unit(frame.look.map((v,i)=>v-frame.eye[i]));
      const r=unit([-f[2],0,f[0]]);
      const u=[r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]];
      const tangent=Math.tan(55*Math.PI/360);
      for(const [name,v] of Object.entries({eye:frame.eye,forwardAxis:f,rightAxis:r,upAxis:u,sun:unit(frame.sun)}))gl.uniform3fv(locations[name],v);
      gl.uniform2f(locations.plane,tangent*w/h,tangent);
      gl.uniform4f(locations.options,frame.cover,frame.shadows ? .88 : 0,frame.shafts ? .53 : 0,frame.time);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.bindVertexArray(null);gl.useProgram(null);gl.enable(gl.DEPTH_TEST);
    },
    dispose(){gl.deleteProgram(p);gl.deleteVertexArray(vao);for(const t of textures)gl.deleteTexture(t);},
  };
}

export async function openDirect(canvas,{signal,fail}){
  const engine=await Engine.create(canvas,{backend:'webgl2',fallback:webglRenderer,signal,exactSize:true,antialias:false,capacity:2});
  engine.onError=fail;
  signal.throwIfAborted();
  let graphics,context,frame;
  const remove=engine.scene.frameGraph.add({name:'cloud ray and coast',order:1,execute(data){
    if(data.backend!=='webgl2')return;
    if(data.gl!==context){graphics?.dispose();context=data.gl;graphics=apply(context);}
    if(frame)graphics.draw(frame,data.width,data.height);
  }});
  return {
    renderer:'webgl2',
    draw(values){frame=values;engine.render({delta:0});},
    finish(){context?.finish();return Promise.resolve();},
    dispose(){remove();graphics?.dispose();engine.dispose();},
  };
}
