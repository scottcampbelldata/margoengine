// Far shadows from a height field. Each cell of the field holds the height below which the sun cannot reach it and how far
// off the ridge that casts it stands, found by one march towards the sun per cell, on the GPU, whenever the sun has moved.
// A receiver past the cascades then reads one bilinear pair: a shadow of mountains out to the horizon for a buffer read. Its
// light is the share of the sun's disc above that horizon, the disc's segment area at the ridge's distance.
import type { ShadowEffect, ShadowEffectFrame } from './shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
/** {@link distanceShadows} settings. `strength`, `fade`, `sunSize` and `bias` are read every frame from `options`. */
export interface DistanceShadowOptions {
  /** Heights, `columns` x `rows`, row by row from the minimum corner, as `heightScale` scales them. */
  heights: Float32Array;
  /** Cells along X, 2 or more. */
  columns: number;
  /** Cells along Z, 2 or more. */
  rows: number;
  /** World XZ of the minimum corner. Default [0, 0]. */
  origin?: readonly [number, number];
  /** World XZ extent of the field, each above 0. */
  size: readonly [number, number];
  /** World Y per height unit. Default 1. */
  heightScale?: number;
  /** World Y added to every height. Default 0. */
  heightOffset?: number;
  /** Share of the cascades' reach, 0 to 1, over which far shadows fade in before it ends. Default 0.1. */
  fade?: number;
  /** How much of the far shadow applies, 0 to 1. Default 1. */
  strength?: number;
  /** The sun's angular diameter in radians, which widens the far penumbra with the ridge's distance. Default 0.0093. */
  sunSize?: number;
  /** World units a receiver lifts over the field, to cover the field's own coarseness, 0 or more. Default 0. */
  bias?: number;
  /** Degrees the sun must move before the field is marched again, 0 or more. Default 0.25. */
  sunStep?: number;
}
/** The effect `distanceShadows` returns, with live `options`. */
export interface DistanceShadows<Context = unknown> extends ShadowEffect<Context> {
  readonly options: DistanceShadowOptions;
  /** March the field again next frame, after editing `heights`. */
  invalidate(): void;
}
// One thread per cell. plane(d) is the ridge's height less the sun's climb over distance d: a point of height y here is in
// shadow when some ridge's plane stands above y. The march stops once even the field's top could not stand above the best.
const march = /* wgsl */ `struct March {sun:vec4f,cell:vec4f,size:vec4u,top:vec4f}
@group(0) @binding(0) var<uniform> m:March;
@group(0) @binding(1) var<storage,read> heights:array<f32>;
@group(0) @binding(2) var<storage,read_write> shade:array<vec2f>;
fn heightAt(p:vec2f)->f32 {
  let hi=vec2i(m.size.xy)-1;let b=floor(p);let f=p-b;let c=vec2i(b);let w=i32(m.size.x);
  let c0=clamp(c,vec2i(0),hi);let c1=clamp(c+vec2i(1),vec2i(0),hi);
  let h=mix(mix(heights[c0.y*w+c0.x],heights[c0.y*w+c1.x],f.x),mix(heights[c1.y*w+c0.x],heights[c1.y*w+c1.x],f.x),f.y);
  return h*m.top.y+m.top.z;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=m.size.xy)){return;}
  let flat=length(m.sun.xz);let tangent=m.sun.y/max(flat,0.000001);
  let step=m.sun.xz/max(flat,0.000001);let stepCells=step/max(abs(step.x),abs(step.y))/m.cell.xy*min(m.cell.x,m.cell.y);
  let worldStep=length(stepCells*m.cell.xy);
  var best=-1e30;var far=0.0;var p=vec2f(id.xy);
  let bound=vec2f(m.size.xy)-1.0;
  if(flat>0.000001){
    for(var i=1u;i<m.size.z;i++){
      p+=stepCells;
      if(any(p<vec2f(0))||any(p>bound)){break;}
      let d=f32(i)*worldStep;
      if(m.top.x-d*tangent<best){break;}
      let plane=heightAt(p)-d*tangent;
      if(plane>best){best=plane;far=d;}
    }
  }
  shade[id.y*m.size.x+id.x]=vec2f(best,far);
}`;
/**
 * Shadows of mountains and other height fields past the reach of the cascades or virtual pages:
 * `Shadows.attach(engine, {distance: 300, effects: [distanceShadows({heights, columns, rows, size})]})`. Cheap and coarse:
 * no depth pass, one storage buffer and one bilinear read per lit pixel past the reach, no sampled texture. What is not in
 * the field casts nothing here. Outside the field nothing is shaded. Throws RangeError for inconsistent sizes.
 */
