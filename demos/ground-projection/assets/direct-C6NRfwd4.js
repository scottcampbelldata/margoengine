import{n as e}from"./index-DHc82pzd.js";import{i as t,r as n,t as r}from"./controls-DYmtbs6s.js";import{t as i,webglRenderer as a}from"./preview-BqcSpyLx.js";var o=`#version 300 es
out vec2 sensor;
void main(){
  vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
  sensor=2.*p-1.;
  gl_Position=vec4(sensor,0.,1.);
}`,s=`
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
`,c=`#version 300 es
precision highp float;
in vec2 sensor;
out vec4 result;
uniform sampler2D panorama;
uniform sampler2D contacts;
uniform vec3 eye,forwardAxis,sideAxis,upAxis;
uniform vec2 frameScale;
uniform bool grounded;
${s}
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
}`,l=`#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
uniform mat4 projection;
out vec3 world,axis;
void main(){
  world=position;axis=normal;
  gl_Position=projection*vec4(position,1.);
}`,u=`#version 300 es
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
${s}
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
}`,d=`#version 300 es
layout(location=0) in vec3 position;
out float altitude;
void main(){
  altitude=position.y;
  gl_Position=vec4(position.x/2.9,position.z/1.55,position.y/1.38*2.-1.,1.);
}`,f=`#version 300 es
precision highp float;
in float altitude;
out vec4 result;
void main(){result=vec4(max(0.,1.-altitude/1.38),0.,0.,1.);}
`;function p(e,t,n,r){let a=i(e,o,c),s=i(e,l,u),p=i(e,d,f),h=[],g=[],_=[],v=[],y=(t,n)=>Object.fromEntries(n.map(n=>[n,e.getUniformLocation(t,n)])),b=y(a,[`panorama`,`contacts`,`eye`,`forwardAxis`,`sideAxis`,`upAxis`,`frameScale`,`grounded`]),x=y(s,[`projection`,`eye`,`sun`,`lightColor`,`color`,`lobe`,`emissive`,`sh[0]`,`glossy`,`brdfMap`,`mips`]),S=e.createVertexArray();_.push(S);let C=t=>{let n=e.createTexture();return h.push(n),e.bindTexture(t,n),n},w=t=>{e.texParameteri(t,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(t,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(t,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(t,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE)},T=C(e.TEXTURE_2D);e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,t.width,t.height,0,e.RGBA,e.UNSIGNED_BYTE,t.data),w(e.TEXTURE_2D),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.REPEAT);let E=C(e.TEXTURE_CUBE_MAP);for(let[t,r]of n.specular.entries()){let i=Math.max(1,n.specularSize>>t),a=i*i*4;for(let n=0;n<6;n++)e.texImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+n,t,e.RGBA16F,i,i,0,e.RGBA,e.HALF_FLOAT,r.subarray(a*n,a*(n+1)))}w(e.TEXTURE_CUBE_MAP),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MAX_LEVEL,n.specular.length-1),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR);let D=C(e.TEXTURE_2D),O=Math.round(Math.sqrt(n.brdf.length));e.texImage2D(e.TEXTURE_2D,0,e.RG16F,O,O,0,e.RG,e.HALF_FLOAT,new Uint16Array(n.brdf.buffer,n.brdf.byteOffset,n.brdf.length*2)),w(e.TEXTURE_2D);let k=r.map(({positions:t,normals:n,indices:r,surface:i,emission:a})=>{let o=e.createVertexArray();_.push(o),e.bindVertexArray(o);for(let[r,i]of[t,n].entries()){let t=e.createBuffer();g.push(t),e.bindBuffer(e.ARRAY_BUFFER,t),e.bufferData(e.ARRAY_BUFFER,i,e.STATIC_DRAW),e.enableVertexAttribArray(r),e.vertexAttribPointer(r,3,e.FLOAT,!1,0,0)}let s=e.createBuffer();return g.push(s),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,s),e.bufferData(e.ELEMENT_ARRAY_BUFFER,r,e.STATIC_DRAW),{vao:o,count:r.length,surface:i,emission:a}}),A=C(e.TEXTURE_2D);e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,192,192,0,e.RGBA,e.UNSIGNED_BYTE,null),w(e.TEXTURE_2D);let j=e.createFramebuffer(),M=e.createRenderbuffer();if(v.push(j,M),e.bindFramebuffer(e.FRAMEBUFFER,j),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,A,0),e.bindRenderbuffer(e.RENDERBUFFER,M),e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_COMPONENT16,192,192),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,M),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw Error(`Contact shadow target is incomplete.`);e.viewport(0,0,192,192),e.disable(e.CULL_FACE),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),e.depthMask(!0),e.clearDepth(1),e.clearColor(0,0,0,1),e.clear(e.COLOR_BUFFER_BIT|e.DEPTH_BUFFER_BIT),e.useProgram(p);for(let t of k)e.bindVertexArray(t.vao),e.drawElements(e.TRIANGLES,t.count,e.UNSIGNED_SHORT,0);e.bindFramebuffer(e.FRAMEBUFFER,null),e.useProgram(a),e.uniform1i(b.panorama,0),e.uniform1i(b.contacts,1),e.useProgram(s),e.uniform1i(x.glossy,2),e.uniform1i(x.brdfMap,3),e.uniform3fv(x.sun,m([-.16,.41,.89])),e.uniform3f(x.lightColor,.47,.4183,.376),e.uniform3fv(x[`sh[0]`],n.irradiance),e.uniform1f(x.mips,n.specular.length-1);function N(t,n,r){e.activeTexture(e.TEXTURE0+t),e.bindTexture(n,r)}return{draw(t,n,r,i){e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,n,r),e.disable(e.BLEND),e.disable(e.CULL_FACE),e.disable(e.DEPTH_TEST),e.useProgram(a),e.bindVertexArray(S),N(0,e.TEXTURE_2D,T),N(1,e.TEXTURE_2D,A);let o=m(t.target.map((e,n)=>e-t.position[n])),c=m([-o[2],0,o[0]]),l=[-c[2]*o[1],c[2]*o[0]-c[0]*o[2],c[0]*o[1]],u=Math.tan(t.fov*Math.PI/360);e.uniform3fv(b.eye,t.position),e.uniform3fv(b.forwardAxis,o),e.uniform3fv(b.sideAxis,c),e.uniform3fv(b.upAxis,l),e.uniform2f(b.frameScale,u*n/r,u),e.uniform1i(b.grounded,+(i===`ground`)),e.drawArrays(e.TRIANGLES,0,3),e.enable(e.DEPTH_TEST),e.depthMask(!0),e.clearDepth(1),e.clear(e.DEPTH_BUFFER_BIT),e.depthFunc(e.LEQUAL),e.useProgram(s),N(2,e.TEXTURE_CUBE_MAP,E),N(3,e.TEXTURE_2D,D),e.uniform3fv(x.eye,t.position),e.uniformMatrix4fv(x.projection,!1,t.matrix);for(let{vao:t,count:n,surface:r,emission:i}of k)e.uniform4fv(x.color,r.baseColorFactor),e.uniform2f(x.lobe,r.roughnessFactor,r.metallicFactor),e.uniform3fv(x.emissive,i),e.bindVertexArray(t),e.drawElements(e.TRIANGLES,n,e.UNSIGNED_SHORT,0);e.bindVertexArray(null),e.useProgram(null)},dispose(){for(let t of[a,s,p])e.deleteProgram(t);for(let t of h)e.deleteTexture(t);for(let t of g)e.deleteBuffer(t);for(let t of _)e.deleteVertexArray(t);e.deleteFramebuffer(v[0]),e.deleteRenderbuffer(v[1])}}}var m=e=>{let t=Math.hypot(...e);return e.map(e=>e/t)};async function h(i,o,s,c,l,u){let d=await e.create(i,{backend:`webgl2`,fallback:a,signal:l,exactSize:!0,antialias:!0,capacity:2});d.onError=u,performance.mark(`ground-device`);let[f,m,h]=await Promise.all([o.then(n),s,c.then(t)]);l.throwIfAborted(),performance.mark(`ground-assets`);let g,_,v=`ground`,y=d.scene.frameGraph.add({name:`coastal projection`,order:1,execute(e){e.backend===`webgl2`&&(_=e.gl,g??=p(_,f,h,m),g.draw(e.camera,e.width,e.height,v))}});return i.addEventListener(`webglcontextrestored`,()=>{g=void 0},{signal:l}),{engine:d,view:await r(d,i,l,e=>{v=e,d.render({delta:0})},()=>{let e=_.fenceSync(_.SYNC_GPU_COMMANDS_COMPLETE,0);return _.flush(),new Promise((t,n)=>{let r=performance.now()+1500;function i(){let a=_.clientWaitSync(e,0,0);a===_.TIMEOUT_EXPIRED&&!l.aborted&&performance.now()<r?setTimeout(i,4):(_.deleteSync(e),a===_.WAIT_FAILED||a===_.TIMEOUT_EXPIRED?n(Error(`The ground projection frame did not finish.`)):t())}i()})},()=>{y(),g?.dispose()})}}export{h as openDirect};