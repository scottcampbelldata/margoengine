
import {Engine} from '@margoengine/core';
import {webglRenderer,glProgram} from '@margoengine/webgl2-compat/preview';
import {parsePrefilteredIBL} from '@margoengine/environment/prefiltered';
import {decodePhoto} from './radiance.js';
import {connectProjection} from './controls.js';

const triangle=`#version 300 es
out vec2 sensor;
void main(){
  vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
  sensor=2.*p-1.;
  gl_Position=vec4(sensor,0.,1.);
}`;
const outputColor=`
vec3 displayColor(vec3 value){
  vec3 v=max(value,0.);
  float minimum=min(v.x,min(v.y,v.z));
  float toe=minimum<.08?minimum-6.25*minimum*minimum:.04;
  v-=toe;
  float m=max(v.x,max(v.y,v.z));
  if(m>=.76){
    float result=1.-.0576/(m-.52);
    v=mix(result*v/m,vec3(result),1.-1./(1.+.15*(m-result)));
  }
  return mix(1.055*pow(max(v,0.),vec3(.41666667))-.055,12.92*v,lessThanEqual(v,vec3(.0031308)));
}
vec3 environmentSpace(vec3 direction){
  const float c=.8196480,s=.5728675;
  return vec3(c*direction.x-s*direction.z,direction.y,c*direction.z+s*direction.x);
}
`;
const coast=`#version 300 es
precision highp float;
in vec2 sensor;
out vec4 result;
uniform sampler2D panorama;
uniform sampler2D contacts;
uniform vec3 eye,forwardAxis,sideAxis,upAxis;
uniform vec2 frameScale;
uniform bool grounded;
${outputColor}
void main(){
  vec3 ray=normalize(forwardAxis+sideAxis*sensor.x*frameScale.x+upAxis*sensor.y*frameScale.y);
  float plane=ray.y<0.?-eye.y/ray.y:1e6;
  float b=dot(eye,ray);
  float dome=-b+sqrt(max(0.,b*b-dot(eye,eye)+68.*68.));
  vec3 intersection=eye+ray*min(dome,plane);
  vec3 direction=grounded?normalize(intersection-vec3(0,1.58,0)):ray;
  direction=environmentSpace(direction);
  vec2 uv=vec2(.5+atan(direction.x,-direction.z)/6.28318530718,acos(clamp(direction.y,-1.,1.))/3.14159265359);
  vec3 rgb=(exp2(texture(panorama,uv).rgb*13.)-1.)*(.76/24.);
  if(plane<dome){
    vec2 groundUV=(intersection.xz/vec2(5.8,3.1))+.5;
    vec2 delta=vec2(.011,.017);
    float shadow=texture(contacts,groundUV).r*.28;
    shadow+=.18*(texture(contacts,groundUV+vec2(delta.x,0)).r+texture(contacts,groundUV-vec2(delta.x,0)).r);
    shadow+=.18*(texture(contacts,groundUV+vec2(0,delta.y)).r+texture(contacts,groundUV-vec2(0,delta.y)).r);
    float inside=step(0.,groundUV.x)*step(groundUV.x,1.)*step(0.,groundUV.y)*step(groundUV.y,1.);
    rgb*=1.-.73*shadow*inside;
  }
  result=vec4(displayColor(rgb),1.);
}`;
const object=`#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
uniform mat4 projection;
out vec3 world,axis;
void main(){
  world=position;axis=normal;
  gl_Position=projection*vec4(position,1.);
}`;
const finish=`#version 300 es
precision highp float;
in vec3 world,axis;
out vec4 result;
uniform vec3 eye;
uniform vec3 lightColor,sun;
uniform vec4 color;
uniform vec2 lobe;
uniform vec3 emissive;
uniform vec3 sh[9];
uniform samplerCube glossy;
uniform sampler2D brdfMap;
uniform float mips;
${outputColor}
vec3 indirect(vec3 normal){
  vec3 n=environmentSpace(normal);
  return max(vec3(0.),sh[0]*.282095+sh[1]*(.488603*n.y)+sh[2]*(.488603*n.z)+sh[3]*(.488603*n.x)
     +sh[4]*(1.092548*n.x*n.y)+sh[5]*(1.092548*n.y*n.z)+sh[6]*(.315392*(3.*n.z*n.z-1.))
     +sh[7]*(1.092548*n.x*n.z)+sh[8]*(.546274*(n.x*n.x-n.y*n.y)));
}
void main(){
  vec3 n=normalize(axis)*(gl_FrontFacing?1.:-1.);
  vec3 view=normalize(eye-world),halfway=normalize(view+sun);
  float nv=max(dot(n,view),.0001),nl=max(dot(n,sun),0.),nh=max(dot(n,halfway),0.),vh=max(dot(view,halfway),0.);
  float alpha=lobe.x*lobe.x,alpha2=alpha*alpha;
  float diagonal=max(nh*nh*(alpha2-1.)+1.,.00001);
  float distribution=alpha2/(3.14159265*diagonal*diagonal);
  float visibility=.5/max(nl*sqrt(nv*nv*(1.-alpha2)+alpha2)+nv*sqrt(nl*nl*(1.-alpha2)+alpha2),.0001);
  vec3 f0=mix(vec3(.04),color.rgb,lobe.y);
  vec3 fresnel=f0+(1.-f0)*pow(1.-vh,5.);
  vec3 diffuse=color.rgb*(1.-lobe.y);
  vec3 direct=((1.-fresnel)*diffuse/3.14159265+distribution*visibility*fresnel)*nl*lightColor;
  vec3 reflected=environmentSpace(reflect(-view,n));
  vec2 brdf=texture(brdfMap,vec2(nv,lobe.x)).rg;
  vec3 lighting=indirect(n)*diffuse+textureLod(glossy,reflected,lobe.x*mips).rgb*(f0*brdf.x+brdf.y);
  result=vec4(displayColor(direct+.97*lighting+emissive),1.);
}`;
const maskGeometry=`#version 300 es
layout(location=0) in vec3 position;
out float altitude;
void main(){
  altitude=position.y;
  gl_Position=vec4(position.x/2.9,position.z/1.55,position.y/1.38*2.-1.,1.);
}`;
const maskColor=`#version 300 es
precision highp float;
in float altitude;
out vec4 result;
void main(){result=vec4(max(0.,1.-altitude/1.38),0.,0.,1.);}
`;

