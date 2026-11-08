import { applyView } from '../../shared/view-rect.js';
import type { VFXExtension, VFXMeshParticles, VFXState } from './base.js';
import { frame } from './frame.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; INDIRECT: number; COPY_DST: number };

/** Most triangles of a particle mesh (each corner takes 32 bytes on the GPU and runs for every drawn particle). */
export const MAX_PARTICLE_MESH_TRIANGLES = 65_536;

const defaultLight = [0.4, 1, 0.3] as const;

/**
 * The mesh's corners as the shader reads them: position (scaled so the farthest vertex from the mesh origin is 1) and
 * normal, two vec4s a corner. Without `normals` each triangle takes its face normal (counter-clockwise faces point out).
 */
export function meshCorners(m: VFXMeshParticles): Float32Array {
  const pos = m.positions,
    count = pos.length / 3,
    index = m.indices ?? Array.from({ length: count }, (_, i) => i);
  let radius = 0;
  for (let i = 0; i < count; i++) radius = Math.max(radius, Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  const out = new Float32Array(index.length * 8);
  for (let t = 0; t < index.length; t += 3) {
    const at = (k: number) => [0, 1, 2].map((c) => pos[index[t + k] * 3 + c]),
      a = at(0),
      b = at(1),
      c = at(2),
      u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
      face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      length = Math.hypot(...face) || 1;
    [a, b, c].forEach((p, k) => {
      const n = m.normals ? [0, 1, 2].map((e) => m.normals![index[t + k] * 3 + e]) : face.map((e) => e / length),
        nl = Math.hypot(...n) || 1;
      out.set([p[0] / radius, p[1] / radius, p[2] / radius, 0, n[0] / nl, n[1] / nl, n[2] / nl, 0], (t + k) * 8);
    });
  }
  return out;
}

/**
 * One instance per listed particle (the billboards' draw list, so culling and `sort` order apply), one vertex per mesh
 * corner. `random`: the mesh turns by the particle's angle (birth angle + spin x age) about an axis drawn from its birth
 * angle (uniform on the sphere: z and longitude from the hash's two halves), so each piece tumbles its own way.
 * `velocity`: the mesh's +y follows the particle's velocity and the angle spins it about that line. The mesh's radius is
 * half the particle size, so the billboards' cull sphere (radius size) holds it. Lambert shading from one directional
 * light plus ambient (direction.w), opaque and depth written.
 */
const shader = (align: 'random' | 'velocity') =>
  frame +
  /* wgsl */ `
@group(0) @binding(1) var<storage,read> particles:array<vec4f>;
@group(0) @binding(2) var<storage,read> alive:array<u32>;
@group(0) @binding(15) var<storage,read> meshCorners:array<vec4f>;
struct MeshLight {direction:vec4f,color:vec4f}
@group(0) @binding(16) var<uniform> meshLight:MeshLight;
struct Out {@builtin(position) clip:vec4f,@location(0) color:vec3f,@location(1) normal:vec3f}
fn turn(v:vec3f,axis:vec3f,angle:f32)->vec3f {let c=cos(angle);let s=sin(angle);return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1-c);}
fn meshHash(v:u32)->u32 {var x=v;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return x^(x>>16u);}
@vertex fn vertex(@builtin(vertex_index) corner:u32,@builtin(instance_index) instance:u32)->Out {
  let at=alive[instance]*2;let cold=f.control.x*2+at;let p=particles[at];let vs=particles[at+1];let color=particles[cold];let r=particles[cold+1];
  let angle=r.x+r.y*(r.z-p.w);var q=meshCorners[corner*2].xyz;var n=meshCorners[corner*2+1].xyz;
  ${
    align === 'random'
      ? `let h=meshHash(bitcast<u32>(r.x));let z=f32(h&0xffffu)/32767.5-1;let lon=f32(h>>16u)/65536*6.2831853;let s=sqrt(max(0.0,1-z*z));
  let axis=vec3f(s*cos(lon),z,s*sin(lon));q=turn(q,axis,angle);n=turn(n,axis,angle);`
      : `let speed=length(vs.xyz);let y=select(vec3f(0,1,0),vs.xyz/speed,speed>1e-6);
  let x=normalize(cross(y,select(vec3f(0,0,1),vec3f(1,0,0),abs(y.z)>0.9)));let z=cross(x,y);
  q=turn(q,vec3f(0,1,0),angle);n=turn(n,vec3f(0,1,0),angle);q=x*q.x+y*q.y+z*q.z;n=x*n.x+y*n.y+z*n.z;`
  }
  var o:Out;o.clip=f.camera*vec4f(p.xyz+q*vs.w*0.5,1);o.normal=n;o.color=color.rgb;return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let lit=meshLight.direction.w+(1-meshLight.direction.w)*max(dot(normalize(i.normal),meshLight.direction.xyz),0.0);
  return vec4f(i.color*meshLight.color.rgb*lit,1);
}`;

/** Checks a finite flat list of numbers. */
const list = (v: unknown, name: string): ArrayLike<number> => {
  const a = v as ArrayLike<number>;
  if (!a || typeof a !== 'object' || typeof a.length !== 'number')
    throw new TypeError(`VFX mesh ${name} must be an array of numbers; pass a Float32Array or number[]`);
  for (let i = 0; i < a.length; i++)
    if (typeof a[i] !== 'number' || !Number.isFinite(a[i]))
      throw new RangeError(`VFX mesh ${name}[${i}] is not a finite number; pass finite values`);
  return a;
};

/** Mesh objects whose geometry passed the checks, so the frame's validation does not walk a large mesh again. */
const checked = new WeakSet<VFXMeshParticles>();

/** Checks the geometry, which is read once at attach. */
function geometry(m: VFXMeshParticles): void {
  const pos = list(m.positions, 'positions');
  if (pos.length % 3 || pos.length < 9)
    throw new RangeError('VFX mesh positions must be xyz triples, at least one triangle; pass 3 numbers a vertex');
  const vertices = pos.length / 3,
    index = m.indices === undefined ? undefined : list(m.indices, 'indices'),
    corners = index ? index.length : vertices;
  if (corners % 3 || !corners || corners / 3 > MAX_PARTICLE_MESH_TRIANGLES)
    throw new RangeError(
      `VFX mesh needs 1 to ${MAX_PARTICLE_MESH_TRIANGLES} whole triangles; pass indices (or positions) a multiple of 3`,
    );
  if (index)
    for (let i = 0; i < index.length; i++)
      if (!Number.isInteger(index[i]) || index[i] < 0 || index[i] >= vertices)
        throw new RangeError(`VFX mesh indices[${i}] is ${index[i]}; pass whole numbers below ${vertices}`);
  if (m.normals !== undefined && list(m.normals, 'normals').length !== pos.length)
    throw new RangeError('VFX mesh normals must have one xyz normal per vertex, as many numbers as positions');
  let far = 0;
  for (let i = 0; i < pos.length; i++) far = Math.max(far, Math.abs(pos[i]));
  if (!far) throw new RangeError('VFX mesh positions are all at the origin; pass a mesh with some size');
  checked.add(m);
}

/**
 * The `mesh` feature: draws each particle as an instance of a small triangle mesh instead of a billboard, tumbling by
 * its spin or following its velocity, lit by one directional light. Pass it as `{mesh}` to `VFX` from
 * `@margoengine/vfx/base`; the root `VFX` has it. The mesh is read at attach; `light`, `color` and `ambient` every frame.
 */
export const mesh: VFXExtension<VFXMeshParticles> = {
  validate(m) {
    if (!m || typeof m !== 'object')
      throw new TypeError('VFX mesh must be an object with positions; pass e.g. {positions, indices}');
    if (!checked.has(m)) geometry(m);
    if (m.align !== undefined && m.align !== 'random' && m.align !== 'velocity')
      throw new TypeError(`VFX mesh align is ${String(m.align)}; pass 'random' or 'velocity'`);
    const light = m.light ?? defaultLight;
    if (!Array.isArray(light) || light.length !== 3 || !light.every(Number.isFinite) || !Math.hypot(...light))
      throw new RangeError('VFX mesh light must be a nonzero direction [x, y, z] towards the light');
    const color = m.lightColor ?? [1, 1, 1];
    if (!Array.isArray(color) || color.length !== 3 || !color.every((c) => Number.isFinite(c) && c >= 0 && c <= 16))
      throw new RangeError('VFX mesh lightColor must be linear [r, g, b], each 0 to 16');
    if (m.ambient !== undefined && !(typeof m.ambient === 'number' && m.ambient >= 0 && m.ambient <= 1))
      throw new RangeError('VFX mesh ambient must be 0 to 1; pass e.g. 0.35');
  },
  create(state: VFXState, value, owned) {
    // The arrays may have changed since the construction's check; they are read now, once.
    geometry(value);
    const { device, options } = state,
      corners = meshCorners(value),
      count = corners.length / 8,
      align = value.align ?? 'random',
      vertices = device.createBuffer({
        size: corners.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    owned.push(vertices);
    device.queue.writeBuffer(vertices, 0, corners as Float32Array<ArrayBuffer>);
    const light = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(light);
    // The draw's arguments: the mesh's corners, and the billboards' count of listed particles copied in each frame.
    const indirect = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    owned.push(indirect);
    device.queue.writeBuffer(indirect, 0, new Uint32Array([count, 0, 0, 0]));
    const values = new Float32Array(8),
      pipelines = new Map<string, [GPURenderPipeline, GPUBindGroup]>(),
      color: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' },
      depth: GPURenderPassDepthStencilAttachment = {
        view: undefined!,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
      descriptor: GPURenderPassDescriptor = { colorAttachments: [color], depthStencilAttachment: depth };
    let module: GPUShaderModule | undefined;
    const settings = () => {
      if (options.mesh !== value)
        throw new TypeError('VFX mesh is fixed at attach; change its light in place or attach a new VFX');
      return value;
    };
    return {
      hides: () => true,
      write(c) {
        const m = settings(),
          d = m.light ?? defaultLight,
          length = Math.hypot(d[0], d[1], d[2]);
        values.set([d[0] / length, d[1] / length, d[2] / length, m.ambient ?? 0.35, ...(m.lightColor ?? [1, 1, 1]), 0]);
        c.device.queue.writeBuffer(light, 0, values as Float32Array<ArrayBuffer>);
      },
      draw(c) {
        const format = c.descriptor.depthStencil!.format,
          samples = c.descriptor.multisample?.count ?? 1,
          key = c.format + ':' + format + ':' + samples;
        let drawing = pipelines.get(key);
        if (!drawing) {
          module ??= device.createShaderModule({ code: shader(align) });
          const pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            multisample: c.descriptor.multisample,
            depthStencil: { format, depthWriteEnabled: true, depthCompare: 'greater' },
          });
          drawing = [
            pipeline,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: state.uniform } },
                { binding: 1, resource: { buffer: state.particles } },
                { binding: 2, resource: { buffer: state.alive } },
                { binding: 15, resource: { buffer: vertices } },
                { binding: 16, resource: { buffer: light } },
              ],
            }),
          ];
          pipelines.set(key, drawing);
        }
        c.encoder.copyBufferToBuffer(state.visible, 4, indirect, 4, 4);
        color.view = c.color;
        depth.view = c.depth;
        const stencil = format.includes('stencil');
        depth.stencilLoadOp = stencil ? 'load' : undefined;
        depth.stencilStoreOp = stencil ? 'store' : undefined;
        const pass = c.encoder.beginRenderPass(descriptor);
        pass.setPipeline(drawing[0]);
        pass.setBindGroup(0, drawing[1]);
        applyView(pass, c);
        pass.drawIndirect(indirect, 0);
        pass.end();
        state.stats.drawCalls++;
      },
    };
  },
};
