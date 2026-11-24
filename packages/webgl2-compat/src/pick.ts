import type { Batch, Camera, Engine, EnginePlugin, Mesh, RenderView, ViewDraw } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { glProgram, glRenderer, type GLRenderer } from './preview.js';

// The preview's own vertex placement and face test (index.ts), with the mesh id in place of the shading.
const pickVertex = `#version 300 es
precision highp float;layout(location=0) in vec3 p;layout(location=2) in vec4 m0;layout(location=3) in vec4 m1;layout(location=4) in vec4 m2;layout(location=5) in vec4 m3;layout(location=7) in vec4 factors;uniform mat4 camera;flat out uint id;flat out vec2 face;void main(){id=uint(factors.w);face=vec2(dot(m0.xyz,cross(m1.xyz,m2.xyz)),factors.z);gl_Position=camera*(mat4(m0,m1,m2,m3)*vec4(p,1));}`;
const pickFragment = `#version 300 es
precision highp float;precision highp int;flat in uint id;flat in vec2 face;layout(location=0) out uint o;void main(){if(gl_FrontFacing!=(face.x>0.0)&&face.y<0.5)discard;o=id;}`;
// So one import gives a React Canvas both: `loadFallback={() => import('margoengine/webgl2-compat/pick')}`.
export { webglRenderer } from './preview.js';

/** The clear value of the id target: no mesh. */
const none = 0xffffffff;

type Render = Engine['render'];
type Target = { framebuffer: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer };

const inside = (rect: readonly number[] | undefined, x: number, y: number) =>
  !rect || (x >= rect[0] && y >= rect[1] && x < rect[0] + rect[2] && y < rect[1] + rect[3]);

class WebGLPicking implements EnginePlugin {
  readonly name = 'webgl-pick';
  private engine?: Engine;
  private renderer?: GLRenderer;
  private frame?: Render;
  private program?: WebGLProgram;
  private camera: WebGLUniformLocation | null = null;
  private target?: Target;
  private generation = 0;
  private readonly matrix = new Float32Array(16);
  private readonly pixel = new Uint32Array(4);
  /** Canvas views of the last `render({views})`, as core keeps them for its own pick. */
  private views?: RenderView[];

  setup(engine: Engine): void {
    // WebGPU and the compatibility layer have core's pick: one `use` serves every backend.
    if (engine.backend !== 'webgl2') return;
    const renderer = glRenderer(engine.canvas);
    if (!renderer)
      throw new MargoError('unsupported', 'webglPicking needs webglRenderer from @margoengine/webgl2-compat/preview as the fallback');
    this.engine = engine;
    this.renderer = renderer;
    const frame = (this.frame = engine.render),
      refuse = engine.pick;
    // Core's pick refuses every renderer but WebGPU's before any plugin hook, so this engine's two methods are
    // covered until the plugin goes: click handlers keep calling engine.pick, and core stays as it is.
    engine.pick = (x, y, view) =>
      [x, y].every(Number.isFinite) ? this.pick(x, y, view && { ...view }) : refuse.call(engine, x, y, view);
    engine.render = (options) => {
      frame.call(engine, options);
      if (renderer.intercept) return;
      this.views = options?.views
        ?.filter((view) => !view.target)
        .map((view) => ({
          ...view,
          viewport: [...view.viewport] as unknown as RenderView['viewport'],
          scissor: view.scissor && ([...view.scissor] as unknown as RenderView['viewport']),
        }));
    };
  }

  /** One frame of the engine into the id target: core refreshes the scene and enters each view's scene as for any frame. */
  private async pick(x: number, y: number, view?: RenderView): Promise<Mesh | null> {
    // Out of any frame in progress; picks made together keep their order.
    await null;
    const { engine, renderer, frame } = this;
    if (!engine || !renderer || !frame || renderer.gl.isContextLost()) return null;
    const { canvas } = engine,
      width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height,
      chosen = view ? [view] : this.views;
    if (x < 0 || y < 0 || x >= width || y >= height || chosen?.length === 0) return null;
    let id: number | null = null;
    renderer.intercept = (camera, batches, drawn) => {
      const px = (x * canvas.width) / width,
        py = (y * canvas.height) / height;
      // The last view under the point wins: it is the one drawn on top.
      if (inside(drawn?.rect, px, py) && inside(drawn?.scissor, px, py)) id = this.read(camera, batches, px, py, drawn);
    };
    try {
      frame.call(engine, chosen ? { views: chosen } : undefined);
    } finally {
      renderer.intercept = undefined;
    }
    return id === null ? null : (engine.meshes.get(id) ?? null);
  }

