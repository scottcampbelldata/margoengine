import { Node, int, cast, uv, type NodeInput } from './node.js';
import { sampled, type BindableTexture } from './texture.js';

/** Samples an integer layer of a 2d-array texture, sharing one texture/sampler pair across all layer nodes.
 * UV defaults to uv(); fragment/post sampling uses implicit derivatives unless level is supplied.
 * Vertex/compute sampling defaults to level zero. Layer selection clamps to the available range in the shader API.
 */
export function textureArray(
  source: BindableTexture,
  layer: NodeInput<'i32' | 'u32'>,
  coord: NodeInput<'vec2f'> = uv(),
  level?: NodeInput<'f32'>,
): Node<'vec4f'> {
  if (layer instanceof Node) {
    if (layer.type !== 'i32' && layer.type !== 'u32') throw new TypeError('Use an i32 or u32 texture array layer');
  } else if (!Number.isInteger(layer) || layer < -2147483648 || layer > 2147483647) {
    throw new RangeError('Use an integer texture array layer within the i32 range');
  }
  return sampled(
    'textureArray',
    '2d-array',
    source,
    cast(coord, 'vec2f', 'texture array UV'),
    level,
    layer instanceof Node ? layer : int(layer),
  );
}
