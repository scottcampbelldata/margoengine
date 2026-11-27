import{n as e}from"./index-CBrTRTUH.js";import{t,webglRenderer as n}from"./preview-BqcSpyLx.js";import{n as r,t as i}from"./interaction-CrSj_VpO.js";var a=`#version 300 es
out vec2 sensor;
void main(){
  vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
  sensor=2.*p-1.;
  gl_Position=vec4(sensor,0.,1.);
}`,o=`#version 300 es
precision highp float;
in vec2 sensor;
out vec4 outputColor;
uniform vec3 eye,forwardAxis,rightAxis,upAxis;
uniform vec2 lens;
uniform mat4 cameraMatrix;
uniform sampler2D opaqueZ;
uniform vec4 part[48];
uniform int count,method;
const int capacity=12;
const float tau=6.28318530718;
float smokeShape(vec2 uv){
  float s=uv.x,t=uv.y,r=length(uv);
  float x=s-.09*sin(4.7*t),y=t+.17*sin(3.2*s);
  float knot=x*x/.42+y*y/.61;
  float detail=.55+.16*sin(9.4*s+4.1*t)+.10*sin(17.9*t-14.3*s)+.07*cos(28.1*s+12.4*t);
  float rim=max(0.,1.-pow(r,2.6));
  return exp(-1.9*knot)*rim*rim*detail;
}
void main(){
  vec3 ray=normalize(forwardAxis+rightAxis*sensor.x*lens.x+upAxis*sensor.y*lens.y);
  float opaque=texelFetch(opaqueZ,ivec2(gl_FragCoord.xy),0).r;
  int used=0;
  float depths[capacity];
  vec4 surfaces[capacity];
  float cover=1.;
  for(int i=0;i<capacity;i++){
    if(i>=count)break;
    vec4 center=part[4*i],axisX=part[4*i+1],axisY=part[4*i+2],color=part[4*i+3];
    vec3 normal=cross(axisX.xyz,axisY.xyz);
    float alignment=dot(ray,normal);
    if(abs(alignment)<.0001)continue;
    float t=dot(center.xyz-eye,normal)/alignment;
    if(t<=0.)continue;
    vec3 p=eye+t*ray;
    vec4 lensPoint=cameraMatrix*vec4(p,1.);
    if(.5+.5*lensPoint.z/lensPoint.w>opaque+.000005)continue;
    vec3 d=p-center.xyz;
    vec2 local=vec2(dot(d,axisX.xyz),dot(d,axisY.xyz));
    vec2 bounds=vec2(axisX.w,axisY.w);
    float rounding=.13*min(bounds.x,bounds.y);
    vec2 edge=abs(local)-bounds+rounding;
    float outside=length(max(edge,0.))+min(max(edge.x,edge.y),0.)-rounding;
    if(outside>.0035)continue;
    float opacity=color.a*(1.-smoothstep(-.002,.0035,outside));
    if(center.w>0.5)opacity*=smokeShape(local/bounds);
    if(opacity<.001)continue;
    int index=used;
    if(method==2)for(int j=0;j<capacity;j++){
      if(index==0||depths[index-1]>=t)break;
      depths[index]=depths[index-1];
      surfaces[index]=surfaces[index-1];
      index--;
    }
    depths[index]=t;
    surfaces[index]=vec4(color.rgb,opacity);
    used++;
    cover*=1.-opacity;
  }
  if(used==0)discard;
  if(method==2){
    vec3 rgb=vec3(0.);
    for(int i=0;i<capacity;i++){
      if(i>=used)break;
      vec4 c=surfaces[i];
      rgb=mix(rgb,c.rgb,c.a);
    }
    outputColor=vec4(rgb,1.-cover);
    return;
  }
  vec2 moments[3];
  float optical=0.;
  for(int j=0;j<3;j++)moments[j]=vec2(0.);
  if(method==1)for(int i=0;i<capacity;i++){
    if(i>=used)break;
    float absorb=-log(1.-surfaces[i].a);
    float phase=tau*(.09+.82*clamp((depths[i]-3.1)/6.3,0.,1.));
    optical+=absorb;
    for(int order=1;order<=3;order++){
      moments[order-1]+=absorb*vec2(cos(float(order)*phase),sin(float(order)*phase));
    }
  }
  vec3 sum=vec3(0.);
  float weightSum=0.;
  for(int i=0;i<capacity;i++){
    if(i>=used)break;
    vec4 c=surfaces[i];
    float weight=c.a/(.056+pow(depths[i]*.14,3.));
    if(method==1){
      float phase=tau*(.09+.82*clamp((depths[i]-3.1)/6.3,0.,1.));
      float travel=optical*phase/tau;
      for(int order=1;order<=3;order++){
        float h=float(order),a=h*phase;
        travel+=(1.-h/4.)*dot(moments[order-1],vec2(sin(a),1.-cos(a)))/(3.14159265*h);
      }
      // Only optical depth in front contributes. Each layer's narrow self peak accounts for half its own weight.
      travel=clamp(travel+.5*log(1.-c.a),0.,optical);
      weight=c.a*exp(-travel);
    }
    sum+=c.rgb*weight;
    weightSum+=weight;
  }
  outputColor=vec4(sum/max(.0001,weightSum)*(1.-cover),1.-cover);
}`,s=e=>{let t=Math.hypot(...e);return e.map(e=>e/t)},c=e=>[1,3,5].map(t=>Number.parseInt(e.slice(t,t+2),16)/255),l=`#version 300 es
layout(location=0) in vec3 vertex;
uniform mat4 cameraMatrix,world;
void main(){gl_Position=cameraMatrix*world*vec4(vertex,1.);}
`,u=`#version 300 es
precision highp float;
void main(){}
`;function d(e,n){let r=t(e,l,u),i=new WeakMap,a=[],o=[],s=e.getUniformLocation(r,`world`),c=e.getUniformLocation(r,`cameraMatrix`),d=n.map(t=>{let n=t.geometry;if(!i.has(n)){let t=e.createVertexArray(),r=e.createBuffer(),s=e.createBuffer();o.push(t),a.push(r,s),e.bindVertexArray(t),e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,n.vertices,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,3,e.FLOAT,!1,24,0),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,s),e.bufferData(e.ELEMENT_ARRAY_BUFFER,n.indices,e.STATIC_DRAW),i.set(n,{vao:t,count:n.indices.length})}return{mesh:t,...i.get(n)}});return{draw(t){e.disable(e.BLEND),e.disable(e.CULL_FACE),e.enable(e.DEPTH_TEST),e.depthMask(!0),e.depthFunc(e.LEQUAL),e.clearDepth(1),e.clear(e.DEPTH_BUFFER_BIT),e.useProgram(r),e.uniformMatrix4fv(c,!1,t);for(let{mesh:t,vao:n,count:r}of d)e.bindVertexArray(n),e.uniformMatrix4fv(s,!1,t.matrix),e.drawElements(e.TRIANGLES,r,e.UNSIGNED_INT,0)},dispose(){e.deleteProgram(r);for(let t of a)e.deleteBuffer(t);for(let t of o)e.deleteVertexArray(t)}}}function f(e,n){let r=t(e,a,o),i=e.createVertexArray(),c=e.createTexture(),l=e.createFramebuffer(),u=Object.fromEntries([`eye`,`forwardAxis`,`rightAxis`,`upAxis`,`lens`,`cameraMatrix`,`opaqueZ`,`part[0]`,`count`,`method`].map(t=>[t,e.getUniformLocation(r,t)])),f=new Float32Array(192),p=0,m=0,h=d(e,n);function g(t,n){if(t!==p||n!==m){if(p=t,m=n,e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,c),e.texImage2D(e.TEXTURE_2D,0,e.DEPTH_COMPONENT24,p,m,0,e.DEPTH_COMPONENT,e.UNSIGNED_INT,null),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.bindFramebuffer(e.FRAMEBUFFER,l),e.framebufferTexture2D(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.TEXTURE_2D,c,0),e.drawBuffers([e.NONE]),e.readBuffer(e.NONE),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw Error(`Glass depth target is incomplete.`);e.bindFramebuffer(e.FRAMEBUFFER,null)}}return{draw(t,n,a){let{camera:o}=t;g(t.width,t.height),e.bindFramebuffer(e.FRAMEBUFFER,l),e.viewport(0,0,p,m),h.draw(o.matrix),e.bindFramebuffer(e.FRAMEBUFFER,null);let d=s(o.target.map((e,t)=>e-o.position[t])),_=s([-d[2],0,d[0]]),v=[-_[2]*d[1],_[2]*d[0]-_[0]*d[2],_[0]*d[1]],y=Math.tan(o.fov*Math.PI/360);e.viewport(0,0,p,m),e.disable(e.CULL_FACE),e.disable(e.DEPTH_TEST),e.depthMask(!1),e.enable(e.BLEND),e.blendEquation(e.FUNC_ADD),e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA),e.useProgram(r),e.bindVertexArray(i),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,c),e.uniform1i(u.opaqueZ,0);for(let[t,n]of Object.entries({eye:o.position,forwardAxis:d,rightAxis:_,upAxis:v}))e.uniform3fv(u[t],n);e.uniform2f(u.lens,y*p/m,y),e.uniformMatrix4fv(u.cameraMatrix,!1,o.matrix),e.uniform1i(u.count,n.length),e.uniform1i(u.method,a===`weighted`?0:a===`moments`?1:2);for(let[e,t]of n.entries()){let n=t.anchor.matrix,r=16*e;f.set([n[12],n[13],n[14],+!!t.smoke,n[0],n[1],n[2],t.width*.5,n[4],n[5],n[6],t.height*.5,...t.tint,t.opacity],r)}e.uniform4fv(u[`part[0]`],f),e.drawArrays(e.TRIANGLES,0,3),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthMask(!0),e.bindVertexArray(null),e.useProgram(null)},dispose(){h.dispose(),e.deleteProgram(r),e.deleteVertexArray(i),e.deleteFramebuffer(l),e.deleteTexture(c)}}}async function p(t,a,o){let s=await e.create(t,{backend:`webgl2`,fallback:n,signal:a,exactSize:!0,antialias:!1,capacity:96,camera:{near:.14,far:45,fov:39}});s.onError=o,performance.mark(`glass-device`);let l,u,d=r(s);for(let e of d.glazes)e.tint=c(e.color);for(let e of d.smoke)e.tint=c(e.color).map(e=>e*.965),e.smoke=!0;let p=[],m=`weighted`,h=s.scene.frameGraph.add({name:`glass transparency`,order:8,execute(e){e.backend===`webgl2`&&(u=e.gl,l??=f(u,d.opaque),l.draw(e,p,m))}}),g={room:d,renderer:`webgl2`,exact:`Per-pixel depth sort`,select(e){return m=e.mode,p=[...d.glazes,...e.smoke?d.smoke:[]],e.reverse&&p.reverse(),p.length},wait(){let e=u.fenceSync(u.SYNC_GPU_COMMANDS_COMPLETE,0);return u.flush(),new Promise((t,n)=>{let r=performance.now()+1500;function i(){let o=u.clientWaitSync(e,0,0);o===u.TIMEOUT_EXPIRED&&!a.aborted&&performance.now()<r?setTimeout(i,4):(u.deleteSync(e),o===u.WAIT_FAILED||o===u.TIMEOUT_EXPIRED?n(Error(`The transparent frame did not finish.`)):t())}i()})},dispose(){h(),l?.dispose()}};return t.addEventListener(`webglcontextrestored`,()=>{l=void 0},{signal:a}),{engine:s,view:await i(s,t,a,o,g)}}export{p as openDirect};