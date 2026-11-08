import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension, VFXLit, VFXLightSource, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** The lit uniform's binding in the billboard's group 0: sun direction, sun colour and wrap, ambient, eye. */
const BINDING = 21;

function once(code: string, from: string, to: string): string {
  if (code.split(from).length !== 2)
    throw new MargoError('unsupported', 'VFX lit needs the billboard shader it was written for; update the lit edits');
  return code.replace(from, to);
}

/**
 * Each billboard is shaded as a ball of its own size: the pixel at `uv` on the unit disc (rotated with the particle,
 * and stretched with it under `stretch`) has the normal `side + toward * sqrt(1 - |uv|^2)`, with `toward` the camera
 * plane's normal, and lies that far in front of the disc. The sun is diffuse with wrap lighting, `max(0, (n.l + w) /
 * (1 + w))` (Green, "Real-Time Approximations to Subsurface Scattering", GPU Gems 1, ch. 16), over pi as core's
 * Lambert term, times the sun's colour and intensity; the ambient adds `base * ambient`. Clustered lights come from the
 * clustered shader's own `clusterLighting` (its falloff, cones, shadows and BRDF) at roughness 1 and no metal, and sun
 * shadows from the shadow pass's `shadowLit` at the ball's surface point.
 */
const billboard = (code: string, lit: VFXLit): string => {
  let out = once(
    code,
    '@location(0) uv:vec2f,',
    '@location(0) uv:vec2f,@location(8) litWorld:vec3f,@location(9) litSide:vec4f,',
  );
  out = once(
    out,
    'o.clip=f.camera*vec4f(position,1);',
    'o.clip=f.camera*vec4f(position,1);let litHalf=p.velocitySize.w*0.5*grow;o.litWorld=position;o.litSide=vec4f((position-p.positionLife.xyz)/litHalf,litHalf);',
  );
  out = once(
    out,
    '@fragment fn fragment(i:Out)->@location(0) vec4f {',
    '@fragment fn fragment(i:Out)->@location(0) vec4f {return lit(i,unlit(i));}\nfn unlit(i:Out)->vec4f {',
  );
  const sun = 'base*litFrame.sunColor.rgb*(max(0.0,dot(n,litFrame.sun.xyz)+wrap)/(1.0+wrap)*0.31830989)';
  return (
    out +
    /* wgsl */ `
struct LitFrame {sun:vec4f,sunColor:vec4f,ambient:vec4f,eye:vec4f}
@group(0) @binding(${BINDING}) var<uniform> litFrame:LitFrame;
fn lit(i:Out,c:vec4f)->vec4f {
  let toward=cross(f.right.xyz,f.up.xyz);let z=sqrt(max(0.0,1.0-dot(i.uv,i.uv)));
  let n=normalize(i.litSide.xyz+toward*z);let p=i.litWorld+toward*(z*i.litSide.w);let base=c.rgb;let wrap=litFrame.sunColor.w;
  var light=base*litFrame.ambient.rgb+${lit.shadows ? `shadowLit(${sun},p,n)` : sun};
  ${lit.lights ? 'light+=clusterLighting(i.clip.xy,p,n,litFrame.eye.xyz,base,1.0,0.0,vec3f(0.04),1.0);' : ''}
  return vec4f(light,c.a);
}
`
  );
};

function source(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (!value ||
      typeof (value as VFXLightSource).pbr !== 'function' ||
      typeof (value as VFXLightSource).bindings !== 'function')
  )
    throw new TypeError(
      `VFX lit ${name} must be ${name === 'lights' ? 'Clustered' : 'Shadows'} or have pbr and bindings`,
    );
}

let revision = 0;

/**
 * The `lit` feature: billboards lit by the engine's sun (with wrap lighting), its ambient light, `Clustered` point and
 * spot lights and `Shadows` sun shadows, shaded as balls so smoke and dust take light from the side it comes from.
 * Pass it as `{lit}` to `VFX` from `@margoengine/vfx/base`; the root `VFX` has it. `lights` and `shadows` are read at
 * attach; `wrap` and `ambient` every frame. Under an order-independent pass (`addEffect` from `@margoengine/oit/vfx`)
 * the particles are lit the same: the pass's declarations take bind group 1 and the lights and shadows group 2.
 */
export const lit: VFXExtension<VFXLit> = {
  validate(l) {
    if (!l || typeof l !== 'object')
      throw new TypeError('VFX lit must be an object; pass {} for the sun, or {lights, shadows}');
    source(l.lights, 'lights');
    source(l.shadows, 'shadows');
    if (l.wrap !== undefined && !(typeof l.wrap === 'number' && l.wrap >= 0 && l.wrap <= 1))
      throw new RangeError('VFX lit wrap must be 0 to 1; pass e.g. 0.5');
    const a = l.ambient;
    if (
      a !== undefined &&
      (!Array.isArray(a) || a.length !== 3 || !a.every((v) => typeof v === 'number' && v >= 0 && v <= 16))
    )
      throw new RangeError('VFX lit ambient must be linear [r, g, b], each 0 to 16');
  },
  billboard: (code, value) => billboard(code, value),
  create(state: VFXState, value, owned) {
    const { device, options } = state,
      buffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(buffer);
    const values = new Float32Array(16),
      sources = !!(value.lights || value.shadows),
      // The sources' declarations for each group, and a key that changes when they do.
      declared = new Map<number, { lights: string; shadows: string; key: string }>(),
      groups = new WeakMap<
        GPURenderPipeline,
        { lights?: GPUBindGroupEntry[]; shadows?: GPUBindGroupEntry[]; group: GPUBindGroup }
      >();
    const declare = (group: number) => {
      const lights = value.lights?.pbr(group).declarations ?? '',
        shadows = value.shadows?.pbr(group).declarations ?? '';
      let d = declared.get(group);
      if (!d || d.lights !== lights || d.shadows !== shadows)
        declared.set(group, (d = { lights, shadows, key: ':lit' + ++revision }));
      return d;
    };
    return {
      render: [{ binding: BINDING, resource: { buffer } }],
      write(c) {
        if (options.lit !== value)
          throw new TypeError('VFX lit is fixed at attach; change its wrap or ambient in place or attach a new VFX');
        const { direction, radiance, ambient } = state.engine.lighting,
          length = Math.hypot(direction[0], direction[1], direction[2]),
          intensity = length > 0 ? Math.max(0, direction[3]) : 0;
        for (let i = 0; i < 3; i++) {
          values[i] = intensity ? direction[i] / length : 0;
          values[4 + i] = radiance[i] * intensity;
          values[8 + i] = value.ambient ? value.ambient[i] : radiance[3] * ambient[i];
          values[12 + i] = c.camera.position[i];
        }
        values[7] = value.wrap ?? 0.5;
        c.device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
      },
      ...(sources
        ? {
            key: (group: number) => declare(group).key,
            shade(code: string, group: number) {
              const d = declare(group);
              return d.lights + d.shadows + code;
            },
            bind(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, group: number) {
              const lights = value.lights?.bindings(),
                shadows = value.shadows?.bindings();
              let held = groups.get(pipeline);
              if (!held || held.lights !== lights || held.shadows !== shadows)
                groups.set(
                  pipeline,
                  (held = {
                    lights,
                    shadows,
                    group: device.createBindGroup({
                      layout: pipeline.getBindGroupLayout(group),
                      entries: [...(lights ?? []), ...(shadows ?? [])],
                    }),
                  }),
                );
              pass.setBindGroup(group, held.group);
            },
          }
        : {}),
    };
  },
};
