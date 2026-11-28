import{n as e,r as t}from"./tile-BYZuyUSW.js";var n=`#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}`,r=`#version 300 es
precision highp float; precision highp int;
uniform vec2 size, repeats, offset;
uniform uint seed;
uniform int kind;
uniform float detail, grout, stagger;
uniform vec3 color, secondary;
out vec4 result;
float hash(uvec2 cell){
 uint h=(cell.x*1597334677u)^(cell.y*3812015801u)^seed;
 h=(h^(h>>16u))*2246822519u; h=(h^(h>>13u))*3266489917u;
 return float((h^(h>>16u))>>8u)/16777215.0;
}
float noise(vec2 uv,uint period){
 vec2 q=uv*float(period); uvec2 cell=uvec2(floor(q));
 vec2 f=fract(q),t=f*f*f*(f*(f*6.0-15.0)+10.0);
 float a=hash(cell%uvec2(period)),b=hash((cell+uvec2(1,0))%uvec2(period));
 float c=hash((cell+uvec2(0,1))%uvec2(period)),d=hash((cell+uvec2(1,1))%uvec2(period));
 return mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
}
void main(){
 vec2 uv=fract(gl_FragCoord.xy/size+offset);
 float n=(noise(uv,4u)*8.0+noise(uv,8u)*4.0+noise(uv,16u)*2.0+noise(uv,32u))/15.0;
 float value=n;
 if(kind==1||kind==2){
  uint row=uint(floor(uv.y*repeats.y));
  float shift=kind==1?float(row%2u)*stagger:0.0;
  vec2 local=fract(uv*repeats+vec2(shift,0)),edge=min(local,1.0-local);
  value=(all(greaterThanEqual(edge,vec2(grout)))?1.0:0.0)*(1.0-detail*(1.0-n));
 }else if(kind==3){
  float ring=0.5+0.5*cos(6.28318530718*(uv.x*repeats.x+detail*n));value=0.2+0.8*ring;
 }else if(kind==4){value=smoothstep(0.35-detail*0.2,0.65+detail*0.2,n);}

 result=vec4(floor(clamp(mix(secondary,color,value),0.0,1.0)*255.0+0.5)/255.0,1);
}`,i=e=>t(`failed`,e,`procedural`);function a(a){let o=()=>{if(a.isContextLost())throw i(`Texture baker context was lost; recreate the baker after restoration`)};o();let s=a.createProgram(),c=[];if(!s)throw i(`Texture baker could not allocate a WebGL2 program`);try{for(let[e,t]of[[a.VERTEX_SHADER,n],[a.FRAGMENT_SHADER,r]]){let n=a.createShader(e);if(!n)throw i(`Texture baker could not allocate a WebGL2 shader`);if(c.push(n),a.shaderSource(n,t),a.compileShader(n),!a.getShaderParameter(n,a.COMPILE_STATUS))throw i(`Texture shader: ${a.getShaderInfoLog(n)}`);a.attachShader(s,n)}if(a.linkProgram(s),!a.getProgramParameter(s,a.LINK_STATUS))throw i(`Texture pipeline: ${a.getProgramInfoLog(s)}`)}catch(e){throw a.deleteProgram(s),e}finally{for(let e of c)a.deleteShader(e)}let l=Object.fromEntries([`size`,`repeats`,`offset`,`seed`,`kind`,`detail`,`grout`,`stagger`,`color`,`secondary`].map(e=>[e,a.getUniformLocation(s,e)])),u=new Set,d=!1,f=!1,p=()=>{f=!0};a.canvas.addEventListener(`webglcontextlost`,p);let m=()=>{if(d)throw t(`disposed`,`Texture baker is disposed; create a new baker`,`procedural`);if(f)throw i(`Texture baker context was lost; recreate the baker after restoration`);o()};return{async bake(t={}){m();let n=e(t,a.getParameter(a.MAX_TEXTURE_SIZE)),r=a.createTexture(),o=a.createFramebuffer(),c=a.createVertexArray();if(!r||!o||!c)throw a.deleteTexture(r),a.deleteFramebuffer(o),a.deleteVertexArray(c),i(`Texture bake could not allocate WebGL2 resources`);let d=[a.BLEND,a.CULL_FACE,a.DEPTH_TEST,a.SCISSOR_TEST,a.STENCIL_TEST,a.DITHER,a.RASTERIZER_DISCARD,a.SAMPLE_ALPHA_TO_COVERAGE,a.SAMPLE_COVERAGE].map(e=>[e,a.isEnabled(e)]),f={draw:a.getParameter(a.DRAW_FRAMEBUFFER_BINDING),read:a.getParameter(a.READ_FRAMEBUFFER_BINDING),program:a.getParameter(a.CURRENT_PROGRAM),vao:a.getParameter(a.VERTEX_ARRAY_BINDING),texture:a.getParameter(a.TEXTURE_BINDING_2D),viewport:a.getParameter(a.VIEWPORT),mask:a.getParameter(a.COLOR_WRITEMASK)},p=!1;try{if(a.bindTexture(a.TEXTURE_2D,r),a.texStorage2D(a.TEXTURE_2D,1,a.RGBA8,n.width,n.height),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MIN_FILTER,a.LINEAR),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MAG_FILTER,a.LINEAR),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_S,a.REPEAT),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_T,a.REPEAT),a.bindFramebuffer(a.DRAW_FRAMEBUFFER,o),a.framebufferTexture2D(a.DRAW_FRAMEBUFFER,a.COLOR_ATTACHMENT0,a.TEXTURE_2D,r,0),a.checkFramebufferStatus(a.DRAW_FRAMEBUFFER)!==a.FRAMEBUFFER_COMPLETE)throw i(`Texture bake framebuffer is incomplete; check WebGL2 texture limits`);a.useProgram(s),a.bindVertexArray(c);for(let[e]of d)a.disable(e);a.colorMask(!0,!0,!0,!0),a.viewport(0,0,n.width,n.height),a.uniform2f(l.size,n.width,n.height),a.uniform2fv(l.repeats,n.repeat),a.uniform2fv(l.offset,n.offset.map(e=>(e%1+1)%1)),a.uniform1ui(l.seed,n.seed),a.uniform1i(l.kind,n.kind),a.uniform1f(l.detail,n.detail),a.uniform1f(l.grout,n.grout),a.uniform1f(l.stagger,n.stagger),a.uniform3fv(l.color,n.color),a.uniform3fv(l.secondary,n.secondary),a.drawArrays(a.TRIANGLES,0,3)}catch(e){throw a.deleteTexture(r),e}finally{a.bindFramebuffer(a.DRAW_FRAMEBUFFER,f.draw),a.bindFramebuffer(a.READ_FRAMEBUFFER,f.read),a.useProgram(f.program),a.bindVertexArray(f.vao),a.bindTexture(a.TEXTURE_2D,f.texture),a.viewport(f.viewport[0],f.viewport[1],f.viewport[2],f.viewport[3]),a.colorMask(f.mask[0],f.mask[1],f.mask[2],f.mask[3]);for(let[e,t]of d)t?a.enable(e):a.disable(e);a.deleteFramebuffer(o),a.deleteVertexArray(c)}try{await Promise.resolve(),n.signal?.throwIfAborted(),m();let e={backend:`webgl2`,texture:r,gl:a,width:n.width,height:n.height,dispose(){u.delete(e)&&a.deleteTexture(r)},[Symbol.dispose](){this.dispose()}};return u.add(e),p=!0,e}finally{p||a.deleteTexture(r)}},dispose(){if(!d){d=!0,a.canvas.removeEventListener(`webglcontextlost`,p);for(let e of u)e.dispose();a.deleteProgram(s)}},[Symbol.dispose](){this.dispose()}}}export{a as createWebGLBaker};