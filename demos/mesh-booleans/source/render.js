import {metre} from './specimen.mjs';

const stride=7;
const vertexAt=(data,k)=>data.slice(k*3,k*3+3);

export function paintMesh(compiled, faceKind) {
  const {positions,normals,indices,triangleFaces}=compiled;
  const out=new Float32Array(indices.length*stride);
  for(let i=0;i<indices.length;i++) {
    const at=i*stride, k=indices[i];
    out.set(vertexAt(positions,k).map(x=>x*metre),at);
    out.set(vertexAt(normals,k),at+3);
    out[at+6]=faceKind(triangleFaces[Math.floor(i/3)],i);
  }
  return out;
}

export function studioBed() {
  const out=[];
  function tri(a,b,c,n,kind) {
    for(const p of [a,b,c])out.push(...p.map(x=>x*metre),...n,kind);
  }
  function quad(a,b,c,d,n,kind){tri(a,b,c,n,kind);tri(a,c,d,n,kind);}
  function frustum(rings, kind, sweep=false) {
    const sides=rings[0].length;
    const safe=([x,y,z])=>{
      const length=Math.hypot(x,y,z)||1;
      return [x/length,y/length,z/length];
    };
    for(let j=1;j<rings.length;j++)for(let i=0;i<sides;i++){
      const k=(i+1)%sides, a=rings[j-1][i], b=rings[j-1][k], c=rings[j][k], d=rings[j][i];
      const u=b.map((x,i)=>x-a[i]), v=d.map((x,i)=>x-a[i]);
      const n=safe([v[1]*u[2]-v[2]*u[1],v[2]*u[0]-v[0]*u[2],v[0]*u[1]-v[1]*u[0]]);
      if(sweep)quad(a,b,c,d,n,kind);
      else quad(a,d,c,b,n,kind);
    }
    if(sweep)return;
    const last=rings.at(-1);
    for(let i=1;i<sides-1;i++)tri(last[0],last[i+1],last[i],[0,1,0],kind);
  }
  const oct=(w,y,d,cut,cx=.13,cz=.05)=>[
    [-w+cut,-d],[w-cut,-d],[w,-d+cut],[w,d-cut],[w-cut,d],[-w+cut,d],[-w,d-cut],[-w,-d+cut],
  ].map(([x,z])=>[cx+x,y,cz+z]);
  const profile=[[0,.001],[3.6,.001],[5.6,.001],[6.25,.065],[6.9,.26],[7.35,.63],
    [7.69,1.10],[7.86,1.67],[7.93,2.35],[7.95,3.25],[7.95,5],[7.95,9]];
  const floor=profile.map(([r,y])=>Array.from({length:64},(_,i)=>{
    const theta=i*2*Math.PI/64;return [r*Math.cos(theta),y,r*Math.sin(theta)];
  }));
  frustum(floor,4,true);
  frustum([oct(1.57,.015,.965,.155),oct(1.65,.042,1.035,.206),oct(1.65,.105,1.035,.206),
    oct(1.63,.135,1.012,.196)],5);
  frustum([oct(1.622,.132,1.008,.195),oct(1.643,.148,1.026,.206),oct(1.643,.164,1.026,.206)],6);
  frustum([oct(1.625,.164,1.008,.198),oct(1.651,.183,1.033,.210),oct(1.651,.220,1.033,.210),
    oct(1.616,.267,.994,.188)],7);
  // Embedded measurement rule. The marks are real geometry above the display deck.
  for(let i=0;i<=28;i++) {
    const x=-1.16+i*.087, step=i%5===0?.07:.036, z=.879, y=.26775;
    quad([x-.004,y,z],[x-.004,y,z+step],[x+.004,y,z+step],[x+.004,y,z],[0,1,0],6);
  }
  quad([-1.168,.2678,.963],[-1.168,.2678,.973],[1.293,.2678,.973],[1.293,.2678,.963],[0,1,0],6);
  return Float32Array.from(out);
}

