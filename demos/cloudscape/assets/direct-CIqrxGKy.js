import{n as e,s as t}from"./index-CU-znA48.js";import{n,t as r}from"./api-B13ANfe4.js";var i=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,a=(e,t)=>RangeError(i(e,t)),o=/Mobi|Android/;function s(e){return e?.exact||(globalThis.margoLow||o.test(globalThis.navigator?.userAgent)?1:4)}var c=[.018,.023,.035,1],l=e=>/^#([\da-f]{3}){1,2}$/i.test(e)?parseInt((e[4]?e:e.replace(/\w/g,`$&$&`)).slice(1),16):-1;function u(e){if(typeof e!=`string`)return c;let t=l(e);if(t<0)throw RangeError(`Invalid color; use #rrggbb`);return[(t>>16)/255,(t>>8&255)/255,(t&255)/255,1]}function d(e,t,n){if(e!==void 0){if(!Array.isArray(e)||e.length!==4)throw a(`Invalid draw rectangle`,`views`);for(let t=0;t<4;t++)if(!Number.isSafeInteger(e[t])||e[t]<(t<2?0:1))throw a(`Invalid draw rectangle`,`views`);if(e[0]+e[2]>t||e[1]+e[3]>n)throw a(`Draw rectangle exceeds target`,`views`)}}var f=`a2/(3.14159265*pow(max(dot(cross(n,h),cross(n,h)),step(nh,0.0))+a2*nh*nh,2.0))`,p=`2.0*nl*nv/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),1e-30)`,m={},h=`#version 300 es
precision highp float;layout(location=0) in vec3 p;layout(location=1) in vec3 n;layout(location=2) in vec4 m0;layout(location=3) in vec4 m1;layout(location=4) in vec4 m2;layout(location=5) in vec4 m3;layout(location=6) in vec4 color;layout(location=7) in vec4 factors;uniform mat4 camera;out vec3 w;out vec3 wn;out vec3 b;out vec4 m;void main(){mat4 M=mat4(m0,m1,m2,m3);vec4 q=M*vec4(p,1);vec3 a=m0.xyz,y=m1.xyz,c=m2.xyz;float s=dot(a,cross(y,c))<0.?-1.:1.;vec3 k=mat3(cross(y,c),cross(c,a),cross(a,y))*n*s;wn=dot(k,k)>0.?k:vec3(0,1,0);w=q.xyz;b=color.rgb;m=vec4(factors.xyz,s);gl_Position=camera*q;}`,g=`#version 300 es
precision highp float;in vec3 w;in vec3 wn;in vec3 b;in vec4 m;uniform vec3 eye;uniform vec4 light;uniform vec4 radiance;uniform vec3 ambient;out vec4 o;vec3 pbrNeutral(vec3 c){float x=min(c.r,min(c.g,c.b));float offset=x<0.08?x-6.25*x*x:0.04;c-=offset;float peak=max(c.r,max(c.g,c.b));if(peak<0.76)return c;float newPeak=1.0-0.24*0.24/(peak+0.24-0.76);c*=newPeak/peak;return mix(c,vec3(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}void main(){bool front=gl_FrontFacing==(m.w>0.0);if(!front&&m.z<0.5)discard;vec3 n=normalize(wn);if(!front)n=-n;vec3 v=normalize(eye-w),l=normalize(light.xyz),h=(v+l)/max(length(v+l),0.0001);float nl=clamp(dot(n,l),0.0,1.0),nv=clamp(dot(n,v),0.0001,1.0),nh=clamp(dot(n,h),0.0,1.0),vh=clamp(dot(v,h),0.0,1.0);float a=m.x*m.x,a2=a*a,d=${f};float g=${p};vec3 f0=mix(vec3(0.04),b,m.y),f=f0+(1.0-f0)*pow(1.0-vh,5.0);vec3 direct=((1.0-(0.04+0.96*pow(1.0-vh,5.0)))*(1.0-m.y)*b/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;vec3 linear=direct*radiance.rgb*light.w+b*(1.0-m.y)*radiance.w*ambient;vec3 mapped=pbrNeutral(max(linear,vec3(0.0)));o=vec4(mix(mapped*12.92,1.055*pow(mapped,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),mapped)),1);}`,_=(e,t,r)=>{let i=[],a=e.createProgram();if(!a)throw new n(`failed`,`GL program; the WebGL context may be lost`);try{for(let[o,s]of[[e.VERTEX_SHADER,t],[e.FRAGMENT_SHADER,r]]){let t=e.createShader(o);if(!t)throw new n(`failed`,`GL shader; the WebGL context may be lost`);if(i.push(t),e.shaderSource(t,s),e.compileShader(t),!e.getShaderParameter(t,e.COMPILE_STATUS))throw new n(`failed`,e.getShaderInfoLog(t)??`GL compile failed; check the shader source`);e.attachShader(a,t)}if(e.linkProgram(a),!e.getProgramParameter(a,e.LINK_STATUS))throw new n(`failed`,e.getProgramInfoLog(a)??`GL link failed; check the shader outputs`)}catch(t){throw e.deleteProgram(a),t}finally{for(let t of i)e.deleteShader(t)}return a},v=new WeakMap,y=class{constructor(e,{transparent:t=!1}={}){this.canvas=e,this.backend=`webgl2`,this.recovering=!1,this.generation=0,this.camera=null,this.eye=null,this.light=null,this.radiance=null,this.ambient=null,this.resources=new Map,this.clear=t?[0,0,0,0]:c;let r=e.getContext(`webgl2`,{alpha:t,premultipliedAlpha:!0,antialias:s()>1,powerPreference:`high-performance`});if(!r)throw new n(`unsupported`,`No WebGL2 canvas; use a browser with WebGL2 and a canvas without another context`);this.gl=r,this.link(),v.set(e,this)}link(){let{gl:e}=this,t=_(e,h,g);this.program=t,this.camera=e.getUniformLocation(t,`camera`),this.eye=e.getUniformLocation(t,`eye`),this.light=e.getUniformLocation(t,`light`),this.radiance=e.getUniformLocation(t,`radiance`),this.ambient=e.getUniformLocation(t,`ambient`)}restore(){let{gl:e}=this,t=[...this.resources];if(this.recovering)this.generation++,this.resources.clear(),e.getError();else{for(let[e]of t)this.remove(e);this.releaseProgram()}this.link();for(let[e,{capacity:n}]of t)this.add(e,n);this.recovering=!1}add(e,t){let r=this.gl,i=[];if(this.recovering&&r.isContextLost()){this.remove(e),this.resources.set(e,{vao:null,buffers:i,instance:null,capacity:t});return}let a=r.createVertexArray();if(!a)throw new n(`failed`,`GL VAO; the WebGL context may be lost`);try{r.bindVertexArray(a);let o=(e,t)=>{let a=r.createBuffer();if(!a)throw new n(`failed`,`GL buffer; the WebGL context may be lost`);return i.push(a),r.bindBuffer(e,a),typeof t==`number`?r.bufferData(e,t,r.DYNAMIC_DRAW):r.bufferData(e,t,r.STATIC_DRAW),a};o(r.ARRAY_BUFFER,e.vertices);for(let e=0;e<2;e++)r.enableVertexAttribArray(e),r.vertexAttribPointer(e,3,r.FLOAT,!1,24,e*12);o(r.ELEMENT_ARRAY_BUFFER,e.indices);let s=o(r.ARRAY_BUFFER,t*96);for(let e=0;e<6;e++)r.enableVertexAttribArray(e+2),r.vertexAttribPointer(e+2,4,r.FLOAT,!1,96,e*16),r.vertexAttribDivisor(e+2,1);let c=r.getError();if(c!==r.NO_ERROR)throw new n(`failed`,`GL buffer failed (error ${c}); use a smaller geometry or check the context`);this.remove(e),this.resources.set(e,{vao:a,buffers:i,instance:s,capacity:t})}catch(e){for(let e of i)r.deleteBuffer(e);throw r.deleteVertexArray(a),e}finally{r.bindVertexArray(null)}}remove(e){let t=this.resources.get(e);if(t){for(let e of t.buffers)this.gl.deleteBuffer(e);this.gl.deleteVertexArray(t.vao),this.resources.delete(e)}}render(e,t,r,i,a,o){let s=this.gl;if(s.isContextLost()){if(this.recovering)return;throw new n(`failed`,`WebGL context lost; create a new engine, or add webglRestore from the /restore entry`)}if(o?.target)throw new n(`unsupported`,`WebGL2 cannot draw a view into a texture; use the WebGPU backend for target views`);if(this.intercept)return this.intercept(e,r,o);let c=!1,l={backend:`webgl2`,gl:s,camera:e,view:o&&{id:o.id,camera:e,viewport:o.rect,scissor:o.scissor,index:o.index,count:o.count,clear:o.clear,layers:o.layers,target:o.target},width:this.canvas.width,height:this.canvas.height,delta:a,draw:(n=m)=>{let{width:i,height:a}=l,f=n.viewport===void 0?l.view?.viewport:n.viewport,p=n.scissor===void 0?n.viewport===void 0?l.view?.scissor??l.view?.viewport:void 0:n.scissor;d(f,i,a),d(p,i,a),!c&&!o?.index&&(s.disable(s.SCISSOR_TEST),s.colorMask(!0,!0,!0,!0),s.clearColor(...this.clear),s.clear(s.COLOR_BUFFER_BIT)),c=!0;let h=l.view?.clear?.color,g=n.clear??(h===!1?!1:typeof h==`string`||!l.view?.index),_=n.clearDepth??l.view?.clear?.depth??n.clear??!0;f?s.viewport(f[0],a-f[1]-f[3],f[2],f[3]):s.viewport(0,0,i,a),p?(s.scissor(p[0],a-p[1]-p[3],p[2],p[3]),s.enable(s.SCISSOR_TEST)):s.disable(s.SCISSOR_TEST),s.enable(s.DEPTH_TEST),s.disable(s.CULL_FACE),g&&s.clearColor(...typeof h==`string`?u(h):this.clear),(g||_)&&s.clear((g?s.COLOR_BUFFER_BIT:0)|(_?s.DEPTH_BUFFER_BIT:0)),s.useProgram(this.program),s.uniformMatrix4fv(this.camera,!1,e.matrix),s.uniform3f(this.eye,...e.position),s.uniform4fv(this.light,t.direction),s.uniform4fv(this.radiance,t.radiance),s.uniform3f(this.ambient,t.ambient?.[0]??1,t.ambient?.[1]??1,t.ambient?.[2]??1),this.drawBatches(r)}};i.execute(l)}drawBatches(e){let t=this.gl;for(let n of e)if(n.count){let e=this.resources.get(n.geometry);t.bindVertexArray(e.vao),t.bindBuffer(t.ARRAY_BUFFER,e.instance),t.bufferSubData(t.ARRAY_BUFFER,0,n.instances,0,n.count*24),t.drawElementsInstanced(t.TRIANGLES,n.geometry.indices.length,t.UNSIGNED_INT,0,n.count)}t.bindVertexArray(null)}dispose(){for(let e of this.resources.keys())this.remove(e);this.releaseProgram()}releaseProgram(){let{gl:e}=this;e.getParameter(e.CURRENT_PROGRAM)===this.program&&e.useProgram(null),e.deleteProgram(this.program)}[Symbol.dispose??Symbol()](){this.dispose()}},b=(e,t)=>new y(e,t),x=`#version 300 es
out vec2 ndc;
void main(){
  vec2 point=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2))*2.-1.;
  ndc=point;gl_Position=vec4(point,0.,1.);
}`,S=`#version 300 es
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
}`,C=e=>{let t=Math.hypot(...e);return e.map(e=>e/t)};function w(n){let r=n.createProgram();for(let[e,t]of[[n.VERTEX_SHADER,x],[n.FRAGMENT_SHADER,S]]){let i=n.createShader(e);if(n.shaderSource(i,t),n.compileShader(i),!n.getShaderParameter(i,n.COMPILE_STATUS)){let e=n.getShaderInfoLog(i);throw n.deleteShader(i),n.deleteProgram(r),Error(e)}n.attachShader(r,i),n.deleteShader(i)}if(n.linkProgram(r),!n.getProgramParameter(r,n.LINK_STATUS)){let e=n.getProgramInfoLog(r);throw n.deleteProgram(r),Error(e)}let i=n.createVertexArray(),a=Object.fromEntries([`relief`,`pigment`,`vapor`,`eye`,`forwardAxis`,`rightAxis`,`upAxis`,`sun`,`plane`,`options`].map(e=>[e,n.getUniformLocation(r,e)])),o=e(177),s=t(42,7538),c=[];function l(e,t,r,i,a,o){let s=n.createTexture();c.push(s),n.activeTexture(n.TEXTURE0+e),n.bindTexture(t,s),n.pixelStorei(n.UNPACK_ALIGNMENT,1),t===n.TEXTURE_3D?(n.texImage3D(t,0,n.R8,o,o,o,0,r,i,a),n.texParameteri(t,n.TEXTURE_WRAP_R,n.REPEAT)):n.texImage2D(t,0,n.RGBA8,o,o,0,r,i,a),n.texParameteri(t,n.TEXTURE_MIN_FILTER,n.LINEAR),n.texParameteri(t,n.TEXTURE_MAG_FILTER,n.LINEAR),n.texParameteri(t,n.TEXTURE_WRAP_S,t===n.TEXTURE_3D?n.REPEAT:n.CLAMP_TO_EDGE),n.texParameteri(t,n.TEXTURE_WRAP_T,t===n.TEXTURE_3D?n.REPEAT:n.CLAMP_TO_EDGE)}l(0,n.TEXTURE_2D,n.RGBA,n.UNSIGNED_BYTE,o.elevation,177),l(1,n.TEXTURE_2D,n.RGBA,n.UNSIGNED_BYTE,o.diffuse,177),l(2,n.TEXTURE_3D,n.RED,n.UNSIGNED_BYTE,s,42),n.pixelStorei(n.UNPACK_ALIGNMENT,4),n.useProgram(r);for(let[e,t]of[`relief`,`pigment`,`vapor`].entries())n.uniform1i(a[t],e);return n.useProgram(null),{draw(e,t,o){n.disable(n.CULL_FACE),n.disable(n.BLEND),n.disable(n.DEPTH_TEST),n.viewport(0,0,t,o),n.useProgram(r),n.bindVertexArray(i);for(let e=0;e<3;e++)n.activeTexture(n.TEXTURE0+e),n.bindTexture(e===2?n.TEXTURE_3D:n.TEXTURE_2D,c[e]);let s=C(e.look.map((t,n)=>t-e.eye[n])),l=C([-s[2],0,s[0]]),u=[l[1]*s[2]-l[2]*s[1],l[2]*s[0]-l[0]*s[2],l[0]*s[1]-l[1]*s[0]],d=Math.tan(55*Math.PI/360);for(let[t,r]of Object.entries({eye:e.eye,forwardAxis:s,rightAxis:l,upAxis:u,sun:C(e.sun)}))n.uniform3fv(a[t],r);n.uniform2f(a.plane,d*t/o,d),n.uniform4f(a.options,e.cover,e.shadows?.88:0,e.shafts?.53:0,e.time),n.drawArrays(n.TRIANGLES,0,3),n.bindVertexArray(null),n.useProgram(null),n.enable(n.DEPTH_TEST)},dispose(){n.deleteProgram(r),n.deleteVertexArray(i);for(let e of c)n.deleteTexture(e)}}}async function T(e,{signal:t,fail:n}){let i=await r.create(e,{backend:`webgl2`,fallback:b,signal:t,exactSize:!0,antialias:!1,capacity:2});i.onError=n,t.throwIfAborted();let a,o,s,c=i.scene.frameGraph.add({name:`cloud ray and coast`,order:1,execute(e){e.backend===`webgl2`&&(e.gl!==o&&(a?.dispose(),o=e.gl,a=w(o)),s&&a.draw(s,e.width,e.height))}});return{renderer:`webgl2`,draw(e){s=e,i.render({delta:0})},finish(){return o?.finish(),Promise.resolve()},dispose(){c(),a?.dispose(),i.dispose()}}}export{T as openDirect};