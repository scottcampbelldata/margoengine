import { finiteVector } from '@margoengine/math/validate';
import { compute, group } from '../../shared/gpu.js';
import { loadCompatRoute } from '../../shared/compat.js';
import type { SkyFeatures } from './base.js';
import { MargoError } from '@margoengine/math/errors';
import { environment } from './environment.js';
import { project } from './project.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
// The sky's light as the scene receives it: a 64 x 32 environment rendered each frame, three box-filtered mips for
// rougher reflections, and nine spherical-harmonic coefficients for diffuse light.
const renderLight = `
@group(0) @binding(3) var lightTarget:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn renderLight(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 textureStore(lightTarget,vec2i(id.xy),vec4f(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),1));
}`;
const downsample = `
@group(0) @binding(0) var finer:texture_2d<f32>;
@group(0) @binding(1) var coarser:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,4) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=textureDimensions(coarser))){return;}let p=vec2i(id.xy)*2;
 textureStore(coarser,vec2i(id.xy),(textureLoad(finer,p,0)+textureLoad(finer,p+vec2i(1,0),0)+textureLoad(finer,p+vec2i(0,1),0)+textureLoad(finer,p+vec2i(1),0))*0.25);
}`;
// Analytic environment BRDF in skyLighting: Karis 2014, "Physically Based Shading on Mobile" (after Lazarov 2013), a
// published engine standard. Reflection mip = roughness x 3 is Margo's.
// Patched into the scene shader as margoAmbient, the name SSAO looks for to occlude ambient light.
const declarations = `@group(0) @binding(8) var<uniform> skyLight:array<vec4f,10>;
@group(0) @binding(10) var skyLightMap:texture_2d<f32>;
@group(0) @binding(11) var skyLightSampler:sampler;
// Irradiance over pi for a unit normal: the sky's nine coefficients, never below the ambient floor.
fn skyIrradiance(n:vec3f)->vec3f {
 return max(skyLight[0].rgb+skyLight[1].rgb*n.y+skyLight[2].rgb*n.z+skyLight[3].rgb*n.x+skyLight[4].rgb*(n.x*n.y)+skyLight[5].rgb*(n.y*n.z)+skyLight[6].rgb*(3.0*n.z*n.z-1.0)+skyLight[7].rgb*(n.x*n.z)+skyLight[8].rgb*(n.x*n.x-n.y*n.y),skyLight[9].rgb);
}
// Diffuse sky light plus split-sum specular (Karis 2013): the sky map blurred through its mips by roughness, times
// Karis's analytic environment BRDF (2014) instead of a lookup table.
fn skyLighting(n:vec3f,v:vec3f,base:vec3f,metal:f32,roughness:f32,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
 let rough=clamp(roughness,0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let r=reflect(-v,n);
 let k=rough*vec4f(-1.0,-0.0275,-0.572,0.022)+vec4f(1.0,0.0425,1.04,-0.04);
 let a=min(k.x*k.x,exp2(-9.28*nv))*k.x+k.y;let ab=vec2f(-1.04,1.04)*a+k.zw;
 let specular=mix(dielectricF0,base,metal)*ab.x+mix(dielectricF90,1.0,metal)*ab.y;
 let uv=vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(clamp(r.y,-1.0,1.0))/3.14159265);
 return (vec3f(1.0)-specular)*(1.0-metal)*base*skyIrradiance(n)+textureSampleLevel(skyLightMap,skyLightSampler,uv,rough*3.0).rgb*specular;
}
`;
/**
 * Drives the engine's directional light (sun or moon) and, with `ambient`, lights core's PBR shader from the sky
 * itself: directional diffuse from nine spherical harmonics and sky reflections, above the ambient floor (`lighting`).
 */
