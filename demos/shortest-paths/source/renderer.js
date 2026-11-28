import {Engine} from '@margoengine/core';
import {LineBatch,LineBatches} from '@margoengine/lines/batch';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
import {paper,projection} from './map-model.mjs';

const vertex=`#version 300 es
precision highp float;
layout(location=0) in vec2 position;
layout(location=1) in vec3 shade;
layout(location=2) in vec2 feather;
uniform vec2 css;
out vec3 ink;
out vec2 edge;
void main(){
  gl_Position=vec4(position.x/css.x*2.0-1.0,1.0-position.y/css.y*2.0,0.0,1.0);
  ink=shade;
  edge=feather;
}`;
const fragment=`#version 300 es
precision highp float;
in vec3 ink;
in vec2 edge;
out vec4 color;
void main(){color=vec4(ink,1.0-smoothstep(edge.y,edge.y+1.0,abs(edge.x)));}`;

function loadProgram(gl){
  const program=gl.createProgram();
  for(const [type,code] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
    const shader=gl.createShader(type);
    gl.shaderSource(shader,code);
    gl.compileShader(shader);
    gl.attachShader(program,shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
    const problem=gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('The map’s line shader could not link. '+problem);
  }
  return program;
}

function rgb(hex){
  return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
}

function lineGeometry(styles,map,density){
  const data=new Float32Array(styles.reduce((count,s)=>count+s.vertices.length/6,0)*42);
  let write=0;
  for(const {width,color,vertices} of styles){
    const shade=rgb(color),half=width*density*.5,total=half+1;
    for(let i=0;i<vertices.length;i+=6){
      const a=map.screen([vertices[i],vertices[i+1]]),b=map.screen([vertices[i+3],vertices[i+4]]);
      const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.max(.001,Math.hypot(dx,dy));
      const n=[-dy/length*total/density,dx/length*total/density];
      for(const [p,side] of [[a,-1],[a,1],[b,1],[a,-1],[b,1],[b,-1]]){
        data.set([p[0]+n[0]*side,p[1]+n[1]*side,...shade,total*side,half],write);
        write+=7;
      }
    }
  }
  return data;
}

function linePass(gl){
  const program=loadProgram(gl),vao=gl.createVertexArray(),buffer=gl.createBuffer();
  const css=gl.getUniformLocation(program,'css');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  for(const [index,size,offset] of [[0,2,0],[1,3,8],[2,2,20]]){
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index,size,gl.FLOAT,false,28,offset);
  }
  let count=0;
  return {
    update(styles,map,density){
      const vertices=lineGeometry(styles,map,density);
      count=vertices.length/7;
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.DYNAMIC_DRAW);
    },
    draw(map){
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao);
      gl.useProgram(program);
      gl.uniform2f(css,map.width,map.height);
      gl.drawArrays(gl.TRIANGLES,0,count);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      gl.useProgram(null);
    },
    dispose(){gl.deleteVertexArray(vao);gl.deleteBuffer(buffer);gl.deleteProgram(program);},
  };
}

function camera(engine,getMap){
  engine.camera.position=[0,0,10];
  engine.camera.target=[0,0,0];
  engine.camera.up=[0,1,0];
  engine.camera.near=.05;
  engine.camera.far=100;
  engine.camera.project=(out,_aspect,webgpu)=>{
    const map=getMap(),n=engine.camera.near,f=engine.camera.far;
    out[0]=2*map.scale/map.width;
    out[5]=2*map.scale/map.height;
    out[10]=webgpu?1/(f-n):-2/(f-n);
    out[13]=1-2*map.center[1]/map.height;
    out[14]=webgpu?f/(f-n):-(f+n)/(f-n);
    out[15]=1;
  };
}

function native(engine){
  const batches=LineBatches.attach(engine),byStyle=new Map();
  return {
    update(strokes){
      const next=new Set();
      for(const {width,color,vertices} of strokes){
        const key=color+'/'+width;
        let item=byStyle.get(key);
        if(!item){
          const batch=batches.add(new LineBatch({positions:vertices,color,width,onTop:true}));
          item={vertices,batch};
          byStyle.set(key,item);
        }else if(item.vertices!==vertices){
          item.batch.setSegments(vertices);
          item.vertices=vertices;
        }
        item.batch.visible=true;
        next.add(key);
      }
      for(const [key,{batch}] of byStyle)if(!next.has(key))batch.visible=false;
    },
    settle:()=>engine.gpu.queue.onSubmittedWorkDone(),
    dispose(){for(const {batch} of byStyle.values())batch.dispose();},
  };
}

function compatibility(engine,getMap){
  let gl,pass,strokes=[],updated=true;
  engine.scene.frameGraph.add({
    name:'street-map-ink',order:1,execute(context){
      if(context.backend!=='webgl2')throw new Error('The map expected WebGL2.');
      if(gl!==context.gl){
        pass?.dispose();
        gl=context.gl;
        pass=linePass(gl);
        updated=true;
      }
      const map=getMap();
      if(updated){
        pass.update(strokes,map,context.width/map.width);
        updated=false;
      }
      pass.draw(map);
    },
  });
  return {
    update(next){strokes=next;updated=true;},
    async settle(){gl.finish();},
    dispose(){pass?.dispose();},
  };
}

export async function openMap(canvas,force,signal){
  const options={exactSize:true,antialias:false,capacity:16,signal};
  let engine;
  if(!force&&navigator.gpu){
    try{engine=await Engine.create(canvas,{...options,backend:'webgpu'});}
    catch(reason){if(!['unsupported','no-adapter'].includes(reason?.code))throw reason;}
  }
  engine??=await Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
  const getMap=()=>projection(canvas.clientWidth,canvas.clientHeight);
  camera(engine,getMap);
  engine.scene.background=paper;
  const ink=engine.backend==='webgpu'?native(engine):compatibility(engine,getMap);
  return {
    engine,backend:engine.backend,getMap,
    draw(styles){
      const density=Math.max(1.5,Math.min(1.75,devicePixelRatio||1));
      const w=Math.max(1,Math.round(canvas.clientWidth*density)),h=Math.max(1,Math.round(canvas.clientHeight*density));
      if(canvas.width!==w)canvas.width=w;
      if(canvas.height!==h)canvas.height=h;
      ink.update(styles);
      engine.render();
    },
    settle:ink.settle,
    dispose(){ink.dispose();engine.dispose();},
  };
}
