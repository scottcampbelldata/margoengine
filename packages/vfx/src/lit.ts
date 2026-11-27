import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension, VFXLit, VFXLightSource, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/**
 * The lit uniform's binding in the billboard's group 0: sun direction, sun colour and wrap, ambient and ground albedo,
 * eye, glow, glow colour and power, air, air reflectance.
 */
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
 * Lambert term, times the sun's colour and intensity. The ambient and the air's light are split into the light from
 * above and from below by the isotropic view factors of a surface tilted from the horizontal, (1 + n_y) / 2 of the
 * upper hemisphere and (1 - n_y) / 2 of the lower (B. Y. H. Liu and R. C. Jordan, "A Rational Procedure for Predicting
 * the Long-Term Average Performance of Flat-Plate Solar-Energy Collectors", Solar Energy 7(2):53-74, 1963; J. A. Duffie
 * and W. A. Beckman, "Solar Engineering of Thermal Processes", 4th ed., 2013, eq. 2.15.1), a two-stream split of the
 * diffuse light (W. E. Meador and W. R. Weaver, "Two-Stream Approximations to Radiative Transfer in Planetary
 * Atmospheres", J. Atmos. Sci. 37(3):630-643, 1980). The sky's ambient A comes down and the ground sends back its
 * albedo g of it: 2A / (1 + g) from above and g times that from below. The air's light S (a fire's light on its pall)
 * comes up and the layer over the particle sends back its reflectance R of it: 2S / (1 + R) from below and R times that
 * from above. Both keep their mean over every normal, so a ball seen side-on is as bright as before on the whole, but
 * lit on top by the sky and underneath by the fire (KB-VFX-SMOKEFLAT1). Clustered lights come from the
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
struct LitFrame {sun:vec4f,sunColor:vec4f,ambient:vec4f,eye:vec4f,glow:vec4f,glowColor:vec4f,air:vec4f,airBack:vec4f}
@group(0) @binding(${BINDING}) var<uniform> litFrame:LitFrame;
fn lit(i:Out,c:vec4f)->vec4f {
  let toward=cross(f.right.xyz,f.up.xyz);let z=sqrt(max(0.0,1.0-dot(i.uv,i.uv)));
  let n=normalize(i.litSide.xyz+toward*z);let p=i.litWorld+toward*(z*i.litSide.w);let base=c.rgb;let wrap=litFrame.sunColor.w;
  let up=n.y;let g=litFrame.ambient.w;let r=litFrame.airBack.rgb;
  let sky=litFrame.ambient.rgb*((1.0+up)+g*(1.0-up))/(1.0+g);
  let air=litFrame.air.rgb*((1.0-up)+r*(1.0+up))/(1.0+r);
  var light=base*(sky+air)+${lit.shadows ? `shadowLit(${sun},p,n)` : sun};
  ${lit.lights ? 'light+=clusterLighting(i.clip.xy,p,n,litFrame.eye.xyz,base,1.0,0.0,vec3f(0.04),1.0);' : ''}
  // A fire's glow: a point source of radiant power P (W) at glow.xyz, softened over glow.w metres; its irradiance
  // P / (4 pi (d^2 + r^2)) lights the ball as the noon sun of 1,000 W/m^2 would, with the same wrap: the power is
  // written times noon / pi, so the pi of the sun's Lambert term cancels and E / 1,000 is the share of that sun.
  let toGlow=litFrame.glow.xyz-p;let d2=dot(toGlow,toGlow);
  let e=litFrame.glowColor.w/(12566.37*(d2+litFrame.glow.w*litFrame.glow.w));
  light+=base*litFrame.glowColor.rgb*(e*max(0.0,dot(n,toGlow*inverseSqrt(max(d2,1e-6)))+wrap)/(1.0+wrap));
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

/** A flame's colour as light, linear RGB (a 1,300 K blackbody's hue, as the flame ramp's edge). */
export const GLOW_COLOR: readonly [number, number, number] = [1, 0.42, 0.12];

function checkGlow(g: VFXLit['glow']): void {
  if (g === undefined) return;
  const ok = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (
    !g ||
    typeof g !== 'object' ||
    !Array.isArray(g.position) ||
    g.position.length !== 3 ||
    !g.position.every((v) => ok(v, -1e7, 1e7)) ||
    !ok(g.power, 0, 1e13) ||
    (g.radius !== undefined && !ok(g.radius, 0.01, 1e5)) ||
    (g.color !== undefined && (!Array.isArray(g.color) || g.color.length !== 3 || !g.color.every((v) => ok(v, 0, 16))))
  )
    throw new RangeError(
      'VFX lit glow needs {position: [x, y, z], power: watts 0 to 1e13, radius?: 0.01 to 1e5 m, color?: linear [r, g, b] 0 to 16}',
    );
}

function checkAir(a: unknown): void {
  if (
    a !== undefined &&
    (!Array.isArray(a) ||
      a.length !== 3 ||
      !a.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e3))
  )
    throw new RangeError(
      "VFX lit air must be [r, g, b] shares of the noon sun's light, each 0 to 1000; pass e.g. [0.002, 0.0008, 0.0002]",
    );
}
/**
 * The reflectance of a thick smoke pall, red, green and blue (670, 550 and 440 nm): the two-stream slab reflection of
 * Meador and Weaver (1980) for wildfire smoke, as `hazeReflectance({smoke: 1})` of `@margoengine/weather` gives it.
 * The share of the air's light that the pall over a column sends back down onto its puffs when none is given.
 */