function fragment(wgsl) {
  const v=wgsl?'vec3f':'vec3', v2=wgsl?'vec2f':'vec2';
  const c=wgsl?'let':v, f=wgsl?'let':'float';
  const mut=(type,name,value)=>(wgsl?'var ':type+' ')+name+'='+value+';';
  return [
    c+' p=world*10.0;',
    c+' n=normalize(normal);',
    c+' view=normalize(eye-world);',
    c+' key=normalize('+v+'(-0.59,0.68,0.31));',
    c+' bounce=normalize('+v+'(0.72,0.29,0.48));',
    c+' rim=normalize('+v+'(0.32,0.44,-0.84));',
    f+' bloom=max(0.0,dot(n,key));',
    f+' rimLight=max(0.0,dot(n,rim));',
    f+' soft=max(0.0,dot(n,bounce));',
    'if(kind>3.5&&kind<4.5){',
      f+' shade=smoothstep(1.10,2.78,length((p.xz-'+v2+'(0.54,0.09))*'+v2+'(0.72,1.13)));',
      f+' fall=exp(-0.032*dot(p.xz,p.xz)-0.10*max(p.y,0.0));',
      f+' grain=(hash(p*129.0)-0.5)*0.00045;',
      'return pow(max('+v+'(0.0),('+v+'(0.020,0.021,0.031)+fall*'+v+'(0.051,0.043,0.035))*(0.31+shade*0.69)+grain),'+v+'(0.454545));',
    '}',
    f+' coarse=hash(p*74.0);',
    f+' fine=hash(p*221.0);',
    f+' warp=variation(p*1.71+'+v+'(1.4,0.7,2.5));',
    f+' secondary=variation(p*3.48);',
    f+' plane=p.y+0.46*p.x-0.28*p.z+0.37*(warp-0.5)+0.21*(secondary-0.5);',
    f+' band=sin(26.0*plane+0.76*sin(9.0*p.x+6.0*p.y));',
    f+' wash=sin(8.7*plane+1.3*sin(3.7*p.x+2.7*p.z));',
    f+' vein=pow(0.5+0.5*sin(44.0*plane+0.9*sin(5.0*p.z)),21.0)*(0.27+0.73*pow(0.5+0.5*wash,2.0));',
    mut(v,'base',v+'(0.022,0.088,0.217)'),
    mut(v,'reflectance',v+'(0.050,0.085,0.125)'),
    mut('float','power','47.0'),
    'if(kind<1.5){',
      'base*=0.85+0.14*band+0.12*wash+0.08*coarse+0.22*warp;',
      'base+=vein*'+v+'(0.16,0.21,0.176);',
      'base+=smoothstep(0.975,0.998,fine)*smoothstep(0.66,0.96,0.5+0.5*wash)*'+v+'(0.24,0.145,0.046);',
      'base*=0.66+0.34*smoothstep(0.27,0.43,p.y);',
    '} else if(kind<2.5){',
      'base='+v+'(0.101,0.217,0.254)*(0.82+0.13*band+0.16*wash+0.12*coarse);',
      'base+=vein*'+v+'(0.12,0.15,0.129);',
      'base*=0.89+0.11*sin(p.z*145.0+0.75*wash);',
      'reflectance='+v+'(0.069,0.095,0.098);power=31.0;',
    '} else if(kind<3.5){',
      f+' tool=sin(87.0*(p.z-0.009*wash));',
      'base='+v+'(0.334,0.148,0.044)*(0.89+0.11*tool+0.05*fine);',
      'reflectance='+v+'(0.51,0.31,0.105);power=43.0;',
    '} else if(kind<5.5){',
      'base='+v+'(0.042,0.056,0.063)*(0.93+0.10*coarse+0.05*band);',
      'reflectance='+v+'(0.057,0.081,0.092);power=60.0;',
    '} else if(kind<6.5){',
      'base='+v+'(0.227,0.135,0.066)*(0.94+0.068*fine);',
      'reflectance='+v+'(0.32,0.21,0.105);power=47.0;',
    '} else {',
      f+' pad=length(p.xz*'+v2+'(0.69,1.35));',
      'base='+v+'(0.16,0.15,0.131)*(0.65+0.35*smoothstep(0.61,1.24,pad))*(0.945+0.08*coarse+0.025*fine);',
      'reflectance='+v+'(0.06,0.056,0.05);power=23.0;',
    '}',
    f+' hot=pow(max(0.0,dot(n,normalize(key+view))),power);',
    f+' window=pow(max(0.0,dot(n,normalize(view+'+v+'(-0.39,0.40,0.83)))),19.0);',
    f+' edge=pow(max(0.0,dot(n,normalize(rim+view))),power*0.7);',
    c+' light=base*('+v+'(0.22,0.246,0.270)+bloom*'+v+'(1.46,1.25,0.99)+rimLight*'+v+'(0.44,0.54,0.68)+soft*'+v+'(0.16,0.22,0.23));',
    c+' radiant=max('+v+'(0.0),light+reflectance*((hot+0.35*window)*'+v+'(1.0,0.91,0.74)+edge*'+v+'(0.43,0.53,0.61)));',
    c+' mapped=pow(radiant/(0.80+radiant),'+v+'(0.454545));',
    'if(wire>0.5&&kind<3.5){',
      c+' line=1.0-smoothstep('+v+'(0.0), max(pixelWidth*1.15,'+v+'(0.000001)), bary);',
      'return mix(mapped,'+v+'(0.93,0.89,0.72),max(line.x,max(line.y,line.z))*0.78);',
    '}',
    'return mapped;',
  ].join('\n');
}

