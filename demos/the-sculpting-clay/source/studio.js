import {mapHeight, mapWidth} from './model.mjs';

const stride = 13;

function uploadSurface(surface) {
  const count = surface.positions.length / 3;
  const vertices = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    vertices.set(surface.positions.slice(i * 3, i * 3 + 3), i * stride);
    vertices.set(surface.normals.slice(i * 3, i * 3 + 3), i * stride + 3);
    vertices.set(surface.tangents.slice(i * 4, i * 4 + 4), i * stride + 6);
    vertices.set(surface.uvs.slice(i * 2, i * 2 + 2), i * stride + 10);
    vertices[i * stride + 12] = 1;
  }
  return {vertices, indices: Uint32Array.from(surface.indices)};
}

function stageGeometry() {
  const vertices = [], indices = [];
  const vertex = (point, normal, material) => {
    vertices.push(...point, ...normal, 0, 0, 0, 0, 0, 0, material);
  };
  function lathe(profile, kind, transform) {
    const start = vertices.length / stride;
    const sides = transform ? 32 : 108;
    for (let i = 0; i < profile.length; i++) {
      const [r, y] = profile[i];
      const before = profile[Math.max(i - 1, 0)], after = profile[Math.min(i + 1, profile.length - 1)];
      const dr = after[0] - before[0], dy = after[1] - before[1];
      const length = Math.hypot(dr, dy);
      for (let j = 0; j <= sides; j++) {
        const angle = 2 * Math.PI * j / sides;
        const x = Math.cos(angle), z = Math.sin(angle);
        const point = [r * x, y, r * z];
        const normal = [x * dy / length, -dr / length, z * dy / length];
        if (transform) vertex(transform(point), transform(normal, true), kind);
        else vertex(point, normal, kind);
        if (i && j) {
          const c = start + i * (sides + 1) + j, a = c - sides - 2;
          indices.push(a, c, a + 1, a, c - 1, c);
        }
      }
    }
  }
  lathe([[0,0],[3.0,0],[5.0,0],[6.1,0],[6.7,.06],[7.2,.23],[7.62,.50],
    [7.98,.86],[8.25,1.28],[8.43,1.75],[8.5,2.26],[8.52,3.1],[8.52,5],[8.52,10]], 4);
  lathe([[0,.012],[1.13,.012],[1.22,.02],[1.26,.045],[1.27,.067],[1.27,.112],
    [1.24,.15],[1.18,.17],[.80,.197],[.76,.203],[0,.203]], 2);
  lathe([[.78,.136],[.79,.148],[.79,.207],[.82,.224],[.82,.243]], 5);
  lathe([[0,.222],[1.20,.222],[1.33,.233],[1.37,.252],[1.389,.278],[1.393,.297],
    [1.39,.317],[1.371,.339],[1.34,.354],[1.31,.360],[1.278,.362],[1.24,.363],[0,.363]], 3);
  lathe([[1.384,.269],[1.389,.275],[1.391,.283],[1.390,.288]], 5);
  lathe([[1.262,.072],[1.271,.075],[1.273,.080],[1.273,.093],[1.271,.097]], 5);
  // Hand tools rest beside the wheel. Local Y follows the tool along the worktop.
  const tool = ([ox, oy, oz], angle) => ([x, y, z], normal = false) => {
    const sin=Math.sin(angle), cos=Math.cos(angle);
    return [(normal?0:ox)+sin*y+cos*z,(normal?0:oy)+x,(normal?0:oz)+cos*y-sin*z];
  };
  const modelingTool = tool([-1.43,.044,.55],3.47);
  lathe([[0,0],[.029,.025],[.041,.057],[.044,.115],[.041,.26],[.039,.39],
    [.034,.54],[.030,.61],[0,.635]], 6, modelingTool);
  lathe([[.032,.538],[.038,.55],[.038,.597],[.033,.621],[.026,.632]],5,modelingTool);
  lathe([[.027,.616],[.023,.65],[.019,.71],[.013,.80],[.006,.865],[0,.90]], 5, modelingTool);
  const cleanupTool = tool([1.42,.035,.63],2.94);
  lathe([[0,0],[.028,.028],[.034,.083],[.035,.31],[.030,.47],[.022,.52],[0,.53]], 6, cleanupTool);
  lathe([[.024,.50],[.028,.52],[.026,.58],[.014,.61]], 5, cleanupTool);
  lathe([[.015,.60],[.012,.66],[.009,.72],[.004,.80],[0,.818]], 2, cleanupTool);
  return {vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices)};
}

