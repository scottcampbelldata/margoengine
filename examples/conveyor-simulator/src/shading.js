// Engine plugin that matches the three.js viewer's look on core's instanced draw: two directional
// lights, a hemisphere light, image-based lighting, ACES filmic tone mapping and the page's light
// backdrop. It patches core's shader through the frame graph, like the toon and section plugins.
import {IBL_WGSL, iblBindGroupEntries} from '@margoengine/environment';

const linear = hex => [16, 8, 0].map(shift => {const v = (hex >> shift & 255) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;});
const vec3 = values => `vec3f(${values.map(v => v.toFixed(5)).join(',')})`;

// Values from the three.js viewer: DirectionalLight(0xe0ecff, 1.6) at (70, 45, -90),
// HemisphereLight(0xf7fbff, 0x7f8994, 1.6), ACESFilmicToneMapping at exposure 1.08.
// The key light, DirectionalLight(0xfff7ec, 2.3) at (-30, 100, 75), goes through engine.lighting.
export const KEY_LIGHT = {direction: [-30, 100, 75, 2.3], radiance: [...linear(0xfff7ec), 0]};

const shared = `
fn studioLight(n:vec3f,v:vec3f,base:vec3f,rough:f32,metal:f32,l:vec3f,radiance:vec3f)->vec3f {
  let h=normalize(v+l); let nl=max(dot(n,l),0.0); let nv=max(dot(n,v),0.0001); let nh=max(dot(n,h),0.0); let vh=max(dot(v,h),0.0);
  let a=rough*rough; let a2=a*a; let d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));
  let g=2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001);
  let f0=mix(vec3f(0.04),base,metal); let f=f0+(1.0-f0)*pow(1.0-vh,5.0);
  return ((1.0-f)*(1.0-metal)*base/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl*radiance;
}
fn studioDisplay(color:vec3f)->vec3f {
  let x=mat3x3f(0.59719,0.07600,0.02840,0.35458,0.90834,0.13383,0.04823,0.01566,0.83777)*(color*(1.08/0.6));
  let fit=(x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.4329510)+0.238081);
  let mapped=clamp(mat3x3f(1.60475,-0.10208,-0.00327,-0.53108,1.10813,-0.07276,-0.07367,-0.00605,1.07602)*fit,vec3f(0.0),vec3f(1.0));
  return select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308));
}`;

const body = ibl => `  let n=normalize(i.normal)*select(-1.0,1.0,facing); let v=normalize(frame.eye.xyz-i.position);
  var lit=studioLight(n,v,i.color,i.material.x,i.material.y,normalize(frame.light.xyz),frame.radiance.xyz*frame.light.w)
    +studioLight(n,v,i.color,i.material.x,i.material.y,normalize(vec3f(70.0,45.0,-90.0)),${vec3(linear(0xe0ecff))}*1.6)
    +i.color*(1.0-i.material.y)*mix(${vec3(linear(0x7f8994))},${vec3(linear(0xf7fbff))},0.5*n.y+0.5)*(1.6/3.14159265);
${ibl ? '  lit+=iblShade(iblSpecular,iblSampler,iblBrdf,iblSh,iblParams,n,v,i.color,i.material.y,i.material.x);\n' : ''}  return vec4f(studioDisplay(lit),1);
}`;

const iblDeclarations = first => `
@group(0) @binding(${first}) var iblSpecular:texture_cube<f32>;
@group(0) @binding(${first + 1}) var iblSampler:sampler;
@group(0) @binding(${first + 2}) var iblBrdf:texture_2d<f32>;
@group(0) @binding(${first + 3}) var<uniform> iblSh:array<vec4f,9>;
@group(0) @binding(${first + 4}) var<uniform> iblParams:vec4f;
${IBL_WGSL}`;

