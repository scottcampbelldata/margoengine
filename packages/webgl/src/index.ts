/// <reference lib="esnext.disposable" preserve="true" />
import type {
  Renderer,
  Batch,
  Lighting,
  Geometry,
  Camera,
  FrameGraph,
  PassContext,
  DrawOptions,
  ViewDraw,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { sceneSamples } from '../../shared/quality.js';
import { clearColorValue, defaultClear } from '../../shared/clear-color.js';
import { validateRectangle } from '../../shared/view-rect.js';
import { ggxDFloat, smithGFloat } from '../../shared/light-terms.js';

const defaultDraw: DrawOptions = {};

const glVertex = `#version 300 es
precision highp float;layout(location=0) in vec3 p;layout(location=1) in vec3 n;layout(location=2) in vec4 m0;layout(location=3) in vec4 m1;layout(location=4) in vec4 m2;layout(location=5) in vec4 m3;layout(location=6) in vec4 color;layout(location=7) in vec4 factors;uniform mat4 camera;out vec3 w;out vec3 wn;out vec3 b;out vec4 m;void main(){mat4 M=mat4(m0,m1,m2,m3);vec4 q=M*vec4(p,1);vec3 a=m0.xyz,y=m1.xyz,c=m2.xyz;wn=mat3(cross(y,c),cross(c,a),cross(a,y))*n*sign(dot(a,cross(y,c)));w=q.xyz;b=color.rgb;m=vec4(factors.xyz,sign(dot(a,cross(y,c))));gl_Position=camera*q;}`;
// Core's lighting in GLSL: glTF 2.0 Appendix B BRDF (GGX D: Walter et al. 2007, eq. 33; Smith G: eq. 34; Schlick 1994
// Fresnel, F0 0.04), Khronos PBR Neutral, then the sRGB encoding (IEC 61966-2-1).
const glFragment = `#version 300 es
precision highp float;in vec3 w;in vec3 wn;in vec3 b;in vec4 m;uniform vec3 eye;uniform vec4 light;uniform vec4 radiance;uniform vec3 ambient;out vec4 o;vec3 pbrNeutral(vec3 c){float x=min(c.r,min(c.g,c.b));float offset=x<0.08?x-6.25*x*x:0.04;c-=offset;float peak=max(c.r,max(c.g,c.b));if(peak<0.76)return c;float newPeak=1.0-0.24*0.24/(peak+0.24-0.76);c*=newPeak/peak;return mix(c,vec3(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}void main(){bool front=gl_FrontFacing==(m.w>0.0);if(!front&&m.z<0.5)discard;vec3 n=normalize(wn);if(!front)n=-n;vec3 v=normalize(eye-w),l=normalize(light.xyz),h=(v+l)/max(length(v+l),0.0001);float nl=clamp(dot(n,l),0.0,1.0),nv=clamp(dot(n,v),0.0001,1.0),nh=clamp(dot(n,h),0.0,1.0),vh=clamp(dot(v,h),0.0,1.0);float a=m.x*m.x,a2=a*a,d=${ggxDFloat};float g=${smithGFloat};vec3 f0=mix(vec3(0.04),b,m.y),f=f0+(1.0-f0)*pow(1.0-vh,5.0);vec3 direct=((1.0-f)*(1.0-m.y)*b/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;vec3 linear=direct*radiance.rgb*light.w+b*(1.0-m.y)*radiance.w*ambient;vec3 mapped=pbrNeutral(max(linear,vec3(0.0)));o=vec4(mix(mapped*12.92,1.055*pow(mapped,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),mapped)),1);}`;

/**
 * Compiles and links one program; the shaders are released either way.
 * @throws MargoError `'failed'` when a GL object cannot be created or a shader does not compile or link (the GL info log is the message).
 * @internal
 */
export const glProgram = (gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram => {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (!program) throw new MargoError('failed', 'GL program; the WebGL context may be lost');
  try {
    for (const [type, code] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new MargoError('failed', 'GL shader; the WebGL context may be lost');
      shaders.push(shader);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new MargoError('failed', gl.getShaderInfoLog(shader) ?? 'GL compile failed; check the shader source');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new MargoError('failed', gl.getProgramInfoLog(program) ?? 'GL link failed; check the shader outputs');
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
  return program;
};
// The renderer of each canvas, for the entries that add to it. A canvas has one WebGL2 context, so one renderer.
const renderers = new WeakMap<object, GLRenderer>();
/**
 * The preview renderer drawing to `canvas`, or undefined when none was made for it.
 * @internal
 */
export const glRenderer = (canvas: object): GLRenderer | undefined => renderers.get(canvas);

/**
 * The WebGL2 fallback renderer core uses when WebGPU is missing: core meshes with core's PBR material, shaded per pixel
 * (GGX metallic-roughness, one directional light plus ambient; no textures or effects; picking is the `/pick` entry).
 * Create it through `webglRenderer` as `Engine.create`'s `fallback`, not directly.
 * @throws MargoError `'unsupported'` when the canvas has no WebGL2 context; `'failed'` when a GL object cannot be
 * created, a shader does not compile or link (the GL info log is the message), or the context is lost.
 */
export class GLRenderer implements Renderer {
  readonly backend = 'webgl2';
  /** @internal */ readonly gl: WebGL2RenderingContext;
  /** @internal When set, a frame calls this instead of drawing: the frame's state, with the canvas left as it is. */
  intercept?: (camera: Camera, batches: Iterable<Batch>, view?: ViewDraw) => void;
  private readonly program: WebGLProgram;
  private readonly camera: WebGLUniformLocation | null;
  private readonly eye: WebGLUniformLocation | null;
  private readonly light: WebGLUniformLocation | null;
  private readonly radiance: WebGLUniformLocation | null;
  private readonly ambient: WebGLUniformLocation | null;
  private readonly resources = new Map<
    Geometry,
    { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; instance: WebGLBuffer }
  >();

  private readonly clear: readonly number[];
  constructor(
    private readonly canvas: HTMLCanvasElement,
    { transparent = false }: WebGLRendererOptions = {},
  ) {
    this.clear = transparent ? [0, 0, 0, 0] : defaultClear;
    const gl = canvas.getContext('webgl2', {
      alpha: transparent,
      premultipliedAlpha: true,
      antialias: sceneSamples() > 1,
      powerPreference: 'high-performance',
    });
    if (!gl)
      throw new MargoError(
        'unsupported',
        'No WebGL2 canvas; use a browser with WebGL2 and a canvas without another context',
      );
    this.gl = gl;
    const program = glProgram(gl, glVertex, glFragment);
    this.program = program;
    this.camera = gl.getUniformLocation(program, 'camera');
    this.eye = gl.getUniformLocation(program, 'eye');
    this.light = gl.getUniformLocation(program, 'light');
    this.radiance = gl.getUniformLocation(program, 'radiance');
    this.ambient = gl.getUniformLocation(program, 'ambient');
    renderers.set(canvas, this);
  }
  add(geometry: Geometry, capacity: number): void {
    const gl = this.gl,
      buffers: WebGLBuffer[] = [];
    const vao = gl.createVertexArray();
    if (!vao) throw new MargoError('failed', 'GL VAO; the WebGL context may be lost');
    try {
      gl.bindVertexArray(vao);
      const upload = (target: number, data: Float32Array | Uint32Array | number) => {
        const buffer = gl.createBuffer();
        if (!buffer) throw new MargoError('failed', 'GL buffer; the WebGL context may be lost');
        buffers.push(buffer);
        gl.bindBuffer(target, buffer);
        if (typeof data === 'number') gl.bufferData(target, data, gl.DYNAMIC_DRAW);
        else gl.bufferData(target, data, gl.STATIC_DRAW);
        return buffer;
      };
      upload(gl.ARRAY_BUFFER, geometry.vertices);
      for (let i = 0; i < 2; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 24, i * 12);
      }
      upload(gl.ELEMENT_ARRAY_BUFFER, geometry.indices);
      const instance = upload(gl.ARRAY_BUFFER, capacity * 96);
      for (let i = 0; i < 6; i++) {
        gl.enableVertexAttribArray(i + 2);
        gl.vertexAttribPointer(i + 2, 4, gl.FLOAT, false, 96, i * 16);
        gl.vertexAttribDivisor(i + 2, 1);
      }
      const error = gl.getError();
      if (error !== gl.NO_ERROR)
        throw new MargoError(
          'failed',
          `GL buffer failed (error ${error}); use a smaller geometry or check the context`,
        );
      this.resources.set(geometry, { vao, buffers, instance });
    } catch (error) {
      for (const buffer of buffers) gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      throw error;
    } finally {
      gl.bindVertexArray(null);
    }
  }
  remove(geometry: Geometry): void {
    const r = this.resources.get(geometry);
    if (r) {
      for (const buffer of r.buffers) this.gl.deleteBuffer(buffer);
      this.gl.deleteVertexArray(r.vao);
      this.resources.delete(geometry);
    }
  }
  render(
    camera: Camera,
    lighting: Lighting,
    batches: Iterable<Batch>,
    graph: FrameGraph,
    delta: number,
    view?: ViewDraw,
  ): void {
    const gl = this.gl;
    if (gl.isContextLost()) throw new MargoError('failed', 'WebGL context lost; create a new engine');
    if (view?.target)
      throw new MargoError(
        'unsupported',
        'WebGL2 cannot draw a view into a texture; use the WebGPU backend for target views',
      );
    if (this.intercept) return this.intercept(camera, batches, view);
    const context: PassContext = {
      backend: 'webgl2',
      gl,
      camera,
      view: view && {
        id: view.id,
        camera,
        viewport: view.rect,
        scissor: view.scissor,
        index: view.index,
        count: view.count,
        clear: view.clear,
        layers: view.layers,
        target: view.target,
      },
      width: this.canvas.width,
      height: this.canvas.height,
      delta,
      draw: (options: DrawOptions = defaultDraw) => {
        const { width, height } = context,
          viewport = options.viewport === undefined ? context.view?.viewport : options.viewport,
          scissor =
            options.scissor === undefined
              ? options.viewport === undefined
                ? (context.view?.scissor ?? context.view?.viewport)
                : undefined
              : options.scissor;
        validateRectangle(viewport, width, height);
        validateRectangle(scissor, width, height);
        const named = context.view?.clear?.color,
          clearColor = options.clear ?? (named === false ? false : typeof named === 'string' || !context.view?.index),
          clearDepth = options.clearDepth ?? context.view?.clear?.depth ?? options.clear ?? true;
        if (viewport) gl.viewport(viewport[0], height - viewport[1] - viewport[3], viewport[2], viewport[3]);
        else gl.viewport(0, 0, width, height);
        // Clear only the rectangle. WebGL clear ignores the viewport, so the scissor has to be on first.
        if (scissor) {
          gl.scissor(scissor[0], height - scissor[1] - scissor[3], scissor[2], scissor[3]);
          gl.enable(gl.SCISSOR_TEST);
        } else gl.disable(gl.SCISSOR_TEST);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        if (clearColor)
          gl.clearColor(
            ...((typeof named === 'string' ? clearColorValue(named) : this.clear) as [number, number, number, number]),
          );
        if (clearColor || clearDepth)
          gl.clear((clearColor ? gl.COLOR_BUFFER_BIT : 0) | (clearDepth ? gl.DEPTH_BUFFER_BIT : 0));
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.camera, false, camera.matrix);
        gl.uniform3f(this.eye, ...camera.position);
        gl.uniform4fv(this.light, lighting.direction);
        gl.uniform4fv(this.radiance, lighting.radiance);
        gl.uniform3f(this.ambient, lighting.ambient?.[0] ?? 1, lighting.ambient?.[1] ?? 1, lighting.ambient?.[2] ?? 1);
        this.drawBatches(batches);
      },
    };
    graph.execute(context);
  }
  /** @internal Uploads and draws every batch with the bound program: the geometry of one frame. */
  drawBatches(batches: Iterable<Batch>): void {
    const gl = this.gl;
    for (const batch of batches)
      if (batch.count) {
        const r = this.resources.get(batch.geometry)!;
        gl.bindVertexArray(r.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, r.instance);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.instances, 0, batch.count * 24);
        gl.drawElementsInstanced(gl.TRIANGLES, batch.geometry.indices.length, gl.UNSIGNED_INT, 0, batch.count);
      }
    gl.bindVertexArray(null);
  }
  dispose(): void {
    for (const geometry of this.resources.keys()) this.remove(geometry);
    this.gl.deleteProgram(this.program);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** `transparent`: premultiplied-alpha canvas cleared to transparent black (the WebGL side of `TransparentCanvas` from @margoengine/environment). */
export interface WebGLRendererOptions {
  transparent?: boolean;
}
/** Pass as `fallback` to `Engine.create`: `Engine.create(canvas, {fallback: webglRenderer})`, or `fallback: canvas => webglRenderer(canvas, {transparent: true})`. */
export const webglRenderer = (canvas: HTMLCanvasElement, options?: WebGLRendererOptions): Renderer =>
  new GLRenderer(canvas, options);
