import { boneCount,poseStride } from './opening-data.js';

const colors=wgsl=>{
  const v=wgsl?'vec3f':'vec3', f=wgsl?'let':'float', c=wgsl?'let':'vec3';
  return [
    c+' n=normalize(normal);',
    c+' light=normalize('+v+'(-.45,.78,.36));',
    c+' view=normalize(eye-world);',
    c+' halfWay=normalize(light+view);',
    f+' diffuse=max(0.0,dot(n,light));',
    f+' edge=pow(1.0-max(0.0,dot(halfWay,view)),5.0);',
    c+' specular=mix('+v+'(.04),color.rgb,color.w);',
    f+' shine=pow(max(0.0,dot(n,halfWay)),17.0+53.0*(1.0-surface.w));',
    c+' bronze=('+v+'(1.0,.86,.66))*2.6*(color.rgb*(1.0-color.w)*diffuse*.318+mix(specular,'+v+'(1.0),edge)*shine*(.45+.55*(1.0-surface.w)));',
    c+' shaded=max('+v+'(0.0),bronze+color.rgb*'+v+'(.39,.53,.50)*.36+surface.rgb);',
    c+' mapped=shaded/(shaded+.72)*1.28;',
    'return min('+v+'(1.0),pow(mapped,'+v+'(0.454545)));',
  ].join('\n');
};

const gpuShader='struct Global{camera:mat4x4f,bones:array<mat4x4f,20>,eye:vec4f};\n'+
  'struct Paint{color:vec4f,surface:vec4f};\n'+
  '@group(0) @binding(0) var<uniform> g:Global;\n@group(1) @binding(0) var<uniform> paint:Paint;\n'+
  'struct Output{@builtin(position) clip:vec4f,@location(0) point:vec3f,@location(1) normal:vec3f};\n'+
  '@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec4f,@location(2) j:vec4u,@location(3) w0:vec4f)->Output{\n'+
  ' let w=w0/max(dot(w0,vec4f(1)),0.001);\n'+
  ' let skin=g.bones[j.x]*w.x+g.bones[j.y]*w.y+g.bones[j.z]*w.z+g.bones[j.w]*w.w;\n'+
  ' let point=skin*vec4f(p,1);return Output(g.camera*point,point.xyz,(skin*vec4f(n.xyz,0)).xyz);}\n'+
  'fn surfaceColor(world:vec3f,normal:vec3f,eye:vec3f,color:vec4f,surface:vec4f)->vec3f{\n'+colors(true)+'\n}\n'+
  '@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f{'+
  'return vec4f(surfaceColor(i.point,select(-i.normal,i.normal,front),g.eye.xyz,paint.color,paint.surface),1); }';

const glHead='#version 300 es\nprecision highp float;\nprecision highp int;\n';
const glShader=[
  glHead+'layout(location=0) in vec3 p;layout(location=1) in vec4 n;layout(location=2) in uvec4 j;layout(location=3) in vec4 w0;\n'+
  'uniform mat4 camera;uniform mat4 bones[20];out vec3 world,normal;\n'+
  'void main(){ vec4 w=w0/max(dot(w0,vec4(1)),0.001);'+
  ' mat4 skin=bones[j.x]*w.x+bones[j.y]*w.y+bones[j.z]*w.z+bones[j.w]*w.w;'+
  ' vec4 point=skin*vec4(p,1);world=point.xyz;normal=(skin*vec4(n.xyz,0)).xyz;gl_Position=camera*point;}',
  glHead+'uniform vec3 eye;uniform vec4 color,surface;in vec3 world,normal;out vec4 pixel;\n'+
  'vec3 surfaceColor(vec3 normal){'+colors(false)+'}\n'+
  'void main(){pixel=vec4(surfaceColor(gl_FrontFacing?normal:-normal),1);}',
];

