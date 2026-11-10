import { MargoError } from '@margoengine/math/errors';
import type { VFXEmitter, VFXFeatures } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };

/** Most triangles of a mesh emitter (each takes 48 bytes on the GPU). */
export const MAX_EMITTER_TRIANGLES = 262_144;

const declarations = /* wgsl */ `
struct Emitter {a:vec4f,b:vec4f,count:vec4u}
@group(0) @binding(7) var<uniform> em:Emitter;
`;
const triangles = /* wgsl */ `@group(0) @binding(8) var<storage,read> tris:array<vec4f>;
`;
const origin =
  'let origin=f.emitterTime.xyz+(vec3f(random(seed+5u),random(seed+6u),random(seed+7u))*2-1)*f.emissionExtent.xyz;';
const velocity = 'f.velocitySpread.xyz+(vec3f(random(seed+1u),random(seed+2u),random(seed+3u))*2-1)*f.velocitySpread.w';

// Each shape adds an offset to the birth position and a direction (shapeDir) that `speed` scales into the velocity.
const shapes = {
  // A uniform point of the ball or, with `shell`, of the sphere's surface: the z and angle of a uniform direction
  // (Archimedes' hat-box), and a cube root of the third draw for uniform volume.
  sphere: /* wgsl */ `
  let su=random(seed+8u);let sv=random(seed+9u);let sw=random(seed+10u);
  let sz=1.0-2.0*sv;let sr=sqrt(max(0.0,1.0-sz*sz));let sa=6.2831853*su;
  shapeDir=vec3f(sr*cos(sa),sz,sr*sin(sa));
  origin+=shapeDir*em.a.x*select(pow(sw,0.3333333),1.0,em.a.y>0.5);`,
  // A uniform disc of radius a.x at the apex, and a direction uniform in solid angle inside the half angle: cos of the
  // angle off the axis is uniform between 1 and cos(angle).
  cone: /* wgsl */ `
  let axis=normalize(em.b.xyz);let helper=select(vec3f(0,1,0),vec3f(1,0,0),abs(axis.y)>0.99);
  let tx=normalize(cross(helper,axis));let ty=cross(axis,tx);
  let ca=random(seed+8u)*6.2831853;let cv=random(seed+9u);let cd=random(seed+10u)*6.2831853;let cw=random(seed+11u);
  let cosT=mix(1.0,em.a.w,cv);let sinT=sqrt(max(0.0,1.0-cosT*cosT));
  shapeDir=axis*cosT+(tx*cos(ca)+ty*sin(ca))*sinT;
  origin+=(tx*cos(cd)+ty*sin(cd))*sqrt(cw)*em.a.x;`,
  // A triangle chosen by area (binary search of the running share in the first vec4's w) and a uniform point of it
  // (Osada et al., Shape Distributions, 2002: r1 = sqrt(u), point = (1-r1)A + r1(1-r2)B + r1 r2 C).
  mesh: /* wgsl */ `
  let share=random(seed+8u);var lo=0u;var hi=em.count.x-1u;
  loop{if(lo>=hi){break;}let mid=(lo+hi)/2u;if(tris[mid*3u].w<share){lo=mid+1u;}else{hi=mid;}}
  let ta=tris[lo*3u].xyz;let tb=tris[lo*3u+1u].xyz;let tc=tris[lo*3u+2u].xyz;
  let r1=sqrt(random(seed+9u));let r2=random(seed+10u);
  origin+=ta*(1.0-r1)+tb*(r1*(1.0-r2))+tc*(r1*r2);
  shapeDir=normalize(cross(tb-ta,tc-ta));`,
};

function once(code: string, from: string, to: string): string {
  if (code.split(from).length !== 2)
    throw new MargoError(
      'unsupported',
      'VFX emitter needs the simulation shader it was written for; update the emitter edits',
    );
  return code.replace(from, to);
}

const num = (value: unknown, name: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`VFX emitter ${name} must be a number from ${min} to ${max}; pass a finite value in range`);
};

/** Triangles as the shader reads them: A and the running area share, B, C; zero-area triangles left out. */
function buildTriangles(e: Extract<VFXEmitter, { shape: 'mesh' }>): Float32Array {
  const scale = e.scale ?? 1,
    pos = e.positions,
    index = e.indices ?? Array.from({ length: pos.length / 3 }, (_, i) => i);
  const corners: number[][] = [];
  const areas: number[] = [];
  const at = (i: number) => [pos[i * 3] * scale, pos[i * 3 + 1] * scale, pos[i * 3 + 2] * scale];
  for (let t = 0; t < index.length; t += 3) {
    const a = at(index[t]),
      b = at(index[t + 1]),
      c = at(index[t + 2]),
      u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
      area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (area > 0) {
      corners.push([...a, ...b, ...c]);
      areas.push(area);
    }
  }
  if (!corners.length)
    throw new RangeError('VFX mesh emitter has no triangle with an area; pass positions and indices of a real surface');
  const total = areas.reduce((s, v) => s + v, 0),
    out = new Float32Array(corners.length * 12);
  let run = 0;
  corners.forEach((c, i) => {
    run += areas[i];
    out.set([c[0], c[1], c[2], i === corners.length - 1 ? 1 : run / total], i * 12);
    out.set([c[3], c[4], c[5], 0], i * 12 + 4);
    out.set([c[6], c[7], c[8], 0], i * 12 + 8);
  });
  return out;
}