export function distanceShadows<Context extends { device: GPUDevice; encoder: GPUCommandEncoder }>(
  options: DistanceShadowOptions,
): DistanceShadows<Context> {
  const { heights, columns, rows, size } = options;
  if (!(heights instanceof Float32Array) || !(columns >= 2) || !(rows >= 2) || heights.length !== columns * rows)
    throw new RangeError('Invalid distance shadow heights; give a Float32Array of columns x rows, each 2 or more');
  if (!size || !(size[0] > 0) || !(size[1] > 0)) throw new RangeError('Invalid distance shadow size; give [x, z] above 0');
  const values = new Float32Array(16),
    words = new Uint32Array(values.buffer),
    frame = new Float32Array(16),
    sun = new Float32Array(3);
  let binding = 0,
    device: GPUDevice | undefined,
    heightBuffer: GPUBuffer | undefined,
    shade: GPUBuffer | undefined,
    marchUniform: GPUBuffer | undefined,
    uniform: GPUBuffer | undefined,
    pipeline: GPUComputePipeline | undefined,
    group: GPUBindGroup | undefined,
    stale = true;
  const free = () => {
    for (const buffer of [heightBuffer, shade, marchUniform, uniform]) buffer?.destroy();
    heightBuffer = shade = marchUniform = uniform = undefined;
    pipeline = undefined;
    group = undefined;
    stale = true;
  };
  return {
    options,
    invalidate() {
      stale = true;
    },
    get call() {
      return `vec3f(shadowFxFar${binding}(position))`;
    },
    wgsl(bindGroup, at) {
      binding = at;
      return /* wgsl */ `struct ShadowFxFarFrame${at} {place:vec4f,cells:vec4f,style:vec4f}
@group(${bindGroup}) @binding(${at}) var<uniform> shadowFxFarData${at}:ShadowFxFarFrame${at};
@group(${bindGroup}) @binding(${at + 1}) var<storage,read> shadowFxFarCells${at}:array<vec2f>;
fn shadowFxFarCell${at}(c:vec2i)->vec2f {
  let u=shadowFxFarData${at};let hi=vec2i(u.cells.xy)-1;let k=clamp(c,vec2i(0),hi);return shadowFxFarCells${at}[k.y*i32(u.cells.x)+k.x];
}
fn shadowFxFar${at}(position:vec3f)->f32 {
  let u=shadowFxFarData${at};let depth=-(shadowFrame.view*vec4f(position,1)).z;let reach=shadowReach();
  let weight=smoothstep(reach*(1.0-u.style.x),reach,depth)*u.style.y;if(weight<=0.0){return 1.0;}
  let cell=(position.xz-u.place.xy)/u.place.zw*(u.cells.xy-1.0);
  if(any(cell<vec2f(0))||any(cell>u.cells.xy-1.0)){return 1.0;}
  let b=floor(cell);let f=cell-b;let c=vec2i(b);
  let s=mix(mix(shadowFxFarCell${at}(c),shadowFxFarCell${at}(c+vec2i(1,0)),f.x),mix(shadowFxFarCell${at}(c+vec2i(0,1)),shadowFxFarCell${at}(c+vec2i(1)),f.x),f.y);
  let penumbra=max(s.y*u.style.z,u.style.w*0.5+0.0001);
  let t=clamp(2.0*(position.y+u.style.w-s.x)/penumbra,-1.0,1.0);
  let lit=0.5+(t*sqrt(1.0-t*t)+asin(t))/3.14159265;
  return mix(1.0,lit,weight);
}
`;
    },
    resources() {
      return [{ buffer: uniform! }, { buffer: shade! }];
    },
    setup(gpu: GPUDevice) {
      free();
      device = gpu;
      heightBuffer = gpu.createBuffer({ size: heights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      shade = gpu.createBuffer({ size: columns * rows * 8, usage: GPUBufferUsage.STORAGE });
      marchUniform = gpu.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      uniform = gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    },
    update(f: ShadowEffectFrame<Context>) {
      const o = this.options,
        gpu = device!,
        { origin = [0, 0], heightScale = 1, heightOffset = 0, fade = 0.1, strength = 1 } = o,
        { sunSize = 0.0093, bias = 0, sunStep = 0.25 } = o;
      if (!(fade > 0 && fade <= 1) || !(strength >= 0 && strength <= 1))
        throw new RangeError('Invalid distance shadow fade or strength; use above 0 to 1 and 0 to 1');
      if (!(sunSize >= 0) || !(bias >= 0) || !(sunStep >= 0))
        throw new RangeError('Invalid distance shadow sunSize, bias or sunStep; use 0 or more');
      frame[0] = origin[0];
      frame[1] = origin[1];
      frame[2] = size[0];
      frame[3] = size[1];
      frame[4] = columns;
      frame[5] = rows;
      frame[8] = fade;
      frame[9] = strength;
      frame[10] = sunSize;
      frame[11] = bias;
      gpu.queue.writeBuffer(uniform!, 0, frame, 0, 12);
      const l = f.light,
        moved = l[0] * sun[0] + l[1] * sun[1] + l[2] * sun[2] < Math.cos((sunStep * Math.PI) / 180);
      if (!stale && !moved) return;
      for (let i = 0; i < 3; i++) sun[i] = l[i];
      let top = -Infinity;
      for (let i = 0; i < heights.length; i++) if (heights[i] > top) top = heights[i];
      gpu.queue.writeBuffer(heightBuffer!, 0, heights as Float32Array<ArrayBuffer>);
      values.set(sun);
      values[4] = size[0] / (columns - 1);
      values[5] = size[1] / (rows - 1);
      words[8] = columns;
      words[9] = rows;
      // Each step spans the shorter cell side, so a long cell takes several: enough to cross the field along either axis.
      words[10] = Math.ceil(((columns + rows) * Math.max(values[4], values[5])) / Math.min(values[4], values[5]));
      values[12] = top * heightScale + heightOffset;
      values[13] = heightScale;
      values[14] = heightOffset;
      gpu.queue.writeBuffer(marchUniform!, 0, values);
      pipeline ??= gpu.createComputePipeline({
        layout: 'auto',
        compute: { module: gpu.createShaderModule({ code: march }), entryPoint: 'main' },
      });
      group ??= gpu.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: marchUniform! } },
          { binding: 1, resource: { buffer: heightBuffer! } },
          { binding: 2, resource: { buffer: shade! } },
        ],
      });
      const pass = f.context.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(columns / 8), Math.ceil(rows / 8));
      pass.end();
      stale = false;
    },
    dispose: free,
  };
}