function paint(wgsl) {
  const v = wgsl ? 'vec3f' : 'vec3';
  const v2 = wgsl ? 'vec2f' : 'vec2';
  const scal = wgsl ? 'let' : 'float';
  const vec = wgsl ? 'let' : v;
  const mut = (type, name, value) => (wgsl ? 'var ' : type + ' ') + name + '=' + value + ';';
  const vec2 = wgsl ? 'let' : v2;
  const ramp = wgsl ? 'atan2(p.z,p.x)' : 'atan(p.z,p.x)';
  const fract3 = (x,y,z) => v + '(' + x + ',' + y + ',' + z + ')';
  const normal = wgsl ? 'textureSampleLevel(map, mapSampler, uv, 0.0).xyz' : 'texture(normalMap, uv).xyz';
  return [
    mut(v, 'n', 'normalize(n0)'),
    scal+' radius=length(p.xz);',
    vec+' view=normalize(eye-p);',
    vec+' key=normalize('+v+'(-0.86,0.48,0.17));',
    vec+' rim=normalize('+v+'(0.51,0.36,-0.78));',
    vec+' fill=normalize('+v+'(0.73,0.22,0.58));',
    vec2+' xy=p.xz;',
    scal+' kind=material;',
    'if(kind > 3.5 && kind < 4.5){',
      vec2+' dx=xy-'+v2+'(-1.8,-1.9);',
      scal+' wash=exp(-dot(dx,dx)*0.055);',
      vec2+' shade=xy-'+v2+'(0.41,-0.19);',
      scal+' footprint=smoothstep(1.08,2.08,length(shade*'+v2+'(0.86,1.0)));',
      scal+' seam=0.0015*sin(2.1*p.x+p.z)*sin(1.52*p.z);',
      scal+' grain=0.00065*(noise(p*121.0)-0.5);',
      vec+' floor='+v+'(0.015,0.023,0.024)+wash*'+v+'(0.058,0.074,0.076);',
      'return pow(max('+v+'(0.0001),floor*(0.17+0.83*footprint)+seam+grain),'+v+'(0.454545));',
    '}',
    'if(kind>0.5 && kind<1.5 && mapped>0.5){',
      vec+' t=normalize(tangent.xyz-n*dot(n,tangent.xyz));',
      vec+' b=cross(n,t)*tangent.w;',
      vec+' texel='+normal+'*2.0-1.0;',
      'n=normalize(t*texel.x+b*texel.y+n*texel.z);',
    '}',
    scal+' fleck=noise(p*151.0);',
    scal+' fine=noise(p*275.0);',
    scal+' grain=sin(p.x*45.0+p.y*55.0+3.7*sin(p.z*23.0+p.y*12.0));',
    scal+' mottles=noise(p*7.8)*0.64+noise(p*25.0)*0.36;',
    mut(v,'base',v+'(0.448,0.107,0.044)'),
    mut(v,'gloss',v+'(0.112,0.065,0.040)'),
    mut('float','power','35.0'),
    'if(kind<1.5){',
      'base=base*(0.83+0.25*mottles+0.020*grain+0.028*(fine-0.5));',
      'base-=smoothstep(0.80,0.99,fleck)*'+v+'(0.040,0.021,0.011);',
      'base+=smoothstep(0.81,0.99,fine)*'+v+'(0.049,0.027,0.016);',
      'base*=0.27+0.73*smoothstep(0.36,0.64,p.y);',
    '} else if(kind<2.5){',
      'base='+v+'(0.031,0.039,0.041)*(0.92+0.14*fleck);',
      'power=55.0; gloss='+v+'(0.12,0.13,0.14);',
    '} else if(kind<3.5){',
      scal+' turning=sin(radius*162.0+1.6*noise(p*14.0));',
      scal+' ticks=1.0-smoothstep(0.034,0.11,abs(sin(('+ramp+')*36.0)));',
      scal+' marks=ticks*smoothstep(1.19,1.215,radius)*(1.0-smoothstep(1.239,1.256,radius))*smoothstep(0.345,0.358,p.y);',
      scal+' concentric=1.0-smoothstep(0.001,0.0035,min(abs(radius-1.175),abs(radius-1.266)));',
      scal+' residue=(1.0-smoothstep(0.22,0.65,radius))*mottles*mottles;',
      'base='+v+'(0.064,0.083,0.086)*(0.91+0.055*turning+0.17*mottles)+marks*'+v+'(0.21,0.15,0.091)+concentric*0.018+residue*'+v+'(0.110,0.049,0.021);',
      'base*=0.22+0.78*smoothstep(0.14,0.45,radius);',
      'power=74.0; gloss='+v+'(0.13,0.15,0.16);',
    '} else if(kind<5.5){',
      'base='+v+'(0.16,0.098,0.053)*(0.84+0.15*mottles+0.076*grain);',
      'power=62.0; gloss='+v+'(0.21,0.14,0.077);',
    '} else {',
      scal+' fiber=sin(125.0*p.y+22.0*p.x+4.0*sin(p.z*6.0));',
      'base='+v+'(0.25,0.093,0.035)*(0.93+0.15*mottles+0.08*fiber);',
      'power=47.0; gloss='+v+'(0.14,0.085,0.051);',
    '}',
    scal+' sun=max(0.0,dot(n,key));',
    scal+' second=max(0.0,dot(n,fill));',
    scal+' edging=max(0.0,dot(n,rim));',
    scal+' spec=pow(max(0.0,dot(n,normalize(key+view))),power);',
    scal+' soft=pow(max(0.0,dot(n,normalize(rim+view))),power*0.62);',
    vec+' diffuse=base*('+v+'(0.112,0.142,0.163)+sun*'+v+'(1.72,1.23,0.87)+second*'+v+'(0.12,0.165,0.18)+edging*'+v+'(0.28,0.38,0.45));',
    vec+' reflected=gloss*spec*'+v+'(1.0,0.88,0.71)+soft*gloss*'+v+'(0.44,0.63,0.66);',
    vec+' radiance=max('+fract3('0.0','0.0','0.0')+',diffuse+reflected);',
    'return pow(radiance/(0.89+radiance),'+v+'(0.454545));',
  ].join('\n');
}