export const PALL_REFLECTANCE: readonly [number, number, number] = [0.337, 0.306, 0.268];

function checkSplit(l: VFXLit): void {
  if (l.ground !== undefined && !(typeof l.ground === 'number' && l.ground >= 0 && l.ground <= 1))
    throw new RangeError("VFX lit ground must be the ground's albedo, 0 to 1; pass e.g. 0.2");
  const r = l.airReflectance;
  if (
    r !== undefined &&
    (!Array.isArray(r) || r.length !== 3 || !r.every((v) => typeof v === 'number' && v >= 0 && v <= 1))
  )
    throw new RangeError(
      'VFX lit airReflectance must be [r, g, b] reflectances of the layer over the particles, each 0 to 1; pass e.g. [0.34, 0.31, 0.27]',
    );
}
function checkNoon(n: unknown): void {
  if (n !== undefined && !(typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1e7))
    throw new RangeError("VFX lit noon must be the noon sun's engine intensity, above 0 and at most 1e7; pass e.g. 1");
}

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
    checkGlow(l.glow);
    checkNoon(l.noon);
    checkAir(l.air);
    checkSplit(l);
  },
  billboard: (code, value) => billboard(code, value),
  create(state: VFXState, value, owned) {
    const { device, options } = state,
      buffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(buffer);
    const values = new Float32Array(32),
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
        // The air's own light (a lit haze round the particles): light of irradiance E from every side shows a ball
        // E / pi, so a share s of the noon sun is s noon / pi on the whole (KB-VFX-COLUMNAMBIENT1), split by the shader
        // into the light from below and the layer's reflectance of it from above (KB-VFX-SMOKEFLAT1).
        checkAir(value.air);
        checkSplit(value);
        values.fill(0, 24, 32);
        const back = value.airReflectance ?? PALL_REFLECTANCE;
        for (let i = 0; i < 3; i++) {
          if (value.air) values[24 + i] = (value.air[i]! * (value.noon ?? Math.PI)) / Math.PI;
          values[28 + i] = back[i]!;
        }
        values[11] = value.ground ?? 0.2;
        values[7] = value.wrap ?? 0.5;
        // The glow is read every frame; none (or no power) adds nothing.
        const g = value.glow;
        checkGlow(g);
        checkNoon(value.noon);
        values.fill(0, 16, 24);
        if (g && g.power > 0) {
          const color = g.color ?? GLOW_COLOR;
          for (let i = 0; i < 3; i++) {
            values[16 + i] = g.position[i]!;
            values[20 + i] = color[i]!;
          }
          values[19] = g.radius ?? 1;
          // Referred to the scene's noon sun (KB-VFX-GLOWUNITS1): pi keeps a sun of intensity pi as the reference.
          values[23] = (g.power * (value.noon ?? Math.PI)) / Math.PI;
        }
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
