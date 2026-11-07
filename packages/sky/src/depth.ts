import type { PassContext } from '@margoengine/core/extension';
import { sceneTarget } from '../../shared/msaa.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** The scene depth a pass reads this frame: the resource to bind, its sample count and a key for its shader variant. */
export interface SceneDepth {
  resource: GPUTextureView;
  texture: GPUTexture | GPUTextureView;
  samples: number;
}
/**
 * The provider's reversed-Z scene depth, checked against the frame (`owner` names the effect in the error). A 4x
 * capture resolves its 1x depth only when it presents, after these passes, so its own multisampled depth is read
 * instead, as the sky's fog does. Undefined while the provider returns nothing.
 * @throws RangeError when the texture does not match the viewport or sample count, or is not sampleable depth.
 */
export function sceneDepth(c: Context, provider: () => GPUTexture | undefined, owner: string): SceneDepth | undefined {
  const depth = provider();
  if (!depth) return undefined;
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
    throw new RangeError(`${owner} requires sampleable scene depth matching the viewport; pass the scene's depth texture`);
  const target = sceneTarget(c),
    live = target?.samples === 4 && target.resolvedDepth === depth ? target.depthSource : undefined;
  return live
    ? { resource: live, texture: live, samples: 4 }
    : { resource: depth.createView({ aspect: 'depth-only' }), texture: depth, samples: depth.sampleCount };
}
/**
 * WGSL declaring `sceneDepth` at `binding` of group 0 and `sceneDepthAt(pixel)`, the reversed-Z depth of a pixel (0 is
 * empty sky). A multisampled depth reads its first sample: the effect is shaded once per pixel.
 */
export function depthWGSL(binding: number, samples: number): string {
  return samples === 1
    ? `@group(0) @binding(${binding}) var sceneDepth:texture_depth_2d;
fn sceneDepthAt(pixel:vec2i)->f32 {return textureLoad(sceneDepth,pixel,0);}
`
    : `@group(0) @binding(${binding}) var sceneDepth:texture_depth_multisampled_2d;
fn sceneDepthAt(pixel:vec2i)->f32 {return textureLoad(sceneDepth,pixel,0);}
`;
}
