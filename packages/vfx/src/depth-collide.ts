import { invertMatrix } from '@margoengine/math/mat4';
import { viewRect } from '../../shared/view-rect.js';
import type { VFXDepthCollide, VFXExtension, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Bytes of the collision uniform: last frame's view-projection and its inverse, eye, screen rectangle, shape. */
const BYTES = 176;

/**
 * One thread per particle on last frame's draw list (alive, counted in visible[1]): the particle's centre projects with
 * last frame's camera onto last frame's scene depth (reversed Z). Where the surface there lies within `thickness` behind
 * the centre, or less than the particle's radius in front of it, the particle has met the surface: the surface normal
 * comes from the surface points of neighbouring texels (on each axis the neighbour nearer in depth, so an edge does not
 * bend it), the velocity's part into the surface is reflected and scaled by `bounce`, and the centre moves out until it
 * is a radius in front of the surface's plane. Each thread writes only its own slot, so the result is the same whatever
 * order the threads run in.
 */
const shader = (samples: number) => /* wgsl */ `
struct Collide {last:mat4x4f,inverse:mat4x4f,eye:vec4f,screen:vec4f,shape:vec4f}
@group(0) @binding(0) var<uniform> collide:Collide;
@group(0) @binding(1) var<storage,read_write> particles:array<vec4f>;
@group(0) @binding(2) var<storage,read> alive:array<u32>;
@group(0) @binding(3) var<storage,read> visible:array<u32,5>;
@group(0) @binding(4) var sceneDepth:texture_depth${samples > 1 ? '_multisampled' : ''}_2d;
// The world point of the depth at texel t (clamped to the texture), and that depth in w (0 where nothing was drawn).
fn surfaceAt(t:vec2i)->vec4f {
  let at=clamp(t,vec2i(0),vec2i(textureDimensions(sceneDepth))-1);var d=textureLoad(sceneDepth,at,0);
  ${samples > 1 ? `for(var s=1;s<${samples};s++){d=max(d,textureLoad(sceneDepth,at,s));}` : ''}
  let pixel=vec2f(at)+0.5;let ndc=vec2f((pixel.x-collide.screen.z)/collide.screen.x*2-1,1-(pixel.y-collide.screen.w)/collide.screen.y*2);
  let w=collide.inverse*vec4f(ndc,d,1);return vec4f(w.xyz/w.w,d);
}
@compute @workgroup_size(256) fn collideDepth(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=visible[1]){return;}
  let slot=alive[id.x];let a=particles[slot*2];let b=particles[slot*2+1];
  if(a.w<=0.0){return;}
  let clip=collide.last*vec4f(a.xyz,1);if(clip.w<=0.0){return;}
  let ndc=clip.xy/clip.w;if(any(abs(ndc)>vec2f(1))){return;}
  let t=vec2i(floor(vec2f(ndc.x*0.5+0.5,0.5-ndc.y*0.5)*collide.screen.xy+collide.screen.zw));
  let s=surfaceAt(t);if(s.w<=0.0){return;}
  let radius=b.w*0.5;let gap=dot(a.xyz-s.xyz,normalize(a.xyz-collide.eye.xyz));
  if(gap<=-radius||gap>=collide.shape.x){return;}
  let right=surfaceAt(t+vec2i(1,0));let left=surfaceAt(t-vec2i(1,0));let down=surfaceAt(t+vec2i(0,1));let up=surfaceAt(t-vec2i(0,1));
  let dx=select(s.xyz-left.xyz,right.xyz-s.xyz,abs(right.w-s.w)<abs(left.w-s.w));
  let dy=select(s.xyz-up.xyz,down.xyz-s.xyz,abs(down.w-s.w)<abs(up.w-s.w));
  var n=cross(dx,dy);let size=length(n);if(size<=0.0){return;}n/=size;
  if(dot(n,collide.eye.xyz-s.xyz)<0.0){n=-n;}
  var v=b.xyz;let into=dot(v,n);if(into<0.0){v-=(1.0+collide.shape.y)*into*n;}
  particles[slot*2]=vec4f(a.xyz+n*max(0.0,radius-dot(a.xyz-s.xyz,n)),a.w);particles[slot*2+1]=vec4f(v,b.w);
}
`;

/**
 * The `depthCollide` feature: particles bounce off whatever was drawn last frame, using the scene depth from the
 * `depth` option (as `softness` does). Pass it as `{depthCollide}` to `VFX` from `@margoengine/vfx/base`; the root
 * `VFX` has it. `thickness` is read every frame, `bounce` is the effect's own.
 */
export const depthCollide: VFXExtension<VFXDepthCollide> = {
  validate(d, options) {
    if (!d || typeof d !== 'object')
      throw new TypeError('VFX depthCollide must be an object; pass {} or {thickness: 0.5}');
    const thickness = d.thickness ?? 0.5;
    if (typeof thickness !== 'number' || !Number.isFinite(thickness) || thickness <= 0 || thickness > 1e6)
      throw new RangeError('VFX depthCollide thickness must be a world distance above 0; pass e.g. 0.5');
    if (typeof options.depth !== 'function')
      throw new TypeError(
        'VFX depthCollide needs scene depth: add DepthTexture from @margoengine/post/depth and pass depth: () => depth.texture',
      );
  },
  create(state: VFXState, value, owned) {
    const { device, options } = state,
      buffer = device.createBuffer({ size: BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(buffer);
    const values = new Float32Array(BYTES / 4),
      last = values.subarray(0, 16),
      inverse = values.subarray(16, 32),
      pipelines = new Map<number, GPUComputePipeline>(),
      groups = new WeakMap<GPUTexture, GPUBindGroup>(),
      count = Math.ceil(state.capacity / 256);
    let ready = false;
    return {
      write(c) {
        const d = options.depthCollide,
          depth = options.depth?.();
        if (d && d !== value)
          throw new TypeError('VFX depthCollide is fixed at attach; change its thickness in place or attach a new VFX');
        // Last frame's camera meets last frame's depth: the scene depth of this frame is drawn after the simulation.
        if (d && ready && depth) {
          const samples = depth.sampleCount;
          if (
            !depth.format.startsWith('depth') ||
            depth.dimension !== '2d' ||
            !(depth.usage & 4) /* GPUTextureUsage.TEXTURE_BINDING */
          )
            throw new RangeError(
              'VFX depthCollide needs a sampleable depth texture; pass the texture of DepthTexture from @margoengine/post/depth',
            );
          values[40] = d.thickness ?? 0.5;
          values[41] = options.bounce ?? 0.3;
          c.device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
          let pipeline = pipelines.get(samples);
          if (!pipeline) {
            pipeline = device.createComputePipeline({
              layout: 'auto',
              compute: { module: device.createShaderModule({ code: shader(samples) }), entryPoint: 'collideDepth' },
            });
            pipelines.set(samples, pipeline);
          }
          let group = groups.get(depth);
          if (!group)
            groups.set(
              depth,
              (group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                  ...[buffer, state.particles, state.alive, state.visible].map((b, binding) => ({
                    binding,
                    resource: { buffer: b },
                  })),
                  { binding: 4, resource: depth.createView({ aspect: 'depth-only' }) },
                ],
              })),
            );
          const pass = c.encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(count);
          pass.end();
        }
        // This frame's camera and view, for the next frame's collisions.
        ready = invertMatrix(c.camera.matrix, inverse) !== null;
        last.set(c.camera.matrix);
        const eye = c.camera.position,
          rect = viewRect(c);
        values.set(eye, 32);
        values[36] = rect?.[2] ?? c.width;
        values[37] = rect?.[3] ?? c.height;
        values[38] = rect?.[0] ?? 0;
        values[39] = rect?.[1] ?? 0;
      },
      reset() {
        ready = false;
      },
    };
  },
};
