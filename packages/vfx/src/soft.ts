import { invertMatrix } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { viewRect } from '../../shared/view-rect.js';
import type { VFXFeatures } from './base.js';
/** Bytes of the soft-particle uniform: inverse view-projection (64), view-axis plane (16), screen rectangle (16), softness (16). */
const BYTES = 112;
/**
 * The `soft` feature: `softness` (world units) fades each particle out over that distance in front of whatever opaque
 * surface is behind it, so a particle meeting the floor or a wall no longer shows a hard line. Scene depth comes from the
 * `depth` option, a function returning a sampleable reversed-Z depth texture the size of the drawing buffer (for example
 * `() => depthTexture.texture` with `DepthTexture` from `@margoengine/post/depth`). Pass it as `{soft}` to `VFX` from
 * `@margoengine/vfx/base`; `VFX` from `@margoengine/vfx` already has it.
 */
export const soft: NonNullable<VFXFeatures['soft']> = {
  patch(billboard, samples) {
    const multisampled = samples > 1;
    const code = billboard
      .replace('@location(0) uv:vec2f,', '@location(0) uv:vec2f,@location(6) viewDepth:f32,')
      .replace(
        'o.clip=f.camera*vec4f(position,1);',
        'o.clip=f.camera*vec4f(position,1);o.viewDepth=dot(soft.plane.xyz,position)+soft.plane.w;',
      )
      .replace(
        '@fragment fn fragment(i:Out)->@location(0) vec4f {',
        '@fragment fn fragment(i:Out)->@location(0) vec4f {return softened(i,unsoftened(i));}\nfn unsoftened(i:Out)->vec4f {',
      );
    return (
      code +
      /* wgsl */ `
struct Soft {inverse:mat4x4f,plane:vec4f,screen:vec4f,softness:vec4f}
@group(0) @binding(11) var<uniform> soft:Soft;
@group(0) @binding(12) var sceneDepth:texture_depth${multisampled ? '_multisampled' : ''}_2d;
// Reversed Z: 1 at the near plane, 0 where nothing was drawn. With several samples the nearest one counts.
fn softened(i:Out,c:vec4f)->vec4f {
  let at=vec2i(i.clip.xy);var d=textureLoad(sceneDepth,at,0);
  ${multisampled ? `for(var s=1;s<${samples};s++){d=max(d,textureLoad(sceneDepth,at,s));}` : ''}
  if(d<=0.0){return c;}
  let ndc=vec2f((i.clip.x-soft.screen.z)/soft.screen.x*2-1,1-(i.clip.y-soft.screen.w)/soft.screen.y*2);
  let w=soft.inverse*vec4f(ndc,d,1);
  let gap=dot(soft.plane.xyz,w.xyz/w.w)+soft.plane.w-i.viewDepth;
  return vec4f(c.rgb,c.a*clamp(gap/soft.softness.x,0.0,1.0));
}
`
    );
  },
  create(device, owned) {
    const buffer = device.createBuffer({
      size: BYTES,
      usage: 0x40 /* GPUBufferUsage.UNIFORM */ | 0x8 /* GPUBufferUsage.COPY_DST */,
    });
    owned.push(buffer);
    const values = new Float32Array(BYTES / 4),
      inverse = values.subarray(0, 16),
      entries: GPUBindGroupEntry[] = [
        { binding: 11, resource: { buffer } },
        { binding: 12, resource: undefined! },
      ];
    let texture: GPUTexture | undefined;
    return {
      entries,
      changed: false,
      write(c, depth, view, softness) {
        if (!depth)
          throw new MargoError(
            'state',
            'VFX softness needs scene depth but depth() returned undefined; add DepthTexture from @margoengine/post/depth before the first frame, or set softness to 0',
          );
        const samples = depth.sampleCount;
        if (
          !depth.format.startsWith('depth') ||
          depth.dimension !== '2d' ||
          depth.width !== c.width ||
          depth.height !== c.height ||
          !(depth.usage & 4) /* GPUTextureUsage.TEXTURE_BINDING */ ||
          (samples !== 1 && samples !== (c.descriptor.multisample?.count ?? 1))
        )
          throw new RangeError(
            'VFX depth must be a sampleable depth texture of the drawing size, with 1 sample or the scene sample count; pass the texture of DepthTexture from @margoengine/post/depth',
          );
        this.changed = depth !== texture;
        if (this.changed) {
          texture = depth;
          entries[1].resource = depth.createView({ aspect: 'depth-only' });
        }
        if (!invertMatrix(c.camera.matrix, inverse)) return samples;
        // The view axis (the camera looks down -z of the view matrix); depth along it is dot(forward, p) - dot(forward, eye).
        const x = -view[2],
          y = -view[6],
          z = -view[10],
          eye = c.camera.position,
          rect = viewRect(c);
        values[16] = x;
        values[17] = y;
        values[18] = z;
        values[19] = -(x * eye[0] + y * eye[1] + z * eye[2]);
        values[20] = rect?.[2] ?? c.width;
        values[21] = rect?.[3] ?? c.height;
        values[22] = rect?.[0] ?? 0;
        values[23] = rect?.[1] ?? 0;
        values[24] = softness;
        c.device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
        return samples;
      },
    };
  },
};
