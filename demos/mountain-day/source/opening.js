import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { extent, loadHeight, openingColumns, origin } from './relief.mjs';
import { cameraBasis, setDayView } from './view.js';
import { skyGLSL, skyWGSL, terrainGLSL, terrainWGSL } from './opening-shaders.js';

const width = openingColumns;
const stepX = extent[0] / (width - 1);
const stepZ = extent[1] / (width - 1);

function relief(heights) {
  const vertices = new Float32Array(heights.length * 6);
  const indices = new Uint16Array((width - 1) ** 2 * 6);
  let write = 0;
  for (let z = 0, i = 0; z < width; z++) {
    for (let x = 0; x < width; x++, i++) {
      const left = x > 0 ? i - 1 : i;
      const right = x < width - 1 ? i + 1 : i;
      const front = z > 0 ? i - width : i;
      const back = z < width - 1 ? i + width : i;
      const offset = i * 6;
      vertices[offset] = origin[0] + x * stepX;
      vertices[offset + 1] = heights[i];
      vertices[offset + 2] = origin[1] + z * stepZ;
      vertices[offset + 3] = (heights[left] - heights[right]) / stepX;
      vertices[offset + 4] = 2;
      vertices[offset + 5] = (heights[front] - heights[back]) / stepZ;
      if (x === width - 1 || z === width - 1) continue;
      indices[write++] = i;
      indices[write++] = i + width;
      indices[write++] = i + 1;
      indices[write++] = i + 1;
      indices[write++] = i + width;
      indices[write++] = i + width + 1;
    }
  }
  return {vertices,indices};
}

