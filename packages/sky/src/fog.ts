import { finiteVector } from '@margoengine/math/validate';
import type { SkyFeatures } from './base.js';
import { DECK_ABOVE, overcastLightWgsl } from './clouds.js';
import { perSample, sceneTarget } from '../../shared/msaa.js';
import { applyView } from '../../shared/view-rect.js';
import { checkFireSpots, fireTrackWgsl, writeFireSpots } from './fire-spots.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
// Exponential and EXP2 distance fog beyond `start` as the OpenGL fog equations; the height boost
// (1 + max(-y, 0) h) is Margo's. Under a cloud cover the haze takes the light of the cloud's underside by the cover's
// share (cloudHaze), not the clear sky behind the cloud: a low sun under an overcast no longer tints it gold.
const fragment = `
@group(0) @binding(3) var sceneDepth:texture_depth_2d;
@group(0) @binding(4) var<uniform> fog:array<vec4f,20>;
// The haze's light below the eye (fog.lightDecay in fog[19].xyz, KB-SKY-HAZEBELOW1): a ray going down at sine down
// meets haze lit less than the haze at the eye, by e^(-k tau) at a vertical optical depth tau under it (the two-stream
// diffusion mode). In a layer the same in every horizontal direction the vertical optical depth to a point is down
// times the ray's optical depth to it, whatever the density's height profile, so the in-scatter of a ray of optical
// depth x is the eye's haze colour times (1 - e^(-x (1 + c))) / (1 + c) with c = k down, over the opacity 1 - e^(-x):
// 1 for a short ray, 1 / (1 + c) for a long one (in-scatter along the actual ray to the ground, as in Hillaire 2020 and
// Bruneton and Neyret 2008, not the horizon's for every ray below it).
fn fogBelowLight(down:f32,x:f32)->vec3f {
 let c=fog[19].xyz*down;
 if(x<1e-3){return vec3f(1.0)-0.5*c*x;}
 return (vec3f(1.0)-exp(-x*(vec3f(1.0)+c)))/((vec3f(1.0)+c)*(1.0-exp(-x)));
}
// The fires' colour on the haze (fog.fireSpots), two vec4 a spot from fog[3]: rgb and the reach R squared, then x, an
// unused height and z. Each spot adds its colour times the mean of (R^2 / (R^2 + r^2))^1.5 along the path from start to end,
// seen from above, in closed form: with u along the path from the closest approach to the spot and a^2 = R^2 + d^2, the
// integral is R^3 u / (a^2 sqrt(a^2 + u^2)). The caller ends the path 2 / density from the eye: the haze's light comes
// from there (airlight weighted by e^(-density t) has its mean at 1 / density).
${fireTrackWgsl('fireHaze', (part) => `fog[${part ? 4 : 3}u+2u*i]`)}@fragment fn fogFragment(i:Vertex)->@location(0) vec4f {
 let d=textureLoad(sceneDepth,vec2i(i.position.xy),0);if(d<=0.0){discard;}
 let p=frame.inverse*vec4f(i.uv*vec2f(2,-2)+vec2f(-1,1),d,1);let world=p.xyz/p.w;let offset=world-frame.eye.xyz;
 let distance=length(offset);var optical=max(0.0,distance-fog[0].y)*fog[0].x*(1.0+max(-world.y,0.0)*fog[0].w);
 if(fog[2].x>0.0){let a=(frame.eye.y-fog[2].y)*fog[2].x;let k=(world.y-frame.eye.y)*fog[2].x;optical=optical*exp(-a)*select((1.0-exp(-k))/k,1.0-0.5*k,abs(k)<1e-3);}
 if(optical<=0.0){discard;}
 let x=select(optical*optical,optical,fog[0].z>0.5);let opacity=1.0-exp(-x);
 // shortcut: homogeneous distance haze, use volumetric scattering for local weather and light shafts.
 // A zero footprint takes the sky's gradient without the stylized night's stars and moon.
 let ray=offset/max(distance,0.0001);var color=fog[1].rgb;if(fog[1].w<0.5){color=skyRadiance(normalize(vec3f(ray.x,max(0.0001,ray.y),ray.z)),0.0);
 if(frame.moonColor.w>0.0&&frame.clouds.x>0.0){let under=(overcastLight(1.0)*(${(9 / 7).toFixed(6)}*(1.0+2.0*max(ray.y,0.0))/3.0)+vec3f(0.006,0.01,0.02)*frame.moonColor.w)*(1.0-clamp(frame.sun.w,0.0,1.0));color=mix(color,under,clamp(frame.clouds.x,0.0,1.0));}
 color=color*exp2(frame.settings.y);}
 if(ray.y<0.0){color*=fogBelowLight(-ray.y,x);}
 if(fog[3].w>0.0){color+=fireHaze(frame.eye.xz,mix(frame.eye.xz,world.xz,min(1.0,2.0/max(fog[0].x*distance,1e-6))));}
 if(frame.settings.w<0.5&&frame.sunlight.w<0.5){color=toDisplay(color);}return vec4f(color,opacity);
}`;
/**
 * The sky fog's colour under a cloud cover, as the fog shader draws it (before the sky's exposure): the clear sky's
 * radiance `clear` toward the ray mixed by the cover `coverage` (0 to 1) toward the light under the cloud, the CIE
 * overcast gradation of the two-stream light through a deck of transmission `T` (in the sky model's units, as the sky
 * sets it: `units` / (1 + 0.075 depth)) of the sun `sunlight` at sine of elevation `sunUp` and the clear sky's own E / pi
 * `above` (`clearSkyLevel`, in the model's units), seen at sine of elevation `up` (`overcastDeck`). `T` 0 (no `clouds`
 * option) keeps `clear`. Sources: CIE S 011/E:2003 overcast sky; the two-stream deck of clouds.ts. Fauld recut
 * (2026-11-24): a 2 to 4 degree November sun under an overcast washed the whole valley gold through the haze, first
 * through the clear sky behind the cloud, then (KB-SKY-OVERCAST2) through the deck lit in the sun's colour alone.
 * @example cloudHaze([0.8, 0.5, 0.2], [1, 0.9, 0.8], 0.1, 0, 1, 0.3, [0.2, 0.25, 0.35]); // the deck's grey, not gold
 */
