import { finiteVector } from '@margoengine/math/validate';
import { settle } from './shader.js';
import { extra } from './extra.js';
import type { VFXFeatures } from './base.js';
/** Outward normal (xyz) and signed distance (w) from obstacle i, a sphere or a box. */
const obstacle = /* wgsl */ `
fn obstacle(i:u32,position:vec3f)->vec4f {
  let center=extra.obstacles[i*2u];let extent=extra.obstacles[i*2u+1u].xyz;let r=position-center.xyz;
  if(center.w<0.5){let d=length(r);return vec4f(select(vec3f(0,1,0),r/max(d,0.0001),d>0.003),d-extent.x);}
  let q=abs(r)-extent;let outside=max(q,vec3f(0));let nearest=length(outside);let d=nearest+min(max(q.x,max(q.y,q.z)),0.0);
  if(nearest>0.0001){return vec4f(outside*sign(r)/nearest,d);}
  let s=select(vec3f(-1),vec3f(1),r>=vec3f(0));
  if(q.x>=q.y&&q.x>=q.z){return vec4f(s.x,0,0,d);}if(q.y>=q.z){return vec4f(0,s.y,0,d);}return vec4f(0,0,s.z,d);
}`;
const force =
  'p.velocitySize=vec4f(p.velocitySize.xyz+(f.gravityDelta.xyz+curlNoise(p.positionLife.xyz))*dt,p.velocitySize.w);';
/** `obstacles` option: up to 64 spheres/boxes the flow bends around and particles bounce off. */
export const obstacles: NonNullable<VFXFeatures['obstacles']> = {
  patch: (simulation) =>
    simulation
      .replace('@group(0) @binding(1)', extra + '@group(0) @binding(1)')
      .replace('@compute', obstacle + '\n@compute')
      .replace(
        force,
        /* wgsl */ `var force=f.gravityDelta.xyz+curlNoise(p.positionLife.xyz);
  // Flow bends around obstacles within one unit; particles inside are pushed out and reflected.
  for(var i=0u;i<extra.count.x;i++){let o=obstacle(i,p.positionLife.xyz);if(o.w<1){force-=o.xyz*min(dot(force,o.xyz),0.0)*(1-clamp(o.w,0.0,1.0));}}
  p.velocitySize=vec4f(p.velocitySize.xyz+force*dt,p.velocitySize.w);`,
      )
      .replace(
        settle,
        /* wgsl */ `
  for(var i=0u;i<extra.count.x;i++){let o=obstacle(i,p.positionLife.xyz);let r=p.velocitySize.w*0.5;if(o.w<r){p.positionLife=vec4f(p.positionLife.xyz+o.xyz*(r-o.w),p.positionLife.w);p.velocitySize=vec4f(p.velocitySize.xyz-o.xyz*min(dot(p.velocitySize.xyz,o.xyz),0.0)*(1+f.physics.z),p.velocitySize.w);}}
  ` + settle,
      ),
  write(list, e) {
    if (list.length > 64) throw new RangeError('Obstacle limit is 64');
    new Uint32Array(e.buffer)[8] = list.length;
    for (let i = 0; i < list.length; i++) {
      const b = list[i],
        at = 12 + i * 8,
        box = b.kind === 'box';
      if (!box && b.kind !== 'sphere') throw new RangeError('Invalid obstacle');
      finiteVector(b.center, 3, 'Obstacle center');
      const extent = box ? b.halfSize : ([b.radius, b.radius, b.radius] as const);
      finiteVector(extent, 3, 'Obstacle extent');
      if (!extent.every((v) => v > 0)) throw new RangeError('Invalid obstacle extent');
      e.set(b.center, at);
      e[at + 3] = +box;
      e.set(extent, at + 4);
    }
  },
};