function hardware(context,parts,uniforms) {
  const {device,format}=context;
  const buffer=(data,usage)=>{
    const result=device.createBuffer({size:(data.byteLength+3)&~3,usage:usage|GPUBufferUsage.COPY_DST});
    const aligned=data.byteLength%4?new Uint8Array((data.byteLength+3)&~3):data;
    if(aligned!==data)aligned.set(data);
    device.queue.writeBuffer(result,0,aligned);
    return result;
  };
  const globals=buffer(uniforms,GPUBufferUsage.UNIFORM);
  const module=device.createShaderModule({code:gpuShader});
  const graphics=device.createRenderPipeline({
    layout:'auto',
    vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:24,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'snorm8x4'},
      {shaderLocation:2,offset:16,format:'uint8x4'},{shaderLocation:3,offset:20,format:'unorm8x4'},
    ]}]},
    fragment:{module,entryPoint:'fragment',targets:[{format}]},
    depthStencil:{format:context.descriptor.depthStencil.format,depthWriteEnabled:true,depthCompare:'greater'},
  });
  const globalGroup=device.createBindGroup({layout:graphics.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:globals}}]});
  const draws=parts.map(part=>{
    const vertices=buffer(part.vertices,GPUBufferUsage.VERTEX);
    const indices=buffer(part.indices,GPUBufferUsage.INDEX);
    const paint=buffer(Float32Array.from([...part.color,...part.surface]),GPUBufferUsage.UNIFORM);
    const group=device.createBindGroup({layout:graphics.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:paint}}]});
    return {vertices,indices,paint,group,count:part.indexCount};
  });
  return {device,
    draw(c){
      device.queue.writeBuffer(globals,0,uniforms);
      const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],
        depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true}});
      pass.setPipeline(graphics);
      pass.setBindGroup(0,globalGroup);
      for(const part of draws){
        pass.setBindGroup(1,part.group);
        pass.setVertexBuffer(0,part.vertices);
        pass.setIndexBuffer(part.indices,'uint16');
        pass.drawIndexed(part.count);
      }
      pass.end();
    },
    dispose(){
      globals.destroy();
      for(const part of draws){part.vertices.destroy();part.indices.destroy();part.paint.destroy();}
    },
  };
}

function compatibility({gl},parts,uniforms) {
  const program=gl.createProgram();
  for(const [i,type] of [gl.VERTEX_SHADER,gl.FRAGMENT_SHADER].entries()){
    const stage=gl.createShader(type);
    gl.shaderSource(stage,glShader[i]);
    gl.compileShader(stage);
    gl.attachShader(program,stage);
    gl.deleteShader(stage);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
    const failure=gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Opening robot shader could not link. '+failure);
  }
  const location=Object.fromEntries(['camera','bones[0]','eye','color','surface'].map(name=>[name,gl.getUniformLocation(program,name)]));
  const buffer=(data,target)=>{
    const result=gl.createBuffer();
    gl.bindBuffer(target,result);
    gl.bufferData(target,data,gl.STATIC_DRAW);
    return result;
  };
  const draws=parts.map(part=>{
    const vao=gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vertices=buffer(part.vertices,gl.ARRAY_BUFFER),indices=buffer(part.indices,gl.ELEMENT_ARRAY_BUFFER);
    for(let i=0;i<4;i++)gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
    gl.vertexAttribPointer(1,4,gl.BYTE,true,24,12);
    gl.vertexAttribIPointer(2,4,gl.UNSIGNED_BYTE,24,16);
    gl.vertexAttribPointer(3,4,gl.UNSIGNED_BYTE,true,24,20);
    return {...part,vao,vertices,indices};
  });
  gl.bindVertexArray(null);
  return {device:gl,
    draw(){
      gl.useProgram(program);
      gl.uniformMatrix4fv(location.camera,false,uniforms,0,16);
      gl.uniformMatrix4fv(location['bones[0]'],false,uniforms,16,16*boneCount);
      gl.uniform3fv(location.eye,uniforms,16+16*boneCount,3);
      for(const part of draws){
        gl.uniform4fv(location.color,part.color);
        gl.uniform4fv(location.surface,part.surface);
        gl.bindVertexArray(part.vao);
        gl.drawElements(gl.TRIANGLES,part.indexCount,gl.UNSIGNED_SHORT,0);
      }
      gl.bindVertexArray(null);
      gl.flush();
    },
    dispose(){
      gl.useProgram(null);
      gl.deleteProgram(program);
      for(const part of draws){gl.deleteVertexArray(part.vao);gl.deleteBuffer(part.vertices);gl.deleteBuffer(part.indices);}
    },
  };
}

export function mountOpeningRobot(engine,parts) {
  const uniform=new Float32Array(16+16*boneCount+4);
  for(let i=0;i<boneCount;i++)uniform[16+i*16+15]=1;
  let renderer;
  engine.scene.frameGraph.add({name:'verified opening skin',order:1,execute(context){
    const device=context.backend==='webgpu'?context.device:context.gl;
    if(renderer?.device!==device) {
      renderer?.dispose();
      renderer=(context.backend==='webgpu'?hardware:compatibility)(context,parts,uniform);
    }
    uniform.set(context.camera.matrix);
    uniform.set(context.camera.position,16+16*boneCount);
    renderer.draw(context);
  }});
  return {
    use(clip,frame){
      const start=frame*poseStride;
      for(let i=0;i<boneCount;i++){
        const source=start+i*12, target=16+i*16;
        for(let c=0;c<4;c++) {
          const from=source+c*3, to=target+c*4;
          uniform[to]=clip.values[from];uniform[to+1]=clip.values[from+1];uniform[to+2]=clip.values[from+2];
        }
      }
    },
    dispose(){renderer?.dispose();},
  };
}
