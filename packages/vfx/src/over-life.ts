import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension } from './base.js';

/** Piecewise-linear samples over normalized life; omitted channels keep the stock behaviour. */
export interface VFXOverLife {
  /** Additional angular velocity in radians/second, 2..32 samples, each -1000..1000. */
  spin?: readonly number[];
  /** Multiplier of the birth velocity, 2..32 samples, each 0..1000. Forces remain additive. */
  speed?: readonly number[];
  /** Multiplier of the birth size, 2..32 samples, each 0..1000. May grow beyond 1. */
  size?: readonly number[];
  /** Maximum world speed, 0..1,000,000 units/second, or 2..32 samples in that range. Default no limit. */
  velocityLimit?: number | readonly number[];
}
/** The draw stages' binding of the curves uniform. */
const SPIN_BINDING = 27;
const once = (code: string, from: string, to: string): string => {
  if (code.split(from).length !== 2)
    throw new MargoError('unsupported', 'VFX over-life needs its simulation shader; update the lifetime edits');
  return code.replace(from, to);
};
/** The curves uniform at `binding` and the piecewise-linear sample of a channel at normalized life t. */
const curves = (binding: number) => `struct OverLife {counts:vec4u,values:array<vec4f,32>}
@group(0) @binding(${binding}) var<uniform> lifeCurves:OverLife;
fn lifeValue(channel:u32,t:f32)->f32 {
 let n=lifeCurves.counts[channel];if(n==0u){return select(1.0,0.0,channel==0u);}
 let x=clamp(t,0.0,1.0)*f32(n-1u);let k=min(u32(x),n-2u);let base=channel*8u;
 let a=lifeCurves.values[base+k/4u][k%4u];let j=k+1u;let b=lifeCurves.values[base+j/4u][j%4u];return mix(a,b,x-f32(k));
}
`;
const declarations = `@group(0) @binding(26) var<storage,read_write> lifeBirth:array<vec4f>;
${curves(27)}`;
/**
 * The spin curve's angle, added where the angle is drawn: the curve integrated over the life lived, times the initial
 * life (the curve is over normalized life, its samples radians per second). The particle's `rotation.x` stays its birth
 * angle, which ribbons (the record stamp), random atlas frames and mesh tumble axes key on.
 */
