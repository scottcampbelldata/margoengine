import type { TextureBakeOptions, TextureBaker, WebGLBakedTexture } from './textures.js';
import { textureSettings } from './texture-settings.js';
import { fault } from '../../shared/errors.js';

// Same periodic field as texture-shader.ts, expressed as a WebGL2 fragment pass.
const vertex = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}`;
const fragment = `#version 300 es
precision highp float; precision highp int;
uniform vec2 size, repeats, offset;
uniform uint seed;
uniform int kind;
uniform float detail, grout, stagger;
uniform vec3 color, secondary;
out vec4 result;
float hash(uvec2 cell){
 uint h=(cell.x*1597334677u)^(cell.y*3812015801u)^seed;
 h=(h^(h>>16u))*2246822519u; h=(h^(h>>13u))*3266489917u;
 return float((h^(h>>16u))>>8u)/16777215.0;
}
float noise(vec2 uv,uint period){
 vec2 q=uv*float(period); uvec2 cell=uvec2(floor(q));
 vec2 f=fract(q),t=f*f*f*(f*(f*6.0-15.0)+10.0);
 float a=hash(cell%uvec2(period)),b=hash((cell+uvec2(1,0))%uvec2(period));
 float c=hash((cell+uvec2(0,1))%uvec2(period)),d=hash((cell+uvec2(1,1))%uvec2(period));
 return mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
}
void main(){
 vec2 uv=fract(gl_FragCoord.xy/size+offset);
 float n=(noise(uv,4u)*8.0+noise(uv,8u)*4.0+noise(uv,16u)*2.0+noise(uv,32u))/15.0;
 float value=n;
 if(kind==1||kind==2){
  uint row=uint(floor(uv.y*repeats.y));
  float shift=kind==1?float(row%2u)*stagger:0.0;
  vec2 local=fract(uv*repeats+vec2(shift,0)),edge=min(local,1.0-local);
  value=(all(greaterThanEqual(edge,vec2(grout)))?1.0:0.0)*(1.0-detail*(1.0-n));
 }else if(kind==3){
  float ring=0.5+0.5*cos(6.28318530718*(uv.x*repeats.x+detail*n));value=0.2+0.8*ring;
 }else if(kind==4){value=smoothstep(0.35-detail*0.2,0.65+detail*0.2,n);}
 result=vec4(mix(secondary,color,value),1);
}`;
const failed = (text: string) => fault('failed', text, 'procedural');

/** Internal fragment implementation; never imported by the procedural root. */
export function createWebGLBaker(gl: WebGL2RenderingContext): TextureBaker<WebGLBakedTexture> {
  const checkContext = () => {
    if (gl.isContextLost()) throw failed('Texture baker context was lost; recreate the baker after restoration');
  };
  checkContext();
  const program = gl.createProgram(),
    shaders: WebGLShader[] = [];
  if (!program) throw failed('Texture baker could not allocate a WebGL2 program');
  try {
    for (const [type, code] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw failed('Texture baker could not allocate a WebGL2 shader');
      shaders.push(shader);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw failed(`Texture shader: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw failed(`Texture pipeline: ${gl.getProgramInfoLog(program)}`);
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
  const uniforms = Object.fromEntries(
    ['size', 'repeats', 'offset', 'seed', 'kind', 'detail', 'grout', 'stagger', 'color', 'secondary'].map((name) => [
      name,
      gl.getUniformLocation(program, name),
    ]),
  );
  const outputs = new Set<WebGLBakedTexture>();
  let disposed = false,
    lost = false;
  const onLoss = () => {
    lost = true;
  };
  gl.canvas.addEventListener('webglcontextlost', onLoss);
  const check = () => {
    if (disposed) throw fault('disposed', 'Texture baker is disposed; create a new baker', 'procedural');
    if (lost) throw failed('Texture baker context was lost; recreate the baker after restoration');
    checkContext();
  };
  return {
    async bake(options: TextureBakeOptions = {}): Promise<WebGLBakedTexture> {
      check();
      const o = textureSettings(options, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      const texture = gl.createTexture(),
        framebuffer = gl.createFramebuffer(),
        vao = gl.createVertexArray();
      if (!texture || !framebuffer || !vao) {
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteVertexArray(vao);
        throw failed('Texture bake could not allocate WebGL2 resources');
      }
      const enabled = [
        gl.BLEND,
        gl.CULL_FACE,
        gl.DEPTH_TEST,
        gl.SCISSOR_TEST,
        gl.STENCIL_TEST,
        gl.DITHER,
        gl.RASTERIZER_DISCARD,
        gl.SAMPLE_ALPHA_TO_COVERAGE,
        gl.SAMPLE_COVERAGE,
      ].map((cap) => [cap, gl.isEnabled(cap)] as const);
      const state = {
        draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        texture: gl.getParameter(gl.TEXTURE_BINDING_2D),
        viewport: gl.getParameter(gl.VIEWPORT),
        mask: gl.getParameter(gl.COLOR_WRITEMASK),
      };
      let complete = false;
      try {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, o.width, o.height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw failed('Texture bake framebuffer is incomplete; check WebGL2 texture limits');
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        for (const [cap] of enabled) gl.disable(cap);
        gl.colorMask(true, true, true, true);
        gl.viewport(0, 0, o.width, o.height);
        gl.uniform2f(uniforms.size, o.width, o.height);
        gl.uniform2fv(uniforms.repeats, o.repeat);
        gl.uniform2fv(
          uniforms.offset,
          o.offset.map((v) => ((v % 1) + 1) % 1),
        );
        gl.uniform1ui(uniforms.seed, o.seed);
        gl.uniform1i(uniforms.kind, o.kind);
        gl.uniform1f(uniforms.detail, o.detail);
        gl.uniform1f(uniforms.grout, o.grout);
        gl.uniform1f(uniforms.stagger, o.stagger);
        gl.uniform3fv(uniforms.color, o.color);
        gl.uniform3fv(uniforms.secondary, o.secondary);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } catch (error) {
        gl.deleteTexture(texture);
        throw error;
      } finally {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.draw);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.read);
        gl.useProgram(state.program);
        gl.bindVertexArray(state.vao);
        gl.bindTexture(gl.TEXTURE_2D, state.texture);
        gl.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
        gl.colorMask(state.mask[0], state.mask[1], state.mask[2], state.mask[3]);
        for (const [cap, wasEnabled] of enabled) {
          if (wasEnabled) gl.enable(cap);
          else gl.disable(cap);
        }
        gl.deleteFramebuffer(framebuffer);
        gl.deleteVertexArray(vao);
      }
      try {
        // Release incomplete output if the caller aborts or disposes before the promise publishes it.
        await Promise.resolve();
        o.signal?.throwIfAborted();
        check();
        const output: WebGLBakedTexture = {
          backend: 'webgl2',
          texture,
          gl,
          width: o.width,
          height: o.height,
          dispose() {
            if (outputs.delete(output)) gl.deleteTexture(texture);
          },
          [Symbol.dispose]() {
            this.dispose();
          },
        };
        outputs.add(output);
        complete = true;
        return output;
      } finally {
        if (!complete) gl.deleteTexture(texture);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gl.canvas.removeEventListener('webglcontextlost', onLoss);
      for (const output of outputs) output.dispose();
      gl.deleteProgram(program);
    },
    [Symbol.dispose]() {
      this.dispose();
    },
  };
}
