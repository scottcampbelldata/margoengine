import { whiteTexture } from '../../shared/white-texture.js';
import { Node, cast, uv, unique, type NodeInput, type Resource } from './node.js';
/** Anything with `@margoengine/materials` Texture's `bind`; `srgb` is the default colour space (a texture's own `colorSpace` wins). */
export interface BindableTexture {
  bind(device: GPUDevice, srgb: boolean): [GPUTextureView, GPUSampler] | undefined;
}
const resources = new WeakMap<BindableTexture, Resource & { id: number }>();
type Dimension = '2d' | 'cube' | '3d';
/** Samples a texture (sRGB by default; `new Texture(source, {colorSpace: 'linear'})` for data). Vertex and compute stages, or an explicit
 * `level`, use textureSampleLevel. */
export function texture(
  source: BindableTexture,
  coord: NodeInput<'vec2f'> = uv(),
  level?: NodeInput<'f32'>,
): Node<'vec4f'> {
  return sampled('texture', '2d', source, cast(coord, 'vec2f', 'texture uv'), level);
}
/** Samples a cube texture (`CubeTexture` from `@margoengine/materials`) towards `direction`; `level` as in {@link texture}. */
export function textureCube(
  source: BindableTexture,
  direction: NodeInput<'vec3f'>,
  level?: NodeInput<'f32'>,
): Node<'vec4f'> {
  return sampled('textureCube', 'cube', source, cast(direction, 'vec3f', 'textureCube direction'), level);
}
/** Samples a 3D texture (`dimension: '3d'`) at `coord`, each axis 0-1; `level` as in {@link texture}. */
export function texture3D(
  source: BindableTexture,
  coord: NodeInput<'vec3f'>,
  level?: NodeInput<'f32'>,
): Node<'vec4f'> {
  return sampled('texture3D', '3d', source, cast(coord, 'vec3f', 'texture3D coordinate'), level);
}
function sampled(
  name: string,
  dimension: Dimension,
  source: BindableTexture,
  coord: Node,
  level: NodeInput<'f32'> | undefined,
): Node<'vec4f'> {
  if (typeof source?.bind !== 'function') throw new TypeError(`${name}() needs a Texture from @margoengine/materials`);
  const own = (source as { dimension?: string }).dimension ?? '2d';
  if (own !== dimension) throw new TypeError(`${name}() needs a Texture of dimension ${dimension}, not ${own}`);
  let r = resources.get(source);
  if (!r) {
    r = {
      id: unique(),
      source,
      prefix: 'ndt',
      bindings: 2,
      declare: (name, group, binding) =>
        `@group(${group}) @binding(${binding}) var ${name}:texture_${dimension}<f32>;\n@group(${group}) @binding(${binding + 1}) var ${name}s:sampler;`,
      entries: (device) => source.bind(device, true) ?? whiteTexture(device, dimension),
    };
    resources.set(source, r);
  }
  const resource = r,
    args: Node[] = [coord];
  if (level !== undefined) args.push(cast(level, 'f32', 'texture level'));
  return new Node('vec4f', 't' + r.id, args, (b, n) => {
    const name = b.resource(resource),
      [c, l] = n.args.map((a) => b.expr(a)),
      implicit = l === undefined && (b.stage.kind === 'fragment' || b.stage.kind === 'post');
    return implicit
      ? `textureSample(${name}, ${name}s, ${c})`
      : `textureSampleLevel(${name}, ${name}s, ${c}, ${l ?? '0.0'})`;
  });
}