/**
 * The `emitter` feature: where births start and which way `speed` pushes them. `sphere` (ball or shell), `cone` and
 * `mesh` (the surface of a triangle mesh, area-weighted, pushed along each face's normal). Pass it as `{emitter}` to
 * `VFX` from `@margoengine/vfx/base`; the root `VFX` has it. The shape and a mesh's triangles are read at attach; sizes,
 * angle, axis and speed can change every frame.
 */
export const emitter: NonNullable<VFXFeatures['emitter']> = {
  validate(e: VFXEmitter, mesh = true): void {
    if (!e || typeof e !== 'object' || (e.shape !== 'sphere' && e.shape !== 'cone' && e.shape !== 'mesh'))
      throw new TypeError(
        'VFX emitter needs a shape of "sphere", "cone" or "mesh"; pass e.g. {shape: "sphere", radius: 1}',
      );
    if (e.speed !== undefined) num(e.speed, 'speed', -1000, 1000);
    if (e.shape === 'sphere') {
      if (e.radius !== undefined) num(e.radius, 'radius', 0, 1e6);
      if (e.shell !== undefined && typeof e.shell !== 'boolean')
        throw new TypeError('VFX emitter shell must be true or false; pass a boolean');
    } else if (e.shape === 'cone') {
      if (e.radius !== undefined) num(e.radius, 'radius', 0, 1e6);
      if (e.angle !== undefined) num(e.angle, 'angle', 0, Math.PI / 2);
      if (e.axis !== undefined) {
        if (!Array.isArray(e.axis) || e.axis.length !== 3)
          throw new TypeError('VFX emitter axis needs [x, y, z]; pass three numbers');
        e.axis.forEach((v, i) => num(v, `axis[${i}]`, -1e6, 1e6));
        if (!Math.hypot(...e.axis)) throw new RangeError('VFX emitter axis must not be zero; pass a direction');
      }
    } else if (mesh) {
      const { positions, indices } = e;
      if (!positions || typeof positions.length !== 'number' || positions.length < 9 || positions.length % 3)
        throw new TypeError(
          'VFX mesh emitter needs positions as xyz triples, at least one triangle; pass a Float32Array',
        );
      for (let i = 0; i < positions.length; i++)
        if (!Number.isFinite(positions[i]))
          throw new RangeError('VFX mesh emitter positions must be finite; remove NaN and Infinity');
      const count = indices ? indices.length : positions.length / 3;
      if (count % 3 || count < 3)
        throw new TypeError('VFX mesh emitter indices must be triangle triples; pass a multiple of 3 indices');
      if (count / 3 > MAX_EMITTER_TRIANGLES)
        throw new RangeError(`VFX mesh emitter has more than ${MAX_EMITTER_TRIANGLES} triangles; pass a simpler mesh`);
      if (indices)
        for (let i = 0; i < indices.length; i++)
          if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= positions.length / 3)
            throw new RangeError('VFX mesh emitter index points past the positions; check the index buffer');
      if (e.scale !== undefined) num(e.scale, 'scale', 1e-6, 1e6);
      buildTriangles(e); // refuses a mesh with no surface now, not while attaching
    }
  },
  patch(simulation: string, e: VFXEmitter): string {
    if (e.shape !== 'sphere' && e.shape !== 'cone' && e.shape !== 'mesh')
      throw new TypeError('VFX emitter needs the shapes entry for this shape; pass {emitter: shapes}');
    let code = once(
      simulation,
      'fn hash(v:u32)',
      declarations + (e.shape === 'mesh' ? triangles : '') + 'fn hash(v:u32)',
    );
    code = once(
      code,
      origin,
      'var origin=' + origin.slice('let origin='.length) + '\n  var shapeDir=vec3f(0);' + shapes[e.shape],
    );
    return once(
      code,
      velocity,
      'f.velocitySpread.xyz+shapeDir*em.a.z+(' + velocity.slice('f.velocitySpread.xyz+('.length),
    );
  },
  create(device, e, owned) {
    const buffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      values = new Float32Array(12),
      ints = new Uint32Array(values.buffer);
    owned.push(buffer);
    const entries: GPUBindGroupEntry[] = [{ binding: 7, resource: { buffer } }];
    if (e.shape === 'mesh') {
      const data = buildTriangles(e),
        tris = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      owned.push(tris);
      device.queue.writeBuffer(tris, 0, data as Float32Array<ArrayBuffer>);
      ints[8] = data.length / 12;
      entries.push({ binding: 8, resource: { buffer: tris } });
    }
    return {
      entries,
      write(queue, current) {
        values[2] = current.speed ?? 0;
        if (current.shape === 'sphere') {
          values[0] = current.radius ?? 1;
          values[1] = +!!current.shell;
        } else if (current.shape === 'cone') {
          const axis = current.axis ?? [0, 1, 0],
            length = Math.hypot(...axis);
          values[0] = current.radius ?? 0;
          values[3] = Math.cos(current.angle ?? Math.PI / 6);
          for (let i = 0; i < 3; i++) values[4 + i] = axis[i] / length;
        }
        queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
      },
    };
  },
};