export function cloudHaze(
  clear: readonly number[],
  sunlight: readonly number[],
  sunUp: number,
  up: number,
  coverage: number,
  T: number,
  above: readonly number[] = [0, 0, 0],
  units = 1,
): [number, number, number] {
  if (!(T > 0)) return [clear[0], clear[1], clear[2]];
  const grade = (9 / 7) * ((1 + 2 * Math.max(up, 0)) / 3),
    k = DECK_ABOVE * Math.max(sunUp, 0) * T,
    floor = [0.006, 0.01, 0.02],
    c = Math.min(1, Math.max(0, coverage));
  return [0, 1, 2].map(
    (i) => clear[i] * (1 - c) + ((sunlight[i] * k + (above[i] * T) / units) * grade + floor[i] * T) * c,
  ) as [number, number, number];
}

/**
 * The fog's optical depth along a ray of `distance` metres from an eye at height `eyeY` to a point at `pointY`, as the fog
 * shader computes it (exp falloff, before the squaring of exp2): `density` times the distance past `start`, times the
 * below-zero boost, times the exponential height fog's mean along the ray when `scaleHeight` is over 0:
 * exp(-(eyeY - base) / H) (1 - exp(-k)) / k with k = (pointY - eyeY) / H (the closed-form integral of an exponential
 * density along a straight ray; Wenzel, "Real-time Atmospheric Effects in Games Revisited", GDC 2007; Quilez, "Better
 * Fog", 2010). Fauld recut (2026-11-24): with a density the same at every height, drone shots at 300 to 600 m looked
 * through ground-level winter haze over their whole path and read as grey fields of fog.
 * @example fogOpticalDepth({ density: 0.0005, start: 0, scaleHeight: 400, base: 80 }, 800, 600, 80); // under 0.4, the haze is thin above the layer
 */
export function fogOpticalDepth(
  fog: { density?: number; start?: number; height?: number; scaleHeight?: number; base?: number },
  distance: number,
  eyeY: number,
  pointY: number,
): number {
  let optical = Math.max(0, distance - (fog.start ?? 40)) * (fog.density ?? 0.01) * (1 + Math.max(-pointY, 0) * (fog.height ?? 0));
  if (fog.scaleHeight) {
    const a = (eyeY - (fog.base ?? 0)) / fog.scaleHeight,
      k = (pointY - eyeY) / fog.scaleHeight;
    optical *= Math.exp(-a) * (Math.abs(k) < 1e-3 ? 1 - 0.5 * k : (1 - Math.exp(-k)) / k);
  }
  return optical;
}

