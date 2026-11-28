import {Engine} from '@margoengine/core';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
import {openingPasses,openingPositions} from './opening.mjs';
import {ports,routes} from './network.mjs';
import {background,graphStyle,margin,pickRadius,resizeCanvas,screenPoint} from './presentation.mjs';

const vertexSource=`#version 300 es
precision highp float;
layout(location=0) in vec2 xy;
layout(location=1) in vec3 rgb;
layout(location=2) in float pixels;
uniform vec2 css;
uniform float density;
out vec3 visibleColor;
flat out float diameter;
void main(){
  gl_Position=vec4(xy.x/css.x*2.0-1.0,1.0-xy.y/css.y*2.0,0.0,1.0);
  gl_PointSize=pixels*density;
  diameter=gl_PointSize;
  visibleColor=rgb;
}`;
const edgeFragment=`#version 300 es
precision highp float;
in vec3 visibleColor;
out vec4 color;
void main(){color=vec4(visibleColor,1.0);}`;
const nodeFragment=`#version 300 es
precision highp float;
in vec3 visibleColor;
flat in float diameter;
uniform float density;
out vec4 color;
void main(){
  float radius=length(gl_PointCoord-.5)*diameter;
  float coverage=1.0-smoothstep(diameter*.5-1.12,diameter*.5,radius);
  float pin=1.0-smoothstep(.45*density,.88*density,radius);
  color=vec4(mix(visibleColor,vec3(.98,.949,.831),pin),coverage);
}`;
const pickVertex=`#version 300 es
precision highp float;
layout(location=0) in vec2 xy;
uniform vec2 pointer;
uniform float radius;
flat out int port;
void main(){
  vec2 delta=xy-pointer;
  float score=dot(delta,delta)/(radius*radius);
  gl_Position=score<=1.0?vec4(0,0,score-.99,1):vec4(2,2,2,1);
  gl_PointSize=1.0;
  port=gl_VertexID+1;
}`;
const pickFragment=`#version 300 es
precision highp float;
flat in int port;
out vec4 color;
void main(){color=vec4(float(port&255),float((port>>8)&255),0.0,255.0)/255.0;}`;

const byte=(hex,start)=>parseInt(hex.substring(start,start+2),16)/255;
const rgb=hex=>[byte(hex,1),byte(hex,3),byte(hex,5)];
const linear=n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4;
const encoded=n=>n<=.0031308?12.92*n:1.055*n**(1/2.4)-.055;
const clear=rgb(background).map(linear);

function link(gl,vertex,fragment) {
  const program=gl.createProgram();
  for(const [type,code] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
    const shader=gl.createShader(type);
    gl.shaderSource(shader,code);
    gl.compileShader(shader);
    gl.attachShader(program,shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)) {
    const details=gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('The ferry chart shader did not link. '+details);
  }
  return program;
}

function stream(gl){
  const vao=gl.createVertexArray(),buffer=gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  for(const [index,size,offset] of [[0,2,0],[1,3,8],[2,1,20]]){
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index,size,gl.FLOAT,false,24,offset);
  }
  return {
    upload(values){
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);
    },
    bind:()=>gl.bindVertexArray(vao),
    dispose(){gl.deleteVertexArray(vao);gl.deleteBuffer(buffer);},
  };
}

