import { MargoError } from '@margoengine/math/errors';
import { emitter } from './emitter.js';
import type { VFXEmitter, VFXFeatures } from './base.js';

/** Additional birth distributions; all shapes are centered at the effect position, with Y up. */
export type VFXShape =
  | { shape: 'hemisphere'; radius?: number; shell?: boolean; speed?: number }
  | { shape: 'cylinder'; radius?: number; height?: number; shell?: boolean; speed?: number }
  | { shape: 'torus'; radius?: number; tube?: number; shell?: boolean; speed?: number }
  | { shape: 'rectangle-edge'; width?: number; height?: number; speed?: number }
  | {
      shape: 'grid';
      columns?: number;
      rows?: number;
      layers?: number;
      spacing?: readonly [number, number, number];
      speed?: number;
    };
const extra = (e: VFXEmitter): e is VFXShape =>
  ['hemisphere', 'cylinder', 'torus', 'rectangle-edge', 'grid'].includes(e.shape);
const num = (n: unknown, label: string, min: number, max: number) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    throw new RangeError(`VFX shapes ${label} must be ${min}..${max}; pass a finite value in range`);
};
const once = (code: string, from: string, to: string) => {
  if (code.split(from).length !== 2)
    throw new MargoError('unsupported', 'VFX shapes need their birth shader; update the shapes edits');
  return code.replace(from, to);
};
const declarations = `struct Shape {a:vec4f,b:vec4f}
@group(0) @binding(7) var<uniform> birthShape:Shape;
`;
const sample = {
  hemisphere: `let y=random(seed+8u);let a=6.2831853*random(seed+9u);let r=sqrt(max(0.0,1-y*y));shapeDir=vec3f(r*cos(a),y,r*sin(a));origin+=shapeDir*birthShape.a.x*select(pow(random(seed+10u),0.333333333),1.0,birthShape.a.z>0);`,
  cylinder: `let a=6.2831853*random(seed+8u);shapeDir=vec3f(cos(a),0,sin(a));let r=birthShape.a.x*select(sqrt(random(seed+9u)),1.0,birthShape.a.z>0);origin+=shapeDir*r+vec3f(0,(random(seed+10u)-0.5)*birthShape.a.y,0);`,
  torus: `let a=6.2831853*random(seed+8u);let r=birthShape.a.y*select(sqrt(random(seed+9u)),1.0,birthShape.a.z>0);let quantile=6.2831853*random(seed+10u);var lo=0.0;var hi=6.2831853;
 for(var k=0u;k<24u;k++){let mid=(lo+hi)*0.5;if(mid+(r/birthShape.a.x)*sin(mid)<quantile){lo=mid;}else{hi=mid;}}
 let b=(lo+hi)*0.5;let ring=vec3f(cos(a),0,sin(a));shapeDir=ring*cos(b)+vec3f(0,sin(b),0);origin+=ring*birthShape.a.x+shapeDir*r;`,
  'rectangle-edge': `let w=birthShape.a.x;let h=birthShape.a.y;let t=random(seed+8u)*2*(w+h);var offset=vec3f(0);
 if(t<w){offset=vec3f(t-w*0.5,0,-h*0.5);shapeDir=vec3f(0,0,-1);}else if(t<w+h){offset=vec3f(w*0.5,0,t-w-h*0.5);shapeDir=vec3f(1,0,0);}else if(t<2*w+h){offset=vec3f(w*0.5-(t-w-h),0,h*0.5);shapeDir=vec3f(0,0,1);}else{offset=vec3f(-w*0.5,0,h*0.5-(t-2*w-h));shapeDir=vec3f(-1,0,0);}origin+=offset;`,
  grid: `let counts=vec3u(birthShape.b.xyz);let at=min(u32(random(seed+8u)*f32(counts.x*counts.y*counts.z)),counts.x*counts.y*counts.z-1u);let cell=vec3u(at%counts.x,(at/counts.x)%counts.y,at/(counts.x*counts.y));origin+=(vec3f(cell)-(vec3f(counts)-1)*0.5)*birthShape.a.xyz;shapeDir=vec3f(0,1,0);`,
};
/** Superset of `emitter`: hemisphere, cylinder, torus, rectangle perimeter and grid, plus the original shapes. */
export const shapes: NonNullable<VFXFeatures['emitter']> = {
  validate(e, mesh) {
    if (!e || typeof e !== 'object' || !extra(e)) {
      emitter.validate(e, mesh);
      return;
    }
    num(e.speed ?? 0, 'speed', -1000, 1000);
    if ('shell' in e && e.shell !== undefined && typeof e.shell !== 'boolean')
      throw new TypeError('VFX shapes shell must be boolean; pass true or false');
    if (e.shape === 'hemisphere' || e.shape === 'cylinder' || e.shape === 'torus')
      num(e.radius ?? 1, 'radius', 1e-6, 1e6);
    if (e.shape === 'cylinder') num(e.height ?? 1, 'height', 1e-6, 1e6);
    if (e.shape === 'torus') {
      num(e.tube ?? 0.25, 'tube', 1e-6, 1e6);
      if ((e.tube ?? 0.25) >= (e.radius ?? 1))
        throw new RangeError('VFX torus tube must be smaller than its radius; use a regular ring');
    }
    if (e.shape === 'rectangle-edge') {
      num(e.width ?? 1, 'width', 1e-6, 1e6);
      num(e.height ?? 1, 'height', 1e-6, 1e6);
    }
    if (e.shape === 'grid') {
      let count = 1;
      for (const key of ['columns', 'rows', 'layers'] as const) {
        const n = e[key] ?? 1;
        num(n, key, 1, 1e6);
        if (!Number.isInteger(n)) throw new RangeError(`VFX grid ${key} must be whole; pass an integer`);
        count *= n;
      }
      if (count > 1e6) throw new RangeError('VFX grid needs at most 1000000 cells; reduce its dimensions');
      const spacing = e.spacing ?? [1, 1, 1];
      if (!Array.isArray(spacing) || spacing.length !== 3)
        throw new TypeError('VFX grid spacing needs [x,y,z]; pass three distances');
      spacing.forEach((n) => num(n, 'spacing', 0, 1e6));
    }
  },
  patch(code, e) {
    if (!extra(e)) return emitter.patch(code, e);
    code = code.replace('fn update(', declarations + 'fn update(');
    code = once(
      code,
      'let origin=f.emitterTime.xyz+(vec3f(random(seed+5u),random(seed+6u),random(seed+7u))*2-1)*f.emissionExtent.xyz;',
      `var origin=f.emitterTime.xyz+(vec3f(random(seed+5u),random(seed+6u),random(seed+7u))*2-1)*f.emissionExtent.xyz;var shapeDir=vec3f(0);${sample[e.shape]}`,
    );
    return once(code, 'f.velocitySpread.xyz+(', 'f.velocitySpread.xyz+shapeDir*birthShape.b.w+(');
  },
  create(device, e, owned) {
    if (!extra(e)) return emitter.create(device, e, owned);
    const buffer = device.createBuffer({ size: 32, usage: 0x48 });
    owned.push(buffer);
    const values = new Float32Array(8);
    return {
      entries: [{ binding: 7, resource: { buffer } }],
      write(queue, current) {
        if (!extra(current) || current.shape !== e.shape)
          throw new TypeError('VFX shape is fixed at attach; create a new effect to change it');
        values.fill(0);
        values[7] = current.speed ?? 0;
        if (current.shape === 'hemisphere' || current.shape === 'cylinder' || current.shape === 'torus') {
          values[0] = current.radius ?? 1;
          values[2] = +!!current.shell;
        }
        if (current.shape === 'cylinder') values[1] = current.height ?? 1;
        if (current.shape === 'torus') values[1] = current.tube ?? 0.25;
        if (current.shape === 'rectangle-edge') {
          values[0] = current.width ?? 1;
          values[1] = current.height ?? 1;
        }
        if (current.shape === 'grid') {
          values.set(current.spacing ?? [1, 1, 1]);
          values.set([current.columns ?? 1, current.rows ?? 1, current.layers ?? 1], 4);
        }
        queue.writeBuffer(buffer, 0, values);
      },
    };
  },
};