/**
 * The share of the fog's colour the haze along a ray going below the horizon takes, red, green and blue, as the fog
 * shader computes it (KB-SKY-HAZEBELOW1): with `decay` k (`fog.lightDecay`, the haze's light falling as e^(-k tau) with
 * the vertical optical depth tau below the eye), a ray at sine of elevation `rayY` under 0 and of optical depth `optical`
 * (the fog's exponent: {@link fogOpticalDepth}, squared for 'exp2') takes (1 - e^(-x (1 + c))) / ((1 + c) (1 - e^(-x)))
 * with c = k (-rayY): 1 for a short ray, 1 / (1 + c) for a long one. Rays at or above the horizon take 1. The in-scatter
 * is integrated along the actual ray to the ground, as aerial perspective is (S. Hillaire, "A Scalable and Production
 * Ready Sky and Atmosphere Rendering Technique", EGSR 2020, https://doi.org/10.1111/cgf.14050; E. Bruneton and
 * F. Neyret, "Precomputed Atmospheric Scattering", EGSR 2008, https://doi.org/10.1111/j.1467-8659.2008.01245.x; A. J.
 * Preetham, P. Shirley and B. Smits, "A Practical Analytic Model for Daylight", SIGGRAPH 1999,
 * https://doi.org/10.1145/311535.311545), in place of the horizon's colour for every ray below it, which drew a fully
 * hazed far ground as one flat colour.
 * @example fogBelowLight([0.4, 0.45, 0.5], -0.37, 20); // about 0.87, 0.86 and 0.84: the far ground 22 degrees down is darker
 */
export function fogBelowLight(decay: readonly number[], rayY: number, optical: number): [number, number, number] {
  return [0, 1, 2].map((i) => {
    if (!(rayY < 0)) return 1;
    const c = (decay[i] ?? 0) * -rayY;
    if (optical < 1e-3) return 1 - 0.5 * c * optical;
    return (1 - Math.exp(-optical * (1 + c))) / ((1 + c) * (1 - Math.exp(-optical)));
  }) as [number, number, number];
}

