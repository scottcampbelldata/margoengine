/// <reference lib="esnext.disposable" preserve="true" />
import type {Renderer, Batch, Lighting, Geometry, Camera, FrameGraph} from '@margoengine/core/extension';
import {sceneSamples} from '../../shared/quality.js';

const glVertex = `#version 300 es
precision highp float;layout(location=0) in vec3 p;layout(location=1) in vec3 n;layout(location=2) in vec4 m0;layout(location=3) in vec4 m1;layout(location=4) in vec4 m2;layout(location=5) in vec4 m3;layout(location=6) in vec4 color;layout(location=7) in vec4 factors;uniform mat4 camera;out vec3 w;out vec3 wn;out vec3 b;out vec4 m;void main(){mat4 M=mat4(m0,m1,m2,m3);vec4 q=M*vec4(p,1);vec3 a=m0.xyz,y=m1.xyz,c=m2.xyz;wn=mat3(cross(y,c),cross(c,a),cross(a,y))*n*sign(dot(a,cross(y,c)));w=q.xyz;b=color.rgb;m=vec4(factors.xyz,sign(dot(a,cross(y,c))));gl_Position=camera*q;}`;
const glFragment = `#version 300 es
precision highp float;in vec3 w;in vec3 wn;in vec3 b;in vec4 m;uniform vec3 eye;uniform vec4 light;uniform vec4 radiance;out vec4 o;void main(){bool front=gl_FrontFacing==(m.w>0.0);if(!front&&m.z<0.5)discard;vec3 n=normalize(wn);if(!front)n=-n;vec3 v=normalize(eye-w),l=normalize(light.xyz),h=(v+l)/max(length(v+l),0.0001);float nl=clamp(dot(n,l),0.0,1.0),nv=clamp(dot(n,v),0.0001,1.0),nh=clamp(dot(n,h),0.0,1.0),vh=clamp(dot(v,h),0.0,1.0);float a=m.x*m.x,a2=a*a,d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));float g=2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001);vec3 f0=mix(vec3(0.04),b,m.y),f=f0+(1.0-f0)*pow(1.0-vh,5.0);vec3 direct=((1.0-f)*(1.0-m.y)*b/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;vec3 linear=direct*radiance.rgb*light.w+b*(1.0-m.y)*radiance.w;vec3 mapped=linear/(1.0+linear);o=vec4(mix(mapped*12.92,1.055*pow(mapped,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),mapped)),1);}`;

export class GLRenderer implements Renderer {
  readonly backend = 'webgl2';
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly camera: WebGLUniformLocation|null;
  private readonly eye: WebGLUniformLocation|null;
  private readonly light: WebGLUniformLocation|null;
  private readonly radiance: WebGLUniformLocation|null;
  private readonly resources=new Map<Geometry,{vao:WebGLVertexArrayObject; buffers:WebGLBuffer[]; instance:WebGLBuffer}>();

