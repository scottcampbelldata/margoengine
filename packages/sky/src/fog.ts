import { finiteVector } from '@margoengine/math/validate';
import type { SkyFeatures } from './base.js';
import { perSample, sceneTarget } from '../../shared/msaa.js';
import { applyView } from '../../shared/view-rect.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
// Exponential and EXP2 distance fog beyond `start` as the OpenGL fog equations; the height boost
// (1 + max(-y, 0) h) is Margo's.
const fragment = `
@group(0) @binding(3) var sceneDepth:texture_depth_2d;
@group(0) @binding(4) var<uniform> fog:array<vec4f,2>;
@fragment fn fogFragment(i:Vertex)->@location(0) vec4f {
 let d=textureLoad(sceneDepth,vec2i(i.position.xy),0);if(d<=0.0){discard;}
 let p=frame.inverse*vec4f(i.uv*vec2f(2,-2)+vec2f(-1,1),d,1);let world=p.xyz/p.w;let offset=world-frame.eye.xyz;
 let distance=length(offset);let optical=max(0.0,distance-fog[0].y)*fog[0].x*(1.0+max(-world.y,0.0)*fog[0].w);if(optical<=0.0){discard;}
 let opacity=1.0-exp(-select(optical*optical,optical,fog[0].z>0.5));
 // shortcut: homogeneous distance haze, use volumetric scattering for local weather and light shafts.
 // A zero footprint takes the sky's gradient without the stylized night's stars and moon.
 let ray=offset/max(distance,0.0001);var color=fog[1].rgb;if(fog[1].w<0.5){color=skyRadiance(normalize(vec3f(ray.x,max(0.0001,ray.y),ray.z)),0.0)*exp2(frame.settings.y);}
 if(frame.settings.w<0.5&&frame.sunlight.w<0.5){color=toDisplay(color);}return vec4f(color,opacity);
}`;
/** Distance and height fog over the scene depth (`fog` option), in the sky's colour or a fixed one. */
export const fog: NonNullable<SkyFeatures['fog']> = {
  validate(fog) {
    if (fog?.color) finiteVector(fog.color, 3, 'Fog color');
    if (
      typeof fog !== 'object' ||
      fog === null ||
      typeof fog.depth !== 'function' ||
      (fog.falloff !== undefined && fog.falloff !== 'exp' && fog.falloff !== 'exp2') ||
      !(Math.fround(fog.height ?? 0) >= 0) ||
      !Number.isFinite(Math.fround(fog.height ?? 0)) ||
      !Number.isFinite(Math.fround(fog.density ?? 0.01)) ||
      (fog.density ?? 0.01) < 0 ||
      (fog.density ?? 0.01) > 1 ||
      !Number.isFinite(Math.fround(fog.start ?? 40)) ||
      (fog.start ?? 40) < 0
    )
      throw new RangeError(
        'Invalid sky fog; give a depth function, falloff "exp" or "exp2", height and start of 0 or more, and density from 0 to 1.',
      );
  },
  create(code) {
    const shader = code + fragment,
      values = new Float32Array(8),
      attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' },
      descriptor: GPURenderPassDescriptor = { colorAttachments: [attachment] };
    let uniform: GPUBuffer | undefined,
      pipelines: GPURenderPipeline[] = [],
      binds: GPUBindGroup[] = [],
      bound: GPUTextureView | GPUTexture | undefined,
      key = '';
    return {
      draw(c, fog, entries) {
        const depth = fog.depth();
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
        const target = sceneTarget(c),
          live = target?.samples === 4 && target.resolvedDepth === depth ? target.depthSource : undefined,
          depthSamples = live ? 4 : depth.sampleCount,
          next = c.format + ':' + samples + ':' + depthSamples;
        uniform ??= c.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