const hash=(wgsl)=>(wgsl?'fn hash(p:vec3f)->f32{let q=fract(p*.1031);let f=q+dot(q,q.yzx+33.33);':
  'float hash(vec3 p){vec3 q=fract(p*.1031);vec3 f=q+dot(q,q.yzx+33.33);')+'return fract((f.x+f.y)*f.z);}';
function variation(wgsl) {
  const open=wgsl?'fn variation(p:vec3f)->f32{':'float variation(vec3 p){';
  const v=wgsl?'vec3f':'vec3', c=wgsl?'let':v;
  return open+c+' i=floor(p);'+c+' k=fract(p);'+c+' t=k*k*(3.0-2.0*k);'+
    'return mix(mix(mix(hash(i),hash(i+'+v+'(1,0,0)),t.x),mix(hash(i+'+v+'(0,1,0)),hash(i+'+v+'(1,1,0)),t.x),t.y),'+
    'mix(mix(hash(i+'+v+'(0,0,1)),hash(i+'+v+'(1,0,1)),t.x),mix(hash(i+'+v+'(0,1,1)),hash(i+'+v+'(1,1,1)),t.x),t.y),t.z);}';
}
const wgsl=[
  'struct Camera{matrix:mat4x4f,eye:vec4f};@group(0) @binding(0) var<uniform> g:Camera;',
  'struct Varying{@builtin(position) clip:vec4f,@location(0) world:vec3f,@location(1) n:vec3f,@location(2) bary:vec3f,@location(3) kind:f32};',
  '@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) kind:f32,@builtin(vertex_index) i:u32)->Varying{',
  'let c=i%3u;return Varying(g.matrix*vec4f(p,1),p,n,vec3f(select(0.0,1.0,c==0u),select(0.0,1.0,c==1u),select(0.0,1.0,c==2u)),kind);}',
  hash(true),variation(true),
  'fn shade(world:vec3f,normal:vec3f,kind:f32,bary:vec3f,pixelWidth:vec3f,eye:vec3f,wire:f32)->vec3f{',fragment(true),'}',
  '@fragment fn pixel(i:Varying)->@location(0) vec4f{return vec4f(shade(i.world,i.n,i.kind,i.bary,fwidth(i.bary),g.eye.xyz,g.eye.w),1);}',
].join('\n');

const glHead='#version 300 es\nprecision highp float;\n';
const glsl=[
  glHead+'layout(location=0) in vec3 p;layout(location=1) in vec3 n;layout(location=2) in float k;uniform mat4 camera;out vec3 world,normal,bary;out float kind;\n'+
  'void main(){int t=gl_VertexID%3;bary=vec3(float(t==0),float(t==1),float(t==2));world=p;normal=n;kind=k;gl_Position=camera*vec4(p,1);}',
  [glHead+'in vec3 world,normal,bary;in float kind;uniform vec3 eye;uniform float wire;out vec4 pixel;',
    hash(false),variation(false),'vec3 shade(vec3 pixelWidth){',fragment(false),'}','void main(){pixel=vec4(shade(fwidth(bary)),1);}'].join('\n'),
];

