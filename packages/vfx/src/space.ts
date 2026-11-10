import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension } from './base.js';

/** A rigid emitter frame. Particle buffers remain in world coordinates for collisions, fields and other draws. */
export interface VFXSpace {
  /** `local` follows translation and rotation; `world` leaves existing particles independent. Default `world`. */
  mode?: 'local' | 'world';
  /** Column-major rigid 4x4 transform, read every step. Default identity; scale/shear are rejected. */
  transform?: ArrayLike<number>;
  /** Share of emitter origin velocity added at birth, 0..1. Default 0. */
  inheritVelocity?: number;
  /** Births per world unit travelled by the emitter origin, 0..1,000,000. Default 0. */
  ratePerDistance?: number;
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const once = (code: string, from: string, to: string): string => {
  if (code.split(from).length !== 2)
    throw new MargoError('unsupported', 'VFX space needs its simulation shader; update the space edits');
  return code.replace(from, to);
};

/** Moving local/world emitter space, inherited velocity and distance emission, without CPU particle work. */
export const space: VFXExtension<VFXSpace> = {
  validate(value, options) {
    if (!value || typeof value !== 'object') throw new TypeError('VFX space needs an object; pass {mode: "local"}');
    if (value.mode !== undefined && value.mode !== 'local' && value.mode !== 'world')
      throw new TypeError('VFX space mode must be local or world; choose one');
    for (const [key, max] of [
      ['inheritVelocity', 1],
      ['ratePerDistance', 1e6],
    ] as const) {
      const n = value[key] ?? 0;
      if (!Number.isFinite(n) || n < 0 || n > max)
        throw new RangeError(`VFX space ${key} must be 0..${max}; pass a finite value in range`);
    }
    const m = value.transform ?? identity;
    if (m.length !== 16 || !Array.from(m).every((n) => Number.isFinite(n) && Math.abs(n) <= 1e12))
      throw new RangeError('VFX space transform needs 16 finite rigid matrix values; pass a rigid 4x4 matrix');
    if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1)
      throw new RangeError('VFX space transform must be affine; use a rigid 4x4 matrix');
    for (let a = 0; a < 3; a++)
      for (let b = a; b < 3; b++) {
        const dot = m[a * 4] * m[b * 4] + m[a * 4 + 1] * m[b * 4 + 1] + m[a * 4 + 2] * m[b * 4 + 2];
        if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-5)
          throw new RangeError('VFX space transform cannot scale or shear; use an orthonormal frame');
      }
    if (options.skinned) throw new TypeError('VFX space cannot transform world-space skinned births; use one emitter');
  },
  simulation(code) {
    code = code.replace(
      'fn update(',
      `struct Space {frame:mat4x4f,delta:mat4x4f,motion:vec4f,births:vec4f}
@group(0) @binding(25) var<uniform> space:Space;
fn update(`,
    );
    code = once(
      code,
      '  p.positionLife.w-=dt;',
      `  if(p.positionLife.w>0 && space.births.w>0){
    p.positionLife=vec4f((space.delta*vec4f(p.positionLife.xyz,1)).xyz,p.positionLife.w);
    p.velocitySize=vec4f((space.delta*vec4f(p.velocitySize.xyz,0)).xyz,p.velocitySize.w);
  }
  p.positionLife.w-=dt;`,
    );
    return once(
      code,
      '    particles[cold]=p.color;particles[cold+1]=p.rotation;',
      `    p.positionLife=vec4f((space.frame*vec4f(p.positionLife.xyz,1)).xyz,p.positionLife.w);
    if(f32(ticket)<space.births.x){let along=space.births.y+f32(ticket)*space.births.z;p.positionLife=vec4f(p.positionLife.xyz-space.motion.xyz*(1-along),p.positionLife.w);}
    p.velocitySize=vec4f((space.frame*vec4f(p.velocitySize.xyz,0)).xyz+space.motion.xyz*space.motion.w,p.velocitySize.w);
    particles[cold]=p.color;particles[cold+1]=p.rotation;`,
    );
  },
  create(state, _value, owned) {
    const buffer = state.device.createBuffer({ size: 160, usage: 0x48 });
    owned.push(buffer);
    const values = new Float32Array(40);
    let previous: number[] | undefined,
      remainder = 0;
    return {
      compute: [{ binding: 25, resource: { buffer } }],
      emission(dt) {
        const s = state.options.space ?? {},
          m = s.transform ?? identity,
          p = state.options.position ?? [0, 1, 0];
        // Include the mutable position in the emitter frame, but undo it for the birth transform below.
        const current = Array.from(m);
        for (let row = 0; row < 3; row++) current[12 + row] += m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2];
        const old = previous ?? current;
        values.set(m, 0);
        values.set(identity, 16);
        for (let col = 0; col < 3; col++)
          for (let row = 0; row < 3; row++) {
            let sum = 0;
            for (let k = 0; k < 3; k++) sum += current[k * 4 + row] * old[k * 4 + col];
            values[16 + col * 4 + row] = sum;
          }
        for (let row = 0; row < 3; row++) {
          values[28 + row] = current[12 + row];
          for (let col = 0; col < 3; col++) values[28 + row] -= values[16 + col * 4 + row] * old[12 + col];
          values[32 + row] = current[12 + row] - old[12 + row];
        }
        values[35] = dt > 0 ? (s.inheritVelocity ?? 0) / dt : 0;
        const distance = Math.hypot(values[32], values[33], values[34]);
        const amount = distance * (s.ratePerDistance ?? 0),
          births = Math.floor(amount + remainder);
        values[36] = Math.min(state.capacity, births);
        values[37] = amount > 0 ? (1 - remainder) / amount : 1;
        values[38] = amount > 0 ? 1 / amount : 0;
        values[39] = +(s.mode === 'local');
        remainder = (amount + remainder) % 1;
        previous = current;
        return births;
      },
      write(c) {
        c.device.queue.writeBuffer(buffer, 0, values);
      },
      reset() {
        previous = undefined;
        remainder = 0;
      },
    };
  },
};
