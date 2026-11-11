/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, FrameGraph, PassContext } from '@margoengine/core/extension';
import { WorldPanels as BaseWorldPanels, WorldPanel, screenRay, type WorldPanelsOptions } from '@margoengine/ui/world';
import { GlUiPainter } from './gl.js';
import { attachPointer, detacher, listener, type Detach } from './dom.js';
import { fault, rangeError } from '../../shared/errors.js';

interface GlPanel {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  painter: GlUiPainter;
  version: number;
  width: number;
  height: number;
}
const VERTEX = `#version 300 es
precision highp float;
uniform mat4 model; uniform mat4 viewProj; uniform vec2 size; uniform vec4 surface; uniform vec3 eye;
out vec2 uv; out float facing;
void main(){int v=gl_VertexID%6;int cell=gl_VertexID/6;int cols=int(surface.z);
vec2 c=(vec2(float(cell%cols),float(cell/cols))+vec2(float((0x32>>v)&1),float((0x2c>>v)&1)))/surface.zw;
vec3 p=vec3((c.x-.5)*size.x,(.5-c.y)*size.y,0.);vec3 n=vec3(0.,0.,1.);
if(surface.y>.5){float r=surface.x;float a=p.x/r;float b=surface.y>1.5?p.y/r:0.;n=vec3(sin(a)*cos(b),sin(b),cos(a)*cos(b));p=vec3(r*n.x,surface.y>1.5?r*n.y:p.y,r*(n.z-1.));}
vec4 world=model*vec4(p,1.);facing=dot(eye-world.xyz,(model*vec4(n,0.)).xyz);gl_Position=viewProj*world;uv=c;}`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D panel; uniform bool doubleSided;in vec2 uv;in float facing;out vec4 color;
void main(){if(facing<0.&&!doubleSided)discard;color=texture(panel,vec2(facing<0.?1.-uv.x:uv.x,uv.y));}`;
/** World panels on both native backends. The existing WebGPU renderer is reused unchanged. */
export class GlWorldPanels extends BaseWorldPanels {
  private glEngine?: Engine;
  private glDevice?: WebGL2RenderingContext;
  private glProgram?: WebGLProgram;
  private glVao?: WebGLVertexArrayObject;
  private glDetach?: Detach;
  private readonly glPanels = new Map<WorldPanel, GlPanel>();
  private readonly glOptions: WorldPanelsOptions;
  private gpuMode = false;
  private glFrame = 0;
  private glPaintFrame = -1;
  override onPreUpdate(delta: number): void {
    super.onPreUpdate(delta);
    this.glFrame++;
  }
  /** Attach once; supports native WebGPU, complete compatibility and core's preview WebGL2 backend. */
  static override attach(engine: EngineKernel, options?: WorldPanelsOptions): GlWorldPanels {
    const value = new GlWorldPanels(options);
    engine.use(value);
    return value;
  }
  constructor(options: WorldPanelsOptions = {}) {
    super(options);
    this.glOptions = { ...options };
  }
  override setup(engine: Engine): void {
    this.glEngine = engine;
    this.gpuMode = engine.backend === 'webgpu';
    if (this.gpuMode) {
      super.setup(engine);
      return;
    }
    const canvas = (engine as unknown as { canvas?: HTMLElement }).canvas;
    if ((this.glOptions.input ?? true) && canvas && !this.glDetach) {
      const down = new Set<number>(),
        clean: (() => void)[] = [],
        ray = (x: number, y: number) =>
          screenRay(
            (engine as unknown as EngineKernel).camera,
            x,
            y,
            canvas.clientWidth || 1,
            canvas.clientHeight || 1,
          );
      attachPointer(
        {
          pointerMove: (x, y, info) => this.pointer(ray(x, y), down.has(info.id ?? 0), info),
          pointerDown: (x, y, info) => {
            if (info.button) return false;
            down.add(info.id ?? 0);
            const used = this.pointer(ray(x, y), true, info);
            if (!used) down.delete(info.id ?? 0);
            return used;
          },
          pointerUp: (x, y, info) => {
            if (!down.delete(info.id ?? 0)) return false;
            return this.pointer(ray(x, y), false, info);
          },
          pointerCancel: () => {
            down.clear();
            this.cancel();
          },
          pointerLeave: () => {
            if (!down.size) for (const p of this.list) p.ui.pointerLeave();
          },
          wheel: (x, y, dy) => {
            let nearest: WorldPanel | undefined,
              at: ReturnType<WorldPanel['intersect']> = null;
            const r = ray(x, y);
            for (const p of this.list) {
              if (!p.visible) continue;
              const h = p.intersect(r);
              if (h?.inside && (!at || h.distance < at.distance)) {
                nearest = p;
                at = h;
              }
            }
            return !!nearest && !!at && nearest.ui.wheel(at.x, at.y, dy);
          },
        },
        canvas,
        listener(canvas, clean),
      );
      this.glDetach = detacher(clean, this.glOptions.signal);
    }
  }
  override registerPasses(graph: FrameGraph): void {
    if (this.gpuMode) super.registerPasses(graph);
    else graph.add({ name: `${this.name}:draw`, order: this.order, execute: (c) => this.drawPanels(c) });
  }
  private initialize(gl: WebGL2RenderingContext): void {
    if (this.glDevice === gl && this.glProgram) return;
    this.glDevice = gl;
    const program = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw fault(
        'failed',
        `World panel WebGL2 shader failed: ${gl.getProgramInfoLog(program)}; report the browser and GPU`,
        'ui',
      );
    this.glProgram = program;
    this.glVao = gl.createVertexArray()!;
  }
  private resourcesGl(panel: WorldPanel, gl: WebGL2RenderingContext): GlPanel {
    const old = this.glPanels.get(panel);
    if (old) return old;
    const width = Math.round(panel.cssWidth * panel.pixelRatio),
      height = Math.round(panel.cssHeight * panel.pixelRatio),
      max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (width < 1 || height < 1 || width > max || height > max)
      throw rangeError(
        `World panel ${width} by ${height} exceeds the WebGL2 limit ${max}; lower the size or pixelRatio`,
        'ui',
      );
    const texture = gl.createTexture()!,
      framebuffer = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(width, height))) + 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw fault('failed', 'World panel framebuffer is incomplete; lower its pixelRatio', 'ui');
    const result = {
      texture,
      framebuffer,
      width,
      height,
      painter: new GlUiPainter(
        gl,
        { atlasSize: 1024, colorAtlasSize: 512, maxPages: 16 },
        { rects: 0, glyphs: 0, drawCalls: 0, uploads: 0 },
      ),
      version: -1,
    };
    this.glPanels.set(panel, result);
    return result;
  }
  private drawPanels(context: PassContext): void {
    if (context.backend !== 'webgl2' || !this.glEngine || context.gl.isContextLost()) return;
    const gl = context.gl,
      restore = captureState(gl);
    this.stats.panels = this.stats.drawCalls = 0;
    if (this.glPaintFrame !== this.glFrame) this.stats.repaints = 0;
    this.glPaintFrame = this.glFrame;
    try {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      for (const param of [
        gl.UNPACK_ROW_LENGTH,
        gl.UNPACK_IMAGE_HEIGHT,
        gl.UNPACK_SKIP_PIXELS,
        gl.UNPACK_SKIP_ROWS,
        gl.UNPACK_SKIP_IMAGES,
        gl.UNPACK_FLIP_Y_WEBGL,
        gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      ])
        gl.pixelStorei(param, 0);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      this.initialize(gl);
      gl.bindSampler(0, null);
      gl.bindSampler(1, null);
      const visible: [WorldPanel, GlPanel][] = [];
      for (const p of this.list) {
        if (!p.visible) continue;
        const data = this.resourcesGl(p, gl),
          list = p.ui.draw();
        if (data.version !== list.version) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, data.framebuffer);
          gl.disable(gl.SCISSOR_TEST);
          gl.colorMask(true, true, true, true);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          data.painter.draw(list, data.width, data.height, data.framebuffer);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, data.texture);
          gl.generateMipmap(gl.TEXTURE_2D);
          data.version = list.version;
          this.stats.repaints++;
        }
        if (p.doubleSided || p.side(context.camera.position) > 0) visible.push([p, data]);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, restore.framebuffer);
      const view = context.view?.viewport ?? [0, 0, context.width, context.height],
        clip = context.view?.scissor ?? view;
      gl.viewport(view[0], context.height - view[1] - view[3], view[2], view[3]);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(clip[0], context.height - clip[1] - clip[3], clip[2], clip[3]);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);
      gl.colorMask(true, true, true, true);
      const program = this.glProgram!;
      gl.useProgram(program);
      gl.bindVertexArray(this.glVao!);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(gl.getUniformLocation(program, 'panel'), 0);
      gl.uniformMatrix4fv(gl.getUniformLocation(program, 'viewProj'), false, context.camera.matrix);
      for (const [p, data] of visible) {
        gl.bindTexture(gl.TEXTURE_2D, data.texture);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'model'), false, p.matrix);
        gl.uniform2f(gl.getUniformLocation(program, 'size'), p.width, p.height);
        gl.uniform4fv(gl.getUniformLocation(program, 'surface'), p.surface);
        gl.uniform3fv(gl.getUniformLocation(program, 'eye'), context.camera.position);
        gl.uniform1i(gl.getUniformLocation(program, 'doubleSided'), p.doubleSided ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6 * p.surface[2] * p.surface[3]);
        this.stats.panels++;
        this.stats.drawCalls++;
      }
    } finally {
      restore.apply();
    }
  }
  override remove(panel: WorldPanel): void {
    this.releaseGl(panel);
    super.remove(panel);
  }
  private releaseGl(panel: WorldPanel): void {
    const d = this.glPanels.get(panel),
      gl = this.glDevice;
    if (!d || !gl) return;
    d.painter.dispose();
    gl.deleteTexture(d.texture);
    gl.deleteFramebuffer(d.framebuffer);
    this.glPanels.delete(panel);
  }
  override onDeviceRestored(engine: Engine): void {
    if (this.gpuMode) {
      super.onDeviceRestored(engine);
      return;
    }
    this.glPanels.clear();
    this.glProgram = this.glVao = undefined;
    this.glDevice = undefined;
    this.setup(engine);
  }
  override dispose(): void {
    const engine = this.glEngine;
    this.glDetach?.();
    this.glDetach = undefined;
    for (const p of this.glPanels.keys()) this.releaseGl(p);
    if (this.glDevice) {
      this.glDevice.deleteProgram(this.glProgram ?? null);
      this.glDevice.deleteVertexArray(this.glVao ?? null);
    }
    this.glProgram = this.glVao = undefined;
    this.glDevice = this.glEngine = undefined;
    super.dispose();
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
}
function captureState(gl: WebGL2RenderingContext) {
  const unpackBuffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
    unpack = [
      gl.UNPACK_ROW_LENGTH,
      gl.UNPACK_IMAGE_HEIGHT,
      gl.UNPACK_SKIP_PIXELS,
      gl.UNPACK_SKIP_ROWS,
      gl.UNPACK_SKIP_IMAGES,
      gl.UNPACK_FLIP_Y_WEBGL,
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
    ].map((param) => [param, gl.getParameter(param)] as const);

  const framebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    viewport = gl.getParameter(gl.VIEWPORT),
    scissor = gl.getParameter(gl.SCISSOR_BOX),
    program = gl.getParameter(gl.CURRENT_PROGRAM),
    vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    buffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    active = gl.getParameter(gl.ACTIVE_TEXTURE),
    clear = gl.getParameter(gl.COLOR_CLEAR_VALUE),
    mask = gl.getParameter(gl.COLOR_WRITEMASK),
    depthMask = gl.getParameter(gl.DEPTH_WRITEMASK),
    depthFunc = gl.getParameter(gl.DEPTH_FUNC),
    alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
  const enabled = [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.SCISSOR_TEST].map(
      (cap) => [cap, gl.isEnabled(cap)] as const,
    ),
    blend = [
      gl.BLEND_SRC_RGB,
      gl.BLEND_DST_RGB,
      gl.BLEND_SRC_ALPHA,
      gl.BLEND_DST_ALPHA,
      gl.BLEND_EQUATION_RGB,
      gl.BLEND_EQUATION_ALPHA,
    ].map((p) => gl.getParameter(p));
  const textures = [0, 1].map((i) => {
    gl.activeTexture(gl.TEXTURE0 + i);
    return [
      gl.getParameter(gl.TEXTURE_BINDING_2D),
      gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY),
      gl.getParameter(gl.SAMPLER_BINDING),
    ];
  });
  gl.activeTexture(active);
  return {
    framebuffer,
    apply() {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.viewport(...(viewport as [number, number, number, number]));
      gl.scissor(...(scissor as [number, number, number, number]));
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.clearColor(...(clear as [number, number, number, number]));
      gl.colorMask(...(mask as [boolean, boolean, boolean, boolean]));
      gl.depthMask(depthMask);
      gl.depthFunc(depthFunc);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      for (const [param, value] of unpack) gl.pixelStorei(param, Number(value));
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpackBuffer);
      gl.blendFuncSeparate(blend[0], blend[1], blend[2], blend[3]);
      gl.blendEquationSeparate(blend[4], blend[5]);
      for (const [cap, on] of enabled) {
        if (on) gl.enable(cap);
        else gl.disable(cap);
      }
      textures.forEach((bindings, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, bindings[0]);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, bindings[1]);
        gl.bindSampler(i, bindings[2]);
      });
      gl.activeTexture(active);
    },
  };
}

export * from '@margoengine/ui/world';
export { GlWorldPanels as WorldPanels };