function noise(wgsl) {
  return (wgsl ? 'fn noise(p:vec3f)->f32{let q=fract(p*0.1031);let f=q+dot(q,q.yzx+33.33);'
    : 'float noise(vec3 p){vec3 q=fract(p*0.1031);vec3 f=q+dot(q,q.yzx+33.33);')+
    'return fract((f.x+f.y)*f.z);}';
}

const gpuCode = [
  'struct Camera{matrix:mat4x4f,eye:vec4f}; @group(0) @binding(0) var<uniform> camera:Camera;',
  '@group(1) @binding(0) var<uniform> state:vec4f; @group(1) @binding(1) var map:texture_2d<f32>; @group(1) @binding(2) var mapSampler:sampler;',
  'struct Surface{@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) t:vec4f,@location(3) uv:vec2f,@location(4) material:f32};',
  '@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) tangent:vec4f,@location(3) uv:vec2f,@location(4) material:f32)->Surface{',
  'return Surface(camera.matrix*vec4f(p,1),p,n,tangent,uv,material);}',
  noise(true),
  'fn shade(p:vec3f,n0:vec3f,tangent:vec4f,uv:vec2f,material:f32,eye:vec3f,mapped:f32)->vec3f{',
  paint(true), '}',
  '@fragment fn fragment(i:Surface)->@location(0) vec4f{return vec4f(shade(i.p,i.n,i.t,i.uv,i.material,camera.eye.xyz,state.x),1);}',
].join('\n');

