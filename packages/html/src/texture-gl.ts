import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { HTMLTexture, type HTMLSurface } from './texture.js';
import { htmlProgram, htmlGLState } from './gl.js';

const vertex = `#version 300 es
uniform mat4 camera,model;uniform vec2 size;out vec2 uv;
void main(){
 vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
 uv=corners[gl_VertexID];gl_Position=camera*model*vec4((uv.x-.5)*size.x,(.5-uv.y)*size.y,0,1);
}`;
const fragment = `#version 300 es
precision highp float;uniform sampler2D image;in vec2 uv;out vec4 color;
void main(){color=texture(image,uv);if(color.a<.004)discard;}`;
interface GLResources {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  camera: WebGLUniformLocation | null;
  model: WebGLUniformLocation | null;
  size: WebGLUniformLocation | null;
  image: WebGLUniformLocation | null;
  textures: Map<HTMLSurface, WebGLTexture>;
}
/** HTMLTexture with a native WebGL2 preview route, sharing rasterization, hit testing and WebGPU rendering. */
export class HTMLTextureGL extends HTMLTexture {
  protected override readonly preview = true;
  private glResources?: GLResources;
  static override attach(engine: EngineKernel, options?: ConstructorParameters<typeof HTMLTexture>[0]): HTMLTextureGL {
    const textures = new HTMLTextureGL(options);
    engineRuntime(engine).use(textures);
    return textures;
  }
  override registerPasses(graph: FrameGraph): void {
    super.registerPasses(graph);
    graph.add({name: `${this.name}-gl`, order: 0.75, execute: (context) => {
      if (context.backend === 'webgl2') this.drawGL(context);
    }});
  }
  private resources(gl: WebGL2RenderingContext): GLResources {
    if (this.glResources?.gl !== gl) this.releaseGL();
    if (!this.glResources) {
      const program = htmlProgram(gl, vertex, fragment);
      this.glResources = {gl, program, vao: gl.createVertexArray()!,
        camera: gl.getUniformLocation(program, 'camera'), model: gl.getUniformLocation(program, 'model'),
        size: gl.getUniformLocation(program, 'size'), image: gl.getUniformLocation(program, 'image'), textures: new Map()};
    }
    return this.glResources;
  }
  protected override upload(surface: HTMLSurface, source: HTMLCanvasElement, width: number, height: number): void {
    if (this.runtime?.gpu) return super.upload(surface, source, width, height);
    const state = this.glResources;
    if (!state || state.gl.isContextLost()) {surface.invalidate(); return;}
    const gl = state.gl, restore = htmlGLState(gl), buffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
      parameters = [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_ROW_LENGTH,
        gl.UNPACK_SKIP_ROWS, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_IMAGES],
      previous = parameters.map((p) => gl.getParameter(p));
    try {
      let texture = state.textures.get(surface);
      if (!texture) {texture = gl.createTexture()!; state.textures.set(surface, texture);}
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      parameters.forEach((p, i) => gl.pixelStorei(p, i === 0 ? 1 : 0));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } finally {
      parameters.forEach((p, i) => gl.pixelStorei(p, previous[i]));
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer);
      restore();
    }
  }
  private drawGL(c: Extract<PassContext, {backend: 'webgl2'}>): void {
    if (!this.size || c.gl.isContextLost()) return;
    const state = this.resources(c.gl), gl = c.gl, restore = htmlGLState(gl);
    try {
      const [x, y, w, h] = c.view?.viewport ?? [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight];
      gl.viewport(x, gl.drawingBufferHeight-y-h, w, h);
      gl.useProgram(state.program);
      gl.bindVertexArray(state.vao);
      gl.bindSampler(0, null);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.colorMask(true,true,true,true);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(state.camera, false, c.camera.matrix);
      gl.uniform1i(state.image, 0);
      for (const surface of this.surfaces) {
        this.refresh(surface);
        const texture = state.textures.get(surface);
        if (!texture) continue;
        gl.uniformMatrix4fv(state.model, false, this.worldMatrix(surface));
        gl.uniform2f(state.size, surface.width, surface.height);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    } finally {restore();}
  }
  override remove(surface: HTMLSurface): void {
    const state = this.glResources, texture = state?.textures.get(surface);
    if (texture) {state!.gl.deleteTexture(texture); state!.textures.delete(surface);}
    super.remove(surface);
  }
  private releaseGL(): void {
    const state = this.glResources;
    this.glResources = undefined;
    if (!state || state.gl.isContextLost()) return;
    for (const texture of state.textures.values()) state.gl.deleteTexture(texture);
    state.gl.deleteVertexArray(state.vao);
    state.gl.deleteProgram(state.program);
  }
  override onDeviceRestored(): void {this.releaseGL(); super.onDeviceRestored();}
  override dispose(): void {this.releaseGL(); super.dispose();}
}