  private readonly clear:[number,number,number,number];
  constructor(private readonly canvas: HTMLCanvasElement, {transparent=false}:WebGLRendererOptions={}) {
    this.clear=transparent?[0,0,0,0]:[0.018,0.023,0.035,1];
    const gl=canvas.getContext('webgl2',{alpha:transparent,premultipliedAlpha:true,antialias:sceneSamples()>1,powerPreference:'high-performance'});
    if(!gl)throw new Error('No WebGL2 canvas'); this.gl=gl;
    const shaders:WebGLShader[]=[]; const program=gl.createProgram(); if(!program)throw new Error('GL program');
    try {
      for(const [type,code] of [[gl.VERTEX_SHADER,glVertex],[gl.FRAGMENT_SHADER,glFragment]] as const) {
        const shader=gl.createShader(type); if(!shader)throw new Error('GL shader'); shaders.push(shader);
        gl.shaderSource(shader,code); gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)??'GL compile');
        gl.attachShader(program,shader);
      }
      gl.linkProgram(program); if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??'GL link');
    } catch(error) { gl.deleteProgram(program); throw error; } finally { for(const shader of shaders)gl.deleteShader(shader); }
    this.program=program; this.camera=gl.getUniformLocation(program,'camera'); this.eye=gl.getUniformLocation(program,'eye'); this.light=gl.getUniformLocation(program,'light'); this.radiance=gl.getUniformLocation(program,'radiance');
  }
  add(geometry: Geometry, capacity: number): void {
    const gl=this.gl,buffers:WebGLBuffer[]=[]; const vao=gl.createVertexArray(); if(!vao)throw new Error('GL VAO');
    try {
      gl.bindVertexArray(vao);
      const upload=(target:number,data:Float32Array|Uint32Array|number) => { const buffer=gl.createBuffer(); if(!buffer)throw new Error('GL buffer'); buffers.push(buffer); gl.bindBuffer(target,buffer); if(typeof data==='number')gl.bufferData(target,data,gl.DYNAMIC_DRAW);else gl.bufferData(target,data,gl.STATIC_DRAW);return buffer; };
      upload(gl.ARRAY_BUFFER,geometry.vertices);
      for(let i=0;i<2;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,3,gl.FLOAT,false,24,i*12);}
      upload(gl.ELEMENT_ARRAY_BUFFER,geometry.indices); const instance=upload(gl.ARRAY_BUFFER,capacity*96);
      for(let i=0;i<6;i++){gl.enableVertexAttribArray(i+2);gl.vertexAttribPointer(i+2,4,gl.FLOAT,false,96,i*16);gl.vertexAttribDivisor(i+2,1);}
      const error=gl.getError(); if(error!==gl.NO_ERROR)throw new Error(`GL buffer (${error})`);
      this.resources.set(geometry,{vao,buffers,instance});
    } catch(error) { for(const buffer of buffers)gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);throw error; } finally { gl.bindVertexArray(null); }
  }
  remove(geometry: Geometry): void { const r=this.resources.get(geometry);if(r){for(const buffer of r.buffers)this.gl.deleteBuffer(buffer);this.gl.deleteVertexArray(r.vao);this.resources.delete(geometry);} }
  render(camera: Camera, lighting: Lighting, batches: Iterable<Batch>,graph:FrameGraph,delta:number): void {
    const gl=this.gl; if(gl.isContextLost())throw new Error('WebGL context lost');
    graph.execute({backend:'webgl2',gl,camera,width:this.canvas.width,height:this.canvas.height,delta,draw:()=>{
    gl.viewport(0,0,this.canvas.width,this.canvas.height); gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.clearColor(...this.clear); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.camera,false,camera.matrix);gl.uniform3f(this.eye,...camera.position);gl.uniform4fv(this.light,lighting.direction);gl.uniform4fv(this.radiance,lighting.radiance);
    for(const batch of batches)if(batch.count){const r=this.resources.get(batch.geometry)!;gl.bindVertexArray(r.vao);gl.bindBuffer(gl.ARRAY_BUFFER,r.instance);gl.bufferSubData(gl.ARRAY_BUFFER,0,batch.instances,0,batch.count*24);gl.drawElementsInstanced(gl.TRIANGLES,batch.geometry.indices.length,gl.UNSIGNED_INT,0,batch.count);}
    gl.bindVertexArray(null);}});
  }
  dispose(): void { for(const geometry of this.resources.keys())this.remove(geometry);this.gl.deleteProgram(this.program); }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}

/** `transparent`: premultiplied-alpha canvas cleared to transparent black (the WebGL side of `TransparentCanvas` from @margoengine/environment). */
export interface WebGLRendererOptions {transparent?: boolean}
/** Pass as `fallback` to `Engine.create`: `Engine.create(canvas, {fallback: webglRenderer})`, or `fallback: canvas => webglRenderer(canvas, {transparent: true})`. */
export const webglRenderer = (canvas: HTMLCanvasElement, options?: WebGLRendererOptions): Renderer => new GLRenderer(canvas, options);