const drawnSpin = `${curves(SPIN_BINDING)}fn spinIntegral(t:f32)->f32 {
 let n=lifeCurves.counts.x;if(n<2u){return 0.0;}let end=clamp(t,0.0,1.0);var sum=0.0;
 for(var k=0u;k+1u<n;k++){let a=f32(k)/f32(n-1u);let b=min(end,f32(k+1u)/f32(n-1u));if(b>a){sum+=(lifeValue(0u,a)+lifeValue(0u,b))*(b-a)*0.5;}}
 return sum;
}
fn drawnSpin(life:f32,left:f32)->f32 {return select(0.0,life*spinIntegral(1-left/life),life>0);}
`;
const BILLBOARD_ANGLE = 'let angle=p.rotation.x+p.rotation.y*(p.rotation.z-p.positionLife.w);';
/** GPU spin/speed/growth curves and velocity limiting, shared by billboard, mesh and ribbon consumers. */
export const overLife: VFXExtension<VFXOverLife> = {
  validate(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.keys(value).some((k) => ['spin', 'speed', 'size', 'velocityLimit'].includes(k))
    )
      throw new TypeError('VFX overLife needs a curve or velocityLimit; pass {size: [1, 2]}');
    for (const key of ['spin', 'speed', 'size', 'velocityLimit'] as const) {
      const v = value[key];
      if (v === undefined) continue;
      const min = key === 'spin' ? -1000 : 0,
        max = key === 'velocityLimit' ? 1e6 : 1000;
      const list = key === 'velocityLimit' && typeof v === 'number' ? [v, v] : v;
      if (!Array.isArray(list) || list.length < 2 || list.length > 32)
        throw new TypeError(`VFX overLife ${key} needs 2..32 samples; pass a sampled curve`);
      if (!list.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max))
        throw new RangeError(`VFX overLife ${key} samples must be ${min}..${max}; pass finite values in range`);
    }
  },
  simulation(code) {
    // The slot's stored life and birth velocity are read once, before this slot stores anything: a kernel that reads a
    // buffer back after storing to it runs on the WebGL2 layer's CPU tier, 95 s over the embers of one FireFront
    // (KB-VFX-EMBERCPU1). The locals follow the stores below, so the values are the ones the read-back gave.
    code = once(
      code,
      'var p=Particle(particles[at],particles[at+1],vec4f(0),vec4f(0));',
      'var p=Particle(particles[at],particles[at+1],vec4f(0),vec4f(0));var coldLife=particles[cold+1].z;var birthNow=lifeBirth[i];',
    );
    if (code.includes('var<uniform> space:Space;'))
      code = once(
        code,
        '  p.positionLife.w-=dt;',
        `  if(p.positionLife.w>0 && space.births.w>0){birthNow=vec4f((space.delta*vec4f(birthNow.xyz,0)).xyz,birthNow.w);lifeBirth[i]=birthNow;}
  p.positionLife.w-=dt;`,
      );
    code = code.replace('fn update(', declarations + 'fn update(');
    code = once(
      code,
      '    particles[cold]=p.color;particles[cold+1]=p.rotation;',
      `    lifeBirth[i]=p.velocitySize;birthNow=p.velocitySize;coldLife=p.rotation.z;
    p.velocitySize=vec4f(p.velocitySize.xyz*lifeValue(1u,0.0),p.velocitySize.w);
    particles[cold]=p.color;particles[cold+1]=p.rotation;`,
    );
    return once(
      code,
      '  p.positionLife=vec4f(p.positionLife.xyz+p.velocitySize.xyz*dt,p.positionLife.w);',
      `  let totalLife=coldLife;let age=clamp(1-p.positionLife.w/totalLife,0.0,1.0);
  let previousAge=max(0.0,age-dt/totalLife);let birth=birthNow;
  var velocity=p.velocitySize.xyz+birth.xyz*(lifeValue(1u,age)-lifeValue(1u,previousAge));
  let cap=lifeValue(3u,age);let speed=length(velocity);
  if(lifeCurves.counts.w>0u && speed>cap){velocity*=cap/max(speed,1e-20);}
  p.velocitySize=vec4f(velocity,birth.w*lifeValue(2u,age));
  p.positionLife=vec4f(p.positionLife.xyz+p.velocitySize.xyz*dt,p.positionLife.w);`,
    );
  },
  billboard(code) {
    if (code.split(BILLBOARD_ANGLE).length !== 2)
      throw new MargoError('unsupported', 'VFX over-life spin needs the billboard angle; update the spin edit');
    return code
      .replace(BILLBOARD_ANGLE, BILLBOARD_ANGLE.replace(';', '+drawnSpin(p.rotation.z,p.positionLife.w);'))
      .replace('@vertex fn vertex(', drawnSpin + '@vertex fn vertex(');
  },
  create(state, _value, owned) {
    const birth = state.device.createBuffer({ size: state.capacity * 16, usage: 0x88 });
    owned.push(birth);
    const buffer = state.device.createBuffer({ size: 528, usage: 0x48 });
    owned.push(buffer);
    const values = new Float32Array(132),
      counts = new Uint32Array(values.buffer, 0, 4);
    const entry = { binding: SPIN_BINDING, resource: { buffer } };
    state.spin = { code: drawnSpin, entry };
    return {
      render: [entry],
      compute: [
        { binding: 26, resource: { buffer: birth } },
        { binding: 27, resource: { buffer } },
      ],
      write(c) {
        const v = state.options.overLife ?? {};
        values.fill(0);
        for (const [i, key] of (['spin', 'speed', 'size', 'velocityLimit'] as const).entries()) {
          const value = v[key],
            list = typeof value === 'number' ? [value, value] : value;
          if (list) {
            counts[i] = list.length;
            values.set(list, 4 + i * 32);
          }
        }
        c.device.queue.writeBuffer(buffer, 0, values);
      },
    };
  },
};