const glSource = '#version 300 es\nprecision highp float;\n';
const glCode = [
  glSource + 'layout(location=0) in vec3 p; layout(location=1) in vec3 n; layout(location=2) in vec4 tangent; layout(location=3) in vec2 texcoord; layout(location=4) in float kind;',
  'uniform mat4 matrix; out vec3 world,normal; out vec4 frame; out vec2 uv; out float material;',
  'void main(){world=p;normal=n;frame=tangent;uv=texcoord;material=kind;gl_Position=matrix*vec4(p,1);}',
].join('\n');
const glPaint = [
  glSource + 'uniform vec3 eye;uniform float mapped;uniform sampler2D normalMap;in vec3 world,normal;in vec4 frame;in vec2 uv;in float material;out vec4 pixel;',
  noise(false), 'vec3 shade(vec3 p,vec3 n0,vec4 tangent){', paint(false), '}',
  'void main(){pixel=vec4(shade(world,normal,frame),1);}',
].join('\n');

function webgpu(context, parts, camera) {
  const {device, format, descriptor} = context;
  function buffer(data, usage) {
    const result = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(result, 0, data);
    return result;
  }
  const code = device.createShaderModule({code: gpuCode});
  const graphics = device.createRenderPipeline({
    layout:'auto',
    vertex:{module:code,entryPoint:'vertex',buffers:[{arrayStride:stride*4,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},
      {shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:2,offset:24,format:'float32x4'},
      {shaderLocation:3,offset:40,format:'float32x2'},
      {shaderLocation:4,offset:48,format:'float32'},
    ]}]},
    fragment:{module:code,entryPoint:'fragment',targets:[{format}]},
    depthStencil:{format:descriptor.depthStencil.format,depthWriteEnabled:true,depthCompare:'greater'},
  });
  const uniform = buffer(camera, GPUBufferUsage.UNIFORM);
  const view = device.createBindGroup({layout:graphics.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
  const mapTexture = device.createTexture({size:[mapWidth,mapHeight,1],format:'rgba8unorm',usage:
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  const sampler = device.createSampler({addressModeU:'repeat',addressModeV:'clamp-to-edge',minFilter:'linear',magFilter:'linear'});
  const states = [0,1].map(value => {
    const usage = buffer(Float32Array.of(value,0,0,0), GPUBufferUsage.UNIFORM);
    const group = device.createBindGroup({layout:graphics.getBindGroupLayout(1),entries:[
      {binding:0,resource:{buffer:usage}},{binding:1,resource:mapTexture.createView()},{binding:2,resource:sampler},
    ]});
    return {usage,group};
  });
  const draws = parts.map(part => ({vertex:buffer(part.vertices,GPUBufferUsage.VERTEX),
    index:buffer(part.indices,GPUBufferUsage.INDEX),count:part.indices.length}));
  const upload = (slice, offset) => device.queue.writeBuffer(draws[1].vertex, offset*stride*4, slice);
  return {
    key:device, upload,
    texture(bytes) {
      device.queue.writeTexture({texture:mapTexture},bytes,{bytesPerRow:mapWidth*4,rowsPerImage:mapHeight},[mapWidth,mapHeight,1]);
    },
    draw(c, mode) {
      device.queue.writeBuffer(uniform,0,camera);
      const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],
        depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true}});
      pass.setPipeline(graphics);
      pass.setBindGroup(0,view);
      for (const i of [0,mode==='high'?1:2]) {
        const draw=draws[i];
        pass.setBindGroup(1,states[i===2&&mode==='baked'?1:0].group);
        pass.setVertexBuffer(0,draw.vertex);
        pass.setIndexBuffer(draw.index,'uint32');
        pass.drawIndexed(draw.count);
      }
      pass.end();
    },
    dispose() {
      uniform.destroy();
      mapTexture.destroy();
      for(const {usage} of states) usage.destroy();
      for(const {vertex,index} of draws){vertex.destroy();index.destroy();}
    },
  };
}

