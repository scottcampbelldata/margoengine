
import {Engine} from '@margoengine/core';
import {webglRenderer,glProgram} from '@margoengine/webgl2-compat/preview';
import {installStaging} from './staging.js';
import {runGlass} from './interaction.js';

const fullscreen=`#version 300 es
out vec2 sensor;
void main(){
  vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
  sensor=2.*p-1.;
  gl_Position=vec4(sensor,0.,1.);
}`;
const composite=`#version 300 es
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
}`;
const unit=vec=>{const length=Math.hypot(...vec);return vec.map(x=>x/length);};
const components=color=>[1,3,5].map(i=>Number.parseInt(color.slice(i,i+2),16)/255);

const depthVertex=`#version 300 es
layout(location=0) in vec3 vertex;
uniform mat4 cameraMatrix,world;
void main(){gl_Position=cameraMatrix*world*vec4(vertex,1.);}
`;
const depthFragment=`#version 300 es
precision highp float;
void main(){}
`;
function prepareDepth(gl,objects){
  const program=glProgram(gl,depthVertex,depthFragment),data=new WeakMap(),buffers=[],arrays=[];
  const world=gl.getUniformLocation(program,'world'),camera=gl.getUniformLocation(program,'cameraMatrix');
  const inputs=objects.map(mesh=>{
    const geometry=mesh.geometry;
    if(!data.has(geometry)){
      const vao=gl.createVertexArray(),vertex=gl.createBuffer(),index=gl.createBuffer();
      arrays.push(vao);buffers.push(vertex,index);
      gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,vertex);gl.bufferData(gl.ARRAY_BUFFER,geometry.vertices,gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,geometry.indices,gl.STATIC_DRAW);
      data.set(geometry,{vao,count:geometry.indices.length});
    }
    return {mesh,...data.get(geometry)};
  });
  return {
    draw(matrix){
      gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.depthFunc(gl.LEQUAL);gl.clearDepth(1);gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);gl.uniformMatrix4fv(camera,false,matrix);
      for(const {mesh,vao,count} of inputs){
        gl.bindVertexArray(vao);gl.uniformMatrix4fv(world,false,mesh.matrix);gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_INT,0);
      }
    },
    dispose(){
      gl.deleteProgram(program);
      for(const buffer of buffers)gl.deleteBuffer(buffer);
      for(const vao of arrays)gl.deleteVertexArray(vao);
    }
  };
}

function stagePass(gl,objects){
  const program=glProgram(gl,fullscreen,composite),empty=gl.createVertexArray(),depth=gl.createTexture(),copy=gl.createFramebuffer();
  const uniforms=Object.fromEntries(['eye','forwardAxis','rightAxis','upAxis','lens','cameraMatrix','opaqueZ','part[0]','count','method']
    .map(key=>[key,gl.getUniformLocation(program,key)]));
  const values=new Float32Array(48*4);
  let w=0,h=0;
  const receiverDepth=prepareDepth(gl,objects);
  function storage(width,height){
    if(width===w&&height===h)return;
    w=width;h=height;
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,depth);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,w,h,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER,copy);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,depth,0);
    gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Glass depth target is incomplete.');
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  return {
    draw(frame,parts,mode){
      const {camera}=frame;
      storage(frame.width,frame.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER,copy);gl.viewport(0,0,w,h);
      receiverDepth.draw(camera.matrix);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      const f=unit(camera.target.map((value,i)=>value-camera.position[i])),r=unit([-f[2],0,f[0]]),
        u=[-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]];
      const tangent=Math.tan(camera.fov*Math.PI/360);
      gl.viewport(0,0,w,h);gl.disable(gl.CULL_FACE);gl.disable(gl.DEPTH_TEST);gl.depthMask(false);
      gl.enable(gl.BLEND);gl.blendEquation(gl.FUNC_ADD);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(program);gl.bindVertexArray(empty);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,depth);
      gl.uniform1i(uniforms.opaqueZ,0);
      for(const [key,value] of Object.entries({eye:camera.position,forwardAxis:f,rightAxis:r,upAxis:u}))gl.uniform3fv(uniforms[key],value);
      gl.uniform2f(uniforms.lens,tangent*w/h,tangent);
      gl.uniformMatrix4fv(uniforms.cameraMatrix,false,camera.matrix);
      gl.uniform1i(uniforms.count,parts.length);
      gl.uniform1i(uniforms.method,mode==='weighted'?0:mode==='moments'?1:2);
      for(const [i,part] of parts.entries()){
        const m=part.anchor.matrix,index=16*i;
        values.set([m[12],m[13],m[14],part.smoke?1:0,m[0],m[1],m[2],part.width*.5,
          m[4],m[5],m[6],part.height*.5,...part.tint,part.opacity],index);
      }
      gl.uniform4fv(uniforms['part[0]'],values);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.disable(gl.BLEND);gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.bindVertexArray(null);gl.useProgram(null);
    },
    dispose(){receiverDepth.dispose();gl.deleteProgram(program);gl.deleteVertexArray(empty);gl.deleteFramebuffer(copy);gl.deleteTexture(depth);}
  };
}
export async function openDirect(canvas,signal,fail){
  const engine=await Engine.create(canvas,{backend:'webgl2',fallback:webglRenderer,signal,exactSize:true,antialias:false,capacity:96,
    camera:{near:.14,far:45,fov:39}});
  engine.onError=fail;performance.mark('glass-device');
  let layer,gl;
  const room=installStaging(engine);
  for(const item of room.glazes)item.tint=components(item.color);
  for(const item of room.smoke){item.tint=components(item.color).map(channel=>channel*.965);item.smoke=true;}
  let parts=[],mode='weighted';
  const remove=engine.scene.frameGraph.add({name:'glass transparency',order:8,execute(frame){
    if(frame.backend!=='webgl2')return;
    gl=frame.gl;
    layer??=stagePass(gl,room.opaque);layer.draw(frame,parts,mode);
  }});
  const adapter={
    room,renderer:'webgl2',exact:'Per-pixel depth sort',
    select(settings){
      mode=settings.mode;
      parts=[...room.glazes,...(settings.smoke?room.smoke:[])];
      if(settings.reverse)parts.reverse();
      return parts.length;
    },
    wait(){
      const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();
      return new Promise((resolve,reject)=>{
        const maximum=performance.now()+1500;
        function poll(){
          const result=gl.clientWaitSync(fence,0,0);
          if(result===gl.TIMEOUT_EXPIRED&&!signal.aborted&&performance.now()<maximum){setTimeout(poll,4);return;}
          gl.deleteSync(fence);
          if(result===gl.WAIT_FAILED||result===gl.TIMEOUT_EXPIRED)reject(Error('The transparent frame did not finish.'));
          else resolve();
        }
        poll();
      });
    },
    dispose(){remove();layer?.dispose();}
  };
  canvas.addEventListener('webglcontextrestored',()=>{layer=undefined;},{signal});
  return {engine,view:await runGlass(engine,canvas,signal,fail,adapter)};
}