// The page's `radial-gradient(ellipse at 50% 30%, #f2f4f5 0, #e5eaee 75%)`, drawn where depth is still clear.
const backdrop = `
@vertex fn vertex(@builtin(vertex_index) id:u32)->@builtin(position) vec4f {return vec4f(f32(id&1u)*4.0-1.0,f32(id>>1u)*4.0-1.0,0.0,1.0);}
@group(0) @binding(0) var<uniform> size:vec4f;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let t=clamp(length((p.xy/size.xy-vec2f(0.5,0.3))*vec2f(1.0,1.0/0.7))/0.75,0.0,1.0);
  return vec4f(mix(vec3f(0.949,0.957,0.961),vec3f(0.898,0.918,0.933),t),1);
}`;

export class StudioShading {
  name = 'conveyor-shading';
  #environment = null; #entries = []; #version = -1; #shaders = new Map();
  #device; #uniform; #pipelines = new Map(); #group; #size = new Float32Array(4);
  #color = {view: undefined, loadOp: 'load', storeOp: 'store'}; #depth = {view: undefined, depthReadOnly: true};
  #pass = {colorAttachments: [this.#color], depthStencilAttachment: this.#depth};

  /** Image-based lighting from an Environment; null falls back to the analytic lights only. */
  set environment(value) {this.#environment = value; this.#version = -1;}

  setup(engine) {
    this.#device = engine.gpu;
    if (!this.#device) return; // WebGL2 fallback keeps core's own shading.
    this.#uniform = this.#device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.#pipelines.clear(); this.#group = undefined; this.#version = -1;
  }
  onDeviceRestored(engine) {this.dispose(); this.setup(engine);}
  dispose() {this.#uniform?.destroy(); this.#uniform = undefined;}

  registerPasses(graph) {
    graph.add({name: 'conveyor:shade', order: -25, execute: context => {
      if (context.backend !== 'webgpu') return;
      const environment = this.#environment?.device === context.device ? this.#environment : null, first = environment ? context.bindings.length + 1 : 0;
      const key = first + context.shader;
      let shader = this.#shaders.get(key);
      if (!shader) {
        const at = context.shader.indexOf('  let n=normalize(i.normal)');
        if (at < 0) throw new Error('Core fragment shader changed; update the conveyor shading patch');
        shader = (environment ? iblDeclarations(first) : '') + shared + context.shader.slice(0, at) + body(!!environment);
        this.#shaders.set(key, shader);
      }
      context.shader = shader;
      if (!environment) return;
      // Reuse the entry objects: core rebuilds its bind group whenever a resource identity changes.
      if (this.#version !== environment.version || this.#entries[0]?.binding !== first) {this.#entries = iblBindGroupEntries(environment, first); this.#version = environment.version;}
      context.bindings.push(...this.#entries);
    }});
    graph.add({name: 'conveyor:backdrop', order: 1, execute: context => {
      if (context.backend !== 'webgpu' || !this.#uniform) return;
      const depthFormat = context.descriptor.depthStencil.format, key = context.format + depthFormat;
      let pipeline = this.#pipelines.get(key);
      if (!pipeline) {
        const module = context.device.createShaderModule({code: backdrop});
        pipeline = context.device.createRenderPipeline({layout: 'auto', vertex: {module, entryPoint: 'vertex'}, fragment: {module, entryPoint: 'fragment', targets: [{format: context.format}]},
          depthStencil: {format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal'}});
        this.#pipelines.set(key, pipeline);
        this.#group = context.device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: this.#uniform}}]});
      }
      if (this.#size[0] !== context.width || this.#size[1] !== context.height) {this.#size[0] = context.width; this.#size[1] = context.height; context.device.queue.writeBuffer(this.#uniform, 0, this.#size);}
      this.#color.view = context.color; this.#depth.view = context.depth;
      if (depthFormat.includes('stencil')) this.#depth.stencilReadOnly = true;
      const pass = context.encoder.beginRenderPass(this.#pass);
      pass.setPipeline(pipeline); pass.setBindGroup(0, this.#group); pass.draw(3); pass.end();
    }});
  }
}
