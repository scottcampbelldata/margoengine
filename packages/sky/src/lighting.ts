import { finiteVector } from '@margoengine/math/validate';
import { compute, group } from '../../shared/gpu.js';
import { loadCompatRoute } from '../../shared/compat.js';
import type { SkyFeatures } from './base.js';
import { MargoError } from '@margoengine/math/errors';
import { environment, environmentLayer } from './environment.js';
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
// The same with the sky's environment layer (Sky.environmentLayer, the clouds' deck) laid over it, before the mips and
// the harmonics are taken, so the scene is lit by the clouds as well as the sky.
const renderLayered = `${environmentLayer}
@group(0) @binding(3) var lightTarget:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn renderLight(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 textureStore(lightTarget,vec2i(id.xy),vec4f(layered(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),id.xy),1));
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
// The coefficients are in the sky's units; skyLight[9].w (Sky.lightScale) takes them into the engine light's.
fn skyIrradiance(n:vec3f)->vec3f {
 return max((skyLight[0].rgb+skyLight[1].rgb*n.y+skyLight[2].rgb*n.z+skyLight[3].rgb*n.x+skyLight[4].rgb*(n.x*n.y)+skyLight[5].rgb*(n.y*n.z)+skyLight[6].rgb*(3.0*n.z*n.z-1.0)+skyLight[7].rgb*(n.x*n.z)+skyLight[8].rgb*(n.x*n.x-n.y*n.y))*skyLight[9].w,skyLight[9].rgb);
}
// The sky map toward the unit direction r, blurred through its mips by roughness, in the engine light's units. Light
// probes (@margoengine/environment/probes with a sky) read it with skyIrradiance as their fallback outside the probes.
fn skyRadiance(r:vec3f,rough:f32)->vec3f {
 let uv=vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(clamp(r.y,-1.0,1.0))/3.14159265);
 return textureSampleLevel(skyLightMap,skyLightSampler,uv,rough*3.0).rgb*skyLight[9].w;
}
// Diffuse sky light plus split-sum specular (Karis 2013): the sky map blurred through its mips by roughness, times
// Karis's analytic environment BRDF (2014) instead of a lookup table.
fn skyLighting(n:vec3f,v:vec3f,base:vec3f,metal:f32,roughness:f32,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
 let rough=clamp(roughness,0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let r=reflect(-v,n);
 let k=rough*vec4f(-1.0,-0.0275,-0.572,0.022)+vec4f(1.0,0.0425,1.04,-0.04);
 let a=min(k.x*k.x,exp2(-9.28*nv))*k.x+k.y;let ab=vec2f(-1.04,1.04)*a+k.zw;
 let specular=mix(dielectricF0,base,metal)*ab.x+mix(dielectricF90,1.0,metal)*ab.y;
 let uv=vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(clamp(r.y,-1.0,1.0))/3.14159265);
 return (vec3f(1.0)-specular)*(1.0-metal)*base*skyIrradiance(n)+textureSampleLevel(skyLightMap,skyLightSampler,uv,rough*3.0).rgb*skyLight[9].w*specular;
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
      (l.minimum ?? 0) < 0 ||
      !((l.ground ?? 0.2) >= 0 && (l.ground ?? 0.2) <= 1)
    )
      throw new RangeError(
        'Invalid sky lighting options; set intensity and minimum to finite numbers of 0 or more and ground to an albedo from 0 to 1, or leave them out.',
      );
    if (
      (l.moon !== undefined &&
        (typeof l.moon !== 'object' ||
          l.moon === null ||
          !Number.isFinite(Math.fround(l.moon.intensity ?? 0)) ||
          (l.moon.intensity ?? 0) < 0 ||
          !((l.moon.extinction ?? 0) >= 0 && (l.moon.extinction ?? 0) <= 2) ||
          !(typeof l.moon.brightness === 'string'
            ? l.moon.brightness === 'bright' || l.moon.brightness === 'dim'
            : (l.moon.brightness ?? 1) >= 0 && (l.moon.brightness ?? 1) <= 1e4) ||
          (typeof l.moon.color === 'string' && l.moon.color !== 'blood' && l.moon.color !== 'reddened') ||
          !((l.moon.cloudCover ?? 0) >= 0 && (l.moon.cloudCover ?? 0) <= 1))) ||
      (l.ambient !== undefined && (typeof l.ambient !== 'object' || l.ambient === null))
    )
      throw new RangeError(
        "Invalid sky night options; give moon and ambient as objects, with a finite moon intensity of 0 or more, a moon extinction from 0 to 2, a moon brightness from 0 to 10000 or 'bright' or 'dim', a moon color of linear RGB or 'blood' or 'reddened', and a moon cloudCover from 0 to 1.",
      );
    for (const color of [
      l.color,
      l.sunset,
      typeof l.moon?.color === 'string' ? undefined : l.moon?.color,
      l.ambient?.day,
      l.ambient?.night,
    ])
      if (color !== undefined) {
        finiteVector(color, 3, 'Sky color');
        if (color.some((v) => v < 0)) throw new RangeError('Invalid sky color; use non-negative RGB components.');
      }
    const t = l.twilight;
    if (
      t !== undefined &&
      t !== false &&
      (typeof t !== 'object' ||
        t === null ||
        !((t.brightness ?? 1) >= 0 && (t.brightness ?? 1) <= 1e4) ||
        !((t.cloudCover ?? 0) >= 0 && (t.cloudCover ?? 0) <= 1))
    )
      throw new RangeError(
        'Invalid sky twilight; give false or an object with a brightness from 0 to 10000 and a cloudCover from 0 to 1.',
      );
    if (t && t.color !== undefined) {
      finiteVector(t.color, 3, 'Sky twilight color');
      if (t.color.some((v) => v < 0)) throw new RangeError('Invalid sky color; use non-negative RGB components.');
    }
    if (l.ambient && (!l.ambient.day || !l.ambient.night))
      throw new RangeError('Invalid sky ambient colors; give both ambient.day and ambient.night.');
  },
  create(d, code, entries, owned) {
    // Rows 9 and 10 of the light buffer: the ambient floor and the light scale; the sun's light on level ground (E / pi,
    // the sky's units) and the ground's albedo, which the projection (project.ts) reads.
    const floor = new Float32Array(8),
      descriptor: GPUComputePassDescriptor = {},
      sizes = [8, 4, 4, 4, 2, 2, 1, 1, 1, 1];
    let source = '',
      shader = '';
    // Built on the first ambient frame, so a sky that only drives the light allocates nothing for it.
    const build = () => {
      const buffer = d.createBuffer({
          size: 176,
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
        top = level(0),
        down = compute(d, downsample),
        reduce = compute(d, project);
      const pipelines = [render, down, down, down, reduce],
        groups = [
          d.createBindGroup({
            layout: render.getBindGroupLayout(0),
            entries: [...entries, { binding: 3, resource: top }],
          }),
          group(d, down, [top, level(1)]),
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
        top,
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
    let gpu: ReturnType<typeof build> | undefined,
      layered: { pipeline: GPUComputePipeline; layer?: GPUTexture; group?: GPUBindGroup } | undefined;
    const hooks = new Map<number, { readonly declarations: string; readonly ambient: string }>(),
      terrains = new Map<string, string>();
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
      terrain(source, group) {
        const hook = this.pbr(group);
        if (!hook) return source;
        const key = group + source,
          cached = terrains.get(key);
        if (cached) return cached;
        // Terrain's ambient term: its flat `lighting.ambient` x `radiance[3]`, or a HemisphereLight's term in its place,
        // then what the effects before multiplied it by (layer materials' occlusion, relief lighting's sky visibility).
        const lines = source.match(/let linear=[^;]+;/g),
          term =
            /\+base\*(frame\.radiance\.w\*frame\.ambient\.rgb|margoSkyLight\(n\))((?:\*[A-Za-z_][\w.]*(?:\([^()]*\))?)*)/,
          found = lines?.length === 1 ? term.exec(lines[0]) : null;
        if (!lines || !found)
          throw new MargoError(
            'unsupported',
            "Sky ambient on a terrain requires the terrain's lit shader once; remove the effect that replaced its ambient term",
          );
        // The sky's light (diffuse from its nine harmonics, reflections from its map, Karis's split sum) takes the flat
        // term's place, as on core meshes; a hemisphere's light stays beside it. Terrain is a dielectric (F0 0.04).
        const multiplied = found[2],
          sky = `+margoAmbient${multiplied}`,
          replaced = found[1].startsWith('margoSkyLight') ? found[0] + sky : sky,
          lit = `let margoAmbient=skyLighting(n,v,base,0.0,i.material.x,vec3f(0.04),1.0);${lines[0].replace(found[0], () => replaced)}`,
          code = hook.declarations + source.replace(lines[0], () => lit);
        if (terrains.size >= 16) terrains.clear();
        terrains.set(key, code);
        return code;
      },
      recode(next, bindings) {
        code = next;
        entries = bindings;
        layered = undefined;
        if (!gpu) return;
        // A model switch: only the sky render step reads the sky's code; the map, buffer and bindings stay.
        const render = compute(d, code + environment + renderLight, 'renderLight');
        gpu.pipelines[0] = render;
        gpu.groups[0] = d.createBindGroup({
          layout: render.getBindGroupLayout(0),
          entries: [...entries, { binding: 3, resource: gpu.top }],
        });
      },
      update({ direction, radiance }, sky, l, ambient, night, scale) {
        floor[3] = scale;
        if (ambient) for (let i = 0; i < 3; i++) floor[i] = ambient.day[i] * (1 - night) + ambient.night[i] * night;
        floor[4] = floor[5] = floor[6] = 0;
        floor[7] = l?.ground ?? 0.2;
        // Without `lighting` only the ambient floor moves: the fallback environment never drives the engine light.
        if (!l) return;
        // shortcut: one directional source shares PCSS, use separate shadow maps for simultaneous sun/moon shadows.
        // The engine light is whichever of sun and moon is stronger above the cloud; the moon's is the light under it
        // (Sky.moonUnderClouds, dimmed by lighting.moon.cloudCover). The sun fades out through its own transmittance
        // as its disc sets before the moon fades in, so at dusk the light switches direction while both are near zero
        // (a cross-fade) instead of sweeping through blended directions across the sky.
        // Twilight (sky.twilightLight) is the sky's light on the sun's side; it adds to the sun's beam as irradiance
        // vectors, the sum of both sources as in reality: for any surface both reach, n . (E1 d1 + E2 d2) is the light
        // the two give, and on the ground it is the measured sum of beam and sky. Both lie in the sun's vertical plane,
        // so the light rises from the setting sun toward the twilight glow without crossing the sky, and as the beam
        // goes out the sum becomes the twilight alone (KB-TWILIGHT1). The moon still takes over only as a whole body,
        // while it is stronger under the cloud than the twilight, when both are dim.
        const sun = sky.lights[0],
          moon = sky.lights[1],
          dusk = sky.twilightLight,
          below = sky.moonUnderClouds,
          lum = (c: Float32Array) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
          a = sun.direction,
          b = dusk.direction,
          wa = a[3] * lum(sun.radiance),
          wb = b[3] * lum(dusk.radiance);
        if (l.moon && moon.direction[3] > a[3] && below.direction[3] * lum(below.radiance) >= wb) {
          for (let i = 0; i < 3; i++) {
            direction[i] = below.direction[i];
            radiance[i] = below.radiance[i];
          }
          direction[3] = Math.max(l.minimum ?? 0, below.direction[3]);
        } else if (b[3] === 0) {
          for (let i = 0; i < 3; i++) {
            direction[i] = a[i];
            radiance[i] = sun.radiance[i];
          }
          direction[3] = Math.max(l.minimum ?? 0, a[3]);
        } else {
          // Direction: the luminance-weighted sum. Colour: the intensity-weighted mean. Intensity: the sum's length
          // over that colour's luminance, so the luminance each surface receives is exactly the two lights' sum.
          const x = wa * a[0] + wb * b[0],
            y = wa * a[1] + wb * b[1],
            z = wa * a[2] + wb * b[2],
            length = Math.hypot(x, y, z),
            total = a[3] + b[3];
          for (let i = 0; i < 3; i++) radiance[i] = (a[3] * sun.radiance[i] + b[3] * dusk.radiance[i]) / total;
          direction[0] = x / length;
          direction[1] = y / length;
          direction[2] = z / length;
          direction[3] = Math.max(l.minimum ?? 0, length / (lum(radiance) || 1));
        }
        if (ambient) radiance[3] = Math.max(floor[0], floor[1], floor[2]);
        // The engine light on level ground, E / pi in the sky's units, for the ground's reflected light.
        const level = (Math.max(direction[1], 0) * direction[3]) / (Math.PI * (scale || 1));
        for (let i = 0; i < 3; i++) floor[4 + i] = radiance[i] * level;
      },
      pass(c, layer) {
        const g = (gpu ??= build()),
          encoder = c.encoder.beginComputePass(descriptor);
        if (layer) {
          layered ??= { pipeline: compute(d, code + environment + renderLayered, 'renderLight') };
          if (layered.layer !== layer)
            layered.group = d.createBindGroup({
              layout: layered.pipeline.getBindGroupLayout(0),
              entries: [...entries, { binding: 3, resource: g.top }, { binding: 4, resource: layer.createView() }],
            });
          layered.layer = layer;
        }
        for (let i = 0; i < 5; i++) {
          encoder.setPipeline(i === 0 && layered && layer ? layered.pipeline : g.pipelines[i]);
          encoder.setBindGroup(0, i === 0 && layered && layer ? layered.group! : g.groups[i]);
          encoder.dispatchWorkgroups(sizes[i * 2], sizes[i * 2 + 1]);
        }
        encoder.end();
        c.device.queue.writeBuffer(g.buffer, 144, floor as Float32Array<ArrayBuffer>);
      },
      patch(c) {
        if (!gpu) return;
        if (source !== c.shader) {
          const anchor = /let linear=([^;]+);/.exec(c.shader);
          // Core's constant ambient term, or a HemisphereLight's sky term in its place (environment, order -1): the
          // hemisphere's light stays beside the sky's, as when the sky patched first.
          if (!anchor || !(anchor[1].includes('frame.radiance.w') || anchor[1].includes('margoSkyLight(')))
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
        c.bindings.push(...gpu.bindings);
      },
    };
  },
};