  /** The mesh id drawn at drawing-buffer pixel (px, py), through a 1x1 target and a projection narrowed to that pixel. */
  private read(camera: Camera, batches: Iterable<Batch>, px: number, py: number, view?: ViewDraw): number | null {
    const renderer = this.renderer!,
      { gl } = renderer,
      { canvas } = this.engine!,
      target = this.ready(gl),
      rect = view?.rect,
      spanX = rect ? rect[2] : canvas.width,
      spanY = rect ? rect[3] : canvas.height,
      nx = (2 * (Math.floor(px - (rect?.[0] ?? 0)) + 0.5)) / spanX - 1,
      ny = 1 - (2 * (Math.floor(py - (rect?.[1] ?? 0)) + 0.5)) / spanY,
      { matrix } = this;
    matrix.set(camera.matrix);
    for (let c = 0; c < 4; c++) {
      matrix[c * 4] = (camera.matrix[c * 4] - nx * camera.matrix[c * 4 + 3]) * spanX;
      matrix[c * 4 + 1] = (camera.matrix[c * 4 + 1] - ny * camera.matrix[c * 4 + 3]) * spanY;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    try {
      gl.viewport(0, 0, 1, 1);
      gl.disable(gl.SCISSOR_TEST);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      // Of two equal depths the later draw wins, as in core's pick.
      gl.depthFunc(gl.LEQUAL);
      gl.clearBufferuiv(gl.COLOR, 0, [none, 0, 0, 0]);
      gl.clearBufferfv(gl.DEPTH, 0, [1]);
      gl.useProgram(this.program!);
      gl.uniformMatrix4fv(this.camera, false, matrix);
      renderer.drawBatches(batches);
      gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.pixel);
    } finally {
      gl.depthFunc(gl.LESS);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return this.pixel[0] === none ? null : this.pixel[0];
  }

  /** The id program and target, made by the first pick: apps that never pick pay nothing. */
  private ready(gl: WebGL2RenderingContext): Target {
    const { generation } = this.renderer!;
    // A lost context took the program and target with it.
    if (this.generation !== generation) this.program = this.target = undefined;
    this.generation = generation;
    if (this.target) return this.target;
    const program = (this.program = glProgram(gl, pickVertex, pickFragment));
    this.camera = gl.getUniformLocation(program, 'camera');
    const framebuffer = gl.createFramebuffer(),
      color = gl.createRenderbuffer(),
      depth = gl.createRenderbuffer();
    if (!framebuffer || !color || !depth)
      throw new MargoError('failed', 'GL pick target; the WebGL context may be lost');
    const target = { framebuffer, color, depth };
    this.target = target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    try {
      for (const [buffer, format, attachment] of [
        [color, gl.R32UI, gl.COLOR_ATTACHMENT0],
        [depth, gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT],
      ] as const) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, format, 1, 1);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, buffer);
      }
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE)
        throw new MargoError('failed', `GL pick target incomplete (status ${status}); use the WebGPU backend`);
    } catch (error) {
      this.release();
      throw error;
    } finally {
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return target;
  }

  private release(): void {
    const gl = this.renderer?.gl;
    if (!gl || this.generation !== this.renderer!.generation) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.target) {
      gl.deleteFramebuffer(this.target.framebuffer);
      gl.deleteRenderbuffer(this.target.color);
      gl.deleteRenderbuffer(this.target.depth);
    }
    this.program = this.target = undefined;
  }

  dispose(): void {
    const engine = this.engine;
    if (!engine) return;
    this.release();
    // Back to the class's methods: core's own answers (`disposed`, `unsupported`) apply again.
    delete (engine as Partial<Engine>).pick;
    delete (engine as Partial<Engine>).render;
    this.engine = this.renderer = this.frame = this.views = undefined;
  }
}

/**
 * `engine.pick` on the WebGL2 preview: `engine.use(webglPicking())` after `Engine.create(canvas, {fallback: webglRenderer})`,
 * then `engine.pick(x, y, view?)` answers as it does on WebGPU, with the same CSS pixels, views, layers and front-face
 * rule. Each pick is one frame's scene refresh, one small draw and one blocking `readPixels` of a single pixel. On
 * WebGPU and the compatibility layer the plugin does nothing, because core's pick already runs there.
 * @throws MargoError `'unsupported'` on attach when the engine's fallback is not `webglRenderer`; `'failed'` from a pick
 * when the id target cannot be made.
 */
export const webglPicking = (): EnginePlugin => new WebGLPicking();