function webgl2({gl}, parts, camera) {
  const program = gl.createProgram();
  for (const [type,source] of [[gl.VERTEX_SHADER,glCode],[gl.FRAGMENT_SHADER,glPaint]]) {
    const shader=gl.createShader(type);
    gl.shaderSource(shader,source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {
      const reason=gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      gl.deleteProgram(program);
      throw new Error('Clay shader: '+reason);
    }
    gl.attachShader(program,shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)) {
    const reason=gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Clay studio material: '+reason);
  }
  const uniforms=Object.fromEntries(['matrix','eye','mapped','normalMap'].map(name=>[name,gl.getUniformLocation(program,name)]));
  const draws=parts.map(part=>{
    const array=gl.createVertexArray(), vertex=gl.createBuffer(), index=gl.createBuffer();
    gl.bindVertexArray(array);
    gl.bindBuffer(gl.ARRAY_BUFFER,vertex);
    gl.bufferData(gl.ARRAY_BUFFER,part.vertices,gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,part.indices,gl.STATIC_DRAW);
    for(const [i,[size,offset]] of [[3,0],[3,12],[4,24],[2,40],[1,48]].entries()){
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i,size,gl.FLOAT,false,stride*4,offset);
    }
    return {array,vertex,index,count:part.indices.length};
  });
  gl.bindVertexArray(null);
  const texture=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,mapWidth,mapHeight,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  return {
    key:gl,
    upload(slice,offset) {
      gl.bindBuffer(gl.ARRAY_BUFFER,draws[1].vertex);
      gl.bufferSubData(gl.ARRAY_BUFFER,offset*stride*4,slice);
    },
    texture(bytes) {
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,mapWidth,mapHeight,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    },
    draw(c,mode) {
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.matrix,false,camera,0,16);
      gl.uniform3fv(uniforms.eye,camera,16,3);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.uniform1i(uniforms.normalMap,0);
      for(const i of [0,mode==='high'?1:2]) {
        const draw=draws[i];
        gl.uniform1f(uniforms.mapped,i===2&&mode==='baked'?1:0);
        gl.bindVertexArray(draw.array);
        gl.drawElements(gl.TRIANGLES,draw.count,gl.UNSIGNED_INT,0);
      }
      gl.bindVertexArray(null);
      gl.flush();
    },
    dispose() {
      gl.deleteProgram(program);
      gl.deleteTexture(texture);
      for(const {array,vertex,index} of draws){gl.deleteVertexArray(array);gl.deleteBuffer(vertex);gl.deleteBuffer(index);}
    },
  };
}

export function installStudio(engine, drawing, low) {
  const clay = {vertices:new Float32Array(drawing.vertices.length/20*stride),indices:drawing.indices};
  const parts = [stageGeometry(),clay,uploadSurface(low)];
  const camera = new Float32Array(20);
  let renderer, bytes, textureDirty = false, mode = 'high';
  let ranges = [{start:0,count:drawing.vertices.length/20}];
  function update() {
    for(const {start,count} of ranges) {
      for(let i=start;i<start+count;i++) {
        const from=i*20, to=i*stride;
        clay.vertices.set(drawing.vertices.subarray(from,from+3),to);
        clay.vertices.set(drawing.vertices.subarray(from+4,from+7),to+3);
        clay.vertices[to+12]=1;
      }
    }
  }
  engine.scene.background='#303736';
  engine.scene.frameGraph.add({name:'clay studio and transferred normals',order:1,execute(context){
    update();
    const key=context.backend==='webgpu'?context.device:context.gl;
    if(renderer?.key!==key) {
      renderer?.dispose();
      renderer=(context.backend==='webgpu'?webgpu:webgl2)(context,parts,camera);
      textureDirty=!!bytes;
    } else {
      for(const {start,count} of ranges) renderer.upload(clay.vertices.subarray(start*stride,(start+count)*stride),start);
    }
    ranges=[];
    if(textureDirty){renderer.texture(bytes);textureDirty=false;}
    camera.set(context.camera.matrix,0);
    camera.set(context.camera.position,16);
    renderer.draw(context,mode);
  }});
  return {
    update(next){ranges.push(...next);},
    view(next){mode=next;},
    map(next){bytes=next;textureDirty=true;},
    dispose(){renderer?.dispose();},
  };
}
