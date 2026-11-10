/// <reference lib="esnext.disposable" preserve="true" />
import type { CullShape } from './shape.js';
import type { PassContext } from '@margoengine/core/extension';
import { CulledMeshes } from './meshes.js';
import { CulledModels } from './models.js';
import { DynamicInstances } from './dynamic.js';
import { localBox, SoftwareDepthBuffer, transform } from './software-depth.js';
import { exactShader } from './pyramid.js';

// A transformed local AABB stays an oriented parallelepiped under rotation, nonuniform scale and shear.
const planeCode = `
fn boxKeep(m:mat4x4f)->bool {
 let c=(m*vec4f(b.boxCenter.xyz,1.0)).xyz;
 let x=m[0].xyz*b.boxHalf.x;let y=m[1].xyz*b.boxHalf.y;let z=m[2].xyz*b.boxHalf.z;
 let pad=1e-5*(1.0+length(c)+length(x)+length(y)+length(z));
 for(var p=0u;p<6u;p++){
  let n=f.planes[p].xyz;let r=abs(dot(n,x))+abs(dot(n,y))+abs(dot(n,z))+pad*length(n);
  if(dot(n,c)+f.planes[p].w< -r){return false;}
 }
 return true;
}
`;
const depthCode = `
fn boxDepth(m:mat4x4f)->bool {
 let center=(m*vec4f(b.boxCenter.xyz,1.0)).xyz;
 let x=m[0].xyz*b.boxHalf.x;let y=m[1].xyz*b.boxHalf.y;let z=m[2].xyz*b.boxHalf.z;
 let pad=1e-5*(1.0+length(center)+length(x)+length(y)+length(z));
 let e=(abs(u.camera[0])+abs(u.camera[1])+abs(u.camera[2]))*pad;
 var lo=vec2f(3.0e38);var hi=vec2f(-3.0e38);var near=0.0;
 for(var i=0u;i<8u;i++){
  let s=vec3f(f32(i&1u),f32((i>>1u)&1u),f32(i>>2u))*2.0-1.0;
  let q=u.camera*vec4f(center+s.x*x+s.y*y+s.z*z,1.0);
  if(q.w-e.w<=1e-6){return true;}
  let a=(q.xy-e.xy)/(q.w-e.w);let bb=(q.xy+e.xy)/(q.w-e.w);
  let cc=(q.xy-e.xy)/(q.w+e.w);let d=(q.xy+e.xy)/(q.w+e.w);
  lo=min(lo,min(min(a,bb),min(cc,d)));hi=max(hi,max(max(a,bb),max(cc,d)));
  near=max(near,(q.z+e.z)/(q.w-e.w));
 }
 return reaches(lo,hi,near);
}
`;
function shape(): CullShape {
  const cache = new WeakMap<Float32Array, Map<number, Float64Array>>();
  let depth: SoftwareDepthBuffer | undefined,
    occlusion = false;
  const box = (vertices: Float32Array, stride: number, padding = 0) => {
    let strides = cache.get(vertices);
    if (!strides) cache.set(vertices, (strides = new Map()));
    let bounds = strides.get(stride);
    if (!bounds) {
      bounds = localBox({ vertices, indices: new Uint32Array(0) }, stride);
      if (!vertices.length) bounds.fill(0);
      strides.set(stride, bounds);
    }
    if (!padding) return bounds;
    return Float64Array.from(bounds, (v, i) => v + (i < 3 ? -padding : padding));
  };
  return {
    shader(code, matrix) {
      code = code.replace(
        /struct Part \{([^}]+)\}/,
        (_, fields) => `struct Part {${fields},boxCenter:vec4f,boxHalf:vec4f}`,
      );
      if (code.includes('struct Item'))
        code = code
          .replace('shape:vec4u}', 'shape:vec4u,boxCenter:vec4f,boxHalf:vec4f}')
          .replace(
            'b.sphere=items[i].sphere;',
            'b.sphere=items[i].sphere;b.boxCenter=items[i].boxCenter;b.boxHalf=items[i].boxHalf;',
          );
      code = code
        .replace(`keep(bound(${matrix}))`, `keep(bound(${matrix}))&&boxKeep(${matrix})`)
        .replace('keep(s)&&unoccluded(s)', `keep(s)&&boxKeep(${matrix})&&boxDepth(${matrix})`)
        .replace(
          'keep(s)&&(u.mode.x!=2u||unoccluded(s))',
          `keep(s)&&boxKeep(${matrix})&&(u.mode.x!=2u||boxDepth(${matrix}))`,
        )
        .replace('shown(i)&&keep(matrix(i))', 'shown(i)&&keep(matrix(i))&&boxKeep(matrix(i))');
      return code + planeCode + (code.includes('fn reaches(') ? depthCode : '');
    },
    write(target, offset, vertices, stride, padding = 0) {
      const bounds = box(vertices, stride, padding);
      for (let k = 0; k < 3; k++) {
        target[offset + k] = (bounds[k] + bounds[k + 3]) / 2;
        target[offset + 4 + k] = (bounds[k + 3] - bounds[k]) / 2;
      }
    },
    prepare(context: PassContext, enabled: boolean) {
      occlusion = context.backend === 'webgpu' && enabled && exactShader(context.shader);
      if (!occlusion || context.backend !== 'webgpu') return;
      depth ??= new SoftwareDepthBuffer();
      depth.clear(context.camera.matrix);
      for (const batch of context.batches ?? [])
        if (!batch.claimed)
          for (let i = 0; i < batch.count; i++) {
            const row = batch.instances.subarray(i * 24, i * 24 + 24);
            depth.rasterize(batch.geometry, row, row[22] >= 0.5);
          }
    },
    cpu(records, at, vertices, stride, padding, frame) {
      const bounds = box(vertices, stride, padding),
        m = records.subarray(at, at + 16),
        center = transform(m, (bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2),
        half = [0, 1, 2].map((k) => (bounds[k + 3] - bounds[k]) / 2),
        pad = 1e-5 * (1 + Math.hypot(...center.slice(0, 3)) + Math.hypot(...half) * Math.hypot(...m.slice(0, 12)));
      for (let p = 16; p < 40; p += 4) {
        let r = pad * Math.hypot(frame[p], frame[p + 1], frame[p + 2]);
        for (let k = 0; k < 3; k++)
          r += Math.abs(frame[p] * m[k * 4] + frame[p + 1] * m[k * 4 + 1] + frame[p + 2] * m[k * 4 + 2]) * half[k];
        if (frame[p] * center[0] + frame[p + 1] * center[1] + frame[p + 2] * center[2] + frame[p + 3] < -r)
          return false;
      }
      return !occlusion || !depth || depth.visible(bounds, m);
    },
  };
}
/** CulledMeshes with oriented box frustum and Hi-Z tests; all existing options and methods apply. */
export class BoxCulledMeshes extends CulledMeshes {
  protected override shape = shape();
  /** Attach an oriented-box culler to core meshes. */
  static override attach(...[engine, options]: Parameters<typeof CulledMeshes.attach>): BoxCulledMeshes {
    const value = new BoxCulledMeshes(options);
    engine.use(value);
    return value;
  }
}
/** CulledModels with oriented boxes for plain and instanced primitives, including local displacement padding. */
export class BoxCulledModels extends CulledModels {
  protected override shape = shape();
  /** Attach box culling to model and materials primitives. */
  static override attach(...[engine, models = [], options]: Parameters<typeof CulledModels.attach>): BoxCulledModels {
    const value = new BoxCulledModels(options);
    for (const model of models) value.add(model);
    engine.use(value);
    return value;
  }
}
/** DynamicInstances with oriented box frustum tests; the live-row, shadow and picking contracts stay the same. */
export class BoxDynamicInstances extends DynamicInstances {
  protected override shape = shape();
  /** Attach a moving instance list with oriented boxes. */
  static override attach(...[engine, options]: Parameters<typeof DynamicInstances.attach>): BoxDynamicInstances {
    const value = new BoxDynamicInstances(options);
    engine.use(value);
    return value;
  }
}
