import { GPURenderer } from '../../packages/core/dist/renderer.js';
import { GLRenderer } from '../../packages/webgl/dist/index.js';
import { Camera } from '../../packages/core/dist/camera.js';
import { FrameGraph } from '../../packages/core/dist/plugin.js';
import { box } from '../../packages/core/dist/geometry.js';

const lighting = {
  direction: new Float32Array([0, 1, 0, 1]),
  radiance: new Float32Array([1, 1, 1, 0.15]),
};

// Replace only the device boundary: real renderer code registers, uploads and draws a real indexed box.
function frames(renderer, canvas, batch) {
  const camera = new Camera();
  camera.update(canvas.width / canvas.height, renderer.backend === 'webgpu');
  renderer.add(batch.geometry, 1);
  return (draws) => {
    const graph = new FrameGraph();
    if (draws)
      graph.add({
        name: 'test-draws',
        order: -1,
        execute(context) {
          const draw = context.draw;
          context.draw = () => draws(draw, context);
        },
      });
    renderer.render(camera, lighting, [batch], graph, 0);
  };
}

export function gpuDrawHarness(t, samples = 1) {
  const saved = Object.fromEntries(
    ['GPUBufferUsage', 'GPUTextureUsage'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  globalThis.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, INDEX: 16, VERTEX: 32, STORAGE: 128 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16 };
  const passes = [],
    canvas = { width: 160, height: 120 },
    pipeline = { getBindGroupLayout: () => ({}) },
    device = {
      features: new Set(),
      limits: { maxBufferSize: 1 << 24 },
      lost: new Promise(() => {}),
      addEventListener() {},
      destroy() {},
      queue: { writeBuffer() {}, submit() {} },
      createBuffer: (descriptor) => ({ ...descriptor, destroy() {} }),
      createBindGroup: () => ({}),
      createTexture(descriptor) {
        const texture = {
          ...descriptor,
          width: descriptor.size[0],
          height: descriptor.size[1],
          createView: () => ({ texture }),
          destroy() {},
        };
        return texture;
      },
      createCommandEncoder: () => ({
        finish: () => ({}),
        beginRenderPass(descriptor) {
          const record = {
            descriptor: {
              ...descriptor,
              colorAttachments: [...descriptor.colorAttachments].map((attachment) => ({ ...attachment })),
              depthStencilAttachment: descriptor.depthStencilAttachment && { ...descriptor.depthStencilAttachment },
            },
            commands: [],
          };
          passes.push(record);
          return {
            setViewport: (...args) => record.commands.push(['viewport', ...args]),
            setScissorRect: (...args) => record.commands.push(['scissor', ...args]),
            setPipeline: () => record.commands.push(['pipeline']),
            setBindGroup() {},
            setVertexBuffer() {},
            setIndexBuffer() {},
            drawIndexed: (...args) => record.commands.push(['draw', ...args]),
            end: () => record.commands.push(['end']),
          };
        },
      }),
    },
    renderer = new GPURenderer(
      canvas,
      device,
      { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({ canvas: true }) }) },
      'bgra8unorm',
      pipeline,
      { multisample: { count: samples }, depthStencil: { format: 'depth32float' } },
      pipeline,
    ),
    geometry = box(),
    batch = { geometry, instances: new Float32Array(24), count: 1, mask: 1 };
  t.after(() => {
    renderer.dispose();
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  return {
    canvas,
    passes,
    frame: frames(renderer, canvas, batch),
    draws: () => passes.filter((pass) => pass.commands.some(([name]) => name === 'draw')),
  };
}

export function glDrawHarness(t) {
  const trace = [],
    draws = [],
    clears = [],
    enabled = new Set(),
    canvas = { width: 160, height: 120 },
    state = { viewport: [0, 0, 160, 120], scissor: [0, 0, 160, 120] },
    gl = {
      VERTEX_SHADER: 35633,
      FRAGMENT_SHADER: 35632,
      COMPILE_STATUS: 35713,
      LINK_STATUS: 35714,
      ARRAY_BUFFER: 34962,
      ELEMENT_ARRAY_BUFFER: 34963,
      STATIC_DRAW: 35044,
      DYNAMIC_DRAW: 35048,
      FLOAT: 5126,
      NO_ERROR: 0,
      DEPTH_TEST: 2929,
      CULL_FACE: 2884,
      SCISSOR_TEST: 3089,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
      TRIANGLES: 4,
      UNSIGNED_INT: 5125,
      drawingBufferWidth: 160,
      drawingBufferHeight: 120,
      createProgram: () => ({}),
      createShader: () => ({}),
      shaderSource() {},
      compileShader() {},
      getShaderParameter: () => true,
      attachShader() {},
      linkProgram() {},
      getProgramParameter: () => true,
      deleteProgram() {},
      deleteShader() {},
      getUniformLocation: (_program, name) => name,
      createVertexArray: () => ({}),
      bindVertexArray() {},
      deleteVertexArray() {},
      createBuffer: () => ({}),
      bindBuffer() {},
      bufferData() {},
      deleteBuffer() {},
      enableVertexAttribArray() {},
      vertexAttribPointer() {},
      vertexAttribDivisor() {},
      getError: () => 0,
      isContextLost: () => false,
      viewport(...args) {
        state.viewport = args;
        trace.push(['viewport', ...args]);
      },
      scissor(...args) {
        state.scissor = args;
        trace.push(['scissor', ...args]);
      },
      enable(capability) {
        enabled.add(capability);
        trace.push(['enable', capability]);
      },
      disable(capability) {
        enabled.delete(capability);
        trace.push(['disable', capability]);
      },
      clearColor() {},
      clear(mask) {
        clears.push({ mask, scissorEnabled: enabled.has(gl.SCISSOR_TEST) });
        trace.push(['clear', mask]);
      },
      useProgram() {},
      uniformMatrix4fv() {},
      uniform3f() {},
      uniform3fv() {},
      uniform4fv() {},
      bufferSubData() {},
      drawElementsInstanced(...args) {
        draws.push({
          args,
          viewport: [...state.viewport],
          scissor: [...state.scissor],
          scissorEnabled: enabled.has(gl.SCISSOR_TEST),
        });
        trace.push(['draw', ...args]);
      },
    };
  canvas.getContext = (kind) => (kind === 'webgl2' ? gl : null);
  const renderer = new GLRenderer(canvas),
    geometry = box(),
    batch = { geometry, instances: new Float32Array(24), count: 1 };
  t.after(() => renderer.dispose());
  return { canvas, gl, trace, draws, clears, frame: frames(renderer, canvas, batch) };
}
