import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension, VFXStretch, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

const uniform = (binding: number) => /* wgsl */ `
struct Stretch {shape:vec4f}
@group(0) @binding(${binding}) var<uniform> stretch:Stretch;
`;

function once(code: string, from: string, to: string): string {
  if (code.split(from).length !== 2)
    throw new MargoError('unsupported', 'VFX stretch needs the shaders it was written for; update the stretch edits');
  return code.replace(from, to);
}

/**
 * The billboard's long axis follows the particle's velocity across the screen (its components along the camera's
 * right and up), and the billboard is `size + factor x speed` long (`factor` seconds of travel), never shorter than
 * `size`; across it stays `size`. A particle too slow to have a direction on screen (under 1e-6 units a second across)
 * keeps the plain round billboard. Spin is left out: a streak points where it flies.
 */
const billboard = (code: string) =>
  once(
    code.replace('struct Out', uniform(18) + 'struct Out'),
    'let rotated=vec2f(corner.x*cs-corner.y*sn,corner.x*sn+corner.y*cs);',
    `let flat=vec2f(dot(p.velocitySize.xyz,f.right.xyz),dot(p.velocitySize.xyz,f.up.xyz));let across=length(flat);
  var rotated=vec2f(corner.x*cs-corner.y*sn,corner.x*sn+corner.y*cs);
  if(across>1e-6){let d=flat/across;let long=1+stretch.shape.x*length(p.velocitySize.xyz)/p.velocitySize.w;rotated=vec2f(d.y,-d.x)*corner.x+d*corner.y*long;}`,
  );

/** The draw list's cull sphere grows to the stretched length, so no streak that can reach the screen is dropped. */
const simulation = (code: string) =>
  once(
    code.replace('fn update(', uniform(18) + 'fn update('),
    'let r=p.velocitySize.w*1.01;',
    'let r=(p.velocitySize.w+stretch.shape.x*length(p.velocitySize.xyz))*1.01;',
  );

/**
 * The `stretch` feature: velocity-stretched billboards, streaks along each particle's motion for sparks, rain and
 * tracers. Pass it as `{stretch}` to `VFX` from `@margoengine/vfx/base`; the root `VFX` has it. `factor` is read
 * every frame.
 */
export const stretch: VFXExtension<VFXStretch> = {
  validate(s) {
    if (!s || typeof s !== 'object') throw new TypeError('VFX stretch must be an object; pass e.g. {factor: 0.05}');
    const factor = s.factor ?? 0.05;
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 10)
      throw new RangeError('VFX stretch factor must be 0 to 10 seconds of travel; pass e.g. 0.05');
  },
  simulation,
  billboard,
  create(state: VFXState, _value, owned) {
    const buffer = state.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(buffer);
    const values = new Float32Array(4),
      entry = { binding: 18, resource: { buffer } };
    return {
      compute: [entry],
      render: [entry],
      write(c) {
        // Removed between frames: no stretch (the shaders keep their edit until a new VFX).
        const v = state.options.stretch;
        values[0] = v ? (v.factor ?? 0.05) : 0;
        c.device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
      },
    };
  },
};