function graphics(gl) {
  const edges=stream(gl),nodes=stream(gl);
  const edgeProgram=link(gl,vertexSource,edgeFragment),nodeProgram=link(gl,vertexSource,nodeFragment);
  const identity=link(gl,pickVertex,pickFragment);
  const css=[gl.getUniformLocation(edgeProgram,'css'),gl.getUniformLocation(nodeProgram,'css')];
  const densities=[gl.getUniformLocation(edgeProgram,'density'),gl.getUniformLocation(nodeProgram,'density')];
  const sampleAt=gl.getUniformLocation(identity,'pointer'),radius=gl.getUniformLocation(identity,'radius');
  const fbo=gl.createFramebuffer(),id=gl.createTexture(),depth=gl.createRenderbuffer(),pixel=new Uint8Array(4);
  gl.bindTexture(gl.TEXTURE_2D,id);
  gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,1,1);
  gl.bindRenderbuffer(gl.RENDERBUFFER,depth);
  gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,1,1);
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,id,0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('The port picking target is unavailable.');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);

  return {
    update(positions,style){
      const vertices=new Float32Array(ports.length*6);
      for(let i=0;i<ports.length;i++)vertices.set([...positions[i],...rgb(style.nodeColor[i]),style.nodeSize[i]],i*6);

      const lines=new Float32Array(routes.length*36);
      for(const [i,{start,end}] of routes.entries()){
        const a=positions[start],b=positions[end],dx=b[0]-a[0],dy=b[1]-a[1];
        const half=style.edgeWidth[i]*.5/Math.max(.001,Math.hypot(dx,dy));
        const offset=[-dy*half,dx*half];
        const color=rgb(style.edgeColor[i]).map((c,k)=>encoded(linear(c)*style.edgeOpacity+clear[k]*(1-style.edgeOpacity)));
        for(const [j,[end,side]] of [[a,-1],[a,1],[b,1],[a,-1],[b,1],[b,-1]].entries())
          lines.set([end[0]+side*offset[0],end[1]+side*offset[1],...color,0],i*36+j*6);
      }
      edges.upload(lines);
      nodes.upload(vertices);
    },
    draw(width,height,w,h) {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.viewport(0,0,width,height);
      gl.useProgram(edgeProgram);
      gl.uniform2f(css[0],w,h);
      gl.uniform1f(densities[0],width/w);
      edges.bind();
      gl.drawArrays(gl.TRIANGLES,0,routes.length*6);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(nodeProgram);
      gl.uniform2f(css[1],w,h);
      gl.uniform1f(densities[1],width/w);
      nodes.bind();
      gl.drawArrays(gl.POINTS,0,ports.length);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      gl.useProgram(null);
    },
    pick(x,y) {
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.viewport(0,0,1,1);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DITHER);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      gl.clearDepth(1);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.useProgram(identity);
      gl.uniform2f(sampleAt,x,y);
      gl.uniform1f(radius,pickRadius);
      nodes.bind();
      gl.drawArrays(gl.POINTS,0,ports.length);
      gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      gl.bindVertexArray(null);
      gl.useProgram(null);
      gl.disable(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
      return (pixel[0]+256*pixel[1])-1;
    },
    dispose() {
      edges.dispose();
      nodes.dispose();
      for(const program of [edgeProgram,nodeProgram,identity])gl.deleteProgram(program);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(id);
      gl.deleteRenderbuffer(depth);
    },
  };
}

export async function openingView(canvas,signal,fail){
  resizeCanvas(canvas);
  const engine=await Engine.create(canvas,{backend:'webgl2',fallback:webglRenderer,exactSize:true,antialias:false,signal});
  engine.onError=fail;
  engine.scene.background=background;
  let gl,renderer,active=-1,dirty=true;
  const area=()=>({
    x:margin.left,y:margin.top,width:canvas.clientWidth-margin.left-margin.right,height:canvas.clientHeight-margin.top-margin.bottom,
  });
  const position=id=>screenPoint(openingPositions,id,area());
  try {
    engine.scene.frameGraph.add({
      name:'ferry-chart-opening',order:1,execute(context) {
        if(context.backend!=='webgl2')throw new Error('The opening chart expected a WebGL2 context.');
        if(gl!==context.gl) {
          renderer?.dispose();
          gl=context.gl;
          renderer=graphics(gl);
          dirty=true;
        }
        if(dirty){
          renderer.update(ports.map((_,i)=>position(i)),graphStyle(active));
          dirty=false;
        }
        renderer.draw(context.width,context.height,canvas.clientWidth,canvas.clientHeight);
      },
    });
    engine.render();
    gl.finish();
    const sample=renderer.pick(...position(0));
    if(sample!==0)throw new Error('The opening chart could not pick the projected harbour.');
    performance.mark('opening-chart-frame');
    return {
      canvas,area,position,renderer:'webgl2',full:false,pickMode:'gpu-opening',
      update(id){active=id;dirty=true;engine.render();gl.finish();},
      pick(x,y){return renderer.pick(x,y);},
      resize(){if(resizeCanvas(canvas)){dirty=true;engine.render();}},
      work(){return {iterations:openingPasses,dispatches:0};},
      dispose(){renderer.dispose();engine.dispose();},
    };
  }catch(reason){
    renderer?.dispose();
    engine.dispose();
    throw reason;
  }
}
