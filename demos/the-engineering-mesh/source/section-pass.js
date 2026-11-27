import {colormap} from '@margoengine/sciviz/colormaps';
import {palette,shellPalette,temperatures} from './mesh-data.mjs';

const vertex=`#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 direction;
layout(location=2) in float temperature;
uniform mat4 view;
out vec3 world;
out vec3 normal;
out float scalar;
void main(){
  world=vec3(position.x,position.z,-position.y);
  normal=vec3(direction.x,direction.z,-direction.y);
  scalar=temperature;
  gl_Position=view*vec4(world,1.0);
}`;
const fragment=`#version 300 es
precision highp float;
in vec3 world;
in vec3 normal;
in float scalar;
uniform vec3 eye;
uniform sampler2D palette;
uniform vec2 range;
uniform float opacity;
out vec4 color;
void main(){
  vec3 toward=normalize(eye-world);
  vec3 face=normalize(normal);
  if(dot(face,toward)<0.0)face=-face;
  vec3 key=normalize(toward+vec3(.35,.60,.20));
  float diffuse=max(dot(face,key),0.0);
  float specular=pow(max(dot(face,normalize(toward+key)),0.0),48.0)*.25;
  float t=(clamp((scalar-range.x)/(range.y-range.x),0.0,1.0)*255.0+.5)/256.0;
  vec3 surface=texture(palette,vec2(t,.5)).rgb;
  vec3 lit=clamp(surface*(.28+.72*diffuse)+specular,0.0,1.0);
  vec3 display=mix(1.055*pow(lit,vec3(1.0/2.4))-.055,12.92*lit,lessThanEqual(lit,vec3(.0031308)));
  color=vec4(display,opacity);
}`;

function buildProgram(gl){
  const program=gl.createProgram();
  for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
    const shader=gl.createShader(type);
    gl.shaderSource(shader,source);
    gl.compileShader(shader);
    gl.attachShader(program,shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
    const why=gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('The engineering section could not link. '+why);
  }
  return program;
}

function texture(gl,stops){
  const tex=gl.createTexture(),rgba=Uint8Array.from(colormap(stops).table(256),c=>Math.round(c*255));
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texStorage2D(gl.TEXTURE_2D,1,gl.SRGB8_ALPHA8,256,1);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,256,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  return tex;
}

function triangles(gl,layer){
  const vao=gl.createVertexArray(),buffer=gl.createBuffer(),palette=texture(gl,layer.stops);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  for(const [index,count,offset] of [[0,3,0],[1,3,12],[2,1,24]]){
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index,count,gl.FLOAT,false,28,offset);
  }
  let uploaded,vertexCount;
  return {
    bind(){
      if(layer.set!==uploaded){
        uploaded=layer.set;
        vertexCount=uploaded.values.length;
        const vertices=new Float32Array(vertexCount*7);
        for(let i=0;i<vertexCount;i++){
          const k=i*3,j=i*7;
          vertices[j]=uploaded.positions[k];
          vertices[j+1]=uploaded.positions[k+1];
          vertices[j+2]=uploaded.positions[k+2];
          vertices[j+3]=uploaded.normals[k];
          vertices[j+4]=uploaded.normals[k+1];
          vertices[j+5]=uploaded.normals[k+2];
          vertices[j+6]=uploaded.values[i];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.DYNAMIC_DRAW);
      }
      gl.bindVertexArray(vao);
      gl.bindTexture(gl.TEXTURE_2D,palette);
      return vertexCount;
    },
    dispose(){gl.deleteVertexArray(vao);gl.deleteBuffer(buffer);gl.deleteTexture(palette);},
  };
}

function passRenderer(gl,layers){
  const program=buildProgram(gl);
  const location=Object.fromEntries(['view','eye','palette','range','opacity'].map(name=>[name,gl.getUniformLocation(program,name)]));
  const streams=layers.map(layer=>triangles(gl,layer));
  return {
    draw(camera){
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(program);
      gl.uniformMatrix4fv(location.view,false,camera.matrix);
      gl.uniform3fv(location.eye,camera.position);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(location.palette,0);
      for(const [i,layer] of layers.entries()){
        if(!layer.visible)continue;
        const blend=layer.opacity<1;
        gl.depthMask(!blend);
        if(blend){gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);}
        gl.uniform2fv(location.range,layer.range);
        gl.uniform1f(location.opacity,layer.opacity);
        const count=streams[i].bind();
        gl.drawArrays(gl.TRIANGLES,0,count);
        if(blend)gl.disable(gl.BLEND);
      }
      gl.depthMask(true);
      gl.bindVertexArray(null);
      gl.useProgram(null);
    },
    dispose(){for(const stream of streams)stream.dispose();gl.deleteProgram(program);},
  };
}

export function sectionPass(engine,sample){
  const make=(set,stops,range,opacity=1)=>({set,stops,range,opacity,visible:true,update(next){this.set=next;}});
  const shell=make(sample.shell,shellPalette,temperatures);
  const section=make(sample.section,palette,temperatures);
  const edges=make(sample.edges,['#163943','#163943'],[0,1],.49);
  let renderer,gl;
  engine.scene.frameGraph.add({
    name:'engineering-section',order:1,execute(context){
      if(context.backend!=='webgl2')throw new Error('The opening section requires WebGL2.');
      if(context.gl!==gl){
        renderer?.dispose();
        gl=context.gl;
        renderer=passRenderer(gl,[shell,section,edges]);
      }
      renderer.draw(context.camera);
    },
  });
  return {
    shell,section,edges,
    render(){engine.render();},
    async settle(){gl.finish();},
    dispose(){renderer?.dispose();},
  };
}