/** Distance and height fog over the scene depth (`fog` option), in the sky's colour or a fixed one. */
export const fog: NonNullable<SkyFeatures['fog']> = {
  validate(fog) {
    if (fog?.color) finiteVector(fog.color, 3, 'Fog color');
    checkFireSpots(fog?.fireSpots, 'fog.fireSpots');
    if (fog?.lightDecay !== undefined) {
      finiteVector(fog.lightDecay, 3, 'Fog lightDecay');
      if (fog.lightDecay.some((k) => !(Math.fround(k) >= 0) || !Number.isFinite(Math.fround(k))))
        throw new RangeError('Invalid sky fog lightDecay; give three finite numbers of 0 or more.');
    }
    if (
      typeof fog !== 'object' ||
      fog === null ||
      (fog.depth !== undefined && typeof fog.depth !== 'function') ||
      (fog.falloff !== undefined && fog.falloff !== 'exp' && fog.falloff !== 'exp2') ||
      !(Math.fround(fog.height ?? 0) >= 0) ||
      !Number.isFinite(Math.fround(fog.height ?? 0)) ||
      !Number.isFinite(Math.fround(fog.density ?? 0.01)) ||
      (fog.density ?? 0.01) < 0 ||
      (fog.density ?? 0.01) > 1 ||
      !Number.isFinite(Math.fround(fog.start ?? 40)) ||
      (fog.start ?? 40) < 0 ||
      !(Math.fround(fog.scaleHeight ?? 0) >= 0) ||
      !Number.isFinite(Math.fround(fog.scaleHeight ?? 0)) ||
      !Number.isFinite(Math.fround(fog.base ?? 0))
    )
      throw new RangeError(
        'Invalid sky fog; give an optional depth function, falloff "exp" or "exp2", height, start and scaleHeight of 0 or more, a finite base, and density from 0 to 1.',
      );
  },
  create(code) {
    // The deck's light (clouds.ts overcastLight): the sky's own when it draws the clouds, else compiled in here.
    const shader = code + (code.includes('fn overcastLight(') ? '' : overcastLightWgsl) + fragment,
      values = new Float32Array(80),
      attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' },
      descriptor: GPURenderPassDescriptor = { colorAttachments: [attachment] };
    let uniform: GPUBuffer | undefined,
      pipelines: GPURenderPipeline[] = [],
      binds: GPUBindGroup[] = [],
      bound: GPUTextureView | GPUTexture | undefined,
      key = '';
    return {
      draw(c, fog, entries) {
        const target = sceneTarget(c);
        const depth = fog.depth ? fog.depth() : target?.resolvedDepth;
        if (!depth || (fog.density ?? 0.01) === 0) return;
        const samples = c.descriptor.multisample?.count ?? 1;
        if (
          !depth.format.startsWith('depth') ||
          depth.dimension !== '2d' ||
          depth.depthOrArrayLayers !== 1 ||
          depth.width !== c.width ||
          depth.height !== c.height ||
          !(depth.usage & GPUTextureUsage.TEXTURE_BINDING) ||
          (depth.sampleCount !== 1 && depth.sampleCount !== samples)
        )
          throw new RangeError('Sky fog requires matching sampleable scene depth');
        // A 4x capture resolves its 1x depth only when it presents, after this pass, so that texture still holds the last
        // frame: fog over it follows every silhouette a frame behind while the view turns. Read the capture's own samples.
        const live = target?.samples === 4 && target.resolvedDepth === depth ? target.depthSource : undefined,
          depthSamples = live ? 4 : depth.sampleCount,
          next = c.format + ':' + samples + ':' + depthSamples;
        uniform ??= c.device.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        if (key !== next) {
          // Per sample over multisampled depth: one draw reading sample_index, or at the compatibility level, which has
          // no sample_index, one masked draw per sample.
          pipelines = (depthSamples === 1 ? [null] : perSample(c.device, samples)).map((sample) => {
            const source =
              depthSamples === 1
                ? shader
                : sample !== null
                  ? shader
                      .replace('sceneDepth:texture_depth_2d', 'sceneDepth:texture_depth_multisampled_2d')
                      .replace('vec2i(i.position.xy),0', `vec2i(i.position.xy),${sample}`)
                  : shader
                      .replace('sceneDepth:texture_depth_2d', 'sceneDepth:texture_depth_multisampled_2d')
                      .replace('fogFragment(i:Vertex)', 'fogFragment(i:Vertex,@builtin(sample_index) sample:u32)')
                      .replace('vec2i(i.position.xy),0', 'vec2i(i.position.xy),i32(sample)');
            const module = c.device.createShaderModule({ code: source });
            return c.device.createRenderPipeline({
              layout: 'auto',
              vertex: { module, entryPoint: 'vertex' },
              fragment: {
                module,
                entryPoint: 'fogFragment',
                targets: [
                  {
                    format: c.format,
                    blend: {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                    },
                  },
                ],
              },
              multisample: sample === null ? c.descriptor.multisample : { count: samples, mask: 1 << sample },
            });
          });
          key = next;
          bound = undefined;
        }
        if (bound !== (live ?? depth)) {
          const view = live ?? depth.createView({ aspect: 'depth-only' });
          binds = pipelines.map((pipeline) =>
            c.device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [...entries, { binding: 3, resource: view }, { binding: 4, resource: { buffer: uniform! } }],
            }),
          );
          bound = live ?? depth;
        }
        values[0] = fog.density ?? 0.01;
        values[1] = fog.start ?? 40;
        values[2] = +(fog.falloff === 'exp');
        values[3] = fog.height ?? 0;
        values.set(fog.color ?? [0, 0, 0], 4);
        values[7] = +!!fog.color;
        values[8] = fog.scaleHeight ? 1 / fog.scaleHeight : 0;
        values[9] = fog.base ?? 0;
        writeFireSpots(values, 12, fog.fireSpots);
        values.set(fog.lightDecay ?? [0, 0, 0], 76);
        c.device.queue.writeBuffer(uniform, 0, values as Float32Array<ArrayBuffer>);
        attachment.view = c.color;
        const pass = c.encoder.beginRenderPass(descriptor);
        applyView(pass, c);
        for (let i = 0; i < pipelines.length; i++) {
          pass.setPipeline(pipelines[i]);
          pass.setBindGroup(0, binds[i]);
          pass.draw(3);
        }
        pass.end();
      },
      release() {
        uniform?.destroy();
      },
    };
  },
};