function native(context, section, camera) {
  const {device,format}=context;
  function buffer(values, usage) {
    const b=device.createBuffer({size:values.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(b,0,values);
    return b;
  }
  const bed=buffer(section,GPUBufferUsage.VERTEX);
  const uniform=buffer(camera,GPUBufferUsage.UNIFORM);
  const module=device.createShaderModule({code:wgsl});
  const pipeline=device.createRenderPipeline({
    layout:'auto',
    vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:stride*4,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},
      {shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:2,offset:24,format:'float32'},
    ]}]},
    fragment:{module,entryPoint:'pixel',targets:[{format}]},
    depthStencil:{format:context.descriptor.depthStencil.format,depthCompare:'greater',depthWriteEnabled:true},
  });
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
  let shape, vertexCount=0;
  return {
    key:device,
    upload(values) {
      shape?.destroy();
      shape=buffer(values,GPUBufferUsage.VERTEX);
      vertexCount=values.length/stride;
    },
    draw(c) {
      device.queue.writeBuffer(uniform,0,camera);
      const pass=c.encoder.beginRenderPass({
        colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],
        depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true},
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0,group);
      pass.setVertexBuffer(0,bed);
      pass.draw(section.length/stride);
      pass.setVertexBuffer(0,shape);
      pass.draw(vertexCount);
      pass.end();
    },
    dispose(){bed.destroy();uniform.destroy();shape?.destroy();},
  };
}

function compatibility({gl}, section, camera) {
  const program=gl.createProgram();
  for(const [stage,source] of [[gl.VERTEX_SHADER,glsl[0]],[gl.FRAGMENT_SHADER,glsl[1]]]){
    const shader=gl.createShader(stage);
    gl.shaderSource(shader,source);
    gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
      const reason=gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      gl.deleteProgram(program);
      throw new Error('Stone shader compilation failed. '+reason);
    }
    gl.attachShader(program,shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
    const reason=gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Stone shader linking failed. '+reason);
  }
  const matrix=gl.getUniformLocation(program,'camera');
  const eye=gl.getUniformLocation(program,'eye');
  const wire=gl.getUniformLocation(program,'wire');
  function attach() {
    const array=gl.createVertexArray(), buffer=gl.createBuffer();
    gl.bindVertexArray(array);
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    for(const [i,[size,offset]] of [[3,0],[3,12],[1,24]].entries()){
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i,size,gl.FLOAT,false,stride*4,offset);
    }
    gl.bindVertexArray(null);
    return {array,buffer};
  }
  const bed=attach(), shape=attach();
  gl.bindBuffer(gl.ARRAY_BUFFER,bed.buffer);
  gl.bufferData(gl.ARRAY_BUFFER,section,gl.STATIC_DRAW);
  let vertexCount=0;
  return {
    key:gl,
    upload(values) {
      gl.bindBuffer(gl.ARRAY_BUFFER,shape.buffer);
      gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);
      vertexCount=values.length/stride;
    },
    draw(){
      gl.useProgram(program);
      gl.uniformMatrix4fv(matrix,false,camera,0,16);
      gl.uniform3fv(eye,camera,16,3);
      gl.uniform1f(wire,camera[19]);
      for(const [draw,count] of [[bed,section.length/stride],[shape,vertexCount]]){
        gl.bindVertexArray(draw.array);
        gl.drawArrays(gl.TRIANGLES,0,count);
      }
      gl.bindVertexArray(null);
      gl.flush();
    },
    dispose(){
      gl.deleteProgram(program);
      for(const {array,buffer} of [bed,shape]){
        gl.deleteVertexArray(array);
        gl.deleteBuffer(buffer);
      }
    },
  };
}

export function mountStage(engine) {
  const stage=studioBed(), camera=new Float32Array(20);
  let renderer, subject, dirty=true, showWire=false;
  engine.scene.background='#19242c';
  engine.scene.frameGraph.add({name:'lapidary surface and triangle view',order:1,execute(context){
    const backend=context.backend==='webgpu'?native:compatibility;
    const key=context.device??context.gl;
    if(renderer?.key!==key) {
      renderer?.dispose();
      renderer=backend(context,stage,camera);
      dirty=true;
    }
    if(dirty){renderer.upload(subject);dirty=false;}
    camera.set(context.camera.matrix,0);
    camera.set(context.camera.position,16);
    camera[19]=showWire?1:0;
    renderer.draw(context);
  }});
  return {
    subject(next) {if(subject!==next){subject=next;dirty=true;}},
    wire(on){showWire=on;},
    dispose(){renderer?.dispose();},
  };
}