function gpuRenderer(context, geometry, frame) {
  const {device,format} = context;
  const vertices = device.createBuffer({size:geometry.vertices.byteLength,
    usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  const indices = device.createBuffer({size:geometry.indices.byteLength,
    usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
  const uniforms = device.createBuffer({size:frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(vertices,0,geometry.vertices);
  device.queue.writeBuffer(indices,0,geometry.indices);

  function pipeline(code, terrain) {
    const module = device.createShaderModule({code});
    const vertex = {module,entryPoint:'vertex'};
    const descriptor = {vertex,layout:'auto',fragment:{module,entryPoint:'fragment',targets:[{format}]}};
    if (terrain) {
      vertex.buffers = [{arrayStride:24,attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      ]}];
      descriptor.depthStencil = {format:context.descriptor.depthStencil.format,depthWriteEnabled:true,depthCompare:'greater'};
    }
    const pipe = device.createRenderPipeline(descriptor);
    const bind = device.createBindGroup({layout:pipe.getBindGroupLayout(0),
      entries:[{binding:0,resource:{buffer:uniforms}}]});
    return {pipe,bind};
  }
  const sky = pipeline(skyWGSL,false);
  const land = pipeline(terrainWGSL,true);
  return {
    device,
    draw(c) {
      device.queue.writeBuffer(uniforms,0,frame);
      const color = [{view:c.color,loadOp:'load',storeOp:'store'}];
      const skyPass = c.encoder.beginRenderPass({colorAttachments:color});
      skyPass.setPipeline(sky.pipe);
      skyPass.setBindGroup(0,sky.bind);
      skyPass.draw(3);
      skyPass.end();
      const terrainPass = c.encoder.beginRenderPass({colorAttachments:color,
        depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true}});
      terrainPass.setPipeline(land.pipe);
      terrainPass.setBindGroup(0,land.bind);
      terrainPass.setVertexBuffer(0,vertices);
      terrainPass.setIndexBuffer(indices,'uint16');
      terrainPass.drawIndexed(geometry.indices.length);
      terrainPass.end();
    },
    dispose() {
      vertices.destroy();
      indices.destroy();
      uniforms.destroy();
    },
  };
}

function webglProgram(gl, source) {
  const program = gl.createProgram();
  for (const [i,type] of [gl.VERTEX_SHADER,gl.FRAGMENT_SHADER].entries()) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader,source[i]);
    gl.compileShader(shader);
    gl.attachShader(program,shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Silverpass opening shader failed: ' + detail);
  }
  return program;
}

function webglRenderer({gl}, geometry, frame) {
  const sky = webglProgram(gl,skyGLSL);
  const land = webglProgram(gl,terrainGLSL);
  const skyVao = gl.createVertexArray();
  const landVao = gl.createVertexArray();
  const vertices = gl.createBuffer(), indices = gl.createBuffer();
  gl.bindVertexArray(landVao);
  gl.bindBuffer(gl.ARRAY_BUFFER,vertices);
  gl.bufferData(gl.ARRAY_BUFFER,geometry.vertices,gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,geometry.indices,gl.STATIC_DRAW);
  for (const i of [0,1]) {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i,3,gl.FLOAT,false,24,i*12);
  }
  gl.bindVertexArray(null);
  const get = (program,names) => Object.fromEntries(names.map(name => [name,gl.getUniformLocation(program,name)]));
  const skyUniforms = get(sky,['forward','right','up','sun','eye','time']);
  const landUniforms = get(land,['transform','eye','sun']);
  return {
    device:gl,
    draw() {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(sky);
      gl.bindVertexArray(skyVao);
      gl.uniform4fv(skyUniforms.sun,frame,20,4);
      gl.uniform3fv(skyUniforms.eye,frame,16,3);
      gl.uniform1f(skyUniforms.time,frame[35]);
      gl.uniform4fv(skyUniforms.forward,frame,24,4);
      gl.uniform4fv(skyUniforms.right,frame,28,4);
      gl.uniform4fv(skyUniforms.up,frame,32,4);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(land);
      gl.bindVertexArray(landVao);
      gl.uniformMatrix4fv(landUniforms.transform,false,frame,0,16);
      gl.uniform3fv(landUniforms.eye,frame,16,3);
      gl.uniform4fv(landUniforms.sun,frame,20,4);
      gl.drawElements(gl.TRIANGLES,geometry.indices.length,gl.UNSIGNED_SHORT,0);
      gl.bindVertexArray(null);
      gl.flush();
    },
    dispose() {
      gl.useProgram(null);
      gl.deleteProgram(sky);
      gl.deleteProgram(land);
      gl.deleteVertexArray(skyVao);
      gl.deleteVertexArray(landVao);
      gl.deleteBuffer(vertices);
      gl.deleteBuffer(indices);
    },
  };
}

export async function openLandscape(canvas, forced, signal) {
  const heights = loadHeight(new URL('./silverpass-opening.height',import.meta.url),width,signal)
    .then(samples => ({samples}),error => ({error}));
  const engine = await autoEngine(canvas, () => {}, {
    backend:forced?'webgl2':undefined,signal,exactSize:true,antialias:false,startupTimeout:8500,
    camera:{near:20,far:84000,fov:38},
  });
  let renderer, solar, second;
  const data = new Float32Array(36);
  try {
    const {samples,error} = await heights;
    if (error) throw error;
    signal.throwIfAborted();
    const geometry = relief(samples);
    engine.scene.frameGraph.add({
      name:'silverpass-opening',
      order:1,
      execute(context) {
        const device = context.backend === 'webgpu' ? context.device : context.gl;
        if (renderer?.device !== device) {
          renderer?.dispose();
          renderer = (context.backend === 'webgpu' ? gpuRenderer : webglRenderer)(context,geometry,data);
        }
        const {matrix,position,fov} = engine.camera;
        const {forward,right,up} = cameraBasis(engine.camera);
        const tangent = Math.tan(fov * Math.PI / 360);
        data.set(matrix);
        data.set(position,16);
        data.set(solar,20);
        data.set([...forward,tangent*context.width/context.height],24);
        data.set([...right,tangent],28);
        data.set([...up,second],32);
        renderer.draw(context);
      },
    });
    return {
      engine,
      async render(state,frame) {
        if (canvas.width !== frame.width) canvas.width = frame.width;
        if (canvas.height !== frame.height) canvas.height = frame.height;
        engine.camera.fov = frame.fov;
        solar = [...state.sun,state.clouds];
        second = frame.second;
        setDayView(engine,state);
        engine.render();
        await engine.gpu?.queue.onSubmittedWorkDone();
      },
      dispose() {
        renderer?.dispose();
        engine.dispose();
      },
    };
  } catch (error) {
    engine.dispose();
    throw error;
  }
}