import { MargoError } from '@margoengine/math/errors';
import type { VFXCurves, VFXFeatures } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Most samples in a size or alpha curve (`curves.size`, `curves.alpha`). */
export const MAX_CURVE_SAMPLES = 32;
/** Most stops in a colour gradient (`curves.color`). */
export const MAX_GRADIENT_STOPS = 8;

const declarations = /* wgsl */ `
struct Curves {counts:vec4u,values:array<vec4f,24>}
@group(0) @binding(7) var<uniform> curves:Curves;
fn sampleCurve(base:u32,n:u32,t:f32)->f32 {
  if(n<2u){return 1.0;}
  let x=clamp(t,0.0,1.0)*f32(n-1u);let i=min(u32(x),n-2u);let j=i+1u;
  return mix(curves.values[base+i/4u][i%4u],curves.values[base+j/4u][j%4u],x-f32(i));
}
fn sampleGradient(n:u32,t:f32)->vec3f {
  if(n<2u){return vec3f(1);}
  var c=curves.values[16u].rgb;
  for(var k=1u;k<n;k++){let a=curves.values[15u+k];let b=curves.values[16u+k];if(t>=a.w){c=mix(a.rgb,b.rgb,clamp((t-a.w)/max(b.w-a.w,1e-6),0.0,1.0));}}
  return c;
}
`;

const size = 'let p=Particle(particles[at],particles[at+1],particles[cold],particles[cold+1]);',
  output = 'o.color=vec4f(p.color.rgb,p.color.a*clamp(p.positionLife.w/p.rotation.z,0.0,1.0)/(grow*grow));';

function once(code: string, from: string, to: string): string {
  if (code.split(from).length !== 2)
    throw new MargoError(
      'unsupported',
      'VFX curves need the billboard shader they were written for; update the curve edits',
    );
  return code.replace(from, to);
}

const range = (value: unknown, name: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`VFX curves ${name} must be a number from ${min} to ${max}; pass a finite value in range`);
};

/** A curve: 2 to 32 numbers from 0 to 1, evenly spaced over the particle's life. */
function checkCurve(curve: unknown, name: string): void {
  if (!Array.isArray(curve) || curve.length < 2 || curve.length > MAX_CURVE_SAMPLES)
    throw new TypeError(`VFX curves ${name} needs 2 to ${MAX_CURVE_SAMPLES} samples; pass an array like [0, 1, 0.5]`);
  curve.forEach((v, i) => range(v, `${name}[${i}]`, 0, 1));
}

/**
 * The `curves` feature: size, opacity and colour over each particle's life. Pass it as `{curves}` to `VFX` from
 * `@margoengine/vfx/base`; the root `VFX` has it. Which of the three curves are set is read at attach; their values
 * can change every frame.
 */
export const curves: NonNullable<VFXFeatures['curves']> = {
  validate(c: VFXCurves): void {
    if (!c || typeof c !== 'object')
      throw new TypeError('VFX curves must be an object with size, alpha or color; pass e.g. {size: [0, 1, 0]}');
    if (c.size !== undefined) checkCurve(c.size, 'size');
    if (c.alpha !== undefined) checkCurve(c.alpha, 'alpha');
    if (c.color !== undefined) {
      if (!Array.isArray(c.color) || c.color.length < 2 || c.color.length > MAX_GRADIENT_STOPS)
        throw new TypeError(
          `VFX curves color needs 2 to ${MAX_GRADIENT_STOPS} stops; pass [{at: 0, color: [1, 1, 1]}, {at: 1, color: [1, 0, 0]}]`,
        );
      let last = -1;
      c.color.forEach((stop, i) => {
        if (!stop || !Array.isArray(stop.color) || stop.color.length !== 3)
          throw new TypeError(`VFX curves color[${i}] needs {at, color: [r, g, b]}; pass three linear channels`);
        range(stop.at, `color[${i}].at`, 0, 1);
        (stop.color as readonly number[]).forEach((v, k) => range(v, `color[${i}].color[${k}]`, 0, 16));
        if (stop.at < last)
          throw new RangeError(`VFX curves color stops must ascend by "at"; move color[${i}] after color[${i - 1}]`);
        last = stop.at;
      });
    }
  },
  patch(billboard: string, c: VFXCurves): string {
    let code = billboard.replace('struct Out', declarations + 'struct Out');
    code = once(
      code,
      size,
      /* wgsl */ `let raw=Particle(particles[at],particles[at+1],particles[cold],particles[cold+1]);
  let age=1.0-clamp(raw.positionLife.w/raw.rotation.z,0.0,1.0);var p=raw;${c.size ? 'p.velocitySize.w=raw.velocitySize.w*sampleCurve(0u,curves.counts.x,age);' : ''}`,
    );
    return once(
      code,
      output,
      `o.color=vec4f(p.color.rgb${c.color ? '*sampleGradient(curves.counts.z,age)' : ''},p.color.a*${
        c.alpha ? 'sampleCurve(8u,curves.counts.y,age)' : 'clamp(p.positionLife.w/p.rotation.z,0.0,1.0)'
      }/(grow*grow));`,
    );
  },
  create(device, owned) {
    const buffer = device.createBuffer({
      size: 16 + 24 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    owned.push(buffer);
    const values = new Float32Array(4 + 96),
      counts = new Uint32Array(values.buffer, 0, 4);
    return {
      entries: [{ binding: 7, resource: { buffer } }],
      write(queue, c) {
        counts.fill(0);
        values.fill(0, 4);
        for (const [slot, curve] of [
          [0, c.size],
          [8, c.alpha],
        ] as const)
          if (curve) {
            counts[slot / 8] = curve.length;
            values.set(curve, 4 + slot * 4);
          }
        if (c.color) {
          counts[2] = c.color.length;
          c.color.forEach((s, i) => values.set([s.color[0], s.color[1], s.color[2], s.at], 4 + (16 + i) * 4));
        }
        queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
      },
    };
  },
};