function uploadSet(gl,image,environment,batches){
  const sky=glProgram(gl,triangle,coast),paint=glProgram(gl,object,finish),mask=glProgram(gl,maskGeometry,maskColor);
  const targets=[],buffers=[],arrays=[],other=[];
  const uniforms=(program,items)=>Object.fromEntries(items.map(key=>[key,gl.getUniformLocation(program,key)]));
  const back=uniforms(sky,['panorama','contacts','eye','forwardAxis','sideAxis','upAxis','frameScale','grounded']);
  const car=uniforms(paint,['projection','eye','sun','lightColor','color','lobe','emissive','sh[0]','glossy','brdfMap','mips']);
  const empty=gl.createVertexArray();arrays.push(empty);
  const texture=type=>{const t=gl.createTexture();targets.push(t);gl.bindTexture(type,t);return t;};
  const linear=type=>{
    gl.texParameteri(type,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(type,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(type,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(type,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  };
  const photo=texture(gl.TEXTURE_2D);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,image.width,image.height,0,gl.RGBA,gl.UNSIGNED_BYTE,image.data);
  linear(gl.TEXTURE_2D);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
  const spec=texture(gl.TEXTURE_CUBE_MAP);
  for(const [level,mip] of environment.specular.entries()){
    const edge=Math.max(1,environment.specularSize>>level),n=edge*edge*4;
    for(let side=0;side<6;side++){
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X+side,level,gl.RGBA16F,edge,edge,0,gl.RGBA,gl.HALF_FLOAT,mip.subarray(n*side,n*(side+1)));
    }
  }
  linear(gl.TEXTURE_CUBE_MAP);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MAX_LEVEL,environment.specular.length-1);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  const brdf=texture(gl.TEXTURE_2D),edge=Math.round(Math.sqrt(environment.brdf.length));
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RG16F,edge,edge,0,gl.RG,gl.HALF_FLOAT,new Uint16Array(environment.brdf.buffer,environment.brdf.byteOffset,environment.brdf.length*2));
  linear(gl.TEXTURE_2D);
  const drawables=batches.map(({positions,normals,indices,surface,emission})=>{
    const vao=gl.createVertexArray();arrays.push(vao);gl.bindVertexArray(vao);
    for(const [i,values] of [positions,normals].entries()){
      const buffer=gl.createBuffer();buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,values,gl.STATIC_DRAW);
      gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,3,gl.FLOAT,false,0,0);
    }
    const element=gl.createBuffer();buffers.push(element);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,element);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
    return {vao,count:indices.length,surface,emission};
  });
  const footmap=texture(gl.TEXTURE_2D),res=192;
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,res,res,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  linear(gl.TEXTURE_2D);
  const framebuffer=gl.createFramebuffer(),depth=gl.createRenderbuffer();other.push(framebuffer,depth);
  gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,footmap,0);
  gl.bindRenderbuffer(gl.RENDERBUFFER,depth);
  gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,res,res);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Contact shadow target is incomplete.');
  gl.viewport(0,0,res,res);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);
  gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LESS);gl.depthMask(true);
  gl.clearDepth(1);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.useProgram(mask);
  for(const item of drawables){gl.bindVertexArray(item.vao);gl.drawElements(gl.TRIANGLES,item.count,gl.UNSIGNED_SHORT,0);}
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.useProgram(sky);gl.uniform1i(back.panorama,0);gl.uniform1i(back.contacts,1);
  gl.useProgram(paint);gl.uniform1i(car.glossy,2);gl.uniform1i(car.brdfMap,3);
  gl.uniform3fv(car.sun,unit([-.16,.41,.89]));gl.uniform3f(car.lightColor,.47,.4183,.376);
  gl.uniform3fv(car['sh[0]'],environment.irradiance); gl.uniform1f(car.mips,environment.specular.length-1);
  function bind(unit,target,data){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(target,data);}
  return {
    draw(camera,width,height,mode){
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,width,height);
      gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);gl.disable(gl.DEPTH_TEST);
      gl.useProgram(sky);gl.bindVertexArray(empty);
      bind(0,gl.TEXTURE_2D,photo);bind(1,gl.TEXTURE_2D,footmap);
      const f=unit(camera.target.map((value,i)=>value-camera.position[i])),s=unit([-f[2],0,f[0]]),
        u=[-s[2]*f[1],s[2]*f[0]-s[0]*f[2],s[0]*f[1]];
      const lens=Math.tan(camera.fov*Math.PI/360);
      gl.uniform3fv(back.eye,camera.position);gl.uniform3fv(back.forwardAxis,f);gl.uniform3fv(back.sideAxis,s);gl.uniform3fv(back.upAxis,u);
      gl.uniform2f(back.frameScale,lens*width/height,lens);gl.uniform1i(back.grounded,mode==='ground'?1:0);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.clearDepth(1);gl.clear(gl.DEPTH_BUFFER_BIT);gl.depthFunc(gl.LEQUAL);
      gl.useProgram(paint);bind(2,gl.TEXTURE_CUBE_MAP,spec);bind(3,gl.TEXTURE_2D,brdf);
      gl.uniform3fv(car.eye,camera.position);gl.uniformMatrix4fv(car.projection,false,camera.matrix);
      for(const {vao,count,surface,emission} of drawables){
        gl.uniform4fv(car.color,surface.baseColorFactor);
        gl.uniform2f(car.lobe,surface.roughnessFactor,surface.metallicFactor);
        gl.uniform3fv(car.emissive,emission);gl.bindVertexArray(vao);gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_SHORT,0);
      }
      gl.bindVertexArray(null);gl.useProgram(null);
    },
    dispose(){
      for(const p of [sky,paint,mask])gl.deleteProgram(p);
      for(const t of targets)gl.deleteTexture(t);
      for(const t of buffers)gl.deleteBuffer(t);
      for(const t of arrays)gl.deleteVertexArray(t);
      gl.deleteFramebuffer(other[0]);gl.deleteRenderbuffer(other[1]);
    }
  };
}
const unit=values=>{const magnitude=Math.hypot(...values);return values.map(value=>value/magnitude);};
export async function openDirect(canvas,photo,car,field,signal,fail){
  const engine=await Engine.create(canvas,{backend:'webgl2',fallback:webglRenderer,signal,exactSize:true,antialias:true,capacity:2});
  engine.onError=fail;
  performance.mark('ground-device');
  const [image,batches,environment]=await Promise.all([photo.then(decodePhoto),car,field.then(parsePrefilteredIBL)]);
  signal.throwIfAborted();
  performance.mark('ground-assets');
  let renderer,gl,mode='ground';
  const remove=engine.scene.frameGraph.add({name:'coastal projection',order:1,execute(context){
    if(context.backend!=='webgl2')return;
    gl=context.gl;
    renderer??=uploadSet(gl,image,environment,batches);
    renderer.draw(context.camera,context.width,context.height,mode);
  }});
  canvas.addEventListener('webglcontextrestored',()=>{renderer=undefined;},{signal});
  const fence=()=>{
    const sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
    gl.flush();
    return new Promise((resolve,reject)=>{
      const stop=performance.now()+1500;
      function wait(){
        const status=gl.clientWaitSync(sync,0,0);
        if(status===gl.TIMEOUT_EXPIRED&&!signal.aborted&&performance.now()<stop){setTimeout(wait,4);return;}
        gl.deleteSync(sync);
        if(status===gl.WAIT_FAILED||status===gl.TIMEOUT_EXPIRED)reject(Error('The ground projection frame did not finish.'));
        else resolve();
      }
      wait();
    });
  };
  const view=await connectProjection(engine,canvas,signal,projection=>{mode=projection;engine.render({delta:0});},
    fence,()=>{remove();renderer?.dispose();});
  return {engine,view};
}
