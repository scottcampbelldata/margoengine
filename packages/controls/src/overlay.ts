import type {PassContext} from '@margoengine/core/extension';
import type {Prim} from './gizmo.js';

declare const GPUBufferUsage: {VERTEX: number; COPY_DST: number};

const FLOATS = 8; // clip xyzw + rgba

const clip = (m: ArrayLike<number>, p: readonly number[]): [number, number, number, number] => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
];

/**
 * Converts world-space primitives to clip-space triangles (thick lines become screen-space quads),
 * sorted back to front so the overlay needs no depth buffer. `pixelRatio` maps CSS pixels to target pixels.
 */
export function tessellate(prims: Prim[], matrix: ArrayLike<number>, width: number, height: number, pixelRatio = 1): Float32Array {
  const triangles: Array<{depth: number; data: number[]}> = [];
  for (const prim of prims) {
    if (prim.kind === 'triangles') {
      const c = prim.color;
      for (let i = 0; i + 2 < prim.points.length; i += 3) {
        const a = clip(matrix, prim.points[i]), b = clip(matrix, prim.points[i + 1]), d = clip(matrix, prim.points[i + 2]);
        if (a[3] <= 0 && b[3] <= 0 && d[3] <= 0) continue;
        triangles.push({depth: a[3] + b[3] + d[3], data: [...a, ...c, ...b, ...c, ...d, ...c]});
      }
    } else {
      const half = prim.width * pixelRatio / 2;
      for (let i = 0, segment = 0; i + 1 < prim.points.length; i += 2, segment++) {
        const a = clip(matrix, prim.points[i]), b = clip(matrix, prim.points[i + 1]), c = prim.colors[Math.min(segment, prim.colors.length - 1)];
        if (a[3] <= 1e-6 || b[3] <= 1e-6) continue;
        // Offset perpendicular to the segment in pixels, then back to clip space per endpoint (perspective-correct).
        const ax = a[0] / a[3] * width / 2, ay = a[1] / a[3] * height / 2, bx = b[0] / b[3] * width / 2, by = b[1] / b[3] * height / 2;
        let nx = ay - by, ny = bx - ax; const l = Math.hypot(nx, ny);
        if (!l) continue;
        nx = nx / l * half; ny = ny / l * half;
        const ox = nx * 2 / width, oy = ny * 2 / height;
        const v = (p: number[], s: number) => [p[0] + ox * s * p[3], p[1] + oy * s * p[3], p[2], p[3], ...c];
        const a0 = v(a, 1), a1 = v(a, -1), b0 = v(b, 1), b1 = v(b, -1);
        const depth = a[3] + b[3] + (a[3] + b[3]) / 2;
        triangles.push({depth, data: [...a0, ...a1, ...b0]}, {depth, data: [...b0, ...a1, ...b1]});
      }
    }
  }
  triangles.sort((p, q) => q.depth - p.depth);
  const out = new Float32Array(triangles.length * 3 * FLOATS);
  triangles.forEach((t, i) => out.set(t.data, i * 3 * FLOATS));
  return out;
}

const WGSL = `struct O {@builtin(position) p: vec4f, @location(0) c: vec4f};
@vertex fn vs(@location(0) p: vec4f, @location(1) c: vec4f) -> O {return O(p, c);}
@fragment fn fs(i: O) -> @location(0) vec4f {return i.c;}`;
const VERT = `#version 300 es
layout(location=0) in vec4 p; layout(location=1) in vec4 c; out vec4 v; void main(){v=c;gl_Position=p;}`;
const FRAG = `#version 300 es
precision mediump float; in vec4 v; out vec4 o; void main(){o=v;}`;

/** Draws pre-tessellated clip-space triangles on top of the frame, on WebGPU or WebGL2. */
export class OverlayRenderer {
  private device: GPUDevice | null = null;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private buffer: GPUBuffer | null = null;
  private capacity = 0;
  private readonly attachment: GPURenderPassColorAttachment = {view: undefined as unknown as GPUTextureView, loadOp: 'load', storeOp: 'store'};
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private glBuffer: WebGLBuffer | null = null;
  /** Number of triangles drawn in the last frame (for tests). */
  lastTriangles = 0;

  draw(ctx: PassContext, vertices: Float32Array): void {
    this.lastTriangles = vertices.length / FLOATS / 3;
    if (!vertices.length) return;
    if (ctx.backend === 'webgpu') this.drawGPU(ctx, vertices); else this.drawGL(ctx.gl, ctx.width, ctx.height, vertices);
  }

  private drawGPU(ctx: Extract<PassContext, {backend: 'webgpu'}>, vertices: Float32Array): void {
    const device = ctx.device;
    if (device !== this.device) {this.release(); this.device = device;}
    const key = ctx.format + ':' + ctx.descriptor.multisample?.count;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({code: WGSL});
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {module, entryPoint: 'vs', buffers: [{arrayStride: FLOATS * 4, attributes: [{shaderLocation: 0, offset: 0, format: 'float32x4'}, {shaderLocation: 1, offset: 16, format: 'float32x4'}]}]},
        fragment: {module, entryPoint: 'fs', targets: [{format: ctx.format, blend: {color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'}, alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'}}}]},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        multisample: ctx.descriptor.multisample,
      });
      this.pipelines.set(key, pipeline);
    }
    if (vertices.byteLength > this.capacity) {
      const capacity = Math.max(4096, 2 ** Math.ceil(Math.log2(vertices.byteLength)));
      const buffer = device.createBuffer({size: capacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
      this.buffer?.destroy();
      this.capacity = capacity;
      this.buffer = buffer;
    }
    device.queue.writeBuffer(this.buffer!, 0, vertices as Float32Array<ArrayBuffer>);
    this.attachment.view = ctx.color;
    const pass = ctx.encoder.beginRenderPass({colorAttachments: [this.attachment]});
    pass.setPipeline(pipeline); pass.setVertexBuffer(0, this.buffer!, 0, vertices.byteLength); pass.draw(vertices.length / FLOATS); pass.end();
  }

  private drawGL(gl: WebGL2RenderingContext, width: number, height: number, vertices: Float32Array): void {
    if (gl !== this.gl) {this.release(); this.gl = gl;}
    if (!this.program) {
      const program = gl.createProgram()!, shaders: WebGLShader[] = [];
      try {
        for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
          const shader = gl.createShader(type)!; shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Gizmo shader failed');
          gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Gizmo program failed');
      } catch (error) {gl.deleteProgram(program); throw error;} finally {for (const shader of shaders) gl.deleteShader(shader);}
      this.program = program; this.vao = gl.createVertexArray(); this.glBuffer = gl.createBuffer();
      gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, FLOATS * 4, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS * 4, 16);
      gl.bindVertexArray(null);
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / FLOATS);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Frees GPU or GL resources; they are recreated on the next draw. */
  release(): void {
    this.buffer?.destroy(); this.buffer = null; this.capacity = 0; this.pipelines.clear(); this.device = null;
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {gl.deleteProgram(this.program); gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.glBuffer);}
    this.gl = null; this.program = null; this.vao = null; this.glBuffer = null;
  }
}
