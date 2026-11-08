import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension, VFXFields, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };

/** Most attractors of an effect. */
export const MAX_ATTRACTORS = 16;
/** Most cells of a vector field (128^3), 16 bytes each on the GPU. */
export const MAX_FIELD_CELLS = 2_097_152;

/** The force sum, in the plain simulation and in the one `obstacles` rewrote (there the flow bends around obstacles with field forces in it). */
const force = 'f.gravityDelta.xyz+curlNoise(p.positionLife.xyz)';

/**
 * attractors[k]: position and strength, then softening radius. Each pulls with strength x d / (|d|^2 + r^2)^(3/2)
 * (Plummer's softened inverse square), so it is finite at its centre and inverse-square far away; a negative strength
 * pushes. The field: cells[x + nx (y + ny z)] are vectors at the cell centres of a box (centre, half size); between
 * centres it is trilinear, past the outer centres it holds the edge value, and outside the box it is zero, times
 * `strength`.
 */
const declarations = (field: boolean) => /* wgsl */ `
struct Fields {count:vec4u,center:vec4f,half:vec4f,attractors:array<vec4f,${MAX_ATTRACTORS * 2}>}
@group(0) @binding(19) var<uniform> fields:Fields;
${
  field
    ? `@group(0) @binding(20) var<storage,read> fieldCells:array<vec4f>;
fn fieldCell(c:vec3u)->vec3f {let n=fields.count.yzw;return fieldCells[c.x+n.x*(c.y+n.y*c.z)].xyz;}`
    : ''
}
fn fieldForce(x:vec3f)->vec3f {
  var a=vec3f(0);
  for(var k=0u;k<fields.count.x;k++){let d=fields.attractors[k*2].xyz-x;let s=fields.attractors[k*2+1].x;let q=dot(d,d)+s*s;a+=d*fields.attractors[k*2].w*inverseSqrt(q*q*q);}
  ${
    field
      ? `let local=(x-fields.center.xyz)/fields.half.xyz;
  if(all(abs(local)<=vec3f(1))){
    let n=fields.count.yzw;let g=clamp((local*0.5+0.5)*vec3f(n)-0.5,vec3f(0),vec3f(n-1u));let i=min(vec3u(g),n-1u);let j=min(i+1u,n-1u);let t=g-vec3f(i);
    let x0=mix(mix(fieldCell(i),fieldCell(vec3u(j.x,i.y,i.z)),t.x),mix(fieldCell(vec3u(i.x,j.y,i.z)),fieldCell(vec3u(j.x,j.y,i.z)),t.x),t.y);
    let x1=mix(mix(fieldCell(vec3u(i.x,i.y,j.z)),fieldCell(vec3u(j.x,i.y,j.z)),t.x),mix(fieldCell(vec3u(i.x,j.y,j.z)),fieldCell(j),t.x),t.y);
    a+=mix(x0,x1,t.z)*fields.half.w;
  }`
      : ''
  }
  return a;
}
`;

const finite = (v: unknown, n: number, name: string): readonly number[] => {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError(`VFX fields ${name} needs ${n} finite numbers`);
  return v;
};

/**
 * The `fields` feature: up to 16 point attractors (or repellers) and one 3D vector field over a box, added to each
 * particle's acceleration. Pass it as `{fields}` to `VFX` from `@margoengine/vfx/base`; the root `VFX` has it. The
 * field's cells are read at attach (and its presence is fixed); attractors, the box and the strengths every frame.
 */
export const fields: VFXExtension<VFXFields> = {
  validate(v) {
    if (!v || typeof v !== 'object') throw new TypeError('VFX fields must be an object; pass {attractors} or {field}');
    const list = v.attractors ?? [];
    if (!Array.isArray(list) || list.length > MAX_ATTRACTORS)
      throw new RangeError(`VFX fields attractors must be an array of at most ${MAX_ATTRACTORS}`);
    list.forEach((a, i) => {
      finite(a?.position, 3, `attractors[${i}].position`);
      if (typeof a.strength !== 'number' || !Number.isFinite(a.strength))
        throw new TypeError(`VFX fields attractors[${i}].strength needs a finite number (negative pushes)`);
      if (a.radius !== undefined && !(a.radius > 0 && Number.isFinite(a.radius)))
        throw new RangeError(`VFX fields attractors[${i}].radius must be above 0; pass e.g. 0.5`);
    });
    const g = v.field;
    if (g !== undefined) {
      const [nx, ny, nz] = finite(g?.size, 3, 'field.size');
      if (![nx, ny, nz].every((n) => Number.isInteger(n) && n >= 1) || nx * ny * nz > MAX_FIELD_CELLS)
        throw new RangeError(`VFX fields field.size needs whole cell counts, at most ${MAX_FIELD_CELLS} cells in all`);
      if (!(g.data instanceof Float32Array) || g.data.length !== nx * ny * nz * 3 || !g.data.every(Number.isFinite))
        throw new RangeError('VFX fields field.data needs a Float32Array of finite xyz vectors, 3 per cell');
      finite(g.center ?? [0, 0, 0], 3, 'field.center');
      const half = finite(g.halfSize, 3, 'field.halfSize');
      if (!half.every((h) => h > 0)) throw new RangeError('VFX fields field.halfSize must be above 0 on every axis');
      if (g.strength !== undefined && !Number.isFinite(g.strength))
        throw new TypeError('VFX fields field.strength needs a finite number');
    }
  },
  simulation(code, v) {
    if (code.split(force).length !== 2)
      throw new MargoError(
        'unsupported',
        'VFX fields need the simulation shader they were written for; update the edit',
      );
    return code
      .replace('fn update(', declarations(!!v.field) + 'fn update(')
      .replace(force, force + '+fieldForce(p.positionLife.xyz)');
  },
  create(state: VFXState, v, owned) {
    const { device, options } = state,
      buffer = device.createBuffer({
        size: 48 + MAX_ATTRACTORS * 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    owned.push(buffer);
    const entries: GPUBindGroupEntry[] = [{ binding: 19, resource: { buffer } }],
      field = v.field,
      grid = field ? [...field.size] : [0, 0, 0];
    if (field) {
      const cells = new Float32Array((field.data.length / 3) * 4);
      for (let i = 0; i < field.data.length / 3; i++) cells.set(field.data.subarray(i * 3, i * 3 + 3), i * 4);
      const storage = device.createBuffer({
        size: cells.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      owned.push(storage);
      device.queue.writeBuffer(storage, 0, cells as Float32Array<ArrayBuffer>);
      entries.push({ binding: 20, resource: { buffer: storage } });
    }
    const values = new Float32Array(12 + MAX_ATTRACTORS * 8),
      ints = new Uint32Array(values.buffer);
    return {
      compute: entries,
      write(c) {
        const now = options.fields;
        if (!now || !!now.field !== !!field || (field && now.field!.data !== field.data))
          throw new TypeError(
            'VFX fields and their field cells are fixed at attach; change attractors and strengths in place',
          );
        const list = now.attractors ?? [];
        values.fill(0);
        ints[0] = list.length;
        ints[1] = grid[0];
        ints[2] = grid[1];
        ints[3] = grid[2];
        if (now.field) {
          values.set(now.field.center ?? [0, 0, 0], 4);
          values.set(now.field.halfSize, 8);
          values[11] = now.field.strength ?? 1;
        }
        list.forEach((a, k) => {
          values.set([...a.position, a.strength, a.radius ?? 0.5], 12 + k * 8);
        });
        c.device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
      },
    };
  },
};