export const lighting: NonNullable<SkyFeatures['lighting']> = {
  validate(l) {
    if (
      typeof l !== 'object' ||
      l === null ||
      !Number.isFinite(Math.fround(l.intensity ?? 1)) ||
      (l.intensity ?? 1) < 0 ||
      !Number.isFinite(Math.fround(l.minimum ?? 0)) ||
      (l.minimum ?? 0) < 0
    )
      throw new RangeError(
        'Invalid sky lighting options; set intensity and minimum to finite numbers of 0 or more, or leave them out.',
      );
    if (
      (l.moon !== undefined &&
        (typeof l.moon !== 'object' ||
          l.moon === null ||
          !Number.isFinite(Math.fround(l.moon.intensity ?? (l.intensity ?? 1) * 0.1)) ||
          (l.moon.intensity ?? 0) < 0)) ||
      (l.ambient !== undefined && (typeof l.ambient !== 'object' || l.ambient === null))
    )
      throw new RangeError(
        'Invalid sky night options; give moon and ambient as objects, with a finite moon intensity of 0 or more.',
      );
    for (const color of [l.color, l.sunset, l.moon?.color, l.ambient?.day, l.ambient?.night])
      if (color !== undefined) {
        finiteVector(color, 3, 'Sky color');
        if (color.some((v) => v < 0)) throw new RangeError('Invalid sky color; use non-negative RGB components.');
      }
    if (l.ambient && (!l.ambient.day || !l.ambient.night))
      throw new RangeError('Invalid sky ambient colors; give both ambient.day and ambient.night.');
  },
  create(d, code, entries, owned) {
    const floor = new Float32Array(4),
      descriptor: GPUComputePassDescriptor = {},
      sizes = [8, 4, 4, 4, 2, 2, 1, 1, 1, 1];
    let source = '',
      shader = '';
    // Built on the first ambient frame, so a sky that only drives the light allocates nothing for it.
    const build = () => {
      const buffer = d.createBuffer({
          size: 160,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        map = d.createTexture({
          size: [64, 32],
          format: 'rgba16float',
          mipLevelCount: 4,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
      owned.push(buffer, map);
      const level = (i: number) => map.createView({ baseMipLevel: i, mipLevelCount: 1 }),
        render = compute(d, code + environment + renderLight, 'renderLight'),
        down = compute(d, downsample),
        reduce = compute(d, project);
      const pipelines = [render, down, down, down, reduce],
        groups = [
          d.createBindGroup({
            layout: render.getBindGroupLayout(0),
            entries: [...entries, { binding: 3, resource: level(0) }],
          }),
          group(d, down, [level(0), level(1)]),
          group(d, down, [level(1), level(2)]),
          group(d, down, [level(2), level(3)]),
          group(d, reduce, [level(1), { buffer }]),
        ];
      // On the WebGL2 layer the projection moves off the CPU tier once its route has loaded.
      loadCompatRoute(d, () => import('./compat.js'))?.then(({ projectRoute }) => {
        const route = compute(d, projectRoute);
        pipelines[4] = route;
        groups[4] = group(d, route, [level(1), { buffer }]);
      });
      return {
        buffer,
        pipelines,
        groups,
        bindings: [
          { binding: 8, resource: { buffer, offset: 0, size: 160 } },
          { binding: 10, resource: map.createView() },
          {
            binding: 11,
            resource: d.createSampler({
              addressModeU: 'repeat',
              addressModeV: 'clamp-to-edge',
              magFilter: 'linear',
              minFilter: 'linear',
              mipmapFilter: 'linear',
            }),
          },
        ],
      };
    };
    let gpu: ReturnType<typeof build> | undefined;
    const hooks = new Map<number, { readonly declarations: string; readonly ambient: string }>();
    return {
      pbr(group) {
        if (!gpu) return undefined;
        let value = hooks.get(group);
        if (!value) {
          value = {
            declarations: declarations.replaceAll('@group(0)', `@group(${group})`),
            ambient: 'skyLighting(s.n,v,s.base.rgb,s.metal,s.roughness,s.f0,s.sw)*s.occlusion',
          };
          hooks.set(group, value);
        }
        return value;
      },
      bindings() {
        return gpu?.bindings ?? [];
      },
      update({ direction, radiance }, sky, l, ambient, night) {
        if (ambient) for (let i = 0; i < 3; i++) floor[i] = ambient.day[i] * (1 - night) + ambient.night[i] * night;
        // Without `lighting` only the ambient floor moves: the fallback environment never drives the engine light.
        if (!l) return;
        // shortcut: one directional source shares PCSS, use separate shadow maps for simultaneous sun/moon shadows.
        // The engine light is whichever of sun and moon is stronger. The sun fades out through its own transmittance
        // as its disc sets before the moon fades in, so at dusk the light switches direction while both are near zero
        // (a cross-fade) instead of sweeping through blended directions across the sky.
        const sun = sky.lights[0],
          moon = sky.lights[1],
          body = l.moon && moon.direction[3] > sun.direction[3] ? moon : sun;
        for (let i = 0; i < 3; i++) {
          direction[i] = body.direction[i];
          radiance[i] = body.radiance[i];
        }
        direction[3] = Math.max(l.minimum ?? 0, body.direction[3]);
        if (ambient) radiance[3] = Math.max(floor[0], floor[1], floor[2]);
      },
      pass(c) {
        const g = (gpu ??= build()),
          encoder = c.encoder.beginComputePass(descriptor);
        for (let i = 0; i < 5; i++) {
          encoder.setPipeline(g.pipelines[i]);
          encoder.setBindGroup(0, g.groups[i]);
          encoder.dispatchWorkgroups(sizes[i * 2], sizes[i * 2 + 1]);
        }
        encoder.end();
        c.device.queue.writeBuffer(g.buffer, 144, floor as Float32Array<ArrayBuffer>);
        if (source !== c.shader) {
          const anchor = /let linear=([^;]+);/.exec(c.shader);
          if (!anchor?.[1].includes('frame.radiance.w'))
            throw new MargoError(
              'unsupported',
              "Sky ambient requires the standard PBR shader; remove the plugin that replaced core's shader",
            );
          // Core's constant ambient term drops out; margoAmbient carries the sky's diffuse and specular light.
          const linear = `let margoAmbient=skyLighting(n,v,i.color,i.material.y,i.material.x,vec3f(0.04),1.0);let linear=${anchor[1].replace('frame.radiance.w', '0.0')}+margoAmbient;`;
          source = c.shader;
          shader = declarations + c.shader.replace(anchor[0], () => linear);
        }
        c.shader = shader;
        c.bindings.push(...g.bindings);
      },
    };
  },
};
