import {settle} from './shader.js';
import type {VFXFeatures} from './base.js';
/** `wrap` option: keeps a field inside the emission box; re-entering particles restart at the emitter velocity. */
export const wrap:NonNullable<VFXFeatures['wrap']>={patch:simulation=>simulation.replace(settle,/* wgsl */`
  let low=f.emitterTime.xyz-f.emissionExtent.xyz;let span=2*f.emissionExtent.xyz;let q=p.positionLife.xyz-low;
  if(any(q<vec3f(0))||any(q>span)){p.positionLife=vec4f(low+q-floor(q/span)*span,p.positionLife.w);p.velocitySize=vec4f(f.velocitySpread.xyz,p.velocitySize.w);}
  `+settle)};
